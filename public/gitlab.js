"use strict";
/* GitLab workspace: connect, overview dashboard, project explorer and the shared API helpers.
   Two ways to reach GitLab:
   - local app (node server.js on localhost): /api/gitlab/* + /gl/api/v4/*; the token stays in the server (keyring / 0600 file).
   - hosted website (Netlify): the browser calls the GitLab API directly (GitLab allows CORS); the token is kept in this
     browser's localStorage, like the Jira token. Local git (clone into a folder, commit, conflicts) then needs the laptop server.
   Uses globals from app.js ($, esc, toast, openModal, closeModal, JT, pool, sleep, agoText, ymdOf, addDays). */

const GL = {
  st: null, tab: "overview", tokenBad: "",
  projects: null, projAt: 0, events: null, evAt: 0, counts: null, cntAt: 0, det: {}, pins: [], opened: {},
  busy: {}, err: {}, f: { q: "", group: "", vis: "", sort: "worked", fav: false, active: false, limit: 100 },
  abort: null, view: null,
};
const GL_PIPE = { success: "good", failed: "low", running: "high", pending: "noest", created: "noest", preparing: "noest", waiting_for_resource: "noest",
  canceled: "noest", skipped: "noest", manual: "over", scheduled: "noest" };
const enc = encodeURIComponent;
/** "" when this page comes from the local JiraTime server; "http://localhost:3000" when it is the hosted website
    talking to the JiraTime server running on this laptop. */
