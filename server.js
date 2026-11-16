"use strict";
// JiraTime local server: serves the web UI and proxies a small allow-list of Jira REST calls.
// Credentials live only in .env on this machine and are never sent to the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = +process.env.PORT || 3000;
const ENV_FILE = path.join(__dirname, ".env");
const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.css": "app.css", "/app.js": "app.js", "/nw.js": "nw.js", "/fields.js": "fields.js" };
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

// Only these Jira calls can be made through the proxy.
const ALLOWED = [
  ["GET", /^\/rest\/api\/3\/myself$/],
  ["GET", /^\/rest\/api\/2\/issue\/picker$/],
  ["GET", /^\/rest\/api\/3\/search\/jql$/],
  ["GET", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["POST", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["DELETE", /^\/rest\/api\/2\/issue\/\d+\/worklog\/\d+$/],
  // issue fields editor
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+\/editmeta$/],
  ["PUT", /^\/rest\/api\/2\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/user\/assignable\/search$/],
];

let cfg = loadEnv();

function loadEnv() {
  const o = {};
  try {
    for (const l of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m) o[m[1]] = m[2];
    }
  } catch { /* no .env yet */ }
  return { base: o.JIRA_BASE, email: o.JIRA_EMAIL, token: o.JIRA_API_TOKEN };
}
const configured = () => !!(cfg.base && cfg.email && cfg.token);
const authHeader = () => "Basic " + Buffer.from(`${cfg.email}:${cfg.token}`).toString("base64");

function send(res, code, body, type = "application/json") {
  if (code === 204) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); }
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, max = 100_000) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}

async function callJira(base, auth, method, pathAndQuery, body) {
  const r = await fetch(base + pathAndQuery, {
    method,
    headers: { Authorization: auth, Accept: "application/json", "X-Atlassian-Token": "no-check", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body || undefined,
  });
  return { status: r.status, text: await r.text() };
}

const server = http.createServer(async (req, res) => {
  try {
    // Block other websites / DNS-rebinding from using this local server.
    const host = req.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, { error: "Forbidden host" });
    if (req.method !== "GET" && req.headers.origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) return send(res, 403, { error: "Forbidden origin" });

    const url = new URL(req.url, "http://localhost");

    if (req.method === "GET" && url.pathname === "/nw-agent.js") {
      const code = fs.readFileSync(path.join(__dirname, "nw-agent.js"), "utf8").replace(/__APP_ORIGIN__/g, "http://" + host);
      return send(res, 200, code, "text/javascript; charset=utf-8");
    }

    if (req.method === "GET" && STATIC[url.pathname]) {
      const f = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(__dirname, f)), TYPES[path.extname(f)] + "; charset=utf-8");
    }

    if (url.pathname === "/api/status" && req.method === "GET") return send(res, 200, { configured: configured(), base: cfg.base || null, email: cfg.email || null });

    if (url.pathname === "/api/setup" && req.method === "POST") {
      const { base, email, token } = JSON.parse(await readBody(req));
      const b = String(base || "").trim().replace(/\/+$/, "");
      if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(b)) return send(res, 400, { error: "Site URL must look like https://name.atlassian.net" });
      if (!email || !token) return send(res, 400, { error: "Email and API token are required" });
      const auth = "Basic " + Buffer.from(`${String(email).trim()}:${String(token).trim()}`).toString("base64");
      const t = await callJira(b, auth, "GET", "/rest/api/3/myself");
      if (t.status !== 200) return send(res, 401, { error: `Jira rejected these credentials (HTTP ${t.status})` });
      fs.writeFileSync(ENV_FILE, `JIRA_BASE=${b}\nJIRA_EMAIL=${String(email).trim()}\nJIRA_API_TOKEN=${String(token).trim()}\n`, { mode: 0o600 });
      cfg = loadEnv();
      return send(res, 200, { ok: true });
    }

    if (url.pathname === "/api/logout" && req.method === "POST") {
      try { fs.unlinkSync(ENV_FILE); } catch { /* ignore */ }
      cfg = loadEnv();
      return send(res, 200, { ok: true });
    }

    if (url.pathname.startsWith("/jira/")) {
      const jpath = url.pathname.slice(5);
      if (!ALLOWED.some(([m, re]) => m === req.method && re.test(jpath))) return send(res, 403, { error: "Endpoint not allowed" });
      if (!configured()) return send(res, 412, { errorMessages: ["Jira not configured"] });
      const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : undefined;
      const r = await callJira(cfg.base, authHeader(), req.method, jpath + url.search, body);
      return send(res, r.status, r.text || "{}");
    }

    send(res, 404, { error: "Not found" });
  } catch (e) {
    send(res, 502, { errorMessages: ["Server error: " + e.message] });
  }
});

server.listen(PORT, "127.0.0.1", () => console.log(`JiraTime running at http://localhost:${PORT}`));
