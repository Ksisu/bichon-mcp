// Run: node --test     (no dependencies; uses a stub Bichon server on a random local port)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------- stub Bichon
const TOKEN = "test-token";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0); // 2026-11-09 12:00Z
// 1200 messages, newest first; every message's date is unique except a block of 3 sharing one timestamp.
const MESSAGES = Array.from({ length: 1200 }, (_, i) => ({
  id: `m${i}`,
  account_id: 1,
  mailbox_id: 7,
  mailbox_name: "[Gmail]/All Mail",
  subject: `Subject ${i}`,
  preview: `Preview\n of   message ${i}`,
  from: i % 3 === 0 ? "News@Shop.example" : i % 3 === 1 ? "alice@friends.example" : "bob@mail.friends.example",
  from_name: i % 3 === 0 ? "Shop News" : null,
  to: ["me@example.com", "Me@example.com"],
  cc: [], bcc: [],
  date: i >= 500 && i <= 502 ? T0 - 500 * 3600_000 : T0 - i * 3600_000,
  thread_id: i < 3 ? "t1" : `t${i}`,
  attachment_count: i === 0 ? 2 : 0,
  regular_attachment_count: i === 0 ? 1 : 0,
  tags: i === 0 ? ["important"] : [],
}));
let lastSearch;
let stubCalls = [];
let stubRejects = false; // simulate a revoked API token