let GL_BASE = "";
const GL_LOCAL_URLS = [localStorage.getItem("jiratime.gl.localUrl") || "http://localhost:3000", "http://127.0.0.1:3000"].filter((v, i, a) => a.indexOf(v) === i);
const glHosted = () => !["localhost", "127.0.0.1"].includes(location.hostname);
/** Direct mode = hosted website talking to GitLab from the browser. "laptop" mode uses the JiraTime server on this laptop. */
const glDirect = () => glHosted() && localStorage.getItem("jiratime.gl.mode") !== "laptop";
const glCreds = {
  get() { try { return JSON.parse(localStorage.getItem("jiratime.gl.direct") || "null"); } catch { return null; } },
  set(c) { localStorage.setItem("jiratime.gl.direct", JSON.stringify(c)); },
  clear() { localStorage.removeItem("jiratime.gl.direct"); },
};
const GL_NET_HINT = "Could not reach GitLab from this browser — is the VPN on? If Chrome asked to allow access to devices on your local network, choose Allow (site settings → Local network access).";
/** One request straight to GitLab with the user's token (direct mode). Returns the fetch Response. */
const GL_WAIT_HINT = "No answer from GitLab in 25 seconds. Chrome is most likely waiting for your permission: look for a popup or an icon at the left of the address bar (“Local network access” / “devices on your local network”), choose Allow, then try again. Also check that the VPN is on.";
/** Chrome's "local network access" permission for this site: "granted" | "denied" | "prompt" | "" (unknown). */
async function glLnaState() {
  for (const name of ["local-network-access", "local-network"]) { try { return (await navigator.permissions.query({ name })).state; } catch { /* name not known in this browser */ } }
  return "";
}
async function glDirectFetch(base, token, path, { signal, method = "GET", body, timeout = 25000 } = {}) {
  const write = method !== "GET", ctl = new AbortController(); let timedOut = false;
  const t = setTimeout(() => { timedOut = true; ctl.abort(); }, timeout);
  signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    return await fetch(base + "/api/v4" + path, { signal: ctl.signal, method, cache: "no-store", targetAddressSpace: "local", headers: { Accept: "application/json", "PRIVATE-TOKEN": token, ...(write ? { "Content-Type": "application/json" } : {}) }, body: write ? JSON.stringify(body || {}) : undefined });
  } catch (e) {
    if (timedOut) throw new GlError(GL_WAIT_HINT, 0);
    if (e.name === "AbortError") throw e;
    throw new GlError((await glLnaState()) === "denied" ? "Chrome is blocking this site from your local network, so it cannot reach GitLab. Click the icon at the left of the address bar → Site settings → Local network access → Allow, then reload." : GL_NET_HINT, 0);
  } finally { clearTimeout(t); }
}
function glDirectError(r, data, write) {
  const m = data?.message ? (typeof data.message === "string" ? data.message : JSON.stringify(data.message)) : data?.error_description || data?.error || "";
  if (r.status === 401) return "GitLab rejected the saved token — it expired or was revoked. Replace the token.";
  if (r.status === 403) return `GitLab refused this${m ? " (" + m + ")" : ""}. ${write ? "You may lack permission in this project, or the token needs the api scope." : "The token needs the read_api scope."}`;
  return `GitLab ${r.status}${m ? ": " + m : ""}`;
}
function glNormUrl(input) {
  let raw = String(input || "").trim(); if (raw && !/^[a-z]+:\/\//i.test(raw)) raw = "https://" + raw;
  let u; try { u = new URL(raw); } catch { throw new Error("GitLab URL is not valid (e.g. https://gitlab.company.com)"); }
  if (u.protocol !== "https:") throw new Error("GitLab URL must start with https://");
  return u.origin;
}
/** Direct mode connect: check the token with GitLab, then keep it in this browser. */
async function glDirectConnect({ url, username, token }) {
  url = glNormUrl(url); username = String(username || "").trim().replace(/^@/, ""); token = String(token || "").trim();
  if (!/^[\x21-\x7e]{10,500}$/.test(token)) throw new Error("Personal Access Token looks wrong (no spaces, at least 10 characters)");
  const r = await glDirectFetch(url, token, "/user");
  if (r.status === 401) throw new Error("GitLab rejected the token — it is wrong, expired or revoked");
  if (r.status === 403) throw new Error("The token is valid but lacks permission. Give it the read_api scope (api for merge requests).");
  if (!r.ok) throw new Error(`GitLab answered ${r.status} — check the URL`);
  let user; try { user = await r.json(); } catch { throw new Error("This URL did not return GitLab data — check the address"); }
  if (!user?.username) throw new Error("This URL did not return a GitLab user — check the address");
  if (![user.username, user.email, user.public_email].filter(Boolean).some((x) => x.toLowerCase() === username.toLowerCase())) throw new Error(`This token belongs to @${user.username}, not "${username}"`);
  let scopes = null, expiresAt = null;
  try { const s = await glDirectFetch(url, token, "/personal_access_tokens/self"); if (s.ok) { const j = await s.json(); scopes = j.scopes || null; expiresAt = j.expires_at || null; } } catch { /* optional */ }
  const c = { url, username: user.username, token, user: { id: user.id, username: user.username, name: user.name, email: user.email || user.public_email || "" }, scopes, expiresAt, connectedAt: new Date().toISOString() };
  glCreds.set(c);
  return glDirectStatus();
}
function glDirectStatus() {
  const c = glCreds.get();
  if (!c) return { available: true, direct: true, api: GL_SERVER_API, connected: false };
  const { token, ...pub } = c; void token;
  return { available: true, direct: true, api: GL_SERVER_API, connected: true, store: "browser", ...pub };
}

class GlError extends Error { constructor(m, s) { super(m); this.status = s; } }
const glNs = () => (GL.st?.connected ? `${GL.st.url}|${GL.st.username}`.toLowerCase() : "");
const glCache = {
  get(n) { try { const v = JSON.parse(localStorage.getItem("jiratime.gl." + n) || "null"); return v && v.ns === glNs() ? v : null; } catch { return null; } },
  set(n, data) { if (!glNs()) return; try { localStorage.setItem("jiratime.gl." + n, JSON.stringify({ ns: glNs(), at: Date.now(), data })); } catch { /* storage full: optional */ } },
  clear() {   // only the cached GitLab data (entries written by set()), never the login, mode or settings
    Object.keys(localStorage).filter((k) => k.startsWith("jiratime.gl.")).forEach((k) => { try { const v = JSON.parse(localStorage.getItem(k)); if (v && typeof v === "object" && "ns" in v && "data" in v) localStorage.removeItem(k); } catch { /* not cache */ } });
  },
};
/** Only links that point into the connected GitLab are rendered as links. */
const glUrl = (u) => (typeof u === "string" && GL.st?.url && (u === GL.st.url || u.startsWith(GL.st.url + "/")) ? u : "");
const glLink = (u, text, cls = "") => (glUrl(u) ? `<a class="${cls}" href="${esc(glUrl(u))}" target="_blank" rel="noopener noreferrer">${text}</a>` : text);
const ago = (iso) => (iso ? agoText(Date.parse(iso)) : "—");
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const initials = (n) => String(n || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();

// ================= API =================
async function glApi(path, { signal, method = "GET", body } = {}) {
  const write = method !== "GET";
  if (glDirect()) {
    const c = glCreds.get(); if (!c) throw new GlError("GitLab is not connected", 412);
    for (let attempt = 1; ; attempt++) {
      const r = await glDirectFetch(c.url, c.token, path, { signal, method, body });
      if (r.status === 429 && attempt <= 2) { await sleep(Math.min(30, +r.headers.get("retry-after") || 3) * 1000); continue; }
      if (!write && [502, 503, 504].includes(r.status) && attempt <= 2) { await sleep(attempt * 1200); continue; }
      const trace = /\/trace$/.test(path.split("?")[0]);
      let data = null;
      if (trace && r.ok) data = { trace: (await r.text()).slice(-400_000) }; else { try { data = await r.json(); } catch { /* empty */ } }
      if (!r.ok) { const msg = glDirectError(r, data, write); if (r.status === 401) { GL.tokenBad = msg; glHead(); glPill(); } throw new GlError(msg, r.status); }
      const total = r.headers.get("x-total");
      return { data, total: total != null && total !== "" ? +total : null, next: r.headers.get("x-next-page") || "" };
    }
  }
  for (let attempt = 1; ; attempt++) {
    let r;
    try { r = await fetch(GL_BASE + "/gl/api/v4" + path, { signal, method, headers: { Accept: "application/json", ...(write ? { "Content-Type": "application/json" } : {}) }, body: write ? JSON.stringify(body || {}) : undefined }); }
    catch (e) { if (e.name === "AbortError") throw e; throw new GlError("The local JiraTime server is not reachable — is node server.js running?", 0); }
    if (r.status === 429 && attempt <= 2) { await sleep(Math.min(30, +r.headers.get("retry-after") || 3) * 1000); continue; }   // GitLab rate limit
    if (!write && [502, 503, 504].includes(r.status) && attempt <= 2) { await sleep(attempt * 1200); continue; }               // never repeat a change
    let data = null; try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      let msg = data?.error || `GitLab ${r.status}`;
      if (/endpoint not allowed|change not allowed/.test(msg) && GL.st?.api !== GL_SERVER_API) msg += " — the JiraTime server on this laptop is an old version: stop it (Ctrl+C) and start node server.js again";
      if (r.status === 401 || r.status === 412) { GL.tokenBad = msg; glHead(); glPill(); }
      throw new GlError(msg, r.status);
    }
    const total = r.headers.get("x-total");
    return { data, total: total != null && total !== "" ? +total : null, next: r.headers.get("x-next-page") || "" };
  }
}
/** All pages (100 per page), at most maxPages. */
async function glAll(path, maxPages = 10, signal) {
  const out = []; let page = 1, more = false; const sep = path.includes("?") ? "&" : "?";
  while (page) {
    if (page > maxPages) { more = true; break; }
    const r = await glApi(`${path}${sep}per_page=100&page=${page}`, { signal });
    out.push(...(r.data || [])); page = r.next ? +r.next : 0;
  }
  out.truncated = more;
  return out;
}
/** Local git layer (/api/git/*). */
/** Website mode: base URL of the JiraTime helper on this laptop (git runs there), or "" when not found. */
let GL_GIT = "";
const GL_INSTALL = "curl -fsSL https://jiratime-by-rocky.netlify.app/install.sh | bash";
/** Look for the laptop helper and give it the same GitLab login as this browser (it needs it for clone / push). */
async function glHelperConnect() {
  GL_GIT = ""; GL.helper = { found: false };
  let st = null;
  for (const base of GL_LOCAL_URLS) { st = await glStatusAt(base); if (st) { GL_GIT = base; break; } }
  if (!st) return GL.helper;
  GL.helper = { found: true, old: st.api !== GL_SERVER_API };
  if (GL.helper.old) { GL_GIT = ""; return GL.helper; }
  const c = glCreds.get();
  if (c && (!st.connected || st.url !== c.url || String(st.username).toLowerCase() !== c.username.toLowerCase())) {
    const r = await fetch(GL_GIT + "/api/gitlab/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: c.url, username: c.username, token: c.token }) }).catch(() => null);
    if (!r || !r.ok) { GL.helper.err = (await r?.json().catch(() => ({})))?.error || "could not pass the GitLab login to the helper"; }
  }
  localStorage.setItem("jiratime.gl.helper", "1");
  return GL.helper;
}
async function gitApi(p, body, { method } = {}) {
  if (glDirect() && !GL_GIT) throw new GlError("Local git needs the JiraTime helper on this laptop — set it up once in GitLab → Local repos.", 0);
  let r;
  try { r = await fetch((glDirect() ? GL_GIT : GL_BASE) + "/api/git" + p, body !== undefined || method === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) } : {}); }
  catch { throw new GlError("The local JiraTime server is not reachable — is node server.js running?", 0); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new GlError(r.status === 404 && (!j.error || j.error === "Not found") ? "The JiraTime server on this laptop is an old version — stop it (Ctrl+C) and start node server.js again" : j.error || `Failed (${r.status})`, r.status);
  return j;
}
async function glStatusAt(base) {
  try {
    const r = await fetch(base + "/api/gitlab/status", { headers: { Accept: "application/json" }, cache: "no-store" });
    if (!r.ok || !String(r.headers.get("content-type") || "").includes("json")) return null;
    const j = await r.json(); return j && j.available ? j : null;
  } catch { return null; }
}
/** Same server first; on the hosted website, the JiraTime server on this laptop. */
async function glStatus() {
  if (glDirect()) { GL_BASE = ""; if (localStorage.getItem("jiratime.gl.helper") === "1" && !GL_GIT) glHelperConnect().then(() => { if (GL_GIT && GL.st?.connected) { window.GLL?.load(true).catch(() => {}); if (GL.tab === "local") glRender(); } }).catch(() => {}); return glDirectStatus(); }
  if (!glHosted()) { GL_BASE = ""; return (await glStatusAt("")) || { available: false }; }
  for (const base of GL_LOCAL_URLS) { const j = await glStatusAt(base); if (j) { GL_BASE = base; return { ...j, bridged: true }; } }
  GL_BASE = ""; return { available: false, hosted: true };
}

// ================= data =================
const slimProject = (p) => ({
  id: p.id, name: p.name, path: p.path_with_namespace, ns: p.namespace?.full_path || p.path_with_namespace.split("/").slice(0, -1).join("/"),
  desc: p.description || "", branch: p.default_branch || "", vis: p.visibility || "", web: p.web_url, http: p.http_url_to_repo, ssh: p.ssh_url_to_repo,
  last: p.last_activity_at, created: p.created_at, stars: p.star_count || 0, forks: p.forks_count || 0, topics: p.topics || p.tag_list || [], empty: !!p.empty_repo,
});

function glLoadProjects(force) {
  if (GL.busy.proj) return GL.busy.proj;
  const c = glCache.get("projects");
  if (!GL.projects && c) { GL.projects = c.data; GL.projAt = c.at; }
  if (!force && GL.projects && Date.now() - GL.projAt < 10 * 60e3) return Promise.resolve(GL.projects);
  GL.busy.proj = (async () => {
    try {
      const list = await glAll("/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&simple=false&statistics=false", 20);
      GL.projects = list.map(slimProject); GL.projects.truncated = list.truncated; GL.projAt = Date.now();
      glCache.set("projects", GL.projects); delete GL.err.proj;
    } catch (e) { GL.err.proj = e.message; if (!GL.projects) throw e; }
    finally { GL.busy.proj = null; }
    return GL.projects;
  })();
  return GL.busy.proj;
}

/** My own events (push, MR, comments…) of the last 90 days. */
function glLoadEvents(force) {
  if (GL.busy.ev) return GL.busy.ev;
  const c = glCache.get("events");
  if (!GL.events && c) { GL.events = c.data; GL.evAt = c.at; }
  if (!force && GL.events && Date.now() - GL.evAt < 10 * 60e3) return Promise.resolve(GL.events);
  GL.busy.ev = (async () => {
    try {
      const after = ymdOf(addDays(new Date(), -91));
      const list = await glAll(`/events?after=${after}&sort=desc`, 5);
      GL.events = list.map((e) => ({ pid: e.project_id, act: e.action_name || "", at: e.created_at, type: e.target_type || "", title: e.push_data?.commit_title || e.target_title || "",
        ref: e.push_data?.ref || "", n: e.push_data?.commit_count || 0, push: !!e.push_data }));
      GL.evAt = Date.now(); glCache.set("events", GL.events); delete GL.err.ev;
    } catch (e) { GL.err.ev = e.message; if (!GL.events) GL.events = []; }
    finally { GL.busy.ev = null; }
    return GL.events;
  })();
  return GL.busy.ev;
}

function glLoadCounts(force) {
  if (GL.busy.cnt) return GL.busy.cnt;
  if (!force && GL.counts && Date.now() - GL.cntAt < 5 * 60e3) return Promise.resolve(GL.counts);
  const me = enc(GL.st.username);
  const count = (p) => glApi(p + "&per_page=1").then((r) => (r.total ?? (r.data || []).length)).catch((e) => ({ err: e.message }));
  GL.busy.cnt = Promise.all([
    count("/merge_requests?scope=created_by_me&state=opened"),
    count("/merge_requests?scope=assigned_to_me&state=opened"),
    count(`/merge_requests?scope=all&reviewer_username=${me}&state=opened`),
    count("/issues?scope=assigned_to_me&state=opened"),
  ]).then(([created, assigned, review, issues]) => { GL.counts = { created, assigned, review, issues }; GL.cntAt = Date.now(); return GL.counts; })
    .finally(() => { GL.busy.cnt = null; });
  return GL.busy.cnt;
}

/** Per project: my latest push / activity in the events. */
function glWork() {
  const m = new Map();
  for (const e of GL.events || []) {
    const w = m.get(e.pid) || { lastAny: "", lastPush: "", pushes: 0, commits: 0, commits7: 0, pushes7: 0 };
    if (!w.lastAny || e.at > w.lastAny) w.lastAny = e.at;
    if (e.push) { w.pushes++; w.commits += e.n; if (!w.lastPush || e.at > w.lastPush) w.lastPush = e.at; if (Date.now() - Date.parse(e.at) < 7 * 864e5) { w.commits7 += e.n; w.pushes7++; } }
    m.set(e.pid, w);
  }
  return m;
}
/** Most recent of: opened in JiraTime, my push, any of my GitLab activity. */
const glPersonal = (p, w) => Math.max(GL.opened[p.id] || 0, w?.lastPush ? Date.parse(w.lastPush) : 0, w?.lastAny ? Date.parse(w.lastAny) : 0);
function glRanked() {
  const w = glWork();
  return (GL.projects || []).map((p) => ({ p, w: w.get(p.id), score: glPersonal(p, w.get(p.id)) }))
    .sort((a, b) => b.score - a.score || Date.parse(b.p.last || 0) - Date.parse(a.p.last || 0));
}

/** Last commit on the default branch, open MR count, latest pipeline (cached 5 min). */
async function glProjDetail(p) {
  const c = GL.det[p.id];
  if (c && (c.p || Date.now() - c.at < 5 * 60e3)) return c.p || c;
  const job = (async () => {
    const [commit, mrs, pipe] = await Promise.all([
      p.branch && !p.empty ? glApi(`/projects/${p.id}/repository/commits?ref_name=${enc(p.branch)}&per_page=3`).then((r) => r.data || []).catch(() => []) : [],
      glApi(`/projects/${p.id}/merge_requests?state=opened&per_page=1`).then((r) => r.total ?? (r.data || []).length).catch(() => null),
      glApi(`/projects/${p.id}/pipelines?per_page=1${p.branch ? `&ref=${enc(p.branch)}` : ""}`).then((r) => r.data?.[0] || null).catch(() => null)
        .then((x) => x || (p.branch ? glApi(`/projects/${p.id}/pipelines?per_page=1`).then((r) => r.data?.[0] || null).catch(() => null) : null)),
    ]);
    const slimC = (c) => ({ sha: c.short_id, title: c.title, msg: c.message || c.title, author: c.author_name, at: c.committed_date || c.created_at, web: c.web_url, merge: (c.parent_ids || []).length > 1 });
    GL.det[p.id] = { at: Date.now(), mrs, commits: commit.map(slimC),
      commit: commit[0] ? slimC(commit[0]) : null,
      pipe: pipe && { status: pipe.status, at: pipe.updated_at || pipe.created_at, web: pipe.web_url, ref: pipe.ref, onDefault: pipe.ref === p.branch } };
    return GL.det[p.id];
  })();
  GL.det[p.id] = { ...(c || {}), p: job };
  return job;
}

const GL_SERVER_API = 2;   // must match API_VERSION in lib/gitlab.js
/** What this token allows, in plain words. Merging also depends on your role in each project. */
function glAccessLine(s) {
  if (!s.scopes) return "";
  const has = (x) => s.scopes.includes(x), api = has("api");
  const item = (ok, label, why) => `<span class="gl-acc ${ok ? "ok" : "no"}" title="${esc(why)}">${ok ? "✓" : "✕"} ${label}</span>`;
  return `<div class="gl-access tiny"><span class="muted">This token can:</span>
    ${item(api || has("read_api"), "read projects", "read_api or api scope")}
    ${item(api || has("read_repository") || has("write_repository"), "clone / pull", "read_repository or write_repository scope")}
    ${item(has("write_repository"), "push", "write_repository scope")}
    ${item(api, "create / comment / approve MRs", "api scope")}
    ${item(api, "retry pipelines", "api scope")}
    <span class="gl-acc maybe" title="GitLab decides per project: Maintainer / Owner, or allowed on the protected branch">? merge — depends on your role in the project (shown on each merge request)</span></div>`;
}
const GL_ROLE = { 10: "Guest", 20: "Reporter", 30: "Developer", 40: "Maintainer", 50: "Owner" };
/** Your role in a project (cached), from /projects/:id permissions. */
async function glRole(pid) {
  GL.roles ||= {};
  if (GL.roles[pid] !== undefined) return GL.roles[pid];
  try { const pr = (await glApi(`/projects/${pid}`)).data?.permissions || {}; GL.roles[pid] = Math.max(pr.project_access?.access_level || 0, pr.group_access?.access_level || 0) || null; }
  catch { GL.roles[pid] = null; }
  return GL.roles[pid];
}
/** Hover box with the latest commits of a project card. */
function glCommitPop(list, p) {
  if (!list?.length) return "";
  return `<div class="glc-pop"><div class="glc-pop-h">Latest ${list.length} commit${list.length === 1 ? "" : "s"} on ⎇ ${esc(p.branch)}</div>${list.map((c) => `<div class="glc-pc">
    <div><code class="sha">${esc(c.sha)}</code> ${c.merge ? '<span class="b skip">merge</span> ' : ""}<b>${esc(c.title)}</b></div>
    ${c.msg.trim() !== c.title.trim() ? `<div class="glc-pm">${esc(c.msg.split("\n").slice(1).join("\n").trim().slice(0, 400))}</div>` : ""}
    <div class="muted">${esc(c.author)} · ${esc(ago(c.at))}</div></div>`).join("")}</div>`;
}

// ================= top bar pill =================
function glPill() {
  const el = $("#glPill"); if (!el) return;
  const s = GL.st;
  if (!s || !s.available) { el.classList.add("hidden"); return; }
  const bad = !s.connected || !!GL.tokenBad || s.api !== GL_SERVER_API;
  el.className = "pill gl-pill " + (bad ? "bad" : "ok");
  el.innerHTML = bad ? `🦊 GitLab ${s.connected && s.api !== GL_SERVER_API ? "restart server" : s.connected ? "token problem" : "not connected"}` : `🦊 GitLab connected <span class="gl-pill-u">@${esc(s.username)}</span>`;
  el.title = bad ? "Open the GitLab workspace" : `${s.url} — open the GitLab workspace`;
}

// ================= rendering =================
function glMain() { return $("#glMain"); }

function glRender() {
  const box = glMain(); if (!box) return;
  if (!GL.st) { box.innerHTML = '<p class="muted">Checking GitLab connection…</p>'; return; }
  if (!GL.st.available) { box.innerHTML = glLocalOnly(); return; }
  if (!GL.st.connected || GL.view === "connect") { box.innerHTML = glConnectForm(); glWireConnect(); return; }
  const tabs = GL_TABS.filter((t) => !t.hidden || GL.tab === t.id);
  if (!tabs.some((t) => t.id === GL.tab)) GL.tab = "overview";
  box.innerHTML = `<div id="glHead"></div>
    <div class="gl-sub gl-main-tabs">${tabs.map((t) => `<button class="gl-tab ${GL.tab === t.id ? "on" : ""}" data-gltab="${t.id}"><span class="gl-ti">${t.icon}</span>${t.label}${t.count ? `<span class="gl-tc">${t.count()}</span>` : ""}</button>`).join("")}
      <button class="gl-kbd ghost small" data-glact="palette" title="Search projects, repositories and actions">⌕ Search <kbd>Ctrl</kbd><kbd>K</kbd></button></div>
    <div id="glBody" class="gl-body"></div>`;
  glHead();
  (tabs.find((t) => t.id === GL.tab)?.render || glRenderOverview)();
}
/** Main GitLab tabs. Other files (gl-local.js, gl-mr.js, gl-release.js) add theirs with glAddTab(). */
const GL_TABS = [
  { id: "overview", icon: "◎", label: "Overview", render: () => glRenderOverview() },
  { id: "projects", icon: "▤", label: "Projects", render: () => glRenderProjects(), count: () => (GL.projects ? `${GL.projects.length}${GL.projects.truncated ? "+" : ""}` : "") },
];
function glAddTab(tab, after) { const i = after ? GL_TABS.findIndex((t) => t.id === after) : -1; GL_TABS.splice(i >= 0 ? i + 1 : GL_TABS.length, 0, tab); }
function glGo(tab, opts = {}) { GL.tab = tab; Object.assign(GL, opts); if (document.querySelector(".nav.active")?.dataset.view !== "gitlab") document.querySelector('.nav[data-view="gitlab"]').click(); else glRender(); }

function glLocalOnly() {
  return `<div class="card narrow-wide gl-bridge"><h3>🦊 Start JiraTime on your laptop to use GitLab</h3>
    <p>This website cannot reach your office GitLab or run <code>git</code> itself. It uses the small JiraTime server on <b>your</b> laptop for that — your GitLab token stays on your laptop.</p>
    <ol>
      <li><b>First time only:</b> install Node.js and get the JiraTime folder: <code>git clone https://github.com/Rocky-Saini/JiraTime.git</code></li>
      <li>In that folder run <code>node server.js</code> and keep the terminal open (VPN on).</li>
      <li>Press <b>Try again</b>. If Chrome asks to let this site access devices on your local network, choose <b>Allow</b>.</li>
    </ol>
    <div class="row-actions"><button class="primary" data-glact="retrylocal" style="width:auto;margin:0">⟳ Try again</button><span class="muted tiny">Looking for the server at ${GL_LOCAL_URLS.map(esc).join(" / ")}</span></div>
    <p class="muted tiny">Your Jira features work without it. ${glHosted() ? '<button class="small" data-glact="usebrowser">← Use GitLab from this browser instead (no laptop server)</button>' : ""}</p></div>`;
}

function glConnectForm() {
  const last = (() => { try { return JSON.parse(localStorage.getItem("jiratime.gl.last") || "{}"); } catch { return {}; } })();
  const url = GL.st?.url || last.url || "", user = GL.st?.username || last.username || "";
  const replacing = GL.st?.connected || GL.st?.tokenMissing;
  return `<div class="card gl-connect">
    <h3>🦊 ${replacing ? "Replace GitLab token" : "Connect GitLab"}</h3>
    ${GL.st?.tokenMissing ? '<div class="warnbox">The saved token could not be read from this laptop (keyring locked or file removed). Enter it again.</div>' : ""}
    <div class="form">
      <label>GitLab URL <input id="glUrl" placeholder="https://gitlab.company.com" value="${esc(url)}" autocomplete="url"></label>
      <label>Username <input id="glUser" placeholder="your GitLab username" value="${esc(user)}" autocomplete="username"></label>
      <label>Personal Access Token <input id="glTok" type="password" autocomplete="off" placeholder="glpat-…"></label>
      <p id="glErr" class="st-failed"></p>
    </div>
    <div class="row-actions">
      <button id="glGo" class="primary" style="width:auto;margin:0">Connect</button>
      ${replacing ? '<button id="glCancel">Cancel</button>' : ""}
    </div>
    <div class="gl-help">
      <b>Create the token</b> in GitLab → your avatar → <i>Edit profile → Access tokens → Add new token</i>${url ? ` (<a id="glTokLink" href="${esc(glTokenLink(url))}" target="_blank" rel="noopener noreferrer">open the page</a>)` : ""}.
      <ul>
        <li>Scopes <code>api</code> + <code>write_repository</code> for everything (merge requests, approvals, pipeline retries, clone / push).</li>
        <li><code>read_api</code> + <code>read_repository</code> is enough if you only want to look and clone; you can replace the token later.</li>
        <li>Give it an expiry date as your company policy requires.</li>
      </ul>
      <p class="muted tiny">${glDirect() ? "The token is checked with GitLab and saved in this browser only (like your Jira token). JiraTime's website never receives it — your browser talks to your GitLab directly, so the VPN must be on. If Chrome asks to allow access to your local network, choose <b>Allow</b>." : "The token is checked with GitLab and then kept only on this laptop (OS keyring, or a file in <code>~/.config/jiratime</code> that only your user can read). It is never stored in the browser or sent anywhere except your GitLab."}</p>
    </div></div>`;
}
const glTokenLink = (url) => { try { return new URL(url.includes("://") ? url : "https://" + url).origin + "/-/user_settings/personal_access_tokens?name=JiraTime&scopes=api,write_repository"; } catch { return "#"; } };

function glWireConnect() {
  const go = $("#glGo"), err = $("#glErr");
  $("#glUrl").addEventListener("input", (e) => { const a = $("#glTokLink"); if (a) a.href = glTokenLink(e.target.value); });
  $("#glCancel")?.addEventListener("click", () => { GL.view = null; glRender(); });
  [$("#glUrl"), $("#glUser"), $("#glTok")].forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); }));
  go.onclick = async () => {
    err.textContent = "";
    const body = { url: $("#glUrl").value.trim(), username: $("#glUser").value.trim(), token: $("#glTok").value.trim() };
    if (!body.url || !body.username || !body.token) { err.textContent = "Fill in URL, username and token"; return; }
    go.disabled = true; go.textContent = "Connecting…";
    const slow = setTimeout(() => { if (go.disabled) err.innerHTML = '<span class="muted">Waiting for GitLab… If Chrome shows a popup asking to access devices on your local network, choose <b>Allow</b>.</span>'; }, 3500);
    try {
      let j;
      if (glDirect()) j = await glDirectConnect(body);
      else {
        const r = await fetch(GL_BASE + "/api/gitlab/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `Failed (${r.status})`);
      }
      $("#glTok").value = "";
      const changed = glNs() !== `${j.url}|${j.username}`.toLowerCase();
      GL.st = j; GL.view = null; GL.tokenBad = "";
      localStorage.setItem("jiratime.gl.last", JSON.stringify({ url: j.url, username: j.username }));
      if (changed) glResetData();
      toast(`Connected to GitLab as @${j.username}`); glPill();
      GL.tab = "overview"; glRender(); glRefresh(false);
    } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = "Connect"; }
    finally { clearTimeout(slow); }
  };
  setTimeout(() => ($("#glUrl").value ? ($("#glUser").value ? $("#glTok") : $("#glUser")) : $("#glUrl")).focus(), 30);
}

