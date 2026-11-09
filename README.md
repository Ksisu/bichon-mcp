# bichon-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude (or any MCP client) **read-only** access to a
[Bichon](https://github.com/rustmailer/bichon) e-mail archive through Bichon's REST API. One file, zero
dependencies: Node.js ≥ 18.

It runs in two modes:

- **Local (stdio)** — started by Claude Desktop / Claude Code on your computer. The default.
- **Remote (HTTP)** — a long-running service behind HTTPS, added in Claude as a **custom connector**, so the
  archive is available in Claude on the web and the mobile app too. Has its own login.

## Tools

All tools are read-only (and annotated as such).

| Tool | What it does |
|---|---|
| `list_accounts` | Archive accounts and their ids |
| `list_mailboxes` | Folders of one account and their ids |
| `search_emails` | Full-text and field search (sender, recipient, subject, body, dates, folders, tags, attachments); compact results with `[account_id/envelope_id]` ids |
| `read_email` | Headers, plain-text body (HTML converted when there's no text part), attachment list; truncated at `max_chars` |
| `get_thread` | The whole conversation of a message, oldest first; optionally with each message's text |
| `search_attachments` | Attachments by name, extension, category, MIME type, sender, date, size |
| `sender_stats` | Top senders or recipients (by address or domain) over a date range — pages through up to 50 000 messages |
| `archive_stats` | Totals, all-time top senders, recent activity, largest messages |
| `list_tags` | Tags and their counts |

Dates are accepted as `YYYY-MM-DD`, ISO date-times, `today`/`yesterday` or relative (`7d`, `4w`, `6m`, `1y`), and
are interpreted and shown in `BICHON_TZ`. `since` is inclusive, `before` exclusive.

Attachment *contents* aren't exposed (yet); only their metadata.

## Bichon side: a read-only user

Don't give the server an admin token. In Bichon (as admin):

1. **Users → add user** `claude-mcp` with global role **Member** (`system:access` only).
2. **Accounts → access**: give `claude-mcp` the account role **Account Viewer** (`account:read_details` +
   `data:read`) on every account Claude may see. Accounts added later need this too.
3. Log in as `claude-mcp` (or as admin, creating the token for that user) → **Settings → API tokens** → new token.

That token can search and read, but can't delete, tag, export, download raw EML or change settings, whatever this
server does. The server additionally only calls an allowlist of read endpoints.

## Local use (stdio)

```bash
claude mcp add bichon --env BICHON_URL=http://mail.example.lan --env BICHON_TOKEN=… -- node /path/to/bichon-mcp.mjs
```

or in Claude Desktop's `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bichon": {
      "command": "node",
      "args": ["/path/to/bichon-mcp.mjs"],
      "env": { "BICHON_URL": "http://mail.example.lan", "BICHON_TOKEN": "…" }
    }
  }
}
```

`node bichon-mcp.mjs --check` (with the env set) tests the URL and token and lists the visible accounts.

## Configuration

| Variable | Default | |
|---|---|---|
| `BICHON_URL` | — (required) | Base URL of Bichon, e.g. `http://mail.example.lan` |
| `BICHON_TOKEN` | — (required) | API token of the read-only user |
| `BICHON_TZ` | this machine's time zone (else UTC) | Time zone for dates in and out, e.g. `Europe/Berlin` |
| `BICHON_TIMEOUT_MS` | `30000` | Per-request timeout |
| `BICHON_DEBUG` | — | `1` logs each tool call's duration to stderr |

Remote mode only:

| Variable | Default | |
|---|---|---|
| `MCP_HTTP_PORT` | — | Setting it switches to remote mode |
| `MCP_HTTP_HOST` | `127.0.0.1` | Bind address — keep it local and put a TLS proxy in front |
| `MCP_PUBLIC_URL` | — (required) | The public URL added in Claude, e.g. `https://mail-mcp.example.com/mcp` |
| `MCP_LOGIN_PASSWORD` | — (required, ≥ 12 chars) | Password asked when connecting the connector |
| `MCP_STATE_FILE` | `~/.bichon-mcp/oauth-state.json` | Registered clients and (hashed) tokens |
| `MCP_EXTRA_REDIRECT_URIS` | — | Extra allowed OAuth redirect URIs, comma-separated |

## Remote mode (custom connector)

With `MCP_HTTP_PORT` set, the server speaks MCP Streamable HTTP at the path of `MCP_PUBLIC_URL` and includes the
a minimal single-user OAuth 2.1 server, which is what Claude's custom connectors expect:

- protected-resource and authorization-server metadata under `/.well-known/`
- dynamic client registration (`/register`), limited to Claude's callback and loopback redirects (Claude Code)
- authorization code flow with PKCE S256; "signing in" means entering `MCP_LOGIN_PASSWORD` on `/authorize`;
  10 wrong passwords lock it for 15 minutes
- access tokens valid 1 hour, refresh tokens 90 days and rotated on every use; stored only as hashes

**To sign everyone out**, stop the service, delete the state file and start it again; then reconnect the
connector in Claude.

### Deploying (systemd + Caddy)

`deploy/` has a hardened systemd unit (port 8788), a Caddy site template, an env template and `install.sh` for
Debian/Ubuntu. The server needs a public DNS name and must reach Bichon (e.g. over a VPN).

```bash
scp -r bichon-mcp root@your-server:
ssh root@your-server
bash bichon-mcp/deploy/install.sh     # 1st run: creates /etc/bichon-mcp.env
nano /etc/bichon-mcp.env              # fill it in
bash bichon-mcp/deploy/install.sh     # 2nd run: checks Bichon, starts everything, prints a health check
```

The script creates the `bichon-mcp` system user, installs the program to `/opt/bichon-mcp/`, checks that the token
works (`--check`), writes the Caddy site to `/etc/caddy/conf.d/bichon-mcp.caddy`, adds
`import /etc/caddy/conf.d/*.caddy` to the main Caddyfile if it isn't there (backing it up first), opens 80/443 in ufw
and (re)starts the service. It never rewrites the main Caddyfile otherwise, so other sites on the host stay as they
are. Re-run it after updating `bichon-mcp.mjs`.

The Caddy site answers **403** to everything except the login page unless the request comes from Anthropic's
outbound range (`160.79.104.0/21`) or a network in `MCP_ALLOWED_SUBNETS`.

Then add `MCP_PUBLIC_URL` in Claude under **Settings → Connectors → Add custom connector**; a browser window opens
the login page.

## Security notes

- E-mail is written by strangers. A message can contain text aimed at the model ("ignore your instructions and…").
  This server can't change anything, but in a chat where Claude also has tools that *can* write or send (a wiki,
  web requests, other connectors), such text could try to move archive content there. The server's instructions tell
  Claude to treat e-mail content as untrusted; keep it in mind when combining connectors.
- Everything Claude reads through the connector passes through Anthropic, like any other connector content.
- The login password and the Bichon token are both in `/etc/bichon-mcp.env` (mode 600).

## Tests

```bash
node --test
```

Runs against a stub Bichon server: date parsing, HTML→text, every tool's request and output, the 401 path, and the
full OAuth flow (registration, login, PKCE, refresh rotation, hashed state).
