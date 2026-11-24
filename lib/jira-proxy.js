"use strict";
// Stateless Jira proxy shared by the Netlify function and the local server.
// Credentials arrive per request in headers, are used once, and are never stored or logged.
//
// Network notes: some office networks take ~8 s per DNS lookup. Node's fetch opens a new connection (and a new
// lookup) for every parallel request, which then hits its 10 s connect timeout. So this proxy uses one keep-alive
// connection pool and caches DNS answers (stale-while-revalidate), so a slow lookup happens at most once per 10 min.

const https = require("https");
const dns = require("dns");

const ALLOWED = [
  ["GET", /^\/rest\/api\/3\/myself$/],
  ["GET", /^\/rest\/api\/2\/issue\/picker$/],
  ["GET", /^\/rest\/api\/3\/search\/jql$/],
  ["GET", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["POST", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["DELETE", /^\/rest\/api\/2\/issue\/\d+\/worklog\/\d+$/],
  ["PUT", /^\/rest\/api\/2\/issue\/\d+\/worklog\/\d+$/],
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+\/editmeta$/],
  ["PUT", /^\/rest\/api\/2\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/user\/assignable\/search$/],
  ["GET", /^\/rest\/api\/3\/field$/],
];
const BASE_RE = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i;
const MAX_BODY = 100_000;
const MAX_RESPONSE = 20 * 1024 * 1024;
const TIMEOUT_MS = 25_000;

const reply = (status, body) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });

// ---------- DNS cache ----------
const DNS_TTL = 10 * 60_000;
const dnsCache = new Map();          // host -> { at, addrs, inflight }
function resolveHost(host) {
  const hit = dnsCache.get(host), fresh = hit?.addrs && Date.now() - hit.at < DNS_TTL;
  if (fresh) return Promise.resolve(hit.addrs);
  if (!hit?.inflight) {
    const t0 = Date.now();
    const inflight = dns.promises.lookup(host, { all: true }).then(
      (addrs) => {
        const ms = Date.now() - t0;
        if (ms > 2000) console.warn(`[jira-proxy] DNS lookup for ${host} took ${(ms / 1000).toFixed(1)} s (slow DNS on this network) — cached for 10 min`);
        dnsCache.set(host, { at: Date.now(), addrs });
        return addrs;
      },
      (err) => {
        if (hit?.addrs) { dnsCache.set(host, { at: hit.at, addrs: hit.addrs }); return hit.addrs; }   // keep using the old answer
        dnsCache.delete(host); throw err;
      });
    dnsCache.set(host, { ...(hit || {}), inflight });
    if (!hit?.addrs) return inflight;      // first lookup: everyone waits for this one lookup
  }
  return hit?.addrs ? Promise.resolve(hit.addrs) : dnsCache.get(host).inflight;   // expired: answer at once, refresh behind
}
function cachedLookup(hostname, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  const opts = typeof options === "number" ? { family: options } : options || {};
  resolveHost(hostname).then((addrs) => {
    const list = opts.family === 4 || opts.family === 6 ? addrs.filter((a) => a.family === opts.family) : addrs;
    if (!list.length) { const e = new Error(`getaddrinfo ENOTFOUND ${hostname}`); e.code = "ENOTFOUND"; return cb(e); }
    if (opts.all) cb(null, list); else cb(null, list[0].address, list[0].family);
  }, (err) => cb(err));
}

// ---------- keep-alive HTTPS transport ----------
const AGENT = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 8, maxFreeSockets: 8, timeout: 60_000, lookup: cachedLookup });
function httpsSend(url, { method, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, agent: AGENT, lookup: cachedLookup, servername: u.hostname,
      headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on("data", (c) => { size += c.length; if (size > MAX_RESPONSE) req.destroy(Object.assign(new Error("Jira response too large"), { code: "ETOOBIG" })); else chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(Object.assign(new Error("Jira did not answer in time"), { code: "EPROXYTIMEOUT" })));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const transport = { send: httpsSend };       // tests replace transport.send

const FRIENDLY = {
  ENOTFOUND: "DNS lookup failed — check your internet / VPN",
  EAI_AGAIN: "DNS lookup failed — check your internet / VPN",
  ETIMEDOUT: "connection timed out",
  ECONNREFUSED: "connection refused",
  ECONNRESET: "connection was reset",
  EPIPE: "connection was reset",
  EPROXYTIMEOUT: "Jira did not answer in 25 s",
  ETOOBIG: "Jira response too large",
};
const RETRYABLE = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "UND_ERR_SOCKET"]);

/**
 * @param {{method:string, path:string, query?:string, body?:string, headers:Record<string,string>}} req  (header names lower-case)
 */
async function proxy(req) {
  const h = req.headers || {};
  // Only our own pages may use this proxy (blocks other websites from calling it from a user's browser).
  const site = h["sec-fetch-site"];
  if (site && site !== "same-origin") return reply(403, { error: "Forbidden" });

  if (!ALLOWED.some(([m, re]) => m === req.method && re.test(req.path))) return reply(403, { error: "Endpoint not allowed" });

  const base = String(h["x-jira-base"] || "").trim().replace(/\/+$/, "");
  const email = String(h["x-jira-email"] || "").trim();
  const token = String(h["x-jira-token"] || "").trim();
  if (!base || !email || !token) return reply(412, { errorMessages: ["Jira not configured"] });
  if (!BASE_RE.test(base)) return reply(400, { error: "Jira site must look like https://name.atlassian.net" });
  if (email.length > 200 || token.length > 2000) return reply(400, { error: "Invalid credentials" });
  if (req.body && req.body.length > MAX_BODY) return reply(413, { error: "Body too large" });

  const url = base + req.path + (req.query ? "?" + req.query : "");
  const opts = {
    method: req.method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
      Accept: "application/json",
      "X-Atlassian-Token": "no-check",
      ...(req.body ? { "Content-Type": "application/json" } : {}),
    },
    body: req.body || undefined,
  };
  const t0 = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await transport.send(url, opts);
      return { status: r.status, body: r.status === 204 ? "" : r.text || "{}" };
    } catch (e) {
      const code = e.code || e.cause?.code || e.name || "ERROR";
      // a reused keep-alive socket can be closed by the other side: safe to retry once, but only for reads
      if (req.method === "GET" && attempt === 1 && RETRYABLE.has(code)) { await new Promise((r) => setTimeout(r, 300)); continue; }
      console.warn(`[jira-proxy] ${req.method} ${req.path} failed after ${Date.now() - t0} ms: ${code}`);
      return reply(502, { errorMessages: [`Could not reach Jira (${code}${FRIENDLY[code] ? ": " + FRIENDLY[code] : ""})`] });
    }
  }
}

module.exports = { proxy, _transport: transport, _resolveHost: resolveHost, _lookup: cachedLookup };