function glHead() {
  const el = $("#glHead"); if (!el || !GL.st?.connected) return;
  const s = GL.st, u = s.user || {}, host = s.url.replace(/^https?:\/\//, "");
  const days = s.expiresAt ? Math.ceil((Date.parse(s.expiresAt) - Date.now()) / 864e5) : null;
  const KEY_SC = ["api", "read_api", "read_repository", "write_repository"], other = (s.scopes || []).filter((x) => !KEY_SC.includes(x));
  const scopes = s.scopes ? s.scopes.filter((x) => KEY_SC.includes(x)).map((x) => `<span class="b skip">${esc(x)}</span>`).join(" ") + (other.length ? ` <span class="b skip" title="${esc(other.join(", "))}">+${other.length} more</span>` : "") : '<span class="muted tiny">scopes unknown (older GitLab)</span>';
  const readOk = !s.scopes || s.scopes.some((x) => ["api", "read_api"].includes(x));
  const old = s.api !== GL_SERVER_API;
  el.innerHTML = `<div class="gl-head card">
    <div class="gl-avatar">${esc(initials(u.name || s.username))}</div>
    <div class="gl-who"><b>${esc(u.name || s.username)}</b> <span class="muted">@${esc(s.username)}</span>
      <div class="muted tiny">${glLink(s.url, esc(host))} · ${scopes}${days != null ? ` · <span class="${days <= 14 ? "st-failed" : ""}">token ${days < 0 ? "expired" : `expires in ${days} day${days === 1 ? "" : "s"}`}</span>` : ""} · stored in ${s.store === "keyring" ? "OS keyring" : s.store === "browser" ? "this browser" : "a private file on this laptop"}</div></div>
    <div class="grow"></div>
    <span id="glSync" class="muted tiny"></span>
    <button class="small" data-glact="refresh">⟳ Refresh</button>
    <button class="small" data-glact="replace">Replace token</button>
    <button class="small danger" data-glact="disconnect">Disconnect</button></div>
    ${GL.tokenBad ? `<div class="warnbox">⚠ ${esc(GL.tokenBad)} <button class="small" data-glact="replace">Replace token</button></div>` : ""}
    ${old ? '<div class="warnbox gl-old"><b>⚠ The JiraTime server on this laptop is an older version than this page.</b> Clone, local repositories, merge request details and other new parts will fail with “Not found” / “not allowed”. Stop the server in its terminal (Ctrl+C), start <code>node server.js</code> again and reload this page.</div>' : ""}
    ${glAccessLine(s)}
    ${!readOk ? '<div class="warnbox">⚠ This token has neither <code>read_api</code> nor <code>api</code> scope, so GitLab will refuse most requests. Create a token with <code>read_api</code>.</div>' : ""}
    ${days != null && days >= 0 && days <= 14 ? `<div class="warnbox">The GitLab token expires in ${days} day${days === 1 ? "" : "s"}. Create a new one and use “Replace token”.</div>` : ""}`;
  glSyncInfo();
}
function glSyncInfo() {
  const el = $("#glSync"); if (!el) return;
  const busy = GL.busy.proj || GL.busy.ev || GL.busy.cnt, errs = [GL.err.proj, GL.err.ev].filter(Boolean);
  el.innerHTML = busy ? "⟳ updating…" : errs.length ? `<span class="st-failed">⚠ ${esc(errs[0])}</span>` : GL.projAt ? "updated " + new Date(GL.projAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

// ---------- overview ----------
function glRenderOverview() {
  const body = $("#glBody"); if (!body) return;
  if (!GL.projects) { body.innerHTML = GL.err.proj ? `<div class="warnbox">⚠ Could not load projects: ${esc(GL.err.proj)} <button class="small" data-glact="refresh">Retry</button></div>` : '<p class="muted">Loading your GitLab projects…</p>'; return; }
  const ranked = glRanked(), work = glWork(), since30 = Date.now() - 30 * 864e5;
  const active = GL.projects.filter((p) => Date.parse(p.last || 0) >= since30).length;
  const pushes7 = [...work.values()].reduce((a, w) => a + w.pushes7, 0), commits7 = [...work.values()].reduce((a, w) => a + w.commits7, 0);
  const cnt = GL.counts, me = enc(GL.st.username), base = GL.st.url;
  const num = (v) => (v == null ? "…" : typeof v === "object" ? '<span title="' + esc(v.err) + '">⚠</span>' : v);
  const top = ranked.filter((x) => x.score > 0).slice(0, 12), recentRanked = top.length ? top : ranked.slice(0, 8);
  const failed = recentRanked.filter((x) => GL.det[x.p.id]?.pipe?.status === "failed");
  const pipeDone = recentRanked.every((x) => GL.det[x.p.id] && !GL.det[x.p.id].p);
  const card = (v, label, sub, act, tip) => `<button class="stat glstat" data-glact="${act}" title="${esc(tip || "")}"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</button>`;
  body.innerHTML = `
    <div class="stats gl-stats">
      ${card(GL.projects.length + (GL.projects.truncated ? "+" : ""), "Projects", "you are a member of", "tab:projects")}
      ${card(active, "Active projects", "activity in last 30 days", "active")}
      ${card(num(cnt?.created), "My open MRs", "created by me", window.GLM ? "mrsc:mine" : "web:" + `/dashboard/merge_requests?author_username=${me}`)}
      ${card(num(cnt?.assigned), "Assigned MRs", "assigned to me", window.GLM ? "mrsc:assigned" : "web:" + `/dashboard/merge_requests?assignee_username=${me}`)}
      ${card(num(cnt?.review), "Pending reviews", "I am reviewer", window.GLM ? "mrsc:review" : "web:" + `/dashboard/merge_requests?reviewer_username=${me}`)}
      ${card(num(cnt?.issues), "My open issues", "assigned to me in GitLab", "web:" + `/dashboard/issues?assignee_username=${me}`)}
      ${card(pipeDone ? failed.length : "…", "Failed pipelines", `latest pipeline · ${recentRanked.length} recent projects`, "failed", "Projects in the list below whose latest pipeline failed (default branch, or the latest branch with a pipeline)")}
      ${card(pushes7, "My pushes", `last 7 days · ${commits7} commits incl. merged ones`, "commits", "A push of a merge (e.g. release into your branch) also carries other people's commits, so pushes are counted")}
    </div>
    ${GL.err.ev ? `<div class="warnbox tiny">Your activity could not be read (${esc(GL.err.ev)}), so “recently worked” falls back to recently updated projects.</div>` : ""}
    <div class="gl-sec"><h3>🕘 ${top.length ? "Recently worked projects" : "Recently updated projects"}</h3><span class="muted tiny">${top.length ? "ordered by your latest push / activity in GitLab or opening it here" : "you have no GitLab activity in the last 90 days"}</span></div>
    <div class="gl-grid">${recentRanked.map((x) => glCard(x.p, x.w)).join("")}</div>
    <div class="gl-sec"><h3>Recently updated repositories</h3><span class="muted tiny">latest activity by anyone</span></div>
    <div class="card"><table class="gl-tbl">${GL.projects.slice().sort((a, b) => Date.parse(b.last || 0) - Date.parse(a.last || 0)).slice(0, 8).map((p) =>
      `<tr data-glopen="${p.id}"><td><b>${esc(p.name)}</b><small class="muted">${esc(p.ns)}</small></td><td class="muted">⎇ ${esc(p.branch || "—")}</td><td class="muted nowrap">${esc(ago(p.last))}</td></tr>`).join("")}</table></div>`;
  // fill the cards' details lazily (4 projects at a time)
  const need = recentRanked.filter((x) => !GL.det[x.p.id] || (!GL.det[x.p.id].p && Date.now() - GL.det[x.p.id].at > 5 * 60e3));
  if (need.length) pool(need, 4, async (x) => { await glProjDetail(x.p); glUpdateCard(x.p); }).then(() => { if (GL.tab === "overview" && $("#glBody")) glRenderOverview(); });
}

function glPipeBadge(pipe) {
  if (pipe === undefined) return '<span class="muted tiny">…</span>';
  if (!pipe) return '<span class="muted tiny">no pipeline</span>';
  return glLink(pipe.web, `<span class="eff ${GL_PIPE[pipe.status] || "noest"}" title="latest pipeline on ${esc(pipe.ref)}">${esc(pipe.status)}</span>`) + (pipe.onDefault === false ? ` <span class="muted tiny gl-ref">⎇ ${esc(String(pipe.ref).slice(0, 24))}</span>` : "");
}
function glCard(p, w) {
  const d = GL.det[p.id] && !GL.det[p.id].p ? GL.det[p.id] : null, pin = GL.pins.includes(p.id);
  const mine = w?.lastPush ? `you pushed ${ago(w.lastPush)} · ${w.pushes} push${w.pushes === 1 ? "" : "es"}` : w?.lastAny ? `your activity ${ago(w.lastAny)}` : GL.opened[p.id] ? `opened here ${agoText(GL.opened[p.id])}` : "";
  return `<div class="gl-card" data-glopen="${p.id}" data-pid="${p.id}">
    <div class="glc-top"><b class="glc-name">${esc(p.name)}</b><button class="glc-pin ${pin ? "on" : ""}" data-glpin="${p.id}" title="${pin ? "Unpin" : "Pin"}">${pin ? "★" : "☆"}</button></div>
    <div class="muted tiny glc-ns">${esc(p.ns)}</div>
    <div class="glc-desc">${esc(p.desc) || '<span class="muted">No description</span>'}</div>
    <div class="glc-meta muted tiny">⎇ ${esc(p.branch || "—")} · updated ${esc(ago(p.last))}${window.GLL?.localFor?.(p) ? ' · <span class="gl-local">● on this laptop</span>' : ""}</div>
    <div class="glc-last tiny">${d ? (d.commit ? `<span class="muted">Last commit</span> ${esc(d.commit.title.slice(0, 70))} <span class="muted">— ${esc(d.commit.author)} · ${esc(ago(d.commit.at))}</span>${glCommitPop(d.commits, p)}` : '<span class="muted">No commits on the default branch</span>') : '<span class="muted">Loading last commit…</span>'}</div>
    <div class="glc-foot">${glPipeBadge(d ? d.pipe : undefined)}<span class="tiny">${d ? (d.mrs == null ? "" : `${d.mrs} open MR${d.mrs === 1 ? "" : "s"}`) : ""}</span><span class="muted tiny glc-mine">${esc(mine)}</span></div>
  </div>`;
}
function glUpdateCard(p) {
  const el = document.querySelector(`.gl-card[data-pid="${p.id}"]`); if (!el) return;
  const w = glWork().get(p.id), tmp = document.createElement("div"); tmp.innerHTML = glCard(p, w);
  el.replaceWith(tmp.firstElementChild);
}

// ---------- projects explorer ----------
function glFiltered() {
  const f = GL.f, toks = f.q.toLowerCase().split(/\s+/).filter(Boolean), since30 = Date.now() - 30 * 864e5;
  let list = glRanked().filter(({ p }) => (!toks.length || toks.every((t) => `${p.name} ${p.path} ${p.desc} ${(p.topics || []).join(" ")}`.toLowerCase().includes(t)))
    && (!f.group || p.ns.split("/")[0] === f.group) && (!f.vis || p.vis === f.vis) && (!f.fav || GL.pins.includes(p.id)) && (!f.active || Date.parse(p.last || 0) >= since30));
  const by = { worked: null, activity: (a, b) => Date.parse(b.p.last || 0) - Date.parse(a.p.last || 0), name: (a, b) => a.p.path.localeCompare(b.p.path),
    opened: (a, b) => (GL.opened[b.p.id] || 0) - (GL.opened[a.p.id] || 0) || Date.parse(b.p.last || 0) - Date.parse(a.p.last || 0), created: (a, b) => Date.parse(b.p.created || 0) - Date.parse(a.p.created || 0) }[f.sort];
  if (by) list = list.slice().sort(by);
  return list.sort((a, b) => (GL.pins.includes(b.p.id) ? 1 : 0) - (GL.pins.includes(a.p.id) ? 1 : 0));   // pinned first, stable
}
function glRenderProjects() {
  const body = $("#glBody"); if (!body) return;
  if (!GL.projects) { body.innerHTML = '<p class="muted">Loading your GitLab projects…</p>'; return; }
  const groups = [...new Set(GL.projects.map((p) => p.ns.split("/")[0]))].sort((a, b) => a.localeCompare(b));
  const vis = [...new Set(GL.projects.map((p) => p.vis).filter(Boolean))];
  const f = GL.f;
  body.innerHTML = `<div class="row-actions gl-tools">
      <input id="glQ" placeholder="Search projects, paths, descriptions…" value="${esc(f.q)}" aria-label="Search projects">
      <select id="glGroup" aria-label="Group"><option value="">All groups</option>${groups.map((g) => `<option ${g === f.group ? "selected" : ""}>${esc(g)}</option>`).join("")}</select>
      ${vis.length > 1 ? `<select id="glVis" aria-label="Visibility"><option value="">Any visibility</option>${vis.map((v) => `<option ${v === f.vis ? "selected" : ""}>${esc(v)}</option>`).join("")}</select>` : ""}
      <select id="glSort" aria-label="Sort">${[["worked", "Recently worked"], ["activity", "Recently updated"], ["opened", "Recently opened here"], ["name", "Name"], ["created", "Newest"]]
        .map(([v, l]) => `<option value="${v}" ${v === f.sort ? "selected" : ""}>${l}</option>`).join("")}</select>
      <label class="check tiny"><input id="glFav" type="checkbox" ${f.fav ? "checked" : ""}> ★ Pinned only</label>
      <label class="check tiny"><input id="glActive" type="checkbox" ${f.active ? "checked" : ""}> Active 30 days</label>
      <span id="glCount" class="muted tiny"></span>
    </div>
    <div class="card"><table class="gl-tbl" id="glList"></table><div id="glMore"></div></div>
    ${GL.projects.truncated ? '<p class="muted tiny">Showing the first 2,000 projects you are a member of.</p>' : ""}`;
  const q = $("#glQ"); let t;
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { f.q = q.value; f.limit = 100; glFillProjects(); }, 120); });
  $("#glGroup").onchange = (e) => { f.group = e.target.value; f.limit = 100; glFillProjects(); };
  $("#glVis")?.addEventListener("change", (e) => { f.vis = e.target.value; f.limit = 100; glFillProjects(); });
  $("#glSort").onchange = (e) => { f.sort = e.target.value; glFillProjects(); };
  $("#glFav").onchange = (e) => { f.fav = e.target.checked; glFillProjects(); };
  $("#glActive").onchange = (e) => { f.active = e.target.checked; glFillProjects(); };
  glFillProjects();
  if (!f.q) q.focus();
}
function glFillProjects() {
  const list = glFiltered(), shown = list.slice(0, GL.f.limit);
  $("#glCount").textContent = `${list.length} of ${GL.projects.length}`;
  $("#glList").innerHTML = `<tr><th></th><th>Project</th><th>Default branch</th><th>Visibility</th><th>Last activity</th><th>Your activity</th></tr>` +
    (shown.map(({ p, w }) => {
      const pin = GL.pins.includes(p.id);
      const mine = w?.lastPush ? `pushed ${ago(w.lastPush)}` : w?.lastAny ? `active ${ago(w.lastAny)}` : GL.opened[p.id] ? `opened ${agoText(GL.opened[p.id])}` : "";
      return `<tr data-glopen="${p.id}"><td><button class="glc-pin ${pin ? "on" : ""}" data-glpin="${p.id}" title="${pin ? "Unpin" : "Pin"}">${pin ? "★" : "☆"}</button></td>
        <td><b>${esc(p.name)}</b> <span class="muted tiny">${esc(p.ns)}</span>${p.desc ? `<small class="muted">${esc(p.desc.slice(0, 120))}</small>` : ""}</td>
        <td class="muted">${esc(p.branch || "—")}</td><td class="muted">${esc(p.vis || "")}</td><td class="muted nowrap">${esc(ago(p.last))}</td><td class="tiny nowrap">${esc(mine)}</td></tr>`;
    }).join("") || '<tr><td colspan="6" class="muted">No project matches.</td></tr>');
  $("#glMore").innerHTML = list.length > shown.length ? `<button class="small" data-glact="more">Show ${Math.min(100, list.length - shown.length)} more</button>` : "";
}

