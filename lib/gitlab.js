"use strict";
// GitLab connection for the LOCAL JiraTime server (node server.js).
// The token is validated against GitLab, then kept on this laptop only:
//   1) OS keyring via `secret-tool` (libsecret / GNOME Keyring) when available, else
//   2) ~/.config/jiratime/gitlab-token with file mode 0600 (readable by this user only).
// The browser never receives the token. It calls /gl/api/v4/... and this module adds PRIVATE-TOKEN.
// Phase 1 is read-only: only an allow-list of GET endpoints is forwarded.

const https = require("https");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { _lookup: lookup } = require("./jira-proxy");

const CONFIG_DIR = process.env.JIRATIME_CONFIG_DIR || path.join(os.homedir(), ".config", "jiratime");
const CONFIG_FILE = path.join(CONFIG_DIR, "gitlab.json");
const TOKEN_FILE = path.join(CONFIG_DIR, "gitlab-token");
const TIMEOUT_MS = 30_000;
const MAX_RESPONSE = 25 * 1024 * 1024;

// GET endpoints the browser may use (path after /api/v4). Query strings are passed through.
const ALLOWED_GET = [
  /^\/user$/,
  /^\/personal_access_tokens\/self$/,
  /^\/version$/,
  /^\/projects$/,
  /^\/projects\/\d+$/,
  /^\/projects\/\d+\/languages$/,
  /^\/projects\/\d+\/events$/,
  /^\/projects\/\d+\/merge_requests$/,
  /^\/projects\/\d+\/pipelines$/,
  /^\/projects\/\d+\/repository\/(branches|tags|commits|contributors)$/,
  /^\/merge_requests$/,
  /^\/issues$/,
  /^\/events$/,
  /^\/users\/\d+\/events$/,
  /^\/users$/,
  /^\/search$/,
  /^\/projects\/\d+\/(users|labels|environments|deployments|merge_requests\/\d+(\/(changes|diffs|commits|notes|discussions|approvals|approval_state|pipelines))?)$/,
  /^\/projects\/\d+\/members\/all$/,
  /^\/projects\/\d+\/repository\/(compare|refs)$/,
  /^\/projects\/\d+\/repository\/commits\/[0-9a-f]{6,40}(\/(diff|merge_requests|refs))?$/,
  /^\/projects\/\d+\/pipelines\/\d+(\/jobs)?$/,
  /^\/projects\/\d+\/jobs\/\d+(\/trace)?$/,
];
// Changes the browser may ask for (needs the api scope). Everything else is refused.
const ALLOWED_WRITE = [
  ["POST", /^\/projects\/\d+\/merge_requests$/],
  ["PUT", /^\/projects\/\d+\/merge_requests\/\d+$/],
  ["PUT", /^\/projects\/\d+\/merge_requests\/\d+\/merge$/],
  ["POST", /^\/projects\/\d+\/merge_requests\/\d+\/(approve|unapprove|notes)$/],
  ["POST", /^\/projects\/\d+\/jobs\/\d+\/retry$/],
  ["POST", /^\/projects\/\d+\/repository\/branches$/],
  ["POST", /^\/projects\/\d+\/pipelines\/\d+\/retry$/],
];
const API_VERSION = 2;              // bump when the browser needs new server routes; the page warns about an old running server
const PASS_HEADERS = ["x-total", "x-total-pages", "x-next-page", "x-page", "x-per-page", "retry-after", "link"];

// ---------- token storage ----------
let secretToolChecked = null;
function hasSecretTool() {
  if (secretToolChecked !== null) return Promise.resolve(secretToolChecked);
  return new Promise((resolve) => execFile("secret-tool", ["--version"], { timeout: 3000 }, (err) => resolve((secretToolChecked = !err || err.code !== "ENOENT"))));
}
const keyAttrs = (url) => ["app", "jiratime", "service", "gitlab", "url", url];
function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = execFile(cmd, args, { timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}
function ensureDir() { fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 }); try { fs.chmodSync(CONFIG_DIR, 0o700); } catch { /* not owner */ } }
function writePrivate(file, text) {
  ensureDir();
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
async function saveToken(url, token) {
  if (await hasSecretTool()) {
    try { await run("secret-tool", ["store", "--label=JiraTime GitLab token", ...keyAttrs(url)], token); try { fs.unlinkSync(TOKEN_FILE); } catch { /* none */ } return "keyring"; }
    catch { /* keyring locked / no session bus: fall back to the private file */ }
  }
  writePrivate(TOKEN_FILE, token);
  return "file";
}
async function loadToken(cfg) {
  if (cfg.store === "keyring") { try { return String(await run("secret-tool", ["lookup", ...keyAttrs(cfg.url)])).trim() || null; } catch { return null; } }
  try { return fs.readFileSync(TOKEN_FILE, "utf8").trim() || null; } catch { return null; }
}
async function clearToken(cfg) {
  if (cfg?.store === "keyring" || (await hasSecretTool())) { try { await run("secret-tool", ["clear", ...keyAttrs(cfg?.url || "")]); } catch { /* none */ } }
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* none */ }
}
function loadConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return null; } }

