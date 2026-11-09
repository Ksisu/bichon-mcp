#!/usr/bin/env bash
# Run on the server as root, from the copied bichon-mcp folder:  bash deploy/install.sh
# Safe to re-run (e.g. after updating bichon-mcp.mjs): it restarts the service with the new code.
# Coexists with other Caddy sites: this one lives in /etc/caddy/conf.d/bichon-mcp.caddy and the
# main Caddyfile only gets an `import /etc/caddy/conf.d/*.caddy` line.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== packages: node, caddy (only if missing)"
if ! command -v node >/dev/null; then apt-get update -q && apt-get install -y -q nodejs; fi
node -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || { echo "need Node >= 18"; exit 1; }
if ! command -v caddy >/dev/null; then
  apt-get update -q && apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

echo "== user, program, config"
id bichon-mcp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/bichon-mcp --shell /usr/sbin/nologin bichon-mcp
install -d -m 755 /opt/bichon-mcp
install -m 644 bichon-mcp.mjs /opt/bichon-mcp/bichon-mcp.mjs
if [ ! -f /etc/bichon-mcp.env ]; then
  install -m 600 deploy/bichon-mcp.env.example /etc/bichon-mcp.env
  echo ">> Fill in /etc/bichon-mcp.env, then re-run this script."; exit 0
fi
chmod 600 /etc/bichon-mcp.env
envval() { sed -n "s/^$1=//p" /etc/bichon-mcp.env | tail -1 | tr -d '"'; }
[ -n "$(envval BICHON_URL)" ] || { echo ">> BICHON_URL in /etc/bichon-mcp.env is empty"; exit 1; }
[ -n "$(envval BICHON_TOKEN)" ] || { echo ">> BICHON_TOKEN in /etc/bichon-mcp.env is empty"; exit 1; }
[ "$(envval MCP_LOGIN_PASSWORD | wc -c)" -gt 12 ] || { echo ">> MCP_LOGIN_PASSWORD in /etc/bichon-mcp.env is missing or shorter than 12 chars"; exit 1; }
mcp_host=$(envval MCP_PUBLIC_URL | sed -n 's#^https://\([^/:]*\).*#\1#p')
[ -n "$mcp_host" ] || { echo ">> MCP_PUBLIC_URL in /etc/bichon-mcp.env must be an https:// URL"; exit 1; }
install -m 644 deploy/bichon-mcp.service /etc/systemd/system/bichon-mcp.service

echo "== can this server reach Bichon with the token?"
(set -a; . /etc/bichon-mcp.env; set +a; cd /; runuser -u bichon-mcp -- /usr/bin/node /opt/bichon-mcp/bichon-mcp.mjs --check)

echo "== caddy site for $mcp_host"
install -d -m 755 /etc/caddy/conf.d
sed -e "s#__MCP_HOST__#$mcp_host#" -e "s#__ALLOWED_SUBNETS__#$(envval MCP_ALLOWED_SUBNETS)#" deploy/Caddyfile > /etc/caddy/conf.d/bichon-mcp.caddy
chmod 644 /etc/caddy/conf.d/bichon-mcp.caddy
if ! grep -qx 'import /etc/caddy/conf.d/\*.caddy' /etc/caddy/Caddyfile; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)"
  printf '\n# Sites installed by other services (e.g. bichon-mcp)\nimport /etc/caddy/conf.d/*.caddy\n' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

echo "== firewall: 80 (certificate + redirect) and 443"
if command -v ufw >/dev/null; then
  ufw allow 80/tcp comment 'caddy acme/redirect'
  ufw allow 443/tcp comment 'caddy https'
fi

echo "== start"
systemctl daemon-reload
systemctl enable bichon-mcp
systemctl restart bichon-mcp
systemctl reload-or-restart caddy
sleep 2
curl -fsS http://127.0.0.1:8788/healthz && echo
systemctl --no-pager --lines=5 status bichon-mcp