// ---------- project details ----------
const GL_DTABS = [["info", "Overview"], ["branches", "Branches"], ["commits", "Commits"], ["mrs", "Merge requests"], ["pipes", "Pipelines"], ["people", "Contributors"]];
function glOpenProject(id, tab = "info") {
  const p = (GL.projects || []).find((x) => x.id === +id); if (!p) return;
  GL.opened[p.id] = Date.now(); glCache.set("opened", GL.opened);
  openModal(`<div class="gl-det" data-gldet="${p.id}">
    <div class="gl-det-head"><div><h3>${esc(p.name)}</h3><div class="muted tiny">${esc(p.path)}</div></div><div class="grow"></div>
      ${window.GLL ? ((!glDirect() || GL_GIT) && window.GLL.localFor(p) ? `<button class="small" data-glact="openlocal:${p.id}">📂 Open local repo</button>` : `<button class="small primary-s" data-glact="clone:${p.id}">⬇ Clone</button>`) : ""}
      ${window.GLM ? `<button class="small" data-glact="newmr:${p.id}">＋ Merge request</button>` : ""}
      ${glLink(p.web, "Open in GitLab ↗", "small gl-ext")}</div>
    <div class="gl-sub">${GL_DTABS.map(([t, l]) => `<button class="gl-tab ${t === tab ? "on" : ""}" data-gldtab="${t}">${l}</button>`).join("")}</div>
    <div id="glDetBody" class="gl-det-body"><p class="muted">Loading…</p></div>
    <div class="foot"><button data-glact="closedet">Close</button></div></div>`);
  glDetTab(p, tab);
}
async function glDetTab(p, tab) {
  GL.abort?.abort(); const ctl = new AbortController(); GL.abort = ctl; const signal = ctl.signal;
  document.querySelectorAll("[data-gldtab]").forEach((b) => b.classList.toggle("on", b.dataset.gldtab === tab));
  const box = () => $("#glDetBody"), put = (html) => { if (!signal.aborted && box()) box().innerHTML = html; };
  put('<p class="muted">Loading…</p>');
  try {
    if (tab === "info") {
      const [langs, role] = await Promise.all([glApi(`/projects/${p.id}/languages`, { signal }).then((r) => r.data || {}).catch(() => ({})), glRole(p.id)]);
      const copy = (label, v) => v ? `<div class="gl-clone"><span class="muted tiny">${label}</span><code>${esc(v)}</code><button class="small" data-glcopy="${esc(v)}">Copy</button></div>` : "";
      put(`<p>${esc(p.desc) || '<span class="muted">No description</span>'}</p>
        <table class="gl-kv"><tr><td>Your role</td><td>${role ? `<span class="gl-role">👤 ${GL_ROLE[role] || role}</span> <span class="muted tiny">${role >= 40 ? "can merge into protected branches" : role >= 30 ? "can push branches and open merge requests; merging into protected branches usually needs a Maintainer" : "read only"}</span>` : '<span class="muted">unknown</span>'}</td></tr><tr><td>Default branch</td><td>⎇ ${esc(p.branch || "—")}</td></tr><tr><td>Visibility</td><td>${esc(p.vis || "—")}</td></tr>
        <tr><td>Created</td><td>${esc(fmtDateTime(p.created))}</td></tr><tr><td>Last activity</td><td>${esc(fmtDateTime(p.last))} (${esc(ago(p.last))})</td></tr>
        <tr><td>Stars · forks</td><td>${p.stars} · ${p.forks}</td></tr>${p.topics?.length ? `<tr><td>Topics</td><td>${p.topics.map((t) => `<span class="b skip">${esc(t)}</span>`).join(" ")}</td></tr>` : ""}
        ${Object.keys(langs).length ? `<tr><td>Languages</td><td>${Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([l, v]) => `${esc(l)} ${Math.round(v)}%`).join(" · ")}</td></tr>` : ""}</table>
        <h4>Clone</h4>${copy("HTTPS", p.http)}${copy("SSH", p.ssh)}
        ${window.GLL?.localFor(p) ? `<p class="tiny">● Cloned on this laptop: <code>${esc(window.GLL.localFor(p).path)}</code></p>` : ""}`);
    } else if (tab === "branches") {
      const list = await glAll(`/projects/${p.id}/repository/branches`, 5, signal);
      list.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || Date.parse(b.commit?.committed_date || 0) - Date.parse(a.commit?.committed_date || 0));
      put(`<div class="row-actions"><input id="glBrQ" placeholder="Filter branches…" aria-label="Filter branches"><span class="muted tiny">${list.length}${list.truncated ? "+" : ""} branches</span></div>
        <table class="gl-tbl" id="glBrT">${list.map((b) => `<tr data-name="${esc(b.name.toLowerCase())}"><td><b>${esc(b.name)}</b> ${b.default ? '<span class="b new">default</span>' : ""}${b.protected ? ' <span class="b diff">protected</span>' : ""}${b.merged ? ' <span class="b skip">merged</span>' : ""}</td>
          <td class="tiny">${esc((b.commit?.title || "").slice(0, 80))}<small class="muted">${esc(b.commit?.author_name || "")}</small></td><td class="muted nowrap tiny">${esc(ago(b.commit?.committed_date))}</td><td>${glLink(b.web_url, "↗")}</td></tr>`).join("") || '<tr><td class="muted">No branches.</td></tr>'}</table>`);
      $("#glBrQ")?.addEventListener("input", (e) => { const v = e.target.value.toLowerCase(); document.querySelectorAll("#glBrT tr").forEach((tr) => { tr.style.display = !v || tr.dataset.name.includes(v) ? "" : "none"; }); });
    } else if (tab === "commits") {
      if (p.empty || !p.branch) { put('<p class="muted">This repository has no commits yet.</p>'); return; }
      const r = await glApi(`/projects/${p.id}/repository/commits?ref_name=${enc(p.branch)}&per_page=40`, { signal });
      put(`<p class="muted tiny">Latest 40 commits on ⎇ ${esc(p.branch)}. Click a commit to see its changes.</p>
        <table class="gl-tbl">${(r.data || []).map((c) => `<tr data-glcommit="${p.id}:${esc(c.id)}" title="${esc(c.message || c.title)}"><td><code class="sha">${esc(c.short_id)}</code> <button class="small ghost" data-glcopy="${esc(c.id)}" title="Copy full hash">⧉</button></td>
          <td>${esc(c.title)}<small class="muted">${esc(c.author_name)} · ${esc(fmtDateTime(c.committed_date))}</small></td><td>${glLink(c.web_url, "↗")}</td></tr>`).join("") || '<tr><td class="muted">No commits.</td></tr>'}</table>`);
    } else if (tab === "mrs") {
      const r = await glApi(`/projects/${p.id}/merge_requests?state=opened&order_by=updated_at&per_page=50`, { signal });
      put(`<table class="gl-tbl">${(r.data || []).map((m) => `<tr ${window.GLM ? `data-glact="glmopen:${p.id}|${m.iid}" class="gl-click"` : ""}><td class="nowrap">!${m.iid}</td><td>${m.draft || m.work_in_progress ? '<span class="b skip">Draft</span> ' : ""}${esc(m.title)}
          <small class="muted">${esc(m.author?.name || "")} · ⎇ ${esc(m.source_branch)} → ${esc(m.target_branch)}${m.assignees?.length ? " · assignee " + esc(m.assignees.map((a) => a.name).join(", ")) : ""}</small></td>
          <td class="muted nowrap tiny">updated ${esc(ago(m.updated_at))}</td><td>${glLink(m.web_url, "↗")}</td></tr>`).join("") || '<tr><td class="muted">No open merge requests.</td></tr>'}</table>
        ${r.total > 50 ? `<p class="muted tiny">Showing 50 of ${r.total}.</p>` : ""}`);
    } else if (tab === "pipes") {
      const r = await glApi(`/projects/${p.id}/pipelines?per_page=20`, { signal });
      put(`<p class="muted tiny">A finished pipeline is not the same as a production deployment.</p><table class="gl-tbl">${(r.data || []).map((x) => `<tr ${window.GLP ? `data-glact="glpopen:${p.id}|${x.id}" class="gl-click"` : ""}><td>${glLink(x.web_url, `<span class="eff ${GL_PIPE[x.status] || "noest"}">${esc(x.status)}</span>`)}</td>
          <td>⎇ ${esc(x.ref)} <code class="sha">${esc(String(x.sha || "").slice(0, 8))}</code><small class="muted">${esc(x.source || "")}</small></td><td class="muted nowrap tiny">${esc(fmtDateTime(x.updated_at || x.created_at))}</td></tr>`).join("") || '<tr><td class="muted">No pipelines.</td></tr>'}</table>`);
    } else if (tab === "people") {
      if (p.empty) { put('<p class="muted">No commits yet.</p>'); return; }
      const r = await glApi(`/projects/${p.id}/repository/contributors?order_by=commits&sort=desc&per_page=50`, { signal });
      put(`<table class="gl-tbl"><tr><th>Contributor</th><th>Commits</th><th>Lines +/−</th></tr>${(r.data || []).map((c) => `<tr><td><b>${esc(c.name)}</b><small class="muted">${esc(c.email)}</small></td><td>${c.commits}</td><td class="tiny"><span class="st-success">+${c.additions ?? "?"}</span> <span class="st-failed">−${c.deletions ?? "?"}</span></td></tr>`).join("") || '<tr><td class="muted">No contributors.</td></tr>'}</table>`);
    }
  } catch (e) { if (e.name !== "AbortError") put(`<div class="warnbox">⚠ ${esc(e.message)}</div>`); }
}

