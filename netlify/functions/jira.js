"use strict";
const { proxy } = require("../../lib/jira-proxy");

exports.handler = async (event) => {
  const i = event.path.indexOf("/rest/");
  const path = i >= 0 ? event.path.slice(i) : event.path;
  const query = event.rawQuery || (event.rawUrl && event.rawUrl.includes("?") ? event.rawUrl.split("?")[1] : "");
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body || undefined;
  const r = await proxy({ method: event.httpMethod, path, query, body, headers });
  return { statusCode: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: r.body };
};
