"use strict";
/* JiraTime - bulk worklog filler (web UI). Calls Jira through the /jira proxy (Netlify function or the
   local server.js). Credentials stay in this browser and are sent per request only. */

// ================= helpers =================
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const ymd = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const ymdOf = (t) => ymd(t.getFullYear(), t.getMonth(), t.getDate());
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const fmtH = (sec) => (Math.round((sec / 3600) * 100) / 100) + "h";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 9);
const isWeekend = (s) => { const d = new Date(s + "T00:00:00").getDay(); return d === 0 || d === 6; };
const prettyDate = (s) => { const [y, m, d] = s.split("-"); return `${d}-${MONTHS[+m - 1].slice(0, 3)}-${y}`; };
const todayStr = () => ymdOf(new Date());
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOf = (d) => { const x = new Date(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); x.setHours(0, 0, 0, 0); return x; };

function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), 3500); }
function openModal(html) { $("#modalBox").innerHTML = html; $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }
const modalOpen = () => !$("#modal").classList.contains("hidden");
// ================= in-app dialogs (instead of the browser's confirm / prompt) =================
/** Shows a JiraTime dialog above everything (also above an open modal). Resolves with true/false, or the typed text / null. */
function uiDialog({ title = "", message = "", input = null, value = "", placeholder = "", ok = "OK", cancel = "Cancel", danger = false, match = "" } = {}) {
  return new Promise((resolve) => {
    let box = document.getElementById("uiDlg");
    if (!box) { box = document.createElement("div"); box.id = "uiDlg"; box.className = "ui-dlg hidden"; document.body.appendChild(box); }
    const lines = String(message || "").split("\n\n");
    box.innerHTML = `<div class="ui-dlg-box" role="dialog" aria-modal="true">${title ? `<h3>${esc(title)}</h3>` : ""}
      ${lines.map((l) => `<p>${esc(l).replace(/\n/g, "<br>")}</p>`).join("")}
      ${input ? `<input id="uiDlgIn" type="text" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off">` : ""}
      <div class="ui-dlg-foot">${cancel ? `<button id="uiDlgNo">${esc(cancel)}</button>` : ""}<button id="uiDlgOk" class="${danger ? "danger-s" : "primary-s"}">${esc(ok)}</button></div></div>`;
    box.classList.remove("hidden");
    const inp = $("#uiDlgIn", box), okB = $("#uiDlgOk", box);
    const done = (v) => { box.classList.add("hidden"); document.removeEventListener("keydown", key, true); resolve(v); };
    const accept = () => { if (input) { const v = inp.value.trim(); if (match && v !== match) { inp.classList.add("bad"); inp.focus(); return; } done(v || null); } else done(true); };
    const key = (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(input ? null : false); } else if (e.key === "Enter" && (input || document.activeElement === okB || !box.contains(document.activeElement))) { e.preventDefault(); e.stopPropagation(); accept(); } };
    document.addEventListener("keydown", key, true);
    okB.onclick = accept; const no = $("#uiDlgNo", box); if (no) no.onclick = () => done(input ? null : false);
    box.onmousedown = (e) => { if (e.target === box) done(input ? null : false); };
    setTimeout(() => (inp ? (inp.focus(), inp.select()) : okB.focus()), 20);
  });
}
const uiConfirm = (message, opts = {}) => uiDialog({ title: opts.title || "Please confirm", message, ok: opts.ok || "Yes, continue", danger: opts.danger ?? /delete|discard|drop|remove|reset|abort|close|revoke|clear|overwrite|replace|lost/i.test(message), cancel: opts.cancel ?? "Cancel" });
const uiPrompt = (message, value = "", opts = {}) => uiDialog({ title: opts.title || "", message, input: true, value, placeholder: opts.placeholder || "", ok: opts.ok || "OK", match: opts.match || "" });

// ================= small event bus (lets the add-on modules react) =================
const JT = {
  ready: false,
  on(evt, fn) { document.addEventListener("jt:" + evt, (e) => fn(e.detail)); },
  emit(evt, detail) { document.dispatchEvent(new CustomEvent("jt:" + evt, { detail })); },
  onReady(fn) { this.on("ready", fn); if (this.ready) fn(); },
};
/** Run fn once every <script> on the page has executed. */
const afterScripts = (fn) => (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", fn, { once: true }) : fn());
/** Run fn over items with at most n calls in flight; keeps the result order. */
async function pool(items, n, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
  return out;
}

/** "2h", "1h 30m", "90m", "1.5h", "2" (hours) -> seconds (0 if invalid) */
function parseDuration(str) {
  let s = String(str || "").trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) s += "h";
  const m = s.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+)\s*m)?$/);
  if (!m || (!m[1] && !m[2])) return 0;
  return Math.round(parseFloat(m[1] || 0) * 3600 + parseInt(m[2] || 0, 10) * 60);
}
function secsToDur(secs) {
  const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
  return `${h ? h + "h" : ""}${h && m ? " " : ""}${m ? m + "m" : ""}` || "0m";
}

const store = {
  get: async (k, d) => { try { const v = localStorage.getItem("jiratime." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set: async (k, v) => localStorage.setItem("jiratime." + k, JSON.stringify(v)),
};
const csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

// ================= state =================
const DEFAULTS = { target: 8, duration: "2h", start: "10:00", delay: 500, weekend: false, dup: "skip" };
const S = {
  settings: { ...DEFAULTS }, me: null, base: null, email: null,
  y: new Date().getFullYear(), m: new Date().getMonth(),
  selected: new Set(), lastClicked: null,
  rows: [], months: {}, failed: new Set(),
  holidays: {}, pinned: [], comments: [], history: [],
  week: mondayOf(new Date()), weekInputs: {}, weekComments: {}, weekIssues: [],
  lastSync: 0, prevPattern: null, loadErr: {},
};

// ================= Jira API adapter =================
const API = {
  myself: () => "/rest/api/3/myself",
  picker: (q) => `/rest/api/2/issue/picker?query=${encodeURIComponent(q)}&showSubTasks=true&currentJQL=${encodeURIComponent('project in projectsWhereUserHasPermission("WORK ON ISSUES")')}`,
  jql: (jql, token) => `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=summary${token ? "&nextPageToken=" + encodeURIComponent(token) : ""}`,
  issueWorklogs: (id) => `/rest/api/2/issue/${id}/worklog?startAt=0&maxResults=5000`,
  addWorklog: (id) => `/rest/api/2/issue/${id}/worklog?adjustEstimate=leave`,
  delWorklog: (id, wid) => `/rest/api/2/issue/${id}/worklog/${wid}?adjustEstimate=leave`,
  editWorklog: (id, wid) => `/rest/api/2/issue/${id}/worklog/${wid}?adjustEstimate=leave`,
  myOpen: () => `/rest/api/3/search/jql?jql=${encodeURIComponent("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC")}&maxResults=100&fields=summary,status`,
  issueByKey: (key) => `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,status`,
};
// Jira credentials live only in this browser: sessionStorage by default, localStorage if "remember" is ticked.
const creds = {
  get() { try { return JSON.parse(sessionStorage.getItem("jiratime.creds") || localStorage.getItem("jiratime.creds") || "null"); } catch { return null; } },
  set(c, remember) { this.clear(); (remember ? localStorage : sessionStorage).setItem("jiratime.creds", JSON.stringify(c)); },
  clear() { sessionStorage.removeItem("jiratime.creds"); localStorage.removeItem("jiratime.creds"); },
};
class ApiError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

async function jira(path, opts = {}) {
  const read = !opts.method || opts.method === "GET";
  for (let attempt = 1; ; attempt++) {
    try { return await jiraOnce(path, opts); }
    catch (e) {
      const transient = [429, 502, 503, 504].includes(e.status) || (e.status === 0 && e.uncertain);
      if (!read || !transient || attempt >= 3) throw e;
      await sleep(attempt * 1200);
    }
  }
}
async function jiraOnce(path, opts) {
  let res;
  const c = opts.creds || creds.get();
  if (!c) throw new ApiError("Jira not configured", 412);
  try {
    res = await fetch("/jira" + path, { ...opts, headers: { Accept: "application/json", "X-Jira-Base": c.base, "X-Jira-Email": c.email, "X-Jira-Token": c.token, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
  } catch (e) { const err = new ApiError("Network error: " + e.message, 0); err.uncertain = true; throw err; }
  if (res.status === 412) throw new ApiError("Jira not configured", 412);
  if (res.status === 401) throw new ApiError("Jira rejected the credentials (API token invalid or revoked)", 401);
  if (!res.ok) {
    let msg = res.status + " " + res.statusText;
    try { const j = await res.json(); msg = [...(j.errorMessages || []), ...Object.values(j.errors || {}), j.error].filter(Boolean).join("; ") || msg; } catch { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

function setupDialog(message) {
  const c = creds.get();
  openModal(`
    <h3>Connect Jira</h3>
    <p class="muted">${esc(message || "Create an API token at id.atlassian.com → Security → API tokens. It stays in this browser only; the server never stores it.")}</p>
    <div class="form">
      <label>Jira site URL <input id="suBase" placeholder="https://yourcompany.atlassian.net" value="${esc(c?.base || S.base || "")}"></label>
      <label>Atlassian email <input id="suEmail" type="email" value="${esc(c?.email || S.email || "")}"></label>
      <label>API token <input id="suToken" type="password" autocomplete="off"></label>
      <label class="check"><input id="suRemember" type="checkbox" ${localStorage.getItem("jiratime.creds") ? "checked" : ""}> Remember on this device <span class="muted tiny">(otherwise forgotten when you close the tab)</span></label>
      <p id="suErr" class="st-failed"></p>
    </div>
    <div class="foot"><button id="suCancel">Cancel</button><button id="suGo" class="primary">Connect</button></div>`);
  $("#suCancel").onclick = closeModal;
  $("#suGo").onclick = async () => {
    $("#suErr").textContent = "";
    const next = { base: $("#suBase").value.trim().replace(/\/+$/, ""), email: $("#suEmail").value.trim(), token: $("#suToken").value.trim() };
    if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(next.base)) { $("#suErr").textContent = "Site URL must look like https://name.atlassian.net"; return; }
    if (!next.email || !next.token) { $("#suErr").textContent = "Email and API token are required"; return; }
    try { await jira(API.myself(), { creds: next }); }
    catch (e) { $("#suErr").textContent = e.status === 401 ? "Jira rejected these credentials" : e.message; return; }
    creds.set(next, $("#suRemember").checked);
    closeModal(); S.months = {}; toast("Connected"); boot();
  };
}

async function checkConnection() {
  const el = $("#conn");
  const c = creds.get();
  S.base = c?.base; S.email = c?.email;
  try {
    if (!c) throw new ApiError("Jira not configured", 412);
    S.me = await jira(API.myself());
    el.className = "pill ok"; el.textContent = "● Jira connected";
    $("#user").textContent = S.me.displayName;
    return true;
  } catch (e) {
    S.me = null; el.className = "pill bad";
    el.innerHTML = `● ${esc(e.status === 412 ? "Not connected" : e.message)} — <a href="#" id="connectLink">connect Jira</a>`;
    $("#connectLink").addEventListener("click", (ev) => { ev.preventDefault(); setupDialog(); });
    if (e.status === 412) afterScripts(() => { if (!window.JTW?.autoStart?.()) setupDialog(); });
    return false;
  }
}

// ================= local caches (this browser, per Jira account) =================
// Month worklogs and an issue index are kept in localStorage so the calendar and the issue search show
// results at once; fresh data is still fetched in the background. Never used to decide duplicates.
const cacheNs = () => { const c = creds.get(); return c ? `${c.base}|${c.email}`.toLowerCase() : ""; };
const cache = {
  k: (name) => "jiratime.cache." + name,
  get(name) { try { const v = JSON.parse(localStorage.getItem(this.k(name)) || "null"); return v && v.ns && v.ns === cacheNs() ? v : null; } catch { return null; } },
  set(name, data) { if (!cacheNs()) return; try { localStorage.setItem(this.k(name), JSON.stringify({ ns: cacheNs(), at: Date.now(), data })); } catch { /* storage full: the cache is optional */ } },
  clearAll() { Object.keys(localStorage).filter((k) => k.startsWith("jiratime.cache.")).forEach((k) => localStorage.removeItem(k)); },
};

const packMonth = (d) => ({ issues: d.issues, entries: Object.values(d.byDate).flatMap((x) => x.entries) });
function unpackMonth(p) {
  const data = { byDate: {}, byIssue: {}, issues: p?.issues || {} };
  for (const e of p?.entries || []) {
    (data.byDate[e.date] ||= { secs: 0, entries: [] }).secs += e.secs;
    data.byDate[e.date].entries.push(e);
    ((data.byIssue[e.issueId] ||= {})[e.date] ||= []).push(e);
  }
  return data;
}
const viewMemo = {};
/** Month data for DISPLAY: fresh if loaded this session, else the saved copy, else empty. */
function monthView(key) {
  if (S.months[key]) return S.months[key];
  const c = cache.get("m." + key);
  if (!c) return { byDate: {}, byIssue: {}, issues: {} };
  if (viewMemo[key]?.at !== c.at) viewMemo[key] = { at: c.at, data: unpackMonth(c.data) };
  return viewMemo[key].data;
}
function saveMonthCache(key, data) {
  cache.set("m." + key, packMonth(data));
  const keys = Object.keys(localStorage).filter((k) => k.startsWith("jiratime.cache.m.")).sort();
  while (keys.length > 8) localStorage.removeItem(keys.shift());          // keep 8 months
}

// Issue index: pinned, recently used, my open issues, issues I logged work on, earlier search results.
const IDX = { items: {}, openAt: 0, timer: null };
const PICK = new Map();                                                    // Jira picker results per query (5 min)
function idxLoad() { const c = cache.get("issues"); IDX.items = c?.data?.items || {}; IDX.openAt = c?.data?.openAt || 0; }
function idxSave() {
  clearTimeout(IDX.timer);
  IDX.timer = setTimeout(() => {
    const keep = Object.values(IDX.items).sort((a, b) => (b.used || 0) - (a.used || 0) || (b.open ? 1 : 0) - (a.open ? 1 : 0) || (b.seen || 0) - (a.seen || 0)).slice(0, 800);
    IDX.items = Object.fromEntries(keep.map((i) => [i.id, i]));
    cache.set("issues", { items: IDX.items, openAt: IDX.openAt });
  }, 300);
}
function idxAdd(list, src) {
  const now = Date.now();
  for (const i of list || []) {
    if (!i || !i.id || !i.key) continue;
    const id = String(i.id), cur = IDX.items[id] || {};
    IDX.items[id] = { id, key: i.key, summary: i.summary || cur.summary || "", status: i.status || cur.status || "",
      open: src === "open" || !!cur.open, used: src === "recent" ? now : cur.used || 0, seen: now,
      lastLog: [cur.lastLog || "", i.lastLog || ""].sort().pop() };
  }
  idxSave();
}
const agoText = (t) => { const s = (Date.now() - t) / 1000; return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
/** Search results in groups: 🕘 Recent (last picked first) · ★ Pinned · 👤 Assigned to me · 📝 Logged recently · Jira / other matches. */
function idxGroups(q, remote) {
  const toks = String(q || "").toLowerCase().split(/\s+/).filter(Boolean), q0 = toks.join(" ");
  const pins = new Set(S.pinned.map((p) => String(p.id)));
  const all = new Map(Object.entries(IDX.items));
  for (const p of S.pinned) { const id = String(p.id), cur = all.get(id) || {}; all.set(id, { ...cur, id, key: p.key, summary: p.summary || cur.summary || "" }); }
  for (const r of remote || []) if (!all.has(r.id)) all.set(r.id, { ...r });
  const match = (i) => !toks.length || toks.every((t) => `${i.key} ${i.summary || ""}`.toLowerCase().includes(t));
  const keyScore = (i) => { const k = i.key.toLowerCase(); return q0 && k === q0 ? 2 : q0 && k.startsWith(q0) ? 1 : 0; };
  const shown = new Set(), groups = [];
  const view = (i, extra) => ({ id: i.id, key: i.key, summary: i.summary || "", status: i.status || IDX.items[i.id]?.status || "", pin: pins.has(i.id), ...extra });
  const add = (id, title, list, max, extra = () => ({})) => {
    const items = list.filter((i) => !shown.has(i.id)).slice(0, max);
    items.forEach((i) => shown.add(i.id));
    if (items.length) groups.push({ id, title, items: items.map((i) => view(i, extra(i))) });
  };
  const local = [...all.values()].filter(match);
  if (q0) add("best", "Best match", local.filter((i) => keyScore(i) === 2), 1);
  add("recent", "🕘 Recent", local.filter((i) => i.used).sort((a, b) => b.used - a.used), q0 ? 6 : 8, (i) => ({ recent: i.used }));
  add("pinned", "★ Pinned", local.filter((i) => pins.has(i.id)), 10);
  add("open", "👤 Assigned to me", local.filter((i) => i.open).sort((a, b) => keyScore(b) - keyScore(a) || (b.seen || 0) - (a.seen || 0)), q0 ? 6 : 8);
  add("logged", "📝 Logged recently", local.filter((i) => i.lastLog).sort((a, b) => keyScore(b) - keyScore(a) || b.lastLog.localeCompare(a.lastLog)), q0 ? 6 : 6, (i) => ({ lastLog: i.lastLog }));
  if (remote) add("jira", "🔎 From Jira", remote.map((r) => all.get(r.id) || r), 15);
  if (q0) add("other", "Other matches", local.sort((a, b) => keyScore(b) - keyScore(a) || (b.seen || 0) - (a.seen || 0)), 8);
  return groups;
}
function idxForget(id) { const i = IDX.items[id]; if (i) { i.used = 0; idxSave(); } }
function idxClearRecent() { Object.values(IDX.items).forEach((i) => { i.used = 0; }); idxSave(); }

async function idxRefreshOpen(force) {
  if (!S.me || (!force && Date.now() - IDX.openAt < 30 * 60e3)) return;
  try {
    const r = await jira(API.myOpen());
    Object.values(IDX.items).forEach((i) => { i.open = false; });
    idxAdd((r.issues || []).map((is) => ({ id: is.id, key: is.key, summary: is.fields?.summary, status: is.fields?.status?.name })), "open");
    IDX.openAt = Date.now(); idxSave();
  } catch { /* search keeps working through Jira */ }
}
const issueByKey = (key) => { const k = String(key).toUpperCase(); return Object.values(IDX.items).find((i) => i.key.toUpperCase() === k) || S.pinned.find((p) => p.key.toUpperCase() === k) || null; };

// ================= worklog data =================
async function loadMonth(y, m, force = false) {
  const key = monthKey(y, m);
  if (!force && S.months[key]) return S.months[key];
  const data = { byDate: {}, byIssue: {}, issues: {} };
  if (!S.me) return data;
  const last = new Date(y, m + 1, 0).getDate();
  const from = ymd(y, m, 1), to = ymd(y, m, last);
  const jql = `worklogAuthor = currentUser() AND worklogDate >= "${from}" AND worklogDate <= "${to}"`;
  const issues = []; let token = null;
  do {
    const r = await jira(API.jql(jql, token));
    issues.push(...(r.issues || [])); token = r.nextPageToken || null;
  } while (token && issues.length < 500);
  const lists = await pool(issues, 5, (is) => jira(API.issueWorklogs(is.id)));   // 5 at a time (was one by one)
  issues.forEach((is, k) => {
    data.issues[is.id] = { id: is.id, key: is.key, summary: is.fields?.summary || "" };
    for (const w of lists[k]?.worklogs || []) {
      if (w.author?.accountId !== S.me.accountId) continue;
      const date = String(w.started).slice(0, 10);
      if (date < from || date > to) continue;
      const entry = { id: w.id, issueId: is.id, issueKey: is.key, secs: w.timeSpentSeconds, comment: typeof w.comment === "string" ? w.comment : "", author: w.author.displayName, date, started: String(w.started || "") };
      (data.byDate[date] ||= { secs: 0, entries: [] }).secs += entry.secs;
      data.byDate[date].entries.push(entry);
      ((data.byIssue[is.id] ||= {})[date] ||= []).push(entry);
    }
  });
  S.months[key] = data; delete S.loadErr[key];
  saveMonthCache(key, data);
  idxAdd(Object.values(data.issues).map((i) => ({ ...i, lastLog: Object.keys(data.byIssue[i.id] || {}).sort().pop() || "" })), "worklog");
  JT.emit("data", { key });
  return data;
}
async function ensureRange(fromStr, toStr) {
  const a = new Date(fromStr + "T00:00:00"), b = new Date(toStr + "T00:00:00");
  for (let t = new Date(a.getFullYear(), a.getMonth(), 1); t <= b; t.setMonth(t.getMonth() + 1)) await loadMonth(t.getFullYear(), t.getMonth());
}
/** Make sure the months of these dates are loaded fresh this session (needed before duplicate checks). */
async function ensureDates(dates) { for (const mk of [...new Set(dates.map((d) => d.slice(0, 7)))]) { const [y, m] = mk.split("-").map(Number); await loadMonth(y, m - 1); } }
/** Re-fetch these months (after a write). */
async function reloadMonths(keys) { for (const mk of [...new Set(keys)]) { const [y, m] = mk.split("-").map(Number); await loadMonth(y, m - 1, true); } }
const monthData = (date) => S.months[date.slice(0, 7)] || { byDate: {}, byIssue: {}, issues: {} };
const existingFor = (issueId, date) => monthData(date).byIssue?.[issueId]?.[date] || [];
const loggedSecs = (issueId, date) => existingFor(issueId, date).reduce((a, e) => a + e.secs, 0);

async function refreshNow(silent) {
  if (!S.me) return;
  const key = monthKey(S.y, S.m);
  try {
    await loadMonth(S.y, S.m, true);
    for (const k of Object.keys(S.months)) if (k !== key) delete S.months[k];      // other months reload when needed
    S.lastSync = Date.now();
    renderAll();
    if (!silent) { toast("Synced with Jira"); PICK.clear(); idxRefreshOpen(true); }
  } catch (e) { S.loadErr[key] = e.message; if (!silent) toast("Sync failed: " + e.message); }
  updateSyncInfo();
}
function updateSyncInfo() {
  const el = $("#syncInfo"), key = monthKey(S.y, S.m), err = S.loadErr[key];
  if (err && S.me) {
    el.innerHTML = `<span class="st-failed">⚠ ${S.months[key] ? "Refresh failed" : "Could not load worklogs"}: ${esc(err)}</span> <button id="syncRetry" class="small">Retry</button>`;
    $("#syncRetry").onclick = () => refreshNow(false);
    return;
  }
  el.textContent = !S.months[key] && S.me ? "showing saved data · updating…" : S.lastSync ? "synced " + new Date(S.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

// ================= days / holidays =================
const holidayOf = (d) => S.holidays[d];
const isOffDay = (d) => (!S.settings.weekend && isWeekend(d)) || !!holidayOf(d);
function workingDays(y, m) {
  const out = [], last = new Date(y, m + 1, 0).getDate();
  for (let d = 1; d <= last; d++) { const s = ymd(y, m, d); if (!isOffDay(s)) out.push(s); }
  return out;
}
function dayStatus(date, data) {
  if (holidayOf(date)) return "holiday";
  const secs = data.byDate[date]?.secs || 0, target = S.settings.target * 3600;
  if (secs >= target) return "done";
  if (secs > 0) return "partial";
  return date < todayStr() && !isWeekend(date) ? "missing" : "";
}

// ================= calendar =================
function renderCalendar() {
  const key = monthKey(S.y, S.m), data = monthView(key);
  updateSyncInfo();
  $("#monthSel").value = S.m; $("#yearSel").value = S.y;
  const first = (new Date(S.y, S.m, 1).getDay() + 6) % 7, last = new Date(S.y, S.m + 1, 0).getDate();
  let html = DOW.map((d) => `<div class="dow">${d}</div>`).join("") + '<div class="day empty"></div>'.repeat(first);
  for (let d = 1; d <= last; d++) {
    const s = ymd(S.y, S.m, d), off = isOffDay(s), st = dayStatus(s, data), hol = holidayOf(s);
    const failed = [...S.failed].some((k) => k.endsWith("|" + s));
    const secs = data.byDate[s]?.secs || 0;
    const cls = ["day", off && "off", S.selected.has(s) && "selected", !S.selected.has(s) && st, failed && "failed", s === todayStr() && "today"].filter(Boolean).join(" ");
    html += `<div class="${cls}" data-d="${s}" ${hol ? `title="${esc(hol.label)}"` : ""}><span class="n">${d}</span><button class="dinfo" data-info="${s}" title="Day details" tabindex="-1">⋯</button><span class="h">${hol ? "🏖 " + esc(hol.label.slice(0, 8)) : ""}${secs ? (hol ? " · " : "") + fmtH(secs) : ""}</span></div>`;
  }
  $("#calendar").innerHTML = html; hideDayTip();
  renderStats(data); renderBanner(data); renderSelection();
}

/** Month numbers for the dashboard. Every number is computed from working days only, except "Total logged". */
function monthStats(data, y = S.y, m = S.m) {
  const wd = workingDays(y, m), target = S.settings.target * 3600, today = todayStr();
  let done = 0, partial = 0, missing = 0, upcoming = 0, onWorking = 0, remaining = 0, total = 0, offDays = 0;
  for (const d of wd) {
    const secs = data.byDate[d]?.secs || 0;
    if (secs >= target) done++; else if (secs > 0) partial++; else if (d < today) missing++; else upcoming++;
    onWorking += Math.min(secs, target);
    remaining += Math.max(0, target - secs);
  }
  const wdSet = new Set(wd);
  for (const [d, v] of Object.entries(data.byDate)) { total += v.secs; if (!wdSet.has(d)) offDays += v.secs; }
  return { wd: wd.length, target, done, partial, pending: missing + upcoming, missing, upcoming, total, offDays, extra: total - offDays - onWorking, remaining, expected: wd.length * target, onWorking };
}

function renderStats(data) {
  const st = monthStats(data), h = S.settings.target;
  const failedCount = [...S.failed].filter((k) => k.split("|")[1].startsWith(monthKey(S.y, S.m))).length;
  const card = (v, label, sub, tip) => `<div class="stat" title="${esc(tip)}"><b>${v}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
  $("#stats").innerHTML = [
    card(st.wd, "Working days", "", "Mon–Fri in this month minus holidays and leave"),
    card(st.done, "Completed", "", `Working days with ${h}h or more`),
    card(st.partial, "Partial", "", `Working days with some time but less than ${h}h`),
    card(st.pending, "Pending", st.pending ? `${st.missing} missed · ${st.upcoming} upcoming` : "", "Working days with no worklog yet (missed = before today)"),
    card(failedCount, "Failed (session)", "", "Worklogs that failed to submit in this session"),
    card(fmtH(st.total), "Total logged", st.offDays ? `incl. ${fmtH(st.offDays)} on holidays / weekends` : "", "Everything you logged this month, on any day"),
    card(fmtH(st.remaining), "Remaining", `of ${fmtH(st.expected)} (${st.wd} × ${h}h)`, `Sum over working days of (${h}h − logged that day). Time on holidays/weekends and hours above ${h}h on a day do not reduce it.`),
  ].join("") + `<button class="stat aicard" id="aiCard" title="Open the AI efficiency report"><b class="eff noest">…</b><span>AI efficiency</span><small></small></button>`;
  window.AIEFF?.renderCard?.();
  $("#progressBar").style.width = (st.expected ? Math.round((st.onWorking / st.expected) * 100) : 0) + "%";
}

function missingDays() {
  const data = monthView(monthKey(S.y, S.m));
  return workingDays(S.y, S.m).filter((d) => d <= todayStr() && !data.byDate[d]);
}
function renderBanner(data) {
  const b = $("#banner");
  const missing = S.me && monthKey(S.y, S.m) <= todayStr().slice(0, 7) ? missingDays() : [];
  if (!missing.length) { b.classList.add("hidden"); return; }
  b.classList.remove("hidden");
  const past = missing.filter((d) => d < todayStr()).length, todayToo = missing.includes(todayStr());     // same count as "Pending · missed"
  b.innerHTML = `⚠ ${past ? `<b>${past}</b> past working day${past > 1 ? "s" : ""} in ${MONTHS[S.m]} ha${past > 1 ? "ve" : "s"} no worklog${todayToo ? ", and today is not logged yet" : ""}.` : "Today is not logged yet."} <button id="bnSel" class="small">Select missing days</button> <button id="bnFill" class="small">⚡ Fill my month</button>`;
  $("#bnSel").onclick = () => { missing.forEach((d) => S.selected.add(d)); renderCalendar(); };
  $("#bnFill").onclick = fillMonth;
}

const sortedSelected = () => [...S.selected].sort();
function renderSelection() {
  const dates = sortedSelected();
  $("#selCount").textContent = `(${dates.length})`;
  $("#selDates").innerHTML = dates.map((d) => `<span class="chip">${prettyDate(d)}</span>`).join("") || '<span class="muted">Click dates on the calendar</span>';
  const valid = S.rows.filter((r) => r.issue && parseDuration(r.duration));
  const perDay = valid.reduce((a, r) => a + parseDuration(r.duration), 0);
  $("#summary").innerHTML = `<b>${dates.length}</b> dates × <b>${valid.length}</b> issue(s) = <b>${dates.length * valid.length}</b> entries · <b>${fmtH(perDay * dates.length)}</b> total`;
  $("#previewBtn").disabled = !dates.length || !valid.length || !S.me;
  $("#fillMonth").disabled = (!valid.length && !window.JTT?.hasPlans?.()) || !S.me;
  if ($("#qlInput")?.value) window.JTD?.qlHint?.();          // quick log follows the calendar selection
}

function toggleDate(d, shift) {
  if (isOffDay(d)) return;
  if (shift && S.lastClicked) {
    const [a, b] = [S.lastClicked, d].sort();
    for (let t = new Date(a + "T00:00:00"); ymdOf(t) <= b; t.setDate(t.getDate() + 1)) { const s = ymdOf(t); if (!isOffDay(s)) S.selected.add(s); }
  } else S.selected.has(d) ? S.selected.delete(d) : S.selected.add(d);
  S.lastClicked = d; renderCalendar();
}
// Hover a day: which Jira issues, how many hours each.
function dayTipHtml(date) {
  const md = monthView(date.slice(0, 7)), day = md.byDate[date], hol = holidayOf(date);
  const title = new Date(date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  if (!day?.entries?.length) return hol ? `<b>${esc(title)}</b><div class="tip-hol">🏖 ${esc(hol.label)}</div>` : "";
  const by = new Map();
  for (const e of day.entries) {
    const g = by.get(e.issueId) || { key: e.issueKey, summary: md.issues[e.issueId]?.summary || "", secs: 0, comments: [] };
    g.secs += e.secs; if (e.comment && !g.comments.includes(e.comment)) g.comments.push(e.comment);
    by.set(e.issueId, g);
  }
  const rows = [...by.values()].sort((a, b) => b.secs - a.secs);
  return `<div class="tip-h"><b>${esc(title)}</b><span>${fmtH(day.secs)} / ${S.settings.target}h</span></div>` +
    (hol ? `<div class="tip-hol">🏖 ${esc(hol.label)}</div>` : "") +
    rows.map((g) => `<div class="tip-r"><span class="tip-k">${esc(g.key)}</span><span class="tip-s">${esc(g.summary.slice(0, 48))}${g.comments.length ? `<small>${esc(g.comments.join(" · ").slice(0, 70))}</small>` : ""}</span><b>${fmtH(g.secs)}</b></div>`).join("");
}
const TIP = { el: null, date: null };
function showDayTip(cell) {
  const html = dayTipHtml(cell.dataset.d);
  if (!html) return hideDayTip();
  if (!TIP.el) { TIP.el = document.createElement("div"); TIP.el.className = "daytip"; TIP.el.setAttribute("role", "tooltip"); document.body.appendChild(TIP.el); }
  TIP.date = cell.dataset.d; TIP.el.innerHTML = html; TIP.el.style.display = "block";
  const r = cell.getBoundingClientRect(), t = TIP.el.getBoundingClientRect(), gap = 8;
  let left = r.left + r.width / 2 - t.width / 2, top = r.bottom + gap;
  if (top + t.height > innerHeight - 8) top = r.top - t.height - gap;                 // flip above when no room below
  left = Math.max(8, Math.min(left, innerWidth - t.width - 8));
  TIP.el.style.left = left + "px"; TIP.el.style.top = Math.max(8, top) + "px";
}
function hideDayTip() { if (TIP.el) TIP.el.style.display = "none"; TIP.date = null; }

// Drag across days to select a range; starting on a selected day unselects the range instead.
const DRAG = { on: false, start: null, cur: null, moved: false, shift: false, mode: "add" };
function rangeDates(a, b) {
  const [x, y] = [a, b].sort(), out = [];
  for (let t = new Date(x + "T00:00:00"); ymdOf(t) <= y; t.setDate(t.getDate() + 1)) { const s = ymdOf(t); if (!isOffDay(s)) out.push(s); }
  return out;
}
function paintDrag() {
  const set = new Set(rangeDates(DRAG.start, DRAG.cur)), cls = DRAG.mode === "add" ? "dragsel" : "dragdel";
  document.querySelectorAll("#calendar .day[data-d]").forEach((c) => c.classList.toggle(cls, set.has(c.dataset.d)));
}

async function gotoMonth(y, m) {
  const dt = new Date(y, m, 1); S.y = dt.getFullYear(); S.m = dt.getMonth();
  renderCalendar();
  try { await loadMonth(S.y, S.m); S.lastSync = Date.now(); updateSyncInfo(); }
  catch (e) { S.loadErr[monthKey(S.y, S.m)] = e.message; toast("Could not load worklogs: " + e.message); if (e.status === 401) checkConnection(); }
  renderCalendar(); loadSuggestion();
}
function renderAll() {
  renderCalendar(); renderSuggestion();
  const v = document.querySelector(".nav.active")?.dataset.view;
  if (v === "weekly") renderWeekly(); if (v === "reports") renderReports(); if (v === "history") renderHistory();
  JT.emit("view", v);
}

// ================= issue search (shared) =================
function attachIssueSearch(input, resDiv, onPick) {
  let timer, seq = 0, list = [], act = -1, lastQ = "", lastRemote = null, lastNote = "";
  const rowHtml = (i) => `<div class="rrow" data-id="${esc(i.id)}" data-key="${esc(i.key)}" data-sum="${esc(i.summary)}">
      <div class="rtop"><span class="rkey">${i.pin ? "★ " : ""}${esc(i.key)}</span>${i.status ? `<span class="ist">${esc(i.status)}</span>` : ""}
        <span class="rmeta">${i.recent ? esc(agoText(i.recent)) : i.lastLog ? "logged " + esc(prettyDate(i.lastLog).slice(0, 6)) : ""}</span>
        ${i.recent ? `<button class="rforget" data-forget="${esc(i.id)}" title="Remove from Recent" tabindex="-1">✕</button>` : ""}</div>
      <small>${esc(i.summary)}</small></div>`;
  const render = (q, remote, note) => {
    lastQ = q; lastRemote = remote; lastNote = note;
    const groups = idxGroups(q, remote);
    list = groups.flatMap((g) => g.items); act = list.length ? 0 : -1;
    resDiv.innerHTML = groups.map((g) => `<div class="rhead"><span>${esc(g.title)}</span>${g.id === "recent" ? '<button class="rclear" data-clearrecent tabindex="-1">clear</button>' : ""}</div>` + g.items.map(rowHtml).join("")).join("") +
      (note ? `<div class="muted tiny rnote">${esc(note)}</div>` : "") || '<div class="muted rnote">No issues — type a key or words from the summary</div>';
    resDiv.querySelector("[data-id]")?.classList.add("act");
    resDiv.classList.remove("hidden");
  };
  const remote = async (q, my) => {
    if (!q) { if (my === seq) render(q, null, ""); return; }          // empty box: your own lists only
    let hit = PICK.get(q);                                  // one Jira call per query: shared while in flight, reused for 5 min
    if (!hit || Date.now() - hit.at > 5 * 60e3) {
      hit = { at: Date.now(), p: jira(API.picker(q)).then((r) => (r.sections || []).flatMap((x) => x.issues || []).map((i) => ({ id: String(i.id), key: i.key, summary: i.summaryText || i.summary || "" }))) };
      PICK.set(q, hit);
      hit.p.then((l) => idxAdd(l, "search"), () => PICK.delete(q));
    }
    let found;
    try { found = await hit.p; } catch (e) { if (my === seq) render(q, null, e.message); return; }
    if (my !== seq || resDiv.classList.contains("hidden")) return;
    render(q, found, "");
  };
  const run = (delay, all) => {
    const q = all ? "" : input.value.trim(), my = ++seq;      // on focus: show the full lists, filter once the user types
    render(q, null, q ? "⟳ searching Jira…" : "");          // instant: from this browser's issue lists
    clearTimeout(timer); timer = setTimeout(() => remote(q, my), q ? delay : 0);
  };
  const pick = (i) => { resDiv.classList.add("hidden"); input.blur(); idxAdd([i], "recent"); onPick({ id: i.id, key: i.key, summary: i.summary }); };
  const mark = () => { const rows = resDiv.querySelectorAll("[data-id]"); rows.forEach((d, k) => d.classList.toggle("act", k === act)); rows[act]?.scrollIntoView({ block: "nearest" }); };
  input.addEventListener("focus", () => { input.select(); run(0, true); });
  input.addEventListener("input", () => run(250));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { resDiv.classList.add("hidden"); input.blur(); return; }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && list.length) { e.preventDefault(); act = (act + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length; mark(); }
    if (e.key === "Enter" && list.length) { e.preventDefault(); pick(list[Math.max(0, act)]); }
  });
  input.addEventListener("blur", () => setTimeout(() => resDiv.classList.add("hidden"), 200));
  resDiv.addEventListener("mousedown", (e) => {
    e.preventDefault();                                     // keep the focus in the box
    const f = e.target.closest("[data-forget]");
    if (f) { idxForget(f.dataset.forget); render(lastQ, lastRemote, lastNote); return; }
    if (e.target.closest("[data-clearrecent]")) { idxClearRecent(); render(lastQ, lastRemote, lastNote); return; }
    const d = e.target.closest("[data-id]"); if (!d) return;
    pick({ id: d.dataset.id, key: d.dataset.key, summary: d.dataset.sum });
  });
  resDiv.addEventListener("mousemove", (e) => {
    const d = e.target.closest("[data-id]"); if (!d) return;
    const k = [...resDiv.querySelectorAll("[data-id]")].indexOf(d); if (k !== act) { act = k; resDiv.querySelectorAll("[data-id]").forEach((x, n) => x.classList.toggle("act", n === act)); }
  });
}

const isPinned = (id) => S.pinned.some((p) => p.id === String(id));
async function togglePin(issue) {
  S.pinned = isPinned(issue.id) ? S.pinned.filter((p) => p.id !== String(issue.id)) : [...S.pinned, { id: String(issue.id), key: issue.key, summary: issue.summary }];
  await store.set("pinned", S.pinned); renderPinned(); renderRows();
}
function renderPinned() {
  $("#pinned").innerHTML = S.pinned.length ? '<span class="muted tiny">Pinned:</span>' + S.pinned.map((p) => `<span class="chip pin" data-id="${p.id}" title="${esc(p.summary)}">★ ${esc(p.key)}</span>`).join("") : '<span class="muted tiny">Tip: pin frequently used issues with ☆ so they appear here.</span>';
}

/** Comments previously used for an issue (history + loaded months), then global ones. */
function commentsFor(issueId) {
  const out = [];
  const add = (c) => { if (c && !out.includes(c)) out.push(c); };
  S.history.filter((h) => h.issueId === String(issueId) && h.status === "success").forEach((h) => add(h.comment));
  Object.values(S.months).forEach((md) => Object.values(md.byIssue?.[issueId] || {}).flat().forEach((e) => add(e.comment)));
  S.comments.forEach(add);
  return out.slice(0, 15);
}

// ================= issue rows =================
const newRow = (p = {}) => ({ id: uid(), issue: null, duration: S.settings.duration, comment: "", ...p });

function renderRows() {
  const wrap = $("#rows");
  wrap.innerHTML = S.rows.map((r) => `
    <div class="irow" data-id="${r.id}">
      <input class="q" placeholder="Search issue key / summary / project" value="${esc(r.issue ? r.issue.key + " — " + r.issue.summary : "")}">
      <input class="dur" value="${esc(r.duration)}" title="e.g. 2h, 1h 30m">
      <button class="rm" title="Remove">✕</button>
      <input class="cmt full" list="cmt-${r.id}" placeholder="Comment" value="${esc(r.comment)}">
      <datalist id="cmt-${r.id}">${(r.issue ? commentsFor(r.issue.id) : S.comments).map((c) => `<option value="${esc(c)}">`).join("")}</datalist>
      <div class="full qd">${["1h", "2h", "3h", "4h", "6h", "8h"].map((d) => `<button type="button" class="small ${r.duration === d ? "on" : ""}" data-d="${d}">${d}</button>`).join("")}
        ${r.issue ? `<button type="button" class="small fldbtn">📝 Fields</button><button type="button" class="small pinbtn">${isPinned(r.issue.id) ? "★ Pinned" : "☆ Pin"}</button>` : ""}</div>
      <div class="results hidden"></div>
    </div>`).join("");
  wrap.querySelectorAll(".irow").forEach((el) => {
    const row = S.rows.find((r) => r.id === el.dataset.id);
    const q = $(".q", el), dur = $(".dur", el);
    const syncChips = () => el.querySelectorAll(".qd [data-d]").forEach((x) => x.classList.toggle("on", x.dataset.d === row.duration.trim()));
    dur.addEventListener("input", () => { row.duration = dur.value; dur.style.borderColor = parseDuration(row.duration) ? "" : "var(--bad)"; syncChips(); renderSelection(); });
    el.querySelectorAll(".qd [data-d]").forEach((b) => b.addEventListener("click", () => { row.duration = b.dataset.d; dur.value = row.duration; dur.style.borderColor = ""; syncChips(); renderSelection(); }));
    $(".cmt", el).addEventListener("input", (e) => { row.comment = e.target.value; });
    $(".rm", el).addEventListener("click", () => { S.rows = S.rows.filter((r) => r !== row); if (!S.rows.length) S.rows.push(newRow()); renderRows(); renderSelection(); });
    $(".pinbtn", el)?.addEventListener("click", () => togglePin(row.issue));
    $(".fldbtn", el)?.addEventListener("click", () => window.openIssueFields?.(row.issue));
    attachIssueSearch(q, $(".results", el), (issue) => { row.issue = issue; renderRows(); renderSelection(); renderSuggestion(); });
  });
}

function setRowIssue(issue) {
  let row = S.rows.find((r) => !r.issue);
  if (!row) { row = newRow(); S.rows.push(row); }
  row.issue = issue; renderRows(); renderSelection(); renderSuggestion();
}

// ================= jobs / preview =================
function makeJob(issue, date, duration, comment, include) {
  const existing = existingFor(issue.id, date);
  return { id: uid(), issue, date, duration, comment: (comment || "").trim(), existing, include: include ?? (!existing.length || $("#dupMode").value === "add"), status: "pending", error: "" };
}
function buildJobs() {
  const jobs = [];
  for (const date of sortedSelected()) for (const r of S.rows) if (r.issue && parseDuration(r.duration)) jobs.push(makeJob(r.issue, date, r.duration, r.comment));
  return jobs;
}

/** Sanity checks shown before submit (anomaly detection). */
function warningsFor(jobs) {
  const w = [], inc = jobs.filter((j) => j.include);
  const perDate = {};
  inc.forEach((j) => { perDate[j.date] = (perDate[j.date] || 0) + parseDuration(j.duration); });
  for (const [d, secs] of Object.entries(perDate)) {
    const already = monthData(d).byDate[d]?.secs || 0;
    if (secs + already > 12 * 3600) w.push(`${prettyDate(d)}: total would be ${fmtH(secs + already)} (more than 12h).`);
    else if (secs + already > S.settings.target * 3600) w.push(`${prettyDate(d)}: total ${fmtH(secs + already)} exceeds your ${S.settings.target}h daily target.`);
    if (isWeekend(d)) w.push(`${prettyDate(d)} is a weekend.`);
    if (holidayOf(d)) w.push(`${prettyDate(d)} is marked as ${holidayOf(d).type} (${holidayOf(d).label}).`);
    if (d > todayStr()) w.push(`${prettyDate(d)} is in the future.`);
  }
  const noCmt = inc.filter((j) => !j.comment).length;
  if (noCmt) w.push(`${noCmt} entr${noCmt > 1 ? "ies have" : "y has"} no comment.`);
  const dup = inc.filter((j) => j.existing.length).length;
  if (dup) w.push(`${dup} entr${dup > 1 ? "ies" : "y"} will be added on top of existing worklogs.`);
  return w;
}

async function openPreview(customJobs) {
  let jobs = customJobs;
  if (!jobs) {
    const months = [...new Set(sortedSelected().map((d) => d.slice(0, 7)))];
    try { for (const mk of months) { const [y, m] = mk.split("-").map(Number); await loadMonth(y, m - 1); } }
    catch (e) { toast("Could not check existing worklogs: " + e.message); return; }
    jobs = buildJobs();
  }
  const start = $("#startTime").value || "10:00";
  let dry = false;
  const renderP = () => {
    const inc = jobs.filter((j) => j.include);
    const secs = inc.reduce((a, j) => a + parseDuration(j.duration), 0);
    const dupCount = jobs.filter((j) => j.existing.length).length;
    const bad = inc.some((j) => !parseDuration(j.duration));
    const warns = warningsFor(jobs);
    assignStarts(jobs, start);
    openModal(`
      <h3>Review before submitting</h3>
      <p class="muted">Start ${esc(start)} (same-day entries follow each other) · Weekends excluded: ${S.settings.weekend ? "NO" : "YES"} · Dates with existing worklogs: <b>${dupCount}</b></p>
      ${warns.length ? `<div class="warnbox"><b>⚠ Check these:</b><ul>${warns.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      <div class="scroll" style="max-height:44vh"><table><tr><th></th><th>Date</th><th>Issue</th><th>Duration</th><th>Start</th><th>Comment</th><th>Existing</th></tr>
      ${jobs.map((j, i) => `<tr>
        <td><input type="checkbox" data-i="${i}" class="inc" ${j.include ? "checked" : ""}></td>
        <td>${prettyDate(j.date)}</td><td>${esc(j.issue.key)}</td>
        <td><input class="jd" data-i="${i}" value="${esc(j.duration)}"></td><td class="muted">${j.include ? esc(j.startAt || "") : ""}</td>
        <td>${esc(j.comment) || '<span class="muted">—</span>'}</td>
        <td>${j.existing.length ? `<span class="st-failed">${fmtH(j.existing.reduce((a, e) => a + e.secs, 0))}</span> ${j.existing.map((e) => esc(e.comment || "no comment")).join("; ")} <small class="muted">(${esc(j.existing[0].author)})</small>` : "—"}</td></tr>`).join("")}
      </table></div>
      <p><b>${inc.length}</b> entries · <b>${fmtH(secs)}</b> total</p>
      <div class="foot"><label class="check"><input type="checkbox" id="pvDry" ${dry ? "checked" : ""}> Dry run (don't send anything)</label><div class="grow"></div>
        <button id="pvCancel">Cancel</button><button id="pvGo" class="primary" ${!inc.length || bad ? "disabled" : ""}>${dry ? "Dry-run" : "Submit"} ${inc.length} worklog${inc.length === 1 ? "" : "s"}</button></div>`);
    const box = $("#modalBox");
    box.querySelectorAll(".inc").forEach((c) => c.addEventListener("change", (e) => { jobs[e.target.dataset.i].include = e.target.checked; renderP(); }));
    box.querySelectorAll(".jd").forEach((c) => c.addEventListener("change", (e) => { jobs[e.target.dataset.i].duration = e.target.value; renderP(); }));
    $("#pvDry").onchange = (e) => { dry = e.target.checked; renderP(); };
    $("#pvCancel").onclick = closeModal;
    $("#pvGo").onclick = () => runSubmission(jobs.filter((j) => j.include), start, dry);
  };
  renderP();
}

function startedStamp(date, time) {
  const [h, mi] = time.split(":").map(Number);
  const dt = new Date(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, mi);
  const off = -dt.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
  return `${date}T${pad(h)}:${pad(mi)}:00.000${sign}${pad(Math.floor(a / 60))}${pad(a % 60)}`;
}

/** Same-day entries follow each other (10:00, 10:30, 11:30 …), after the time already logged that day. */
function assignStarts(jobs, base) {
  const [bh, bm] = String(base || "10:00").split(":").map(Number), baseMin = (bh || 0) * 60 + (bm || 0), used = {};
  for (const j of jobs) {
    if (!j.include) { j.startAt = ""; continue; }
    if (!(j.date in used)) used[j.date] = Math.round((monthData(j.date).byDate[j.date]?.secs || 0) / 60);
    const mins = Math.min(baseMin + used[j.date], 23 * 60 + 30);
    j.startAt = `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`;
    used[j.date] += Math.round(parseDuration(j.duration) / 60);
  }
  return jobs;
}

/** Used after an uncertain failure / before a retry, so we never create duplicates. */
async function worklogAlreadyExists(job) {
  const wl = await jira(API.issueWorklogs(job.issue.id));
  const secs = parseDuration(job.duration);
  return (wl.worklogs || []).find((w) =>
    w.author?.accountId === S.me.accountId && String(w.started).slice(0, 10) === job.date &&
    w.timeSpentSeconds === secs && (typeof w.comment === "string" ? w.comment : "") === job.comment &&
    Date.now() - new Date(w.created).getTime() < 15 * 60 * 1000);
}

async function runSubmission(jobs, start, dry) {
  const bid = uid() + Date.now().toString(36);
  jobs.forEach((j) => { j.status = "pending"; j.error = ""; j.batchId ||= bid; });
  let abort = false;
  const draw = (done) => {
    const finished = jobs.filter((j) => j.status === "success" || j.status === "failed").length;
    const failed = jobs.filter((j) => j.status === "failed");
    openModal(`
      <h3>${dry ? "Dry run " : ""}${done ? "finished" : "running…"}</h3>
      <div class="progress"><div style="height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));width:${jobs.length ? (finished / jobs.length) * 100 : 0}%"></div></div>
      <p>Progress: <b>${finished}/${jobs.length}</b> · Failed: <b>${failed.length}</b></p>
      <div class="scroll" style="max-height:50vh"><table>${jobs.map((j) => `<tr><td>${prettyDate(j.date)}</td><td>${esc(j.issue.key)}</td><td>${esc(j.duration)}</td>
        <td class="st-${j.status}">${j.status.toUpperCase()}${j.error ? ` — ${esc(j.error)}` : ""}</td></tr>`).join("")}</table></div>
      <div class="foot">${done ? `${failed.length ? '<button id="retryFailed" class="primary">Retry failed only</button>' : ""}${!dry && finished > failed.length ? '<button id="goNw">🏢 Sync NewersWorld timesheet…</button>' : ""}${!dry ? [...new Map(jobs.filter((j) => j.status === "success").map((j) => [j.issue.id, j.issue])).values()].slice(0, 3).map((i) => `<button class="fieldsAfter" data-i="${esc(i.id)}" data-k="${esc(i.key)}" data-s="${esc(i.summary)}">📝 ${esc(i.key)} fields</button>`).join("") : ""}<button id="doneBtn">Close</button>` : ""}</div>`);
    if (done) {
      $("#doneBtn").onclick = closeModal; $("#retryFailed")?.addEventListener("click", () => runSubmission(failed, start, dry));
      document.querySelectorAll(".fieldsAfter").forEach((b) => b.addEventListener("click", () => { closeModal(); window.openIssueFields?.({ id: b.dataset.i, key: b.dataset.k, summary: b.dataset.s }); }));
      $("#goNw")?.addEventListener("click", () => { closeModal(); document.querySelector('.nav[data-view="nw"]').click(); });
    }
  };
  draw(false);
  for (const j of jobs) {
    if (abort) break;
    j.status = "processing"; draw(false);
    const key = `${j.issue.id}|${j.date}`;
    if (dry) { await sleep(60); j.status = "success"; j.error = "dry run — nothing sent"; draw(false); continue; }
    try {
      if (j.attempted && await worklogAlreadyExists(j)) { j.status = "success"; j.error = "already existed (verified)"; }
      else {
        j.attempted = true;
        const body = { timeSpentSeconds: parseDuration(j.duration), started: startedStamp(j.date, j.startAt || start) };
        if (j.comment) body.comment = j.comment;
        const res = await jira(API.addWorklog(j.issue.id), { method: "POST", body: JSON.stringify(body) });
        j.worklogId = res?.id; j.status = "success";
      }
      S.failed.delete(key);
    } catch (e) {
      if (e.uncertain) {
        try {
          const found = await worklogAlreadyExists(j);
          if (found) { j.status = "success"; j.worklogId = found.id; j.error = "verified after network error"; S.failed.delete(key); } else throw e;
        } catch { j.status = "failed"; j.error = "Result unknown: " + e.message + " (verify before retry)"; S.failed.add(key); }
      } else {
        j.status = "failed"; j.error = e.message; S.failed.add(key);
        if (e.status === 401) { abort = true; j.error = "Credentials rejected — reconnect Jira"; }
      }
    }
    await logHistory(j);
    draw(false);
    if (!abort) await sleep(S.settings.delay);
  }
  jobs.filter((j) => j.status === "processing" || j.status === "pending").forEach((j) => { j.status = "failed"; j.error ||= "Not attempted"; });
  if (!dry) {
    idxAdd([...new Map(jobs.filter((j) => j.status === "success").map((j) => [String(j.issue.id), j.issue])).values()], "recent");
    for (const j of jobs) if (j.comment && j.status === "success" && !S.comments.includes(j.comment)) S.comments.unshift(j.comment);
    S.comments = S.comments.slice(0, 20); await store.set("comments", S.comments);
  }
  draw(true);
  if (!dry) {
    S.weekInputs = {};
    await reloadMonths([...jobs.map((j) => j.date.slice(0, 7)), monthKey(S.y, S.m)]).catch(() => {});
    S.lastSync = Date.now(); updateSyncInfo(); renderAll();
    if (abort) checkConnection();
  }
}

async function logHistory(j) {
  S.history.unshift({ id: uid(), batchId: j.batchId, ts: new Date().toISOString(), date: j.date, issueKey: j.issue.key, issueId: String(j.issue.id), duration: j.duration, comment: j.comment, status: j.status, error: j.error || "", worklogId: j.worklogId || "" });
  S.history = S.history.slice(0, 2000);
  await store.set("history", S.history);
}

// ================= fill my month / balance / suggestions =================
async function fillMonth() {
  if (!S.me) return;
  let data;
  try { data = await loadMonth(S.y, S.m); } catch (e) { toast("Could not load worklogs: " + e.message); return; }
  const isCurrent = monthKey(S.y, S.m) === todayStr().slice(0, 7);
  const days = workingDays(S.y, S.m).filter((d) => !data.byDate[d] && (!isCurrent || d <= todayStr()));
  if (!days.length) { toast("Nothing to fill — no missing working days"); return; }
  if (S.rows.some((r) => r.issue && parseDuration(r.duration))) { S.selected = new Set(days); renderCalendar(); return openPreview(); }
  if (!window.JTT?.hasPlans()) { toast("Pick issues in the rows, or create a day plan on the Templates page"); return; }
  // no rows configured: each day uses the day plan set for its weekday (Templates page), else the first plan
  const jobs = [], missing = new Set();
  for (const d of days) {
    const p = JTT.planFor(d) || JTT.defaultPlan();
    const r = await JTT.planJobs(p, d);
    jobs.push(...r.jobs); r.missing.forEach((m) => missing.add(m));
  }
  if (missing.size) toast(`Pick a Jira issue for: ${[...missing].join(", ")} (Templates page)`);
  if (!jobs.length) return;
  S.selected = new Set(days); renderCalendar();
  openPreview(jobs);
}

function balanceDialog() {
  const data = S.months[monthKey(S.y, S.m)] || { byDate: {} };
  const target = S.settings.target * 3600;
  const gaps = workingDays(S.y, S.m).filter((d) => d <= todayStr()).map((d) => [d, target - (data.byDate[d]?.secs || 0), data.byDate[d]?.secs || 0]).filter(([, g, s]) => s > 0 && g > 0);
  if (!gaps.length) { toast("No partial days to balance 🎉"); return; }
  const valid = S.rows.filter((r) => r.issue);
  const pool = [...valid.map((r) => r.issue), ...S.pinned].filter((i, k, a) => a.findIndex((x) => x.id === i.id) === k);
  if (!pool.length) { toast("Pick or pin an issue first"); return; }
  openModal(`<h3>Balance partial days</h3>
    <p class="muted">Add the missing hours so each of these ${gaps.length} days reaches ${S.settings.target}h.</p>
    <label>Log the gap on <select id="balIssue">${pool.map((i) => `<option value="${i.id}">${esc(i.key)} — ${esc(i.summary).slice(0, 60)}</option>`).join("")}</select></label>
    <label>Comment <input id="balCmt" value="${esc(valid[0]?.comment || "")}" style="width:100%"></label>
    <table>${gaps.map(([d, g, s]) => `<tr><td>${prettyDate(d)}</td><td>logged ${fmtH(s)}</td><td>+${fmtH(g)}</td></tr>`).join("")}</table>
    <div class="foot"><button id="balCancel">Cancel</button><button id="balGo" class="primary">Continue to review</button></div>`);
  $("#balCancel").onclick = closeModal;
  $("#balGo").onclick = () => {
    const issue = pool.find((i) => i.id === $("#balIssue").value), cmt = $("#balCmt").value;
    openPreview(gaps.map(([d, g]) => makeJob(issue, d, secsToDur(g), cmt, true)));
  };
}

function patternFrom(data) {
  const stats = {};
  for (const d of Object.values(data.byDate)) for (const e of d.entries) {
    const s = (stats[e.issueId] ||= { issue: data.issues[e.issueId], n: 0, durs: {}, cmts: {} });
    s.n++; s.durs[e.secs] = (s.durs[e.secs] || 0) + 1; s.cmts[e.comment] = (s.cmts[e.comment] || 0) + 1;
  }
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];
  return Object.values(stats).sort((a, b) => b.n - a.n).slice(0, 5).map((s) => ({ issue: s.issue, duration: fmtH(+top(s.durs)), comment: top(s.cmts) || "", days: s.n }));
}
async function loadSuggestion() {
  if (!S.me) return;
  const pm = new Date(S.y, S.m - 1, 1);
  try { S.prevPattern = patternFrom(await loadMonth(pm.getFullYear(), pm.getMonth())); } catch { S.prevPattern = null; }
  renderSuggestion();
}
function renderSuggestion() {
  const el = $("#suggest");
  if (!S.prevPattern?.length || S.rows.some((r) => r.issue)) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  el.innerHTML = `💡 Last month you usually logged: ${S.prevPattern.map((p) => `<b>${esc(p.issue.key)}</b> ${esc(p.duration)} (${p.days} days)`).join(", ")} <button id="sgApply" class="small">Use this</button>`;
  $("#sgApply").onclick = () => { S.rows = S.prevPattern.map((p) => newRow({ issue: p.issue, duration: p.duration, comment: p.comment })); renderRows(); renderSelection(); renderSuggestion(); };
}
async function copyPrevious() {
  const pm = new Date(S.y, S.m - 1, 1);
  try {
    const rows = patternFrom(await loadMonth(pm.getFullYear(), pm.getMonth()));
    if (!rows.length) { toast("No worklogs found in previous month"); return; }
    S.rows = rows.map((p) => newRow({ issue: p.issue, duration: p.duration, comment: p.comment })); renderRows();
    await loadMonth(S.y, S.m);
    missingDays().forEach((d) => S.selected.add(d));
    renderCalendar(); toast(`Copied ${rows.length} issue(s) from ${MONTHS[pm.getMonth()]}. Missing days selected.`);
  } catch (e) { toast("Copy failed: " + e.message); }
}

// ================= weekly grid =================
const weekDates = () => Array.from({ length: S.settings.weekend ? 7 : 5 }, (_, i) => ymdOf(addDays(S.week, i)));
const normHours = (v) => { const t = String(v || "").trim(); return /^\d+(\.\d+)?$/.test(t) ? t + "h" : t; };

function weekIssueList() {
  const map = new Map();
  const add = (i) => i && !map.has(String(i.id)) && map.set(String(i.id), { id: String(i.id), key: i.key, summary: i.summary || "" });
  for (const d of weekDates()) { const md = monthData(d); (md.byDate[d]?.entries || []).forEach((e) => add(md.issues[e.issueId] || { id: e.issueId, key: e.issueKey })); }
  S.pinned.forEach(add); S.rows.forEach((r) => add(r.issue)); S.weekIssues.forEach(add);
  return [...map.values()];
}

async function renderWeekly() {
  const dates = weekDates();
  $("#wTitle").textContent = `${prettyDate(dates[0])} → ${prettyDate(dates[dates.length - 1])}`;
  try { await ensureRange(dates[0], dates[dates.length - 1]); } catch (e) { toast(e.message); }
  const issues = weekIssueList();
  const head = `<tr><th>Issue</th>${dates.map((d) => `<th class="${isOffDay(d) ? "offc" : ""}">${DOW[(new Date(d + "T00:00:00").getDay() + 6) % 7]}<br><small>${d.slice(8)}/${d.slice(5, 7)}</small>${holidayOf(d) ? "<br>🏖" : ""}</th>`).join("")}<th>Total</th></tr>`;
  const body = issues.map((i) => {
    const tot = dates.reduce((a, d) => a + loggedSecs(i.id, d), 0);
    return `<tr><td class="icell"><b>${esc(i.key)}</b><small class="muted">${esc(i.summary).slice(0, 44)}</small>
      <input class="wc" data-i="${i.id}" placeholder="comment" value="${esc(S.weekComments[i.id] || "")}" list="wcl-${i.id}"><datalist id="wcl-${i.id}">${commentsFor(i.id).map((c) => `<option value="${esc(c)}">`).join("")}</datalist></td>
      ${dates.map((d) => { const l = loggedSecs(i.id, d); return `<td class="${isOffDay(d) ? "offc" : ""}"><div class="lg-s">${l ? fmtH(l) : ""}</div><input class="wi" data-i="${i.id}" data-d="${d}" placeholder="+" value="${esc(S.weekInputs[i.id + "|" + d] || "")}" ${isOffDay(d) ? "disabled" : ""}></td>`; }).join("")}
      <td>${tot ? fmtH(tot) : ""}</td></tr>`;
  }).join("");
  const foot = `<tr class="tot"><td>Logged / +new</td>${dates.map((d) => `<td data-ct="${d}"></td>`).join("")}<td data-ct="all"></td></tr>`;
  $("#wTable").innerHTML = head + (body || `<tr><td colspan="${dates.length + 2}" class="muted">No issues yet — add one with the box above, or pin issues.</td></tr>`) + foot;
  updateWeekTotals();
}
function updateWeekTotals() {
  const dates = weekDates(); let allL = 0, allN = 0;
  for (const d of dates) {
    const l = monthData(d).byDate[d]?.secs || 0;
    const n = [...S.weekInputsEntries(d)].reduce((a, v) => a + parseDuration(v), 0);
    allL += l; allN += n;
    const c = $(`[data-ct="${d}"]`); if (c) c.innerHTML = `${fmtH(l)}${n ? ` <span class="st-processing">+${fmtH(n)}</span>` : ""}`;
  }
  const c = $('[data-ct="all"]'); if (c) c.innerHTML = `${fmtH(allL)}${allN ? ` <span class="st-processing">+${fmtH(allN)}</span>` : ""}`;
}
S.weekInputsEntries = function* (d) { for (const [k, v] of Object.entries(S.weekInputs)) if (k.endsWith("|" + d) && v) yield normHours(v); };

async function weeklyCopyLast() {
  const prev = addDays(S.week, -7);
  const pd = Array.from({ length: S.settings.weekend ? 7 : 5 }, (_, i) => ymdOf(addDays(prev, i)));
  await ensureRange(pd[0], pd[pd.length - 1]);
  let n = 0;
  pd.forEach((d, i) => {
    const target = ymdOf(addDays(S.week, i)); if (isOffDay(target)) return;
    const md = monthData(d);
    for (const e of md.byDate[d]?.entries || []) {
      const key = e.issueId + "|" + target;
      S.weekInputs[key] = fmtH((parseDuration(S.weekInputs[key]) || 0) + e.secs);
      if (!S.weekIssues.some((i2) => i2.id === e.issueId)) S.weekIssues.push({ id: e.issueId, key: e.issueKey, summary: md.issues[e.issueId]?.summary || "" });
      if (e.comment && !S.weekComments[e.issueId]) S.weekComments[e.issueId] = e.comment;
      n++;
    }
  });
  renderWeekly(); toast(n ? `Copied ${n} entries from last week — review, then submit` : "Last week has no worklogs");
}

async function weeklySubmit() {
  const issues = new Map(weekIssueList().map((i) => [i.id, i]));
  const jobs = [];
  for (const [k, v] of Object.entries(S.weekInputs)) {
    const [iid, d] = k.split("|"); const dur = normHours(v);
    if (!v || !issues.has(iid) || !parseDuration(dur)) continue;
    jobs.push(makeJob(issues.get(iid), d, dur, S.weekComments[iid] || "", true));
  }
  if (!jobs.length) { toast("Type hours in the grid first"); return; }
  jobs.sort((a, b) => a.date.localeCompare(b.date) || a.issue.key.localeCompare(b.issue.key));
  openPreview(jobs);
}

// ================= reports =================
async function renderReports() {
  $("#repTitle").textContent = `${MONTHS[S.m]} ${S.y}`;
  let data;
  try { data = await loadMonth(S.y, S.m); } catch (e) { $("#repDays").textContent = e.message; return; }
  const entries = Object.values(data.byDate).flatMap((d) => d.entries);
  const target = S.settings.target * 3600;
  const last = new Date(S.y, S.m + 1, 0).getDate();
  const maxS = Math.max(target, ...Object.values(data.byDate).map((d) => d.secs), 1);
  $("#repDays").innerHTML = Array.from({ length: last }, (_, i) => {
    const s = ymd(S.y, S.m, i + 1), secs = data.byDate[s]?.secs || 0, st = dayStatus(s, data);
    return `<div class="col" title="${prettyDate(s)}: ${fmtH(secs)}"><div class="bar ${st}" style="height:${(secs / maxS) * 100}%"></div><small>${i + 1}</small></div>`;
  }).join("");
  const group = (keyFn) => { const m = {}; entries.forEach((e) => { const k = keyFn(e); m[k] = (m[k] || 0) + e.secs; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const bars = (rows, labelFn = (k) => k) => { const mx = Math.max(...rows.map((r) => r[1]), 1); return rows.map(([k, v]) => `<div class="hbar"><span class="lab" title="${esc(labelFn(k))}">${esc(labelFn(k))}</span><div class="track"><div style="width:${(v / mx) * 100}%"></div></div><b>${fmtH(v)}</b></div>`).join("") || '<p class="muted">No data</p>'; };
  $("#repIssues").innerHTML = bars(group((e) => e.issueKey), (k) => k + " " + (Object.values(data.issues).find((i) => i.key === k)?.summary || "").slice(0, 30));
  $("#repProjects").innerHTML = bars(group((e) => e.issueKey.split("-")[0]));
  $("#repWeeks").innerHTML = bars(group((e) => "Week of " + prettyDate(ymdOf(mondayOf(e.date + "T00:00:00")))).sort((a, b) => a[0].localeCompare(b[0])));
}
function printTimesheet() {
  const data = S.months[monthKey(S.y, S.m)]; if (!data) return;
  const rows = Object.values(data.byDate).flatMap((d) => d.entries).sort((a, b) => a.date.localeCompare(b.date) || a.issueKey.localeCompare(b.issueKey));
  const total = rows.reduce((a, e) => a + e.secs, 0);
  const per = {}; rows.forEach((e) => { per[e.issueKey] = (per[e.issueKey] || 0) + e.secs; });
  const w = window.open("", "_blank");
  if (!w) { toast("Allow pop-ups to print"); return; }
  w.document.write(`<!doctype html><title>Timesheet ${MONTHS[S.m]} ${S.y}</title><style>body{font:13px system-ui;margin:30px}table{border-collapse:collapse;width:100%;margin-bottom:20px}td,th{border:1px solid #bbb;padding:5px 8px;text-align:left}th{background:#eee}h1{font-size:20px}</style>
  <h1>Timesheet — ${esc(S.me?.displayName || "")}<br><small>${MONTHS[S.m]} ${S.y}</small></h1>
  <h3>Summary by issue</h3><table><tr><th>Issue</th><th>Hours</th></tr>${Object.entries(per).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${fmtH(v)}</td></tr>`).join("")}<tr><th>Total</th><th>${fmtH(total)}</th></tr></table>
  <h3>Daily detail</h3><table><tr><th>Date</th><th>Issue</th><th>Hours</th><th>Comment</th></tr>${rows.map((e) => `<tr><td>${prettyDate(e.date)}</td><td>${esc(e.issueKey)}</td><td>${fmtH(e.secs)}</td><td>${esc(e.comment)}</td></tr>`).join("")}</table>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

// ================= history & undo =================
function renderHistory() {
  const f = $("#histFilter").value.trim().toLowerCase(), st = $("#histStatus").value;
  const rows = S.history.filter((h) => (!f || h.issueKey.toLowerCase().includes(f)) && (!st || h.status === st)).slice(0, 300);
  $("#histTable").innerHTML = `<tr><th>Time</th><th>Date</th><th>Issue</th><th>Duration</th><th>Comment</th><th>Status</th><th></th></tr>` +
    (rows.map((h) => `<tr><td>${new Date(h.ts).toLocaleString()}</td><td>${prettyDate(h.date)}</td><td>${esc(h.issueKey)}</td><td>${esc(h.duration)}</td><td>${esc(h.comment)}</td><td class="st-${h.deleted ? "pending" : h.status}">${h.deleted ? "undone" : h.status}${h.error ? " — " + esc(h.error) : ""}</td>
      <td>${h.status === "success" && h.worklogId && !h.deleted ? `<button class="small danger" data-undo="${h.id}">Undo</button>` : ""}</td></tr>`).join("") || '<tr><td colspan="7" class="muted">No history</td></tr>');
  const batches = {};
  S.history.filter((h) => h.batchId && h.status === "success" && h.worklogId && !h.deleted).forEach((h) => { (batches[h.batchId] ||= []).push(h); });
  const list = Object.entries(batches).slice(0, 8);
  $("#batches").innerHTML = list.map(([id, hs]) => `<div class="li"><span><b>${new Date(hs[0].ts).toLocaleString()}</b> — ${hs.length} worklogs, ${esc([...new Set(hs.map((h) => h.issueKey))].join(", "))}, ${fmtH(hs.reduce((a, h) => a + parseDuration(h.duration), 0))}</span><button class="small danger" data-undobatch="${id}">Undo batch</button></div>`).join("") || '<p class="muted">No undoable batches.</p>';
}
async function undoEntries(list, label) {
  if (!list.length || !await uiConfirm(`Delete ${list.length} worklog(s) from Jira (${label})? This cannot be undone.`)) return;
  let ok = 0, fail = 0;
  for (const h of list) {
    try { await jira(API.delWorklog(h.issueId, h.worklogId), { method: "DELETE" }); h.deleted = true; ok++; }
    catch (e) { if (e.status === 404) { h.deleted = true; ok++; } else { fail++; toast("Delete failed: " + e.message); } }
    await sleep(S.settings.delay);
  }
  await store.set("history", S.history);
  toast(`Removed ${ok} worklog(s)${fail ? `, ${fail} failed` : ""}`);
  await reloadMonths([...list.map((h) => h.date.slice(0, 7)), monthKey(S.y, S.m)]).catch(() => {});
  renderAll(); renderHistory();
}

// ================= settings / holidays =================
function fillSettings() {
  const s = S.settings;
  $("#setTarget").value = s.target; $("#setDur").value = s.duration; $("#setStart").value = s.start; $("#setDelay").value = s.delay;
  $("#setWeekend").checked = s.weekend; $("#startTime").value = s.start; $("#dupMode").value = s.dup;
}
function renderHolidays() {
  const items = Object.entries(S.holidays).sort();
  $("#holList").innerHTML = items.map(([d, h]) => `<div class="li"><span>${prettyDate(d)} — ${esc(h.label)} <small class="muted">(${h.type}${h.source === "newersworld" ? " · from NewersWorld" : ""})</small></span><button class="small danger" data-delhol="${d}">✕</button></div>`).join("") || '<p class="muted tiny">None added.</p>';
}
async function saveHolidays() { await store.set("holidays", S.holidays); renderHolidays(); renderCalendar(); }

// ================= boot =================
async function boot() {
  idxLoad();
  const ok = await checkConnection();
  if (ok) await gotoMonth(S.y, S.m); else renderCalendar();
  renderSelection();
  JT.ready = true; JT.emit("ready", { connected: ok });
  if (ok) idxRefreshOpen(false);
}

async function init() {
  S.settings = { ...DEFAULTS, ...(await store.get("settings", {})) };
  S.holidays = await store.get("holidays", {}); S.pinned = await store.get("pinned", []);
  S.comments = await store.get("comments", []);
  S.history = (await store.get("history", [])).map((h) => ({ id: uid(), ...h }));
  S.rows = [newRow()];
  document.documentElement.dataset.theme = await store.get("theme", "dark");

  $("#monthSel").innerHTML = MONTHS.map((n, i) => `<option value="${i}">${n}</option>`).join("");
  fillSettings(); renderRows(); renderPinned(); renderHolidays();

  document.querySelectorAll(".nav").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll(".nav").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.view));
    document.body.classList.remove("navopen");
    renderAll();
  }));
  $("#menuBtn").onclick = () => document.body.classList.toggle("navopen");
  $("#navShade").onclick = () => document.body.classList.remove("navopen");
  $("#themeBtn").onclick = async () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; document.documentElement.dataset.theme = t; await store.set("theme", t); };
  $("#syncBtn").onclick = () => refreshNow(false);

  // calendar
  // click = toggle, drag = range, ⋯ = day details
  const cal = $("#calendar");
  cal.addEventListener("click", (e) => { const b = e.target.closest(".dinfo"); if (b) { hideDayTip(); window.openDay?.(b.dataset.info); } });
  cal.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse" || DRAG.on) return;
    const c = e.target.closest(".day[data-d]"); if (c && c.dataset.d !== TIP.date) showDayTip(c);
  });
  cal.addEventListener("pointerleave", hideDayTip);
  window.addEventListener("scroll", hideDayTip, { passive: true });
  cal.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".dinfo")) return;
    const d = e.target.closest(".day[data-d]"); if (!d) return;
    if (e.pointerType === "mouse") e.preventDefault();
    hideDayTip();
    Object.assign(DRAG, { on: true, start: d.dataset.d, cur: d.dataset.d, moved: false, shift: e.shiftKey, mode: S.selected.has(d.dataset.d) ? "del" : "add" });
  });
  document.addEventListener("pointermove", (e) => {
    if (!DRAG.on) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest?.("#calendar .day[data-d]");
    if (!el || el.dataset.d === DRAG.cur) return;
    DRAG.cur = el.dataset.d; DRAG.moved = true; paintDrag();
  });
  document.addEventListener("pointerup", () => {
    if (!DRAG.on) return;
    DRAG.on = false;
    if (!DRAG.moved) { toggleDate(DRAG.start, DRAG.shift); return; }
    for (const d of rangeDates(DRAG.start, DRAG.cur)) { if (DRAG.mode === "add") S.selected.add(d); else S.selected.delete(d); }
    S.lastClicked = DRAG.cur; renderCalendar();
  });
  document.addEventListener("pointercancel", () => { if (DRAG.on) { DRAG.on = false; renderCalendar(); } });
  $("#prevM").onclick = () => gotoMonth(S.y, S.m - 1);
  $("#nextM").onclick = () => gotoMonth(S.y, S.m + 1);
  $("#todayM").onclick = () => gotoMonth(new Date().getFullYear(), new Date().getMonth());
  $("#monthSel").onchange = (e) => gotoMonth(S.y, +e.target.value);
  $("#yearSel").onchange = (e) => gotoMonth(+e.target.value, S.m);
  $("#selWeekdays").onclick = () => { workingDays(S.y, S.m).forEach((d) => S.selected.add(d)); renderCalendar(); };
  $("#selMissing").onclick = () => { const data = monthView(monthKey(S.y, S.m)); workingDays(S.y, S.m).filter((d) => !data.byDate[d]).forEach((d) => S.selected.add(d)); renderCalendar(); };
  $("#clearSel").onclick = () => { S.selected.clear(); renderCalendar(); };
  $("#balance").onclick = balanceDialog;

  // config
  $("#addRow").onclick = () => { S.rows.push(newRow()); renderRows(); renderSelection(); };
  $("#previewBtn").onclick = () => openPreview();
  $("#fillMonth").onclick = fillMonth;
  $("#copyPrev").onclick = copyPrevious;
  $("#startTime").onchange = (e) => { S.settings.start = e.target.value; };
  $("#dupMode").onchange = (e) => { S.settings.dup = e.target.value; store.set("settings", S.settings); };
  $("#pinned").addEventListener("click", (e) => { const c = e.target.closest(".pin"); if (c) { const p = S.pinned.find((x) => x.id === c.dataset.id); if (e.shiftKey) togglePin(p); else setRowIssue(p); } });
  $("#pinned").title = "Click to use · Shift+click to unpin";
  // weekly
  attachIssueSearch($("#wAdd"), $("#wAddRes"), (i) => { if (!S.weekIssues.some((x) => x.id === i.id)) S.weekIssues.push(i); $("#wAdd").value = ""; renderWeekly(); });
  $("#wPrev").onclick = () => { S.week = addDays(S.week, -7); renderWeekly(); };
  $("#wNext").onclick = () => { S.week = addDays(S.week, 7); renderWeekly(); };
  $("#wToday").onclick = () => { S.week = mondayOf(new Date()); renderWeekly(); };
  $("#wCopy").onclick = weeklyCopyLast;
  $("#wGo").onclick = weeklySubmit;
  $("#wTable").addEventListener("input", (e) => {
    const t = e.target;
    if (t.classList.contains("wi")) { S.weekInputs[t.dataset.i + "|" + t.dataset.d] = t.value; t.style.borderColor = !t.value || parseDuration(normHours(t.value)) ? "" : "var(--bad)"; updateWeekTotals(); }
    if (t.classList.contains("wc")) S.weekComments[t.dataset.i] = t.value;
  });

  // reports / history
  $("#repCsv").onclick = async () => {
    const data = await loadMonth(S.y, S.m);
    const rows = Object.values(data.byDate).flatMap((d) => d.entries).sort((a, b) => a.date.localeCompare(b.date));
    download(`worklogs-${monthKey(S.y, S.m)}.csv`, csv([["date", "issue", "hours", "comment"], ...rows.map((e) => [e.date, e.issueKey, e.secs / 3600, e.comment])]));
  };
  $("#repPrint").onclick = printTimesheet;
  $("#histFilter").oninput = renderHistory; $("#histStatus").onchange = renderHistory;
  $("#histCsv").onclick = () => download("jiratime-history.csv", csv([["time", "date", "issue", "duration", "comment", "status", "error", "worklogId"], ...S.history.map((h) => [h.ts, h.date, h.issueKey, h.duration, h.comment, h.status, h.error, h.worklogId])]));
  $("#histClear").onclick = async () => { if (await uiConfirm("Clear local history? (Undo for these entries will no longer be possible)")) { S.history = []; await store.set("history", []); renderHistory(); } };
  $("#view-history").addEventListener("click", (e) => {
    const u = e.target.closest("[data-undo]"), b = e.target.closest("[data-undobatch]");
    if (u) undoEntries(S.history.filter((h) => h.id === u.dataset.undo), "1 entry");
    if (b) undoEntries(S.history.filter((h) => h.batchId === b.dataset.undobatch && h.status === "success" && h.worklogId && !h.deleted), "whole batch");
  });

  // settings
  $("#setSave").onclick = async () => {
    S.settings = { ...S.settings, target: +$("#setTarget").value || 8, duration: $("#setDur").value || "2h", start: $("#setStart").value || "10:00", delay: +$("#setDelay").value || 500, weekend: $("#setWeekend").checked };
    await store.set("settings", S.settings); toast("Settings saved"); fillSettings(); renderAll();
  };
  $("#setReconnect").onclick = () => setupDialog();
  $("#setLogout").onclick = () => {
    creds.clear(); cache.clearAll(); IDX.items = {}; IDX.openAt = 0; PICK.clear();
    S.me = null; S.months = {}; toast("Credentials and saved Jira data removed from this browser"); boot();
  };
  $("#hAdd").onclick = () => { const d = $("#hDate").value; if (!d) return; S.holidays[d] = { label: $("#hLabel").value || $("#hType").value, type: $("#hType").value }; saveHolidays(); };
  $("#hAddRange").onclick = () => {
    const a = $("#hFrom").value, b = $("#hTo").value; if (!a || !b || a > b) { toast("Pick a valid from/to range"); return; }
    for (let t = new Date(a + "T00:00:00"); ymdOf(t) <= b; t.setDate(t.getDate() + 1)) if (!isWeekend(ymdOf(t))) S.holidays[ymdOf(t)] = { label: $("#hLabel").value || $("#hType2").value, type: $("#hType2").value };
    saveHolidays();
  };
  $("#holList").addEventListener("click", (e) => { const b = e.target.closest("[data-delhol]"); if (b) { delete S.holidays[b.dataset.delhol]; saveHolidays(); } });

  $("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal" && !/running…/.test($("#modalBox").textContent) && !$("#modalBox [data-sticky]")) closeModal(); });

  // auto refresh: every 5 min and when the tab becomes visible again
  setInterval(() => { if (!document.hidden && !modalOpen()) refreshNow(true); }, 5 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !modalOpen() && Date.now() - S.lastSync > 60000) refreshNow(true); });

  await boot();
}
init();