// ================= actions =================
function glResetData() {
  glCache.clear();
  Object.assign(GL, { projects: null, projAt: 0, events: null, evAt: 0, counts: null, cntAt: 0, det: {}, pins: [], opened: {}, err: {} });
}
function glLoadLocal() { GL.pins = glCache.get("pins")?.data || []; GL.opened = glCache.get("opened")?.data || {}; }

async function glRefresh(force) {
  if (!GL.st?.connected) return;
  glLoadLocal();
  if (force) { GL.det = {}; GL.tokenBad = ""; }
  const p = glLoadProjects(force).catch(() => {}), e = glLoadEvents(force), c = glLoadCounts(force);
  glSyncInfo();
  await p; if (GL.tab) glRerender();
  await Promise.allSettled([e, c]); glRerender(); glSyncInfo();
}
function glRerender() {
  if (!$("#glBody")) return glRender();
  document.querySelectorAll(".gl-main-tabs .gl-tc").forEach((el) => { const t = GL_TABS.find((x) => x.id === el.closest("[data-gltab]").dataset.gltab); if (t?.count) el.textContent = t.count(); });
  if (GL.tab === "projects") { if ($("#glList")) glFillProjects(); else glRenderProjects(); }
  else if (GL.tab === "overview") glRenderOverview();
  else GL_TABS.find((t) => t.id === GL.tab)?.refresh?.();
  glSyncInfo();
}

