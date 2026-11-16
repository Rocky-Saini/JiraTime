"use strict";
// Stateless Jira proxy shared by the Netlify function and the local server.
// Credentials arrive per request in headers, are used once, and are never stored or logged.

const ALLOWED = [
  ["GET", /^\/rest\/api\/3\/myself$/],
  ["GET", /^\/rest\/api\/2\/issue\/picker$/],
  ["GET", /^\/rest\/api\/3\/search\/jql$/],
  ["GET", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["POST", /^\/rest\/api\/2\/issue\/\d+\/worklog$/],
  ["DELETE", /^\/rest\/api\/2\/issue\/\d+\/worklog\/\d+$/],
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/issue\/[A-Za-z0-9_-]+\/editmeta$/],
  ["PUT", /^\/rest\/api\/2\/issue\/[A-Za-z0-9_-]+$/],
  ["GET", /^\/rest\/api\/3\/user\/assignable\/search$/],
];
const BASE_RE = /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i;
const MAX_BODY = 100_000;

const reply = (status, body) => ({ status, body: typeof body === "string" ? body : JSON.stringify(body) });

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

  try {
    const r = await fetch(base + req.path + (req.query ? "?" + req.query : ""), {
      method: req.method,
      headers: {
        Authorization: "Basic " + Buffer.from(`${email}:${token}`).toString("base64"),
        Accept: "application/json",
        "X-Atlassian-Token": "no-check",
        ...(req.body ? { "Content-Type": "application/json" } : {}),
      },
      body: req.body || undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(25000),
    });
    return { status: r.status, body: r.status === 204 ? "" : (await r.text()) || "{}" };
  } catch (e) {
    return reply(502, { errorMessages: ["Could not reach Jira: " + (e.name === "TimeoutError" ? "timeout" : "network error")] });
  }
}

module.exports = { proxy };
