"use strict";
/* ⏱ Commit time: when you push a commit whose message says how long you worked on a Jira issue
   (e.g. "FUL2-288698:2hrs fix login"), JiraTime logs that time on the issue. Runs in this browser with your own
   Jira and GitLab logins, every few minutes while JiraTime is open, and catches up on pushes made while it was closed.
   Only your own, non-merge commits are used. Anything that could not be logged lands in "Failed time logs" with the reason. */

// ================= message parser =================
const CT_KEY = "([A-Za-z][A-Za-z0-9_]{1,9}-\\d{1,7})";
const CT_H = "h|hr|hrs|hour|hours", CT_M = "m|min|mins|minute|minutes", CT_D = "d|day|days";
const CT_UNIT_DUR = `(?:\\d+(?:\\.\\d+)?\\s*(?:${CT_D})(?![a-z])(?:\\s*\\d+(?:\\.\\d+)?\\s*(?:${CT_H})(?![a-z]))?(?:\\s*\\d+\\s*(?:${CT_M})(?![a-z]))?|\\d+(?:\\.\\d+)?\\s*(?:${CT_H})(?![a-z])(?:\\s*(?:and\\s*)?\\d+\\s*(?:${CT_M})(?![a-z]))?|\\d+\\s*(?:${CT_M})(?![a-z]))`;
const CT_KW = "(?:log\\s*-?\\s*time|logtime|logged|log|time\\s*spent|time|spent|lt|effort|worked|wl)";
/** Text right after the key: [sep] [keyword [:=-]] duration. Bare numbers need an explicit separator or keyword. */
const CT_AFTER = new RegExp(
  `^\\s*[\\])]?\\s*(?<sep>[:|=,@>~#]|-(?![A-Za-z]{2,}\\b))?\\s*(?:#?(?<kw>${CT_KW})\\s*[:=\\-]?\\s*)?` +
  `(?:(?<unit>${CT_UNIT_DUR})|(?<hm>\\d{1,2}:[0-5]\\d)(?![\\d:])|(?<bare>\\d+(?:\\.\\d+)?)(?=\\s*(?:$|[,;|)\\].\\n]|\\s-\\s|\\s+${CT_KEY.slice(1, -1)})))`, "i");
const CT_SMART = new RegExp(`#time\\s+(${CT_UNIT_DUR}|\\d+(?:\\.\\d+)?)`, "i");   // Jira smart commit: "FUL2-1 #time 2h 30m"
const CT_TIMEISH = /(\b\d+(\.\d+)?\s*(h|hrs?|hours?|mins?|minutes?)\b|log\s*-?time|logtime|#time|\btime\s*[:=])/i;

/** "2 hrs", "1h 30m", "90 min", "1.5", "1:30", "1d" -> seconds (1 day = 8 hours, like Jira). */
function ctDur(s) {
  s = String(s || "").trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{1,2}):([0-5]\d)$/))) return +m[1] * 3600 + +m[2] * 60;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 3600);
  let secs = 0, any = false;
  for (const x of s.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m)(?![a-z])/g)) {
    const n = parseFloat(x[1]), u = x[2][0]; any = true;
    secs += u === "d" ? n * 8 * 3600 : u === "h" ? n * 3600 : n * 60;
  }
  return any ? Math.round(secs) : 0;
}
/** All "issue + time" pairs in a commit message. Returns { found: [{key, secs, raw}], clean, unclear }. */
function ctParse(message) {
  const msg = String(message || ""), keyRe = new RegExp(`(?<![A-Za-z0-9_-])${CT_KEY}(?![A-Za-z0-9_])`, "g");
  const keys = [...msg.matchAll(keyRe)].map((m) => ({ key: m[1].toUpperCase(), at: m.index, end: m.index + m[0].length }));
  const found = [], spans = [];
  keys.forEach((k, i) => {
    const tail = msg.slice(k.end, i + 1 < keys.length ? keys[i + 1].at : k.end + 60).split("\n")[0];
    const m = tail.match(CT_AFTER); if (!m) return;
    const g = m.groups;
    if (g.bare && !g.kw && !(g.sep && /[:|=]/.test(g.sep))) return;           // "FUL2-1 2" or "FUL2-1-2" alone is not time
    const secs = ctDur(g.unit || g.hm || g.bare); if (!secs) return;
    found.push({ key: k.key, secs, raw: msg.slice(k.at, k.end + m[0].length) });
    spans.push([k.end + m[0].match(/^\s*[\])]?/)[0].length, k.end + m[0].length]);
  });
  if (!found.length && keys.length) {
    const sm = msg.match(CT_SMART), uniq = [...new Set(keys.map((k) => k.key))];
    if (sm && uniq.length === 1) { found.push({ key: uniq[0], secs: ctDur(sm[1]), raw: sm[0] }); spans.push([sm.index, sm.index + sm[0].length]); }
  }
  // same issue twice -> one worklog with the sum
  const byKey = new Map(); for (const f of found) { const x = byKey.get(f.key); if (x) { x.secs += f.secs; x.raw += " + " + f.raw; } else byKey.set(f.key, { ...f }); }
  let clean = msg.split("\n")[0];
  for (const [a, b] of spans.filter(([a]) => a < clean.length).sort((x, y) => y[0] - x[0])) clean = clean.slice(0, a) + clean.slice(Math.min(b, clean.length));
  clean = clean.replace(/^[\s:|\-–,]+|[\s:|\-–,]+$/g, "").replace(/\s{2,}/g, " ");
  const unclear = !byKey.size && keys.length > 0 && CT_TIMEISH.test(msg);
  return { found: [...byKey.values()], clean, unclear, keys: [...new Set(keys.map((k) => k.key))] };
}