async function glOpen() {
  if (!GL.st || !GL.st.connected) GL.st = await glStatus();
  if (GL.st.connected) glLoadLocal();
  glRender();
  if (GL.st.connected) glRefresh(false);
}

function glTogglePin(id) {
  id = +id; GL.pins = GL.pins.includes(id) ? GL.pins.filter((x) => x !== id) : [...GL.pins, id];
  glCache.set("pins", GL.pins); glRerender();
}

/** Extra actions registered by other files: data-glact="name:arg". */
const GL_ACTIONS = {};
async function glAction(act) {
  if (act === "helperconnect") { toast("Looking for the JiraTime helper…"); const h = await glHelperConnect(); toast(h.found ? (h.old ? "The helper is an old version — run the setup command again to update it" : h.err ? "Helper found, but: " + h.err : "Laptop connected ✓") : "Helper not found on this laptop — run the setup command, then try again"); return glRender(); }
  if (act === "uselaptop") { localStorage.setItem("jiratime.gl.mode", "laptop"); return glAction("retrylocal"); }
  if (act === "usebrowser") { localStorage.removeItem("jiratime.gl.mode"); GL.st = await glStatus(); glResetData(); glPill(); glRender(); if (GL.st.connected) glRefresh(false); return; }
  if (act === "retrylocal") { GL.st = await glStatus(); glPill(); if (GL.st.connected) glLoadLocal(); glRender(); if (GL.st.connected) glRefresh(false); else if (!GL.st.available) toast("JiraTime server not found on this laptop — is node server.js running?"); return; }
  if (act === "refresh") { GL.tokenBad = ""; glHead(); glPill(); return glRefresh(true); }
  if (act === "replace") { GL.view = "connect"; return glRender(); }
  if (act === "more") { GL.f.limit += 100; return glFillProjects(); }
  if (act === "closedet") { GL.abort?.abort(); return closeModal(); }
  if (act === "disconnect") {
    if (!confirm("Disconnect GitLab? The token is removed from this laptop and the saved GitLab data is cleared.")) return;
    if (glDirect()) glCreds.clear();
    else await fetch(GL_BASE + "/api/gitlab/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
    glResetData(); GL.st = await glStatus(); GL.view = null; toast("GitLab disconnected"); glPill(); return glRender();
  }
  if (act.startsWith("tab:")) { GL.tab = act.slice(4); return glRender(); }
  const [name, arg] = act.split(/:(.*)/s);
  if (GL_ACTIONS[name]) return GL_ACTIONS[name](arg);
  if (act === "active") { GL.tab = "projects"; Object.assign(GL.f, { active: true, fav: false, q: "", sort: "activity" }); return glRender(); }
  if (act.startsWith("web:")) { window.open(GL.st.url + act.slice(4), "_blank", "noopener,noreferrer"); return; }
  if (act === "failed") {
    const list = glRanked().filter((x) => GL.det[x.p.id]?.pipe?.status === "failed");
    openModal(`<h3>Failed pipelines</h3><p class="muted tiny">Latest pipeline of your recent projects (default branch, or the latest branch with a pipeline).</p>
      <table class="gl-tbl">${list.map(({ p }) => `<tr><td><b>${esc(p.name)}</b><small class="muted">${esc(p.ns)}</small></td><td>${glPipeBadge(GL.det[p.id].pipe)}</td><td class="muted tiny">${esc(ago(GL.det[p.id].pipe.at))}</td></tr>`).join("") || '<tr><td class="muted">None failed 🎉</td></tr>'}</table>
      <div class="foot"><button data-glact="closedet" class="primary">Close</button></div>`);
    return;
  }
  if (act === "commits") {
    const since = Date.now() - 7 * 864e5, byId = new Map((GL.projects || []).map((p) => [p.id, p]));
    const pushes = (GL.events || []).filter((e) => e.push && Date.parse(e.at) >= since);
    openModal(`<h3>My pushes — last 7 days</h3>
      <table class="gl-tbl">${pushes.map((e) => `<tr><td class="nowrap muted tiny">${esc(fmtDateTime(e.at))}</td><td><b>${esc(byId.get(e.pid)?.name || "project " + e.pid)}</b> ⎇ ${esc(e.ref)}<small class="muted">${esc(e.title)}</small></td><td class="nowrap">${e.n} commit${e.n === 1 ? "" : "s"}</td></tr>`).join("") || '<tr><td class="muted">No pushes in the last 7 days.</td></tr>'}</table>
      <div class="foot"><button data-glact="closedet" class="primary">Close</button></div>`);
  }
}

(function glInit() {
  const view = $("#view-gitlab"); if (!view) return;
  JT.on("view", (v) => { if (v === "gitlab") glOpen(); });
  const onClick = (e) => {
    const pin = e.target.closest("[data-glpin]"); if (pin) { e.stopPropagation(); return glTogglePin(pin.dataset.glpin); }
    const cp = e.target.closest("[data-glcopy]"); if (cp) { navigator.clipboard.writeText(cp.dataset.glcopy).then(() => toast("Copied")).catch(() => toast("Copy failed")); return; }
    if (e.target.closest("a")) return;
    const t = e.target.closest("[data-gltab]"); if (t) { GL.tab = t.dataset.gltab; return glRender(); }
    const dt = e.target.closest("[data-gldtab]"); if (dt) { const p = GL.projects.find((x) => x.id === +e.target.closest("[data-gldet]").dataset.gldet); return glDetTab(p, dt.dataset.gldtab); }
    const a = e.target.closest("[data-glact]"); if (a) return glAction(a.dataset.glact);
    const cm = e.target.closest("[data-glcommit]"); if (cm && window.GLD) { const [pid, sha] = cm.dataset.glcommit.split(":"); return GLD.openRemoteCommit(+pid, sha); }
    const o = e.target.closest("[data-glopen]"); if (o) return glOpenProject(o.dataset.glopen);
  };
  view.addEventListener("click", onClick);
  $("#modal").addEventListener("click", (e) => { if (e.target.closest("[data-gldet], [data-glact], [data-glcopy]")) onClick(e); });
  $("#glPill")?.addEventListener("click", () => glGo(GL.tab || "overview"));
  // show the GitLab pill in the top bar on every page (only the local app has the GitLab server part)
  glStatus().then((st) => { if (!GL.st || !GL.st.connected) GL.st = st; glPill(); });
  window.addEventListener("focus", () => { if (GL.st?.connected && document.querySelector('.nav.active')?.dataset.view === "gitlab" && Date.now() - GL.projAt > 10 * 60e3) glRefresh(false); });
})();