function stubHandler(req, res) {
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (stubRejects || req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { message: "invalid token", code: 10000 });
  const u = new URL(req.url, "http://stub");
  stubCalls.push(`${req.method} ${u.pathname}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const p = u.pathname;
    if (p === "/api/v1/minimal-account-list") return json(200, [{ id: 1, email: "me@example.com", name: "Main", account_type: "NoSync" }]);
    if (p === "/api/v1/all-tags") return json(200, [{ tag: "a", count: 1 }, { tag: "b", count: 5 }]);
    if (p === "/api/v1/list-mailboxes/1") return json(200, { status: "ready", mailboxes: [{ id: 7, name: "[Gmail]/All Mail", exists: 0 }, { id: 3, name: "INBOX", exists: 12 }] });
    if (p === "/api/v1/search-messages") {
      const b = JSON.parse(body);
      lastSearch = b;
      let items = MESSAGES.filter((m) => (b.filter.before === undefined || m.date <= b.filter.before) && (b.filter.since === undefined || m.date >= b.filter.since));
      if (b.filter.from) items = items.filter((m) => m.from.toLowerCase().includes(b.filter.from.toLowerCase()));
      items.sort((x, y) => (b.desc === false ? x.date - y.date : y.date - x.date));
      const start = (b.page - 1) * b.page_size;
      return json(200, { current_page: b.page, page_size: b.page_size, total_items: items.length, items: items.slice(start, start + b.page_size) });
    }
    if (p === "/api/v1/search-attachment") {
      lastSearch = JSON.parse(body);
      return json(200, { total_items: 1, items: [{ account_id: 1, envelope_id: "m0", date: T0, name: "invoice.pdf", content_type: "application/pdf", size: 52_000, from: "shop@x.example", subject: "Your invoice" }] });
    }
    let m;
    if ((m = /^\/api\/v1\/envelope\/1\/(.+)$/.exec(p))) {
      const e = MESSAGES.find((x) => x.id === decodeURIComponent(m[1]));
      return e ? json(200, { ...e, account_email: "me@example.com" }) : json(404, { message: "envelope not found", code: 40400 });
    }
    if ((m = /^\/api\/v1\/message-content\/1\/(.+)$/.exec(p))) {
      assert.equal(u.searchParams.get("block_remote_content"), "true");
      const id = decodeURIComponent(m[1]);
      if (id === "m1") return json(200, { text: "", html: "<html><head><style>x{}</style></head><body><p>Hi &amp; hello</p><ul><li>one</li><li>two</li></ul><a href=\"https://ex.example/a\">link</a></body></html>", attachments: [], has_remote_content: false });
      return json(200, {
        text: `Body of ${id}. ` + "x".repeat(800),
        attachments: [
          { filename: "report.pdf", file_type: "application/pdf", size: 2048, inline: false, content_hash: "h1", is_message: false, extracted_is_ocr: false },
          { filename: "logo.png", file_type: "image/png", size: 100, inline: true, content_hash: "h2", is_message: false, extracted_is_ocr: false },
        ],
        has_remote_content: false,
      });
    }
    if (p === "/api/v1/get-thread-messages/1") {
      const items = MESSAGES.filter((x) => x.thread_id === u.searchParams.get("thread_id"));
      return json(200, { total_items: items.length, items });
    }
    if (p === "/api/v1/dashboard-stats") {
      return json(200, {
        account_count: 3, email_count: 90000, attachment_count: 12000, total_size_bytes: 20 * 1024 ** 3, storage_usage_bytes: 9 * 1024 ** 3,
        index_usage_bytes: 1024 ** 3, storage_stats_available: true, recent_activity: [{ timestamp_ms: T0, count: 42 }],
        top_senders: [{ key: "news@shop.example", count: 900 }], top_accounts: [{ key: "me@example.com", count: 7, account_id: 1 }], with_attachment_count: 5, without_attachment_count: 6,
        top_largest_emails: [{ subject: "Big", size_bytes: 30 * 1024 ** 2, id: "x" }], top_largest_attachments: [], system_version: "2.3.0",
      });
    }
    json(404, { message: "no such stub route", code: 40400 });
  });
}

// ---------------------------------------------------------------- setup
let stub, mod, mcpServer, base;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bichon-mcp-test-"));
const PASSWORD = "correct-horse-battery";

before(async () => {
  stub = http.createServer(stubHandler);
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  Object.assign(process.env, {
    BICHON_URL: `http://127.0.0.1:${stub.address().port}/`,
    BICHON_TOKEN: TOKEN,
    BICHON_TZ: "Europe/Berlin",
    MCP_PUBLIC_URL: "https://mail-mcp.test/mcp",
    MCP_LOGIN_PASSWORD: PASSWORD,
    MCP_STATE_FILE: path.join(tmp, "state.json"),
  });
  mod = await import("./bichon-mcp.mjs");
  mcpServer = mod.startHttp({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => mcpServer.once("listening", r));
  base = `http://127.0.0.1:${mcpServer.address().port}`;
});
after(() => {
  stub.close();
  mcpServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const call = async (name, args = {}) => {
  const r = await mod.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { text: r.result.content[0].text, isError: !!r.result.isError };
};

// ---------------------------------------------------------------- helpers
test("parseDate: local dates, exclusive before, ISO, relative, epoch", () => {
  const { parseDate } = mod;
  assert.equal(parseDate("2026-11-03"), Date.UTC(2026, 10, 2, 23)); // CET = UTC+1
  assert.equal(parseDate("2026-07-01"), Date.UTC(2026, 5, 30, 22)); // CEST = UTC+2
  assert.equal(parseDate("2026-11-03", { before: true }), Date.UTC(2026, 10, 2, 23) - 1);
  assert.equal(parseDate("2026-11"), Date.UTC(2026, 9, 31, 23));
  assert.equal(parseDate("2026-11-03T10:30"), Date.UTC(2026, 10, 3, 9, 30));
  assert.equal(parseDate("2026-11-03T10:30:00Z"), Date.UTC(2026, 10, 3, 10, 30));
  assert.equal(parseDate("2026-11-03T10:30:00+02:00"), Date.UTC(2026, 10, 3, 8, 30));
  assert.equal(parseDate("7d", { now: T0 }), T0 - 7 * DAY);
  assert.equal(parseDate("1y", { now: T0 }), T0 - Math.round(365.25 * DAY));
  assert.equal(parseDate("today", { now: T0 }), Date.UTC(2026, 10, 8, 23));
  assert.equal(parseDate("yesterday", { now: T0 }), Date.UTC(2026, 10, 7, 23));
  assert.equal(parseDate("1762700000"), 1762700000 * 1000);
  assert.equal(parseDate("1762700000000"), 1762700000000);
  assert.equal(parseDate(undefined), undefined);
  assert.equal(parseDate(""), undefined);
  assert.throws(() => parseDate("last tuesday"), mod.ToolError);
});

test("fmtDate shows local time", () => {
  assert.equal(mod.fmtDate(Date.UTC(2026, 10, 2, 23)), "2026-11-03 00:00");
  assert.equal(mod.fmtDate(Date.UTC(2026, 6, 1, 10, 5)), "2026-07-01 12:05");
  assert.equal(mod.fmtDate(0), "????-??-?? ??:??");
});

test("htmlToText", () => {
  const t = mod.htmlToText(
    "<html><head><title>T</title><style>p{}</style></head><body><script>evil()</script><p>Gr&uuml;&szlig;e, caf&eacute; &amp; na&#239;ve &#x2014; ok</p>" +
    "<ul><li>one</li><li>two</li></ul>Line<br>break<table><tr><td>a</td><td>b</td></tr></table>" +
    "<a href=\"https://x.example/p\">Go</a> <a href=\"mailto:a@b.c\">mail</a> <a href=\"https://track.example/" + "z".repeat(200) + "\">Long</a>" +
    "<!-- hidden --></body></html>");
  assert.match(t, /Grüße, café & naïve — ok/);
  assert.match(t, /• one\n• two/);
  assert.match(t, /Line\nbreak/);
  assert.match(t, /a \| b/);
  assert.match(t, /Go \(https:\/\/x\.example\/p\) mail Long/);
  assert.doesNotMatch(t, /evil|hidden|p\{\}|^T$/m);
});

test("small formatters", () => {
  assert.equal(mod.fmtSize(500), "500 B");
  assert.equal(mod.fmtSize(2048), "2.0 KB");
  assert.equal(mod.fmtSize(30 * 1024 ** 2), "30 MB");
  assert.equal(mod.fmtAddr("a@b.c", "Ann"), "Ann <a@b.c>");
  assert.equal(mod.fmtAddr("a@b.c", "A@B.C"), "a@b.c");
  assert.equal(mod.baseDomain("mail.aliexpress.com"), "aliexpress.com");
  assert.equal(mod.baseDomain("gmail.com"), "gmail.com");
  assert.equal(mod.baseDomain("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(mod.baseDomain("sch.bme.hu"), "bme.hu");
  assert.deepEqual(mod.parseId({ id: "3/abc" }), [3, "abc"]);
  assert.deepEqual(mod.parseId({ id: "[3/abc]" }), [3, "abc"]);
  assert.deepEqual(mod.parseId({ account_id: 3, envelope_id: "abc" }), [3, "abc"]);
  assert.throws(() => mod.parseId({ id: "abc" }), mod.ToolError);
});

// ---------------------------------------------------------------- tools
test("tools/list: all read-only", async () => {
  const r = await mod.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const names = r.result.tools.map((t) => t.name);
  assert.deepEqual(names, ["list_accounts", "list_mailboxes", "search_emails", "read_email", "get_thread", "search_attachments", "sender_stats", "archive_stats", "list_tags"]);
  for (const t of r.result.tools) assert.equal(t.annotations.readOnlyHint, true);
});

test("initialize and unknown methods", async () => {
  const init = await mod.handleRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(init.result.serverInfo.name, "bichon");
  assert.match(init.result.instructions, /untrusted/);
  assert.equal(await mod.handleRpc({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const bad = await mod.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "constructor" } });
  assert.equal(bad.error.code, -32602);
});

test("search_emails builds the filter and formats hits", async () => {
  const { text, isError } = await call("search_emails", { participant: "alice", since: "2026-11-01", before: "2026-11-09", page_size: 500, has_attachment: true });
  assert.equal(isError, false);
  assert.deepEqual(lastSearch.filter, { any_participant: "alice", since: Date.UTC(2026, 9, 31, 23), before: Date.UTC(2026, 10, 8, 23) - 1, has_attachment: true });
  assert.equal(lastSearch.page_size, 100);
  assert.equal(lastSearch.desc, true);
  assert.equal(lastSearch.sort_by, undefined);
  assert.match(text, /^\d+ matching message\(s\); page 1 of \d+ — ask for page=2 for more\./);
  assert.match(text, /• \[1\/m\d+\] 2026-11-\d\d \d\d:\d\d \| /);
  const first = await call("search_emails", { page_size: 1 });
  assert.match(first.text, /\[1\/m0\] 2026-11-09 13:00 \| Shop News <News@Shop.example> → me@example.com\n  Subject 0  \(📎1 · tags: important · in \[Gmail\]\/All Mail\)\n  Preview of message 0/);
  const sorted = await call("search_emails", { sort: "size", oldest_first: true, account_ids: [1], tags: ["x"] });
  assert.equal(lastSearch.sort_by, "SIZE");
  assert.equal(lastSearch.desc, false);
  assert.deepEqual(lastSearch.filter, { account_ids: [1], tags: ["x"] });
  assert.equal(sorted.isError, false);
  const bad = await call("search_emails", { since: "someday" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Unrecognised date/);
});

test("read_email: headers, attachments, body, truncation, HTML fallback", async () => {
  const { text } = await call("read_email", { id: "1/m0", max_chars: 500 });
  assert.match(text, /^Subject: Subject 0\nFrom: Shop News <News@Shop.example>\nTo: me@example.com\nDate: 2026-11-09 13:00 \(Europe\/Berlin\)/);
  assert.match(text, /Thread: t1 \(get_thread with id 1\/m0\)/);
  assert.match(text, /Attachments \(1\):\n  - report.pdf — application\/pdf, 2.0 KB\n\(1 inline image not listed\)/);
  assert.match(text, /-----\nBody of m0\. x+\n…\[truncated: \d+ more characters/);
  const html = await call("read_email", { id: "1/m1" });
  assert.match(html.text, /-----\nHi & hello\n\n• one\n• two\n?\nlink \(https:\/\/ex\.example\/a\)$/);
  const missing = await call("read_email", { id: "1/nope" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Not found in the archive \(404\): envelope not found/);
});

test("get_thread: oldest first, optional bodies", async () => {
  const { text } = await call("get_thread", { id: "1/m1" });
  assert.match(text, /^3 message\(s\) in the thread "Subject 1"\./);
  assert.ok(text.indexOf("[1/m2]") < text.indexOf("[1/m1]") && text.indexOf("[1/m1]") < text.indexOf("[1/m0]"));
  const withBodies = await call("get_thread", { id: "1/m1", include_bodies: true, max_chars_per_message: 200 });
  assert.match(withBodies.text, /\n    Body of m2\. x+…/);
  assert.match(withBodies.text, /\n    Hi & hello/);
});

test("sender_stats: keyset paging over all messages, by address and domain, with a cap", async () => {
  stubCalls = [];
  const all = await call("sender_stats", {});
  assert.match(all.text, /^Top 3 sender addresses over 1200 of 1200 matching message\(s\):/);
  assert.match(all.text, /  1\.    400  Shop News <news@shop.example>/);
  assert.equal(stubCalls.filter((c) => c.endsWith("search-messages")).length, 3);
  const dom = await call("sender_stats", { group_by: "domain" });
  assert.match(dom.text, /  1\.    800  friends\.example\n  2\.    400  shop\.example/);
  const capped = await call("sender_stats", { max_messages: 100 });
  assert.match(capped.text, /over 100 of 1200 matching message\(s\) \(stopped at max_messages=100/);
  const filtered = await call("sender_stats", { from: "friends", since: "2026-11-01" });
  assert.equal(filtered.isError, false);
  assert.equal(lastSearch.filter.from, "friends");
});

test("other tools", async () => {
  assert.match((await call("list_accounts")).text, /^• 1  me@example.com \(Main\) — NoSync$/);
  assert.match((await call("list_mailboxes", { account_id: 1 })).text, /^• 7  \[Gmail\]\/All Mail\n• 3  INBOX — 12 messages$/);
  assert.equal((await call("list_tags")).text, "• b (5)\n• a (1)");
  const att = await call("search_attachments", { extension: ".PDF", since: "2026-01-01" });
  assert.equal(lastSearch.filter.attachment_extension, "pdf");
  assert.match(att.text, /• \[1\/m0\] 2026-11-09 13:00 \| invoice\.pdf — application\/pdf, 51 KB\n  from shop@x\.example: Your invoice/);
  const stats = await call("archive_stats");
  assert.match(stats.text, /^Accounts: 3 · messages: 90000/);
  assert.match(stats.text, /Original size: 20 GB · stored: 9.0 GB · index: 1.0 GB/);
  assert.match(stats.text, /   900  news@shop.example/);
  assert.match(stats.text, /     7  me@example.com \(account 1\)/);
});

test("a rejected Bichon token gives a readable error", async () => {
  stubRejects = true;
  try {
    const r = await call("list_accounts");
    assert.equal(r.isError, true);
    assert.match(r.text, /rejected the API token \(401\)/);
  } finally {
    stubRejects = false;
  }
});

// ---------------------------------------------------------------- remote mode: OAuth + /mcp
test("remote mode: OAuth flow, token use, refresh rotation", async () => {
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);

  const noAuth = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get("www-authenticate"), /resource_metadata="https:\/\/mail-mcp\.test\/\.well-known\/oauth-protected-resource\/mcp"/);

  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, "https://mail-mcp.test/mcp");

  const badReg = await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example/cb"] }) });
  assert.equal(badReg.status, 400);
  const reg = await (await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], client_name: "Claude" }) })).json();
  assert.ok(reg.client_id);

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const q = { response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "s1", code_challenge: challenge, code_challenge_method: "S256" };
  const page = await fetch(`${base}/authorize?${new URLSearchParams(q)}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /read-only access to your archived e-mail/);

  const wrong = await fetch(`${base}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, password: "nope" }), redirect: "manual" });
  assert.equal(wrong.status, 401);
  const ok = await fetch(`${base}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, password: PASSWORD }), redirect: "manual" });
  assert.equal(ok.status, 302);
  const loc = new URL(ok.headers.get("location"));
  assert.equal(loc.searchParams.get("state"), "s1");
  const code = loc.searchParams.get("code");

  const tokenReq = (body) => fetch(`${base}/token`, { method: "POST", body: new URLSearchParams(body) });
  const badPkce = await tokenReq({ grant_type: "authorization_code", code, redirect_uri: q.redirect_uri, client_id: reg.client_id, code_verifier: "wrong" });
  assert.equal(badPkce.status, 400); // and the code is now spent
  const ok2 = await fetch(`${base}/authorize`, { method: "POST", body: new URLSearchParams({ ...q, password: PASSWORD }), redirect: "manual" });
  const code2 = new URL(ok2.headers.get("location")).searchParams.get("code");
  const tok = await (await tokenReq({ grant_type: "authorization_code", code: code2, redirect_uri: q.redirect_uri, client_id: reg.client_id, code_verifier: verifier })).json();
  assert.ok(tok.access_token && tok.refresh_token);
  assert.equal(tok.scope, "mail");

  const rpc = (token, body) => fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const init = await (await rpc(tok.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })).json();
  assert.equal(init.result.serverInfo.name, "bichon");
  const notif = await rpc(tok.access_token, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notif.status, 202);
  const listed = await (await rpc(tok.access_token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_accounts", arguments: {} } })).json();
  assert.match(listed.result.content[0].text, /me@example\.com/);

  const refreshed = await (await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id })).json();
  assert.ok(refreshed.access_token);
  const reused = await tokenReq({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: reg.client_id });
  assert.equal(reused.status, 400);

  const state = JSON.parse(fs.readFileSync(process.env.MCP_STATE_FILE, "utf8"));
  assert.ok(!JSON.stringify(state).includes(tok.access_token), "tokens are stored hashed");
  assert.equal(fs.statSync(process.env.MCP_STATE_FILE).mode & 0o777, 0o600);
});