if (typeof module !== "undefined" && module.exports) module.exports = { ctParse, ctDur };   // unit tests in node

// ================= state =================
const CT_EVERY = 5 * 60e3, CT_MAX_SECS = 16 * 3600;
const CT = (() => {
  const d = { enabled: true, since: "", lastScan: "", emails: "", items: [], seen: {}, tab: "failed" };
  try { return { ...d, ...JSON.parse(localStorage.getItem("jiratime.ct") || "{}"), busy: false, msg: "" }; } catch { return { ...d, busy: false, msg: "" }; }
})();
function ctSave() {
  const cut = Date.now() - 60 * 864e5;                                    // keep 60 days of history
  for (const [k, t] of Object.entries(CT.seen)) if (t < cut) delete CT.seen[k];
  CT.items = CT.items.filter((x) => Date.parse(x.foundAt) > cut || x.status === "failed").slice(-1500);
  const { busy, msg, ...keep } = CT; void busy; void msg;
  try { localStorage.setItem("jiratime.ct", JSON.stringify(keep)); } catch { /* storage full */ }
  ctBadge();
}
const ctFailed = () => CT.items.filter((x) => x.status === "failed");
function ctBadge() {
  const n = ctFailed().length, b = document.querySelector('.nav[data-view="committime"]'); if (!b) return;
  let s = b.querySelector(".ct-badge"); if (!s) { s = document.createElement("span"); s.className = "ct-badge"; b.appendChild(s); }
  s.textContent = n ? String(n) : ""; s.title = n ? `${n} commit time log(s) failed` : "";
}
/** E-mails / names that count as "my" commits. */
function ctMine() {
  const set = new Set(String(CT.emails || "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));
  [GL.st?.user?.email, S.me?.emailAddress, creds.get()?.email].forEach((x) => x && set.add(String(x).toLowerCase()));
  return { emails: set, names: new Set([GL.st?.user?.name, S.me?.displayName].filter(Boolean).map((x) => x.toLowerCase())) };
}
const ctReady = () => !!(creds.get() && S.me && GL.st?.connected);

// ================= scan GitLab pushes =================
/** Commits of one push event (only the new ones it brought). */
async function ctPushCommits(e) {
  const pd = e.push_data || {}, pid = e.project_id, n = Math.min(pd.commit_count || 0, 100);
  if (!n || pd.ref_type !== "branch" || pd.action === "removed" || !pd.commit_to) return [];
  if (pd.commit_from && !/^0+$/.test(pd.commit_from)) {
    try { return ((await glApi(`/projects/${pid}/repository/compare?from=${pd.commit_from}&to=${pd.commit_to}&straight=true`)).data?.commits || []); }
    catch { /* history rewritten: fall back to the newest commits */ }
  }
  return (await glApi(`/projects/${pid}/repository/commits?ref_name=${pd.commit_to}&per_page=${n}`)).data || [];
}
async function ctScan({ days, manual } = {}) {
  if (CT.busy) return;
  if (!ctReady()) { if (manual) toast(!creds.get() || !S.me ? "Connect Jira first" : "Connect GitLab first (GitLab workspace)"); return; }
  // one browser tab at a time
  const lock = (() => { try { return JSON.parse(localStorage.getItem("jiratime.ct.lock") || "null"); } catch { return null; } })(), me = (CT.tabId ||= uid());
  if (lock && lock.tab !== me && lock.until > Date.now()) { if (manual) toast("Another JiraTime tab is scanning — try again in a minute"); return; }
  localStorage.setItem("jiratime.ct.lock", JSON.stringify({ tab: me, until: Date.now() + 4 * 60e3 }));
  CT.busy = true; CT.msg = "Reading your GitLab pushes…"; ctDraw();
  const now = new Date();
  if (!CT.since) CT.since = now.toISOString();                                  // first run: from now on
  const from = days ? new Date(Date.now() - days * 864e5) : new Date(Math.min(Date.parse(CT.lastScan || CT.since), Date.now()) - 10 * 60e3);
  let added = 0, logged = 0, failed = 0;
  try {
    const events = (await glAll(`/events?action=pushed&after=${ymdOf(addDays(from, -1))}&sort=asc`, 10))
      .filter((e) => e.push_data && Date.parse(e.created_at) >= from.getTime());
    if (!GL.projects) await glLoadProjects().catch(() => {});
    const mine = ctMine(), projects = new Map((GL.projects || []).map((p) => [p.id, p]));
    for (const e of events) {
      let commits; try { commits = await ctPushCommits(e); } catch (err) { CT.msg = `Could not read a push in project ${e.project_id}: ${err.message}`; continue; }
      for (const c of commits) {
        if (!c?.id || CT.seen[c.id]) continue;
        CT.seen[c.id] = Date.now();
        if ((c.parent_ids || []).length > 1) continue;                         // merge commits carry other people's messages
        const isMine = mine.emails.has(String(c.author_email || "").toLowerCase()) || mine.emails.has(String(c.committer_email || "").toLowerCase()) || mine.names.has(String(c.author_name || "").toLowerCase());
        const p = ctParse(c.message || c.title);
        if (!p.found.length && !p.unclear) continue;
        const pr = projects.get(e.project_id), base = { sha: c.id, short: c.short_id || c.id.slice(0, 8), pid: e.project_id, project: pr?.path || String(e.project_id),
          branch: e.push_data.ref || "", title: c.title || "", at: c.authored_date || c.created_at, web: c.web_url || "", foundAt: new Date().toISOString(), clean: p.clean };
        if (!isMine) { CT.items.push({ ...base, id: uid(), key: p.found[0]?.key || p.keys[0] || "", secs: p.found[0]?.secs || 0, status: "skipped", reason: `Commit by ${c.author_name} <${c.author_email}> — only your own commits are logged (add your commit e-mail in settings if this is you)` }); continue; }
        if (!p.found.length) { CT.items.push({ ...base, id: uid(), key: p.keys[0], secs: 0, status: "failed", reason: "The message mentions time, but JiraTime could not read it. Use e.g. KEY:2h, KEY-30m or KEY|1.5h." }); added++; failed++; continue; }
        for (const f of p.found) { CT.items.push({ ...base, id: uid(), key: f.key, secs: f.secs, raw: f.raw, status: "pending", reason: "" }); added++; }
      }
      ctSave();
    }
    for (const it of CT.items.filter((x) => x.status === "pending")) { CT.msg = `Logging ${secsToDur(it.secs)} on ${it.key}…`; ctDraw(); await ctLog(it); if (it.status === "logged") logged++; else if (it.status === "failed") failed++; ctSave(); if (it.stop) break; }
    CT.lastScan = now.toISOString(); CT.msg = "";
    if (manual || logged || failed) toast(`Commit time: ${logged} logged${failed ? `, ${failed} failed — see “Failed time logs”` : ""}${!added && manual ? " (no new commits with time)" : ""}`);
    if (logged) reloadMonths([...new Set(CT.items.filter((x) => x.status === "logged" && x.date).map((x) => x.date.slice(0, 7)))].slice(-3)).then(() => renderAll()).catch(() => {});
  } catch (e) { CT.msg = "Scan failed: " + e.message; if (manual) toast(CT.msg); }
  finally { CT.busy = false; localStorage.removeItem("jiratime.ct.lock"); ctSave(); ctDraw(); }
}

// ================= log one item on Jira =================
async function ctLog(it) {
  delete it.stop;
  if (it.secs < 60) return ctFail(it, "Time is less than 1 minute");
  if (it.secs > CT_MAX_SECS) return ctFail(it, `${secsToDur(it.secs)} is more than 16 hours for one commit — check the message, then edit and retry`);
  let issue;
  try { issue = await jira(`/rest/api/3/issue/${encodeURIComponent(it.key)}?fields=summary,status`); }
  catch (e) { return ctFail(it, e.status === 404 ? `Issue ${it.key} does not exist or you have no access to it` : e.status === 401 ? (it.stop = true, "Jira credentials rejected — reconnect Jira") : `Could not read ${it.key}: ${e.message}`); }
  const d = new Date(it.at || Date.now()), date = ymdOf(d), time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const text = ctText(it.clean, it.key, it.title), comment = `${text} — commit ${it.short} (${it.project}${it.branch ? " · " + it.branch : ""})`;
  const near = (t) => Math.abs(Date.parse(t) - d) < 14 * 864e5;
  const twin = CT.items.find((x) => x !== it && x.status === "logged" && x.key === it.key && x.secs === it.secs && ctText(x.clean, x.key, x.title) === text && near(x.at));
  if (twin) { Object.assign(it, { status: "skipped", reason: `Same change as commit ${twin.short}, already logged (squash / cherry-pick / pushed again)` }); return true; }
  Object.assign(it, { issueId: String(issue.id), summary: issue.fields?.summary || "", date });
  try {   // already logged? (another device, a retry, or the same change pushed again as a squash / cherry-pick)
    const wl = await jira(API.issueWorklogs(issue.id)), meId = S.me?.accountId;
    const dup = (wl.worklogs || []).find((w) => { const c = typeof w.comment === "string" ? w.comment : JSON.stringify(w.comment || ""); return c.includes(`commit ${it.short}`) || (w.author?.accountId === meId && w.timeSpentSeconds === it.secs && c.startsWith(text + " — commit ") && near(w.started)); });
    if (dup) { Object.assign(it, { status: "skipped", reason: `Already logged on ${it.key} (worklog ${dup.id}, ${secsToDur(dup.timeSpentSeconds)} on ${String(dup.started).slice(0, 10)})`, worklogId: dup.id }); return true; }
  } catch { /* check is best effort */ }
  const body = { timeSpentSeconds: it.secs, started: startedStamp(date, time), comment };
  try {
    const res = await jira(API.addWorklog(issue.id), { method: "POST", body: JSON.stringify(body) });
    Object.assign(it, { status: "logged", reason: "", worklogId: res?.id || "", loggedAt: new Date().toISOString() });
    await logHistory({ batchId: "commit-" + it.short, date, issue: { key: it.key, id: issue.id }, duration: secsToDur(it.secs), comment, status: "success", worklogId: res?.id });
    return true;
  } catch (e) {
    if (e.status === 401) it.stop = true;
    return ctFail(it, e.status === 401 ? "Jira credentials rejected — reconnect Jira" : e.status === 400 ? `Jira refused the worklog: ${e.message} (closed issue or time tracking off?)` : e.uncertain ? `Network problem — the result is unknown: ${e.message}. Retry checks for a duplicate first.` : e.message);
  }
}
/** Worklog comment text: the commit title without the issue key and the time. */
const ctText = (clean, key, title) => { const t = String(clean || "").replace(new RegExp(`(^|\\s)[\\[(]?${key}[\\])]?(?=\\s|$|[,:;])`, "ig"), " ").replace(/^[\s:|\-–,]+|[\s:|\-–,]+$/g, "").replace(/\s{2,}/g, " ").trim(); return t || title || key; };
function ctFail(it, reason) { Object.assign(it, { status: "failed", reason, failedAt: new Date().toISOString() }); return false; }

// ================= page =================
function ctDraw() {
  const box = $("#ctMain"); if (!box) return;
  ctBadge();
  const f = ctFailed(), logged = CT.items.filter((x) => x.status === "logged").reverse(), skipped = CT.items.filter((x) => x.status === "skipped").reverse();
  const jiraOk = !!(creds.get() && S.me), glOk = !!GL.st?.connected, tabs = [["failed", `⚠ Failed time logs`, f.length], ["logged", "✅ Logged from commits", logged.length], ["skipped", "Skipped", skipped.length]];
  const st = (ok, t) => `<span class="eff ${ok ? "good" : "low"}">${ok ? "✓" : "✕"} ${t}</span>`;
  const row = (x) => `<tr data-ct="${esc(x.id)}">
      <td class="nowrap"><b>${esc(x.key || "—")}</b><small class="muted">${x.secs ? esc(secsToDur(x.secs)) : "time ?"}</small></td>
      <td>${esc(x.title)}<small class="muted">${esc(x.project)}${x.branch ? " · ⎇ " + esc(x.branch) : ""} · ${glLink(x.web, `<code class="sha">${esc(x.short)}</code>`)} · ${esc(fmtDateTime(x.at))}</small>
        ${x.reason ? `<small class="${x.status === "failed" ? "st-failed" : "muted"}">${esc(x.reason)}</small>` : ""}</td>
      <td class="nowrap">${x.status === "failed" ? `<button class="small primary-s" data-ctact="retry">↻ Retry</button> <button class="small" data-ctact="edit">✎ Edit</button> <button class="small ghost" data-ctact="dismiss" title="Do not log this">✕</button>`
        : x.status === "logged" ? `<span class="muted tiny">${esc(x.date || "")}</span> <button class="small ghost danger" data-ctact="undo" title="Delete this worklog in Jira">↶ Undo</button>`
        : x.status === "skipped" && /only your own/.test(x.reason) ? `<button class="small" data-ctact="force">Log it anyway</button>` : ""}</td></tr>`;
  const list = CT.tab === "logged" ? logged : CT.tab === "skipped" ? skipped : f;
  box.innerHTML = `<div class="card ct-head">
      <div class="ct-hl"><h3>⏱ Commit time → Jira</h3><p class="muted tiny">Write the time in your commit message — <code>FUL2-288698:2h fix login</code> — and push. JiraTime logs it on that Jira issue with the commit date.</p></div>
      <label class="check"><input type="checkbox" id="ctOn" ${CT.enabled ? "checked" : ""}> <b>Log time from my commits automatically</b></label>
      <div class="ct-st">${st(jiraOk, "Jira")} ${st(glOk, "GitLab")} <span class="muted tiny">${CT.busy ? `<span class="spin"></span> ${esc(CT.msg)}` : CT.msg ? `<span class="st-failed">${esc(CT.msg)}</span>` : CT.lastScan ? `last checked ${esc(agoText(Date.parse(CT.lastScan)))} · every 5 minutes while JiraTime is open` : CT.since ? "waiting for the first check" : ""}</span></div>
      <div class="row-actions" style="margin:8px 0 0"><button class="small primary-s" data-ctact="scan" ${CT.busy ? "disabled" : ""}>⟳ Check now</button>
        <span class="muted tiny">Catch up on older pushes:</span>${[1, 3, 7, 14].map((d) => `<button class="small" data-ctact="days:${d}" ${CT.busy ? "disabled" : ""}>${d} day${d > 1 ? "s" : ""}</button>`).join("")}
        <span class="grow"></span><button class="small ghost" data-ctact="settings">⚙ My commit e-mails</button></div>
      ${!glOk ? '<div class="warnbox tiny">Connect GitLab in <b>🦊 GitLab Workspace</b> — JiraTime reads your pushes from there.</div>' : ""}${!jiraOk ? '<div class="warnbox tiny">Connect Jira (top bar) — the time is logged with your Jira login.</div>' : ""}</div>
    <div class="card ct-try"><b>Try a commit message</b> <input id="ctTry" placeholder="e.g. FUL2-288698-2hrs fixed the login timeout" style="flex:1"><span id="ctTryOut" class="tiny"></span></div>
    <div class="gl-sub">${tabs.map(([k, l, n]) => `<button class="gl-tab ${CT.tab === k ? "on" : ""}" data-ctact="tab:${k}">${l}${n ? `<span class="gl-tc ${k === "failed" ? "bad" : ""}">${n}</span>` : ""}</button>`).join("")}
      <span class="grow"></span>${CT.tab === "failed" && f.length ? '<button class="small" data-ctact="retryall">↻ Retry all</button>' : ""}</div>
    <div class="card">${list.length ? `<table class="gl-tbl ct-tbl">${list.slice(0, 300).map(row).join("")}</table>` : `<p class="muted">${CT.tab === "failed" ? "Nothing failed. 🎉" : CT.tab === "logged" ? "Nothing logged from commits yet." : "Nothing skipped."}</p>`}</div>`;
  $("#ctOn").onchange = (e) => { CT.enabled = e.target.checked; if (CT.enabled && !CT.since) CT.since = new Date().toISOString(); ctSave(); ctDraw(); if (CT.enabled) ctScan(); };
  const tr = $("#ctTry"); tr.value = CT.tryText || "";
  const tryIt = () => { CT.tryText = tr.value; const r = ctParse(tr.value); $("#ctTryOut").innerHTML = !tr.value.trim() ? '<span class="muted">shows what would be logged</span>' : r.found.length ? r.found.map((x) => `<span class="eff good">${esc(x.key)} · ${esc(secsToDur(x.secs))}</span>`).join(" ") + ` <span class="muted">comment: “${esc(ctText(r.clean, r.found[0].key, ""))} — commit …”</span>` : r.unclear ? '<span class="st-failed">time not understood — would go to Failed time logs</span>' : '<span class="muted">no time found — nothing would be logged</span>'; };
  tr.oninput = tryIt; tryIt();
}
async function ctAct(act, id) {
  const it = CT.items.find((x) => x.id === id);
  if (act === "scan") return ctScan({ manual: true });
  if (act.startsWith("days:")) return ctScan({ manual: true, days: +act.slice(5) });
  if (act.startsWith("tab:")) { CT.tab = act.slice(4); ctSave(); return ctDraw(); }
  if (act === "settings") {
    const auto = [...ctMine().emails].join(", ");
    const v = prompt(`E-mails your git commits use (comma separated).\nAlready included: ${auto || "—"}\n\nAdd e.g. a personal e-mail you commit with:`, CT.emails || "");
    if (v != null) { CT.emails = v; ctSave(); toast("Saved"); }
    return;
  }
  if (act === "retryall") { if (!ctReady()) return toast("Connect Jira and GitLab first"); for (const x of ctFailed()) { if (x.secs) x.status = "pending"; } CT.busy = true; ctDraw(); let ok = 0; for (const x of CT.items.filter((y) => y.status === "pending")) { if (await ctLog(x)) ok++; ctSave(); if (x.stop) break; } CT.busy = false; ctSave(); ctDraw(); return toast(`${ok} logged`); }
  if (!it) return;
  if (act === "retry") { if (!it.secs) return ctAct("edit", id); if (!ctReady()) return toast("Connect Jira and GitLab first"); await ctLog(it); ctSave(); ctDraw(); return toast(it.status === "logged" ? `Logged ${secsToDur(it.secs)} on ${it.key}` : it.status === "skipped" ? it.reason : "Still failing: " + it.reason); }
  if (act === "edit") {
    const key = prompt("Jira issue:", it.key || ""); if (!key) return;
    const dur = prompt("Time (e.g. 2h, 1h 30m, 45m):", it.secs ? secsToDur(it.secs) : ""); if (!dur) return;
    const secs = ctDur(dur) || parseDuration(dur);
    if (!secs) return toast("Time not understood");
    Object.assign(it, { key: key.trim().toUpperCase(), secs }); await ctLog(it); ctSave(); ctDraw(); return;
  }
  if (act === "dismiss") { Object.assign(it, { status: "skipped", reason: "Dismissed by you" }); ctSave(); return ctDraw(); }
  if (act === "force") { Object.assign(it, { status: "failed", reason: "Waiting for retry" }); if (!it.secs) return ctAct("edit", id); await ctLog(it); ctSave(); return ctDraw(); }
  if (act === "undo") {
    if (!confirm(`Delete the ${secsToDur(it.secs)} worklog on ${it.key} in Jira?`)) return;
    try { await jira(API.delWorklog(it.issueId, it.worklogId), { method: "DELETE" }); Object.assign(it, { status: "skipped", reason: "Undone by you (worklog deleted)" }); ctSave(); ctDraw(); toast("Worklog deleted"); reloadMonths([it.date.slice(0, 7)]).then(() => renderAll()).catch(() => {}); }
    catch (e) { toast(e.message); }
  }
}

(function ctInit() {
  if (typeof document === "undefined") return;
  const view = $("#view-committime"); if (!view) return;
  view.addEventListener("click", (e) => { const b = e.target.closest("[data-ctact]"); if (!b) return; const tr = b.closest("[data-ct]"); ctAct(b.dataset.ctact, tr?.dataset.ct); });
  JT.on("view", (v) => { if (v === "committime") ctDraw(); });
  document.querySelectorAll('.nav[data-view="committime"]').forEach((b) => b.addEventListener("click", () => setTimeout(ctDraw, 0)));
  ctBadge();
  const tick = () => { if (CT.enabled && ctReady() && !document.hidden) ctScan(); };
  JT.on("ready", () => setTimeout(tick, 8000));
  setInterval(tick, CT_EVERY);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && Date.now() - Date.parse(CT.lastScan || 0) > CT_EVERY) tick(); });
  setTimeout(tick, 15000);
})();
if (typeof window !== "undefined") window.CT = CT;