let state = { cfg: loadConfig(), token: null, tokenLoaded: false };
async function current() {
  if (!state.cfg) return null;
  if (!state.tokenLoaded) { state.token = await loadToken(state.cfg); state.tokenLoaded = true; }
  return state.token ? { cfg: state.cfg, token: state.token } : null;
}

// ---------- HTTPS to GitLab ----------
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 8, timeout: 60_000, lookup });
function httpsSend(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === "http:" ? http : https;
    const req = mod.request({ hostname: u.hostname, port: u.port || (u.protocol === "http:" ? 80 : 443), path: u.pathname + u.search, method, headers,
      agent: u.protocol === "http:" ? undefined : AGENT, lookup }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_RESPONSE) req.destroy(Object.assign(new Error("GitLab response too large"), { code: "ETOOBIG" })); else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error("GitLab did not answer in time"), { code: "EGLTIMEOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const transport = { send: httpsSend };          // tests replace transport.send

const FRIENDLY = {
  ENOTFOUND: "host not found — check the URL and that you are on the office network / VPN",
  EAI_AGAIN: "DNS lookup failed — check your network / VPN",
  ECONNREFUSED: "connection refused", ECONNRESET: "connection was reset", ETIMEDOUT: "connection timed out",
  EGLTIMEOUT: "GitLab did not answer in 30 s", ETOOBIG: "response too large",
  CERT_HAS_EXPIRED: "the server's TLS certificate has expired",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "the server's TLS certificate is signed by a company CA that Node does not trust — start the server with NODE_EXTRA_CA_CERTS=/path/to/ca.pem",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed TLS certificate in chain — start the server with NODE_EXTRA_CA_CERTS=/path/to/ca.pem",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed TLS certificate — start the server with NODE_EXTRA_CA_CERTS=/path/to/ca.pem",
};
const netError = (e) => { const code = e.code || e.cause?.code || "ERROR"; return `Could not reach GitLab (${code}${FRIENDLY[code] ? ": " + FRIENDLY[code] : ""})`; };
const gitlabMessage = (text) => { try { const j = JSON.parse(text); return j.message ? (typeof j.message === "string" ? j.message : JSON.stringify(j.message)) : j.error_description || j.error || ""; } catch { return ""; } };

async function apiGet(base, token, pathAndQuery) {
  return transport.send(base + "/api/v4" + pathAndQuery, { method: "GET", headers: { "PRIVATE-TOKEN": token, Accept: "application/json", "User-Agent": "JiraTime" } });
}
async function apiSend(base, token, method, pathAndQuery, body) {
  return transport.send(base + "/api/v4" + pathAndQuery, { method, body, headers: { "PRIVATE-TOKEN": token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "JiraTime" } });
}

// ---------- public status ----------
function publicStatus(extra = {}) {
  const c = state.cfg;
  if (!c) return { available: true, api: API_VERSION, connected: false, ...extra };
  return { available: true, api: API_VERSION, connected: !!state.token, tokenMissing: state.tokenLoaded && !state.token, url: c.url, username: c.username, user: c.user, scopes: c.scopes || null,
    expiresAt: c.expiresAt || null, connectedAt: c.connectedAt, store: c.store, ...extra };
}

function normalizeUrl(input) {
  let u;
  let raw = String(input || "").trim();
  if (raw && !/^[a-z]+:\/\//i.test(raw)) raw = "https://" + raw;          // "gitlab.company.com" -> https://gitlab.company.com
  try { u = new URL(raw); } catch { throw new Error("GitLab URL is not valid (e.g. https://gitlab.company.com)"); }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("GitLab URL must start with https:// (the token must not travel unencrypted)");
  if (u.username || u.password) throw new Error("Do not put a username or password in the URL");
  return u.origin;                                // a project / page URL is fine: only the server part is used
}

async function connect(body) {
  const url = normalizeUrl(body.url), username = String(body.username || "").trim().replace(/^@/, ""), token = String(body.token || "").trim();
  if (!username) throw Object.assign(new Error("Username is required"), { status: 400 });
  if (!/^[\x21-\x7e]{10,500}$/.test(token)) throw Object.assign(new Error("Personal Access Token looks wrong (no spaces, at least 10 characters)"), { status: 400 });
  let r;
  try { r = await apiGet(url, token, "/user"); } catch (e) { throw Object.assign(new Error(netError(e)), { status: 502 }); }
  if (r.status === 401) throw Object.assign(new Error("GitLab rejected the token — it is wrong, expired or revoked"), { status: 401 });
  if (r.status === 403) throw Object.assign(new Error("The token is valid but lacks permission. Give it the read_api scope (api to create merge requests later)."), { status: 403 });
  if (r.status === 404) throw Object.assign(new Error("No GitLab API found at this URL — check the address"), { status: 404 });
  if (r.status !== 200) throw Object.assign(new Error(`GitLab answered ${r.status}${gitlabMessage(r.text) ? ": " + gitlabMessage(r.text) : ""}`), { status: 502 });
  let user; try { user = JSON.parse(r.text); } catch { throw Object.assign(new Error("This URL did not return GitLab data — check the address"), { status: 502 }); }
  if (!user?.username) throw Object.assign(new Error("This URL did not return a GitLab user — check the address"), { status: 502 });
  const sameUser = [user.username, user.email, user.public_email].filter(Boolean).some((x) => x.toLowerCase() === username.toLowerCase());
  if (!sameUser) throw Object.assign(new Error(`This token belongs to @${user.username}, not "${username}"`), { status: 400 });

  let scopes = null, expiresAt = null;                     // GitLab 15.5+; older servers simply skip this
  try { const s = await apiGet(url, token, "/personal_access_tokens/self"); if (s.status === 200) { const j = JSON.parse(s.text); scopes = j.scopes || null; expiresAt = j.expires_at || null; } } catch { /* optional */ }

  await clearToken(state.cfg);
  const store = await saveToken(url, token);
  const cfg = { url, username: user.username, user: { id: user.id, username: user.username, name: user.name, email: user.email || user.public_email || "" },
    scopes, expiresAt, connectedAt: new Date().toISOString(), store };
  writePrivate(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  state = { cfg, token, tokenLoaded: true };
  return publicStatus();
}

async function disconnect() {
  await clearToken(state.cfg);
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* none */ }
  state = { cfg: null, token: null, tokenLoaded: true };
  return publicStatus();
}

// ---------- router (called by server.js) ----------
const reply = (status, obj, headers = {}) => ({ status, body: typeof obj === "string" ? obj : JSON.stringify(obj), headers });

/** @param {{method:string, path:string, query:string, body?:string, headers:Record<string,string>}} req */
async function handle(req) {
  const h = req.headers || {};
  if (h["sec-fetch-site"] && h["sec-fetch-site"] !== "same-origin") return reply(403, { error: "Forbidden" });

  if (req.path === "/api/gitlab/status" && req.method === "GET") { await current(); return reply(200, publicStatus()); }

  if (req.path === "/api/gitlab/connect" || req.path === "/api/gitlab/disconnect") {
    if (req.method !== "POST") return reply(405, { error: "Method not allowed" });
    if (!String(h["content-type"] || "").startsWith("application/json")) return reply(415, { error: "JSON required" });   // blocks cross-site form posts
    try {
      if (req.path.endsWith("/disconnect")) return reply(200, await disconnect());
      let body; try { body = JSON.parse(req.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
      return reply(200, await connect(body));
    } catch (e) { return reply(e.status || 400, { error: e.message }); }
  }

  if (req.path.startsWith("/gl/api/v4/")) {
    const apiPath = req.path.slice("/gl/api/v4".length);
    const write = req.method !== "GET";
    if (write) {
      if (!ALLOWED_WRITE.some(([m, re]) => m === req.method && re.test(apiPath))) return reply(403, { error: `GitLab change not allowed: ${req.method} ${apiPath}` });
      if (!String(h["content-type"] || "").startsWith("application/json")) return reply(415, { error: "JSON required" });
      if ((req.body || "").length > 200_000) return reply(413, { error: "Too large" });
    } else if (!ALLOWED_GET.some((re) => re.test(apiPath))) return reply(403, { error: "GitLab endpoint not allowed: " + apiPath });
    const c = await current();
    if (!c) return reply(412, { error: "GitLab is not connected" });
    let r;
    try { r = write ? await apiSend(c.cfg.url, c.token, req.method, apiPath + (req.query ? "?" + req.query : ""), req.body || "{}") : await apiGet(c.cfg.url, c.token, apiPath + (req.query ? "?" + req.query : "")); }
    catch (e) { console.warn(`[gitlab] GET ${apiPath} failed: ${e.code || e.message}`); return reply(502, { error: netError(e) }); }
    const headers = {};
    for (const k of PASS_HEADERS) if (r.headers?.[k]) headers[k] = String(r.headers[k]);
    if (r.status === 401) return reply(401, { error: "GitLab rejected the saved token — it expired or was revoked. Replace the token." }, headers);
    if (r.status === 403) return reply(403, { error: `GitLab refused this${gitlabMessage(r.text) ? " (" + gitlabMessage(r.text) + ")" : ""}. ${write ? "You may lack permission in this project, or the token needs the api scope." : "The token needs the read_api scope."}` }, headers);
    if (r.status >= 400) return reply(r.status, { error: `GitLab ${r.status}${gitlabMessage(r.text) ? ": " + gitlabMessage(r.text) : ""}` }, headers);
    if (/\/trace$/.test(apiPath)) return { status: r.status, body: JSON.stringify({ trace: r.text.slice(-400_000) }), headers };   // job logs are plain text
    return reply(r.status, r.text || "null", headers);
  }
  return null;                                     // not a GitLab route
}

/** For the local git layer: the connected GitLab and its token (never sent to the browser). */
async function getCreds() { const c = await current(); return c ? { url: c.cfg.url, username: c.cfg.username, token: c.token } : null; }

module.exports = { handle, getCreds, _transport: transport, _normalizeUrl: normalizeUrl, CONFIG_DIR };
