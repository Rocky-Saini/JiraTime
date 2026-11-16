"use strict";
// Local dev server: serves ./public and the same stateless Jira proxy used on Netlify.
// (On Netlify the proxy runs as netlify/functions/jira.js; no server is needed.)
const http = require("http");
const fs = require("fs");
const path = require("path");
const { proxy } = require("./lib/jira-proxy");

const PORT = +process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };

function readBody(req, max = 100_000) {
  return new Promise((resolve, reject) => {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > max) { reject(new Error("Body too large")); req.destroy(); } });
    req.on("end", () => resolve(b)); req.on("error", reject);
  });
}
function send(res, code, body, type = "application/json") {
  if (code === 204) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); }
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
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
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(PUBLIC, name);
    if (req.method === "GET" && file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      return send(res, 200, fs.readFileSync(file), (TYPES[path.extname(file)] || "application/octet-stream") + "; charset=utf-8");
    send(res, 404, '{"error":"Not found"}');
  } catch (e) { send(res, 502, JSON.stringify({ errorMessages: ["Server error: " + e.message] })); }
}).listen(PORT, "127.0.0.1", () => console.log(`JiraTime running at http://localhost:${PORT}`));
