"use strict";
// Local dev server: serves ./public and the same stateless Jira proxy used on Netlify.
// (On Netlify the proxy runs as netlify/functions/jira.js; no server is needed.)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { proxy } = require("./lib/jira-proxy");
const gitlab = require("./lib/gitlab");
const localgit = require("./lib/localgit");

const PORT = +process.env.PORT || 9027;
// The helper has no user interface of its own: people always use the JiraTime website.
// Opening the helper's address in a browser sends them there. JIRATIME_UI=1 serves the pages locally (development only).
const SITE = process.env.JIRATIME_SITE || "https://jiratime-by-rocky.netlify.app";
const SERVE_UI = process.env.JIRATIME_UI === "1";
// Installed helper (install.sh sets JIRATIME_AUTOUPDATE=1): pull new versions from GitHub at start and every 30 minutes.
// After an update the process exits and the service manager starts the new version (no running git / Kiro work is cut:
// it waits until none is running).
function autoUpdate() {
  if (process.env.JIRATIME_AUTOUPDATE !== "1" || !fs.existsSync(path.join(__dirname, ".git"))) return;
  const { execFile } = require("child_process");
  const check = () => execFile("git", ["-C", __dirname, "pull", "--ff-only", "-q"], { timeout: 120_000 }, (e) => {
    if (e) return;
    execFile("git", ["-C", __dirname, "rev-parse", "HEAD"], (e2, head) => {
      head = String(head || "").trim(); if (e2 || !head) return;
      if (!autoUpdate.head) { autoUpdate.head = head; return; }
      if (head === autoUpdate.head) return;
      const busy = () => [...require("./lib/kiro").JOBS.values()].some((j) => j.status === "running");
      const restart = () => (busy() ? setTimeout(restart, 30_000) : (console.log("JiraTime helper updated — restarting"), process.exit(0)));
      restart();
    });
  });
  execFile("git", ["-C", __dirname, "rev-parse", "HEAD"], (e, h) => { autoUpdate.head = String(h || "").trim(); check(); });
  setInterval(check, 30 * 60e3).unref();
}
// Websites that may use the GitLab / git part of this local server from the browser (the hosted JiraTime).
// Only these origins get CORS access; every other site is still refused.
const BRIDGE_ORIGINS = (process.env.JIRATIME_ORIGINS || "https://jiratime-by-rocky.netlify.app").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
const EXPOSE = "x-total, x-total-pages, x-next-page, x-page, x-per-page, retry-after, link";
const corsFor = (origin) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Expose-Headers": EXPOSE });
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function readBody(req, max = 100_000) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function send(res, code, body, type = "application/json", extra = {}) {
  if (code === 204) { res.writeHead(204, { ...extra, "Cache-Control": "no-store" }); return res.end(); }
  res.writeHead(code, { ...extra, "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
  res.end(body);
}

http.createServer(async (req, res) => {
  try {
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "")) return send(res, 403, '{"error":"Forbidden host"}');
    const url = new URL(req.url, "http://localhost");

    if (url.pathname.startsWith("/jira/")) {
      const body = ["POST", "PUT"].includes(req.method) ? await readBody(req) : undefined;
      const r = await proxy({ method: req.method, path: url.pathname.slice(5), query: url.search.slice(1), body, headers: req.headers });
      return send(res, r.status, r.body);
    }
    const local = url.pathname.startsWith("/api/git/") || url.pathname.startsWith("/api/gitlab/") || url.pathname.startsWith("/gl/");
    const origin = req.headers.origin, bridge = local && !!origin && BRIDGE_ORIGINS.includes(origin);
    let cors = {};
    if (bridge) {
      cors = corsFor(origin);
      if (req.method === "OPTIONS") return send(res, 204, "", "", { ...cors, "Access-Control-Allow-Methods": "GET, POST, PUT", "Access-Control-Allow-Headers": "Content-Type, Accept",
        "Access-Control-Allow-Private-Network": "true", "Access-Control-Max-Age": "600" });
      req.headers["sec-fetch-site"] = "same-origin";          // trusted hosted JiraTime: treat like this page
    }
    if (url.pathname.startsWith("/api/git/")) {
      const body = req.method === "POST" ? await readBody(req, 15_000_000) : undefined;
      const r = await localgit.handle({ method: req.method, path: url.pathname, query: url.search.slice(1), body, headers: req.headers });
      if (r) return send(res, r.status, r.body, "application/json", { ...r.headers, ...cors });
    }
    if (url.pathname.startsWith("/api/gitlab/") || url.pathname.startsWith("/gl/")) {
      const body = ["POST", "PUT"].includes(req.method) ? await readBody(req, 250_000) : undefined;
      const r = await gitlab.handle({ method: req.method, path: url.pathname, query: url.search.slice(1), body, headers: req.headers });
      if (r) return send(res, r.status, r.body, "application/json", { ...r.headers, ...cors });
    }
    if (!SERVE_UI && req.method === "GET" && !local && !url.pathname.startsWith("/jira/")) { res.writeHead(302, { Location: SITE + "/", "Cache-Control": "no-store" }); return res.end(); }
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(PUBLIC, name);
    if (req.method === "GET" && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      return send(res, 200, fs.readFileSync(file), (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8");
    send(res, 404, '{"error":"Not found"}', "application/json", cors);
  } catch (e) { send(res, 502, JSON.stringify({ errorMessages: ["Server error: " + e.message] })); }
}).listen(PORT, "127.0.0.1", () => { autoUpdate(); console.log(`JiraTime helper ready (port ${PORT})${SERVE_UI ? " — serving the pages too (JIRATIME_UI=1)" : ""}`); });
