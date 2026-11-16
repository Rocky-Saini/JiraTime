"use strict";
/* NewersWorld <-> Jira sync. Uses globals from app.js (S, $, esc, loadMonth, ...).
   NewersWorld is reached through the "JiraTime Agent" bookmarklet running inside your logged-in
   NewersWorld tab (postMessage only). No cookies/tokens are read or stored. */

const NWM = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toNw = (s) => `${s.slice(8)}-${NWM[+s.slice(5, 7) - 1]}-${s.slice(0, 4)}`;
const nwStrip = (s) => String(s || "").replace(/\s+/g, " ").trim();
const mondayIso = (iso) => ymdOf(mondayOf(new Date(iso + "T00:00:00")));

const NWA = { win: null, ready: false, origin: "https://newersworld.tothenew.com", url: (monday) => `https://newersworld.tothenew.com/#/timesheet?date=${toNw(monday)}` };
const NW = { plan: null, dates: [], rows: [], asked: false, busy: false, prefs: { task: "", hours: "jira", comments: false, overwrite: false } };

// ================= agent channel (postMessage) =================
window.addEventListener("message", (e) => {
  if (e.origin !== NWA.origin || !e.data || e.data.jt !== "ready") return;
  NWA.win = e.source; NWA.ready = true; nwPill(); toast("NewersWorld agent connected ✓");
});

function nwCall(msg, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!NWA.win || NWA.win.closed) { NWA.ready = false; nwPill(); return reject(new Error("NewersWorld tab is not connected. Open it from here and click the JiraTime Agent bookmark.")); }
    const id = uid();
    const onMsg = (e) => {
      const d = e.data;
      if (e.origin !== NWA.origin || !d || d.jt !== "res" || d.id !== id) return;
      clearTimeout(timer); window.removeEventListener("message", onMsg); resolve(d.res);
    };
    const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("NewersWorld tab did not answer (timeout). Is the tab still open? Click the bookmark again.")); }, timeoutMs);
    window.addEventListener("message", onMsg);
    NWA.win.postMessage({ jt: "req", id, msg }, NWA.origin);
  });
}

async function nwPing() {
  try { NWA.ready = !!(await nwCall({ type: "JT_PING" }, 1500))?.ok; } catch { NWA.ready = false; }
  nwPill();
  return NWA.ready;
}
function nwPill() {
  const p = $("#nwBridge");
  p.className = "pill " + (NWA.ready ? "ok" : "warn");
  p.textContent = NWA.ready ? "● NewersWorld tab connected" : "Agent not connected";
  $("#nwSetup").classList.toggle("hidden", NWA.ready);
}

// ================= week API (ported from the old extension) =================
function nwNormalizeWeek(data, monday) {
  if (!data || typeof data !== "object") return null;
  const states = {}, tasks = new Map();
  for (let i = 0; i < 7; i++) { const d = ymdOf(addDays(new Date(monday + "T00:00:00"), i)); states[d] = { dateStr: d, filled: false, entries: [], records: [], onLeave: false, leaveTypes: [], isEditable: false }; }
  const projects = [...(Array.isArray(data.projects) ? data.projects : []), ...(Array.isArray(data.nonAllocatedProjects) ? data.nonAllocatedProjects : [])];
  for (const project of projects) for (const task of Array.isArray(project.tasks) ? project.tasks : []) {
    const taskName = nwStrip(task.taskName || "Development");
    if (!tasks.has(taskName)) tasks.set(taskName, { taskName });
    for (const day of Array.isArray(task.dates) ? task.dates : []) {
      const st = states[String(day.date || "")]; if (!st) continue;
      const rec = { taskName, hours: String(Number(day.hours || 0)), description: nwStrip(day.comment), tsbID: day.tsbID ?? null, isEditable: day.isEditable !== false, dateStr: st.dateStr };
      st.records.push(rec);
      if (rec.isEditable) st.isEditable = true;
      for (const lv of Array.isArray(day.leavesDetails) ? day.leavesDetails : []) {
        const t = nwStrip(lv?.leaveType);
        if (t && !/week\s*off/i.test(t)) { st.onLeave = true; if (!st.leaveTypes.includes(t)) st.leaveTypes.push(t); }
      }
      if (Number(day.hours || 0) > 0 || nwStrip(day.comment)) { st.filled = true; st.entries.push(rec); }
    }
  }
  return { ok: true, states, tasks: [...tasks.values()], records: Object.values(states).flatMap((s) => s.records) };
}

async function nwFetchWeek(monday) {
  const end = ymdOf(addDays(new Date(monday + "T00:00:00"), 6));
  const r = await nwCall({ type: "TIMESHEET_FETCH_WEEK_API", startDate: monday, endDate: end }, 60000);
  if (!r?.ok) {
    const expired = r?.status === 401 || r?.status === 403;
    return { ok: false, error: expired ? "NewersWorld session expired — log in again in the NewersWorld tab" : r?.error || "Week-view API failed" };
  }
  return nwNormalizeWeek(r.data, monday) || { ok: false, error: "Unexpected NewersWorld response" };
}

function nwBuildPayload(api, changes) {
  const overrides = new Map(), missing = new Set();
  for (const [date, templates] of Object.entries(changes)) {
    const records = api.states[date]?.records || [], used = new Set();
    for (const t of templates) {
      let rec = records.find((r) => !used.has(r.tsbID) && nwStrip(r.taskName).toLowerCase() === nwStrip(t.taskName).toLowerCase());
      if (!rec && records.length === 1 && templates.length === 1) rec = records[0];
      if (!rec?.tsbID) { missing.add(date); continue; }
      if (rec.isEditable === false) return { ok: false, error: `${date} is not editable in NewersWorld` };
      used.add(rec.tsbID); overrides.set(rec.tsbID, { hours: String(Number(t.hours)), comment: nwStrip(t.description) || null });
    }
  }
  if (missing.size) return { ok: false, needsDomFill: true, error: `No booking rows for ${[...missing].join(", ")}` };
  const payload = [];
  for (const r of api.records) {
    if (!r.tsbID || isWeekend(r.dateStr)) continue;
    let hours = Number(r.hours || 0) > 0 ? String(Number(r.hours)) : null, comment = nwStrip(r.description) || null;
    const o = overrides.get(r.tsbID); if (o) { hours = o.hours; comment = o.comment; }
    payload.push({ tsbID: r.tsbID, hours, comment });
  }
  return payload.length ? { ok: true, payload } : { ok: false, error: "No editable records for this week" };
}

function nwMatches(state, tpls) {
  if (!state?.filled) return false;
  return tpls.every((t) => state.entries.some((e) =>
    (nwStrip(e.taskName).toLowerCase() === nwStrip(t.taskName).toLowerCase() || (tpls.length === 1 && state.entries.length === 1)) &&
    Math.abs(Number(e.hours || 0) - Number(t.hours || 0)) < 0.001 && nwStrip(e.description) === nwStrip(t.description)));
}

// ================= leave import (NewersWorld -> Jira calendar) =================
async function nwImportLeaves(dates) {
  let added = 0, removed = 0; const leave = new Set();
  for (const d of dates) {
    const e = NW.plan.byDate[d]; if (!e?.onLeave) continue;
    leave.add(d);
    const label = (e.leaveTypes || ["Leave"]).join(", "), type = /holiday/i.test(label) ? "holiday" : "leave", prev = S.holidays[d];
    if (!prev || prev.source === "newersworld") { if (!prev || prev.label !== label) added++; S.holidays[d] = { label, type, source: "newersworld" }; }
  }
  for (const d of dates) if (!leave.has(d) && S.holidays[d]?.source === "newersworld") { delete S.holidays[d]; removed++; }
  await store.set("holidays", S.holidays); renderHolidays(); renderCalendar();
  return { added, removed, total: leave.size };
}

// ================= helpers =================
function nwWeekdays(from, to) {
  const out = [];
  for (let t = new Date(from + "T00:00:00"); ymdOf(t) <= to; t.setDate(t.getDate() + 1)) { const s = ymdOf(t); if (!isWeekend(s)) out.push(s); }
  return out;
}
function jiraDay(date) {
  const md = monthData(date), entries = md.byDate[date]?.entries || [];
  if (!entries.length) return null;
  const map = new Map();
  for (const e of entries) {
    const g = map.get(e.issueId) || { key: e.issueKey, summary: md.issues[e.issueId]?.summary || "", secs: 0, comments: [] };
    g.secs += e.secs; if (e.comment && !g.comments.includes(e.comment)) g.comments.push(e.comment);
    map.set(e.issueId, g);
  }
  const issues = [...map.values()].sort((a, b) => b.secs - a.secs);
  return { secs: issues.reduce((a, i) => a + i.secs, 0), issues };
}
function nwDescription(issues, withComments) {
  const showHours = issues.length > 1;
  const d = issues.map((i) => {
    let t = i.key && i.summary ? `${i.key} - ${i.summary}` : i.key || i.summary || "Worklog";
    if (showHours) t += ` (${fmtH(i.secs)})`;
    if (withComments && i.comments.length) t += ` [${i.comments.join(" / ")}]`;
    return t;
  }).join("; ");
  return d.length > 240 ? d.slice(0, 239).trimEnd() + "…" : d;
}
function nwReadPrefs() {
  NW.prefs = { task: $("#nwTask").value, hours: $("#nwHours").value, comments: $("#nwComments").checked, overwrite: $("#nwOverwrite").checked };
  store.set("nwPrefs", NW.prefs);
}
function setNwBusy(on, msg) {
  ["nwRead", "nwSync", "nwLeave"].forEach((id) => { $("#" + id).disabled = on || (id === "nwSync" && !NW.rows.some((r) => r.fill)); });
  if (on) $("#nwSummary").textContent = "⏳ " + msg;
}

// ================= read & compare =================
async function nwRead(leaveOnly = false) {
  if (NW.busy) return;
  const from = $("#nwFrom").value, to0 = $("#nwTo").value || todayStr(), to = to0 > todayStr() ? todayStr() : to0;
  if (!from || from > to) { toast("Pick a valid From date (not after today)"); return; }
  if (!S.me) { toast("Connect Jira first"); return; }
  if (!(await nwPing())) { toast("Connect the NewersWorld tab first (steps above)"); return; }
  nwReadPrefs(); NW.busy = true; setNwBusy(true, "Reading Jira worklogs…");
  try {
    await ensureRange(from, to);
    const dates = nwWeekdays(from, to);
    if (!dates.length) throw new Error("No weekdays in this range");
    NW.dates = dates;
    const byDate = {}, taskNames = [];
    const mondays = [...new Set(dates.map(mondayIso))];
    for (let i = 0; i < mondays.length; i++) {
      setNwBusy(true, `Reading NewersWorld week ${i + 1} of ${mondays.length}…`);
      const api = await nwFetchWeek(mondays[i]);
      if (!api.ok) throw new Error(api.error);
      for (const t of api.tasks) if (!taskNames.includes(t.taskName)) taskNames.push(t.taskName);
      for (const d of dates.filter((x) => mondayIso(x) === mondays[i])) {
        const st = api.states[d];
        byDate[d] = { onLeave: st.onLeave, leaveTypes: st.leaveTypes, locked: !st.isEditable, alreadyFilled: st.filled, existingEntries: st.entries, tasks: api.tasks };
      }
    }
    NW.plan = { byDate, tasks: taskNames };
    const lv = await nwImportLeaves(dates);
    const sel = $("#nwTask");
    sel.innerHTML = taskNames.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join("") || '<option value="">(no task found)</option>';
    sel.value = taskNames.includes(NW.prefs.task) ? NW.prefs.task : taskNames[0] || "";
    nwReadPrefs(); nwBuildRows();
    toast(`Leave imported: ${lv.total} day(s)${lv.removed ? `, ${lv.removed} removed` : ""}`);
    if (leaveOnly) { $("#nwTable").innerHTML = ""; $("#nwSummary").textContent = `Leave days found in NewersWorld: ${lv.total}`; }
  } catch (e) { toast(e.message); $("#nwSummary").innerHTML = `<span class="st-failed">${esc(e.message)}</span>`; }
  finally { NW.busy = false; setNwBusy(false); }
}

function nwBuildRows() {
  if (!NW.plan) return;
  const target = S.settings.target;
  NW.rows = NW.dates.map((date) => {
    const e = NW.plan.byDate[date], jd = jiraDay(date), jh = jd ? jd.secs / 3600 : 0;
    const planned = Math.min(24, Math.round((NW.prefs.hours === "target" ? target : jh) * 100) / 100);
    const nwHours = (e?.existingEntries || []).reduce((a, x) => a + Number(x.hours || 0), 0);
    const names = (e?.tasks || []).map((t) => t.taskName);
    const task = e?.existingEntries?.[0]?.taskName || (names.includes(NW.prefs.task) ? NW.prefs.task : names[0] || NW.prefs.task);
    const r = { date, jd, e, planned, nwHours, task, status: "new", label: "Will fill", fill: false };
    const hol = S.holidays[date];
    if (e?.onLeave) Object.assign(r, { status: "leave", label: "Leave: " + (e.leaveTypes || []).join(", ") });
    else if (hol && hol.source !== "newersworld") Object.assign(r, { status: "skip", label: `${hol.type} (Jira calendar): ${hol.label}` });
    else if (e?.locked) Object.assign(r, { status: "skip", label: "Locked in NewersWorld" });
    else if (!jd) Object.assign(r, { status: "skip", label: "No Jira worklog" });
    else if (!e) Object.assign(r, { status: "skip", label: "Not read" });
    else if (!task) Object.assign(r, { status: "bad", label: "No task available" });
    else if (e.alreadyFilled) {
      if (Math.abs(nwHours - planned) < 0.01) Object.assign(r, { status: "match", label: "Already in sync" });
      else Object.assign(r, { status: "diff", label: `Filled ${nwHours}h ≠ ${planned}h`, fill: NW.prefs.overwrite });
    } else r.fill = true;
    return r;
  });
  renderNw();
}

function renderNw() {
  const rows = NW.rows, fill = rows.filter((r) => r.fill), cnt = (s) => rows.filter((r) => r.status === s).length;
  $("#nwSummary").innerHTML = `<b>${fill.length}</b> day(s) to fill (<b>${fmtH(fill.reduce((a, r) => a + r.planned * 3600, 0))}</b>) · in sync ${cnt("match")} · differ ${cnt("diff")}${NW.prefs.overwrite ? " (will overwrite)" : " (kept)"} · leave ${cnt("leave")} · skipped ${cnt("skip")}`;
  $("#nwTable").innerHTML = `<tr><th>Date</th><th>Jira</th><th>NewersWorld</th><th>Status</th></tr>` + rows.map((r) => `<tr>
    <td>${prettyDate(r.date)}<small>${DOW[(new Date(r.date + "T00:00:00").getDay() + 6) % 7]}</small></td>
    <td>${r.jd ? `<b>${fmtH(r.jd.secs)}</b><small>${esc(r.jd.issues.map((i) => i.key).join(", "))}</small>` : '<span class="muted">—</span>'}</td>
    <td>${r.nwHours ? `${r.nwHours}h` : '<span class="muted">empty</span>'}${r.fill ? `<small>→ ${r.planned}h on ${esc(r.task)}</small>` : ""}</td>
    <td><span class="b ${r.status === "new" ? "new" : r.status}">${esc(r.label)}</span></td></tr>`).join("");
  $("#nwSync").disabled = !fill.length || NW.busy;
}

// ================= execute (ported from the old extension) =================
async function nwExecute(rows, progress) {
  const results = [], push = (date, status, ok, error) => results.push({ date, status, ok, error });
  const groups = {};
  rows.forEach((r) => (groups[mondayIso(r.date)] ||= []).push(r));
  let n = 0;
  for (const [monday, list] of Object.entries(groups)) {
    progress(`Week of ${prettyDate(monday)} (${++n}/${Object.keys(groups).length})…`);
    const api = await nwFetchWeek(monday);
    if (!api.ok) { list.forEach((r) => push(r.date, "error", false, api.error)); continue; }
    const changes = {}, pending = [];
    for (const r of list) {
      const st = api.states[r.date];
      if (st?.onLeave) { push(r.date, "leave_skipped", true); continue; }
      if (st && !st.isEditable) { push(r.date, "locked_skipped", true); continue; }
      if (st?.filled && !r.e.alreadyFilled) { push(r.date, "already_filled", true); continue; }   // filled since we read it
      const tpl = [{ taskName: r.task, hours: String(r.planned), description: nwDescription(r.jd.issues, NW.prefs.comments) }];
      changes[r.date] = tpl; pending.push({ date: r.date, tpl });
    }
    if (!pending.length) continue;
    const built = nwBuildPayload(api, changes);
    if (built.ok) {
      const save = await nwCall({ type: "TIMESHEET_SAVE_API", payload: built.payload }, 60000);
      if (!save?.ok) { pending.forEach((p) => push(p.date, "filled_not_saved", false, save?.error || "Save failed")); continue; }
      await sleep(500);
    } else if (built.needsDomFill) {
      // Empty days have no booking row yet -> type into the NewersWorld grid and press its SAVE (same as the old extension).
      const go = await nwCall({ type: "JT_GOTO", mondayStr: toNw(monday) }, 90000);
      if (!go?.ok) { pending.forEach((p) => push(p.date, "error", false, "Could not open the week in NewersWorld tab")); continue; }
      let any = false;
      for (const p of pending) {
        const f = await nwCall({ type: "TIMESHEET_FILL_DATE", dateStr: toNw(p.date), tasks: p.tpl, save: false, overwrite: rows.find((r) => r.date === p.date).e.alreadyFilled }, 30000);
        if (f?.ok && !f.alreadyFilled) any = true; else if (f?.alreadyFilled) { push(p.date, "already_filled", true); p.skip = true; } else { push(p.date, "error", false, f?.error || "Fill failed"); p.skip = true; }
        await sleep(150);
      }
      if (!any) continue;
      await sleep(500);
      const sv = await nwCall({ type: "TIMESHEET_SAVE_WEEK" }, 30000);
      if (!(sv?.ok && sv.status === "CLICKED")) { pending.filter((p) => !p.skip).forEach((p) => push(p.date, "filled_not_saved", false, `Save button: ${sv?.status || sv?.error || "unknown"}`)); continue; }
      await sleep(2800);
    } else { pending.forEach((p) => push(p.date, "error", false, built.error)); continue; }
    // verify against the portal
    const check = await nwFetchWeek(monday);
    for (const p of pending.filter((x) => !x.skip)) {
      if (nwMatches(check.ok ? check.states[p.date] : null, p.tpl)) push(p.date, "filled_saved", true);
      else push(p.date, "fill_not_persisted", false, check.error || "Portal shows different values after save");
    }
  }
  return results;
}

const NW_LABELS = { filled_saved: "Filled & saved ✓", already_filled: "Already filled — skipped", filled_not_saved: "Filled, could not save", fill_not_persisted: "Save did not persist", leave_skipped: "Leave — skipped", locked_skipped: "Locked — skipped", error: "Failed" };

function nwSyncConfirm() {
  const fill = NW.rows.filter((r) => r.fill);
  if (!fill.length) return;
  const overwrite = fill.filter((r) => r.e.alreadyFilled).length;
  openModal(`<h3>Fill NewersWorld timesheet?</h3>
    <p><b>${fill.length}</b> day(s), <b>${fmtH(fill.reduce((a, r) => a + r.planned * 3600, 0))}</b> total. ${overwrite ? `<span class="st-failed">${overwrite} filled day(s) will be overwritten.</span>` : "No existing entries are overwritten."}</p>
    <div class="scroll" style="max-height:40vh"><table>${fill.map((r) => `<tr><td>${prettyDate(r.date)}</td><td>${r.planned}h</td><td>${esc(r.task)}</td><td><small>${esc(nwDescription(r.jd.issues, NW.prefs.comments).slice(0, 110))}</small></td></tr>`).join("")}</table></div>
    <p class="muted tiny">Keep the NewersWorld tab open. Saved one week at a time and verified. Leave and locked days are never touched.</p>
    <div class="foot"><button id="nwNo">Cancel</button><button id="nwYes" class="primary">Fill ${fill.length} day(s)</button></div>`);
  $("#nwNo").onclick = closeModal; $("#nwYes").onclick = nwSync;
}

async function nwSync() {
  const fill = NW.rows.filter((r) => r.fill);
  NW.busy = true; setNwBusy(true, "Filling NewersWorld…");
  const show = (t) => openModal(`<h3>Filling NewersWorld…</h3><p class="muted">${esc(t)} Keep the NewersWorld tab open.</p>`);
  show("Starting…");
  let results = [];
  try { results = await nwExecute(fill, show); } catch (e) { results.push({ date: fill[0]?.date || todayStr(), status: "error", ok: false, error: e.message }); }
  const okN = results.filter((r) => r.status === "filled_saved").length, bad = results.filter((r) => r.ok === false).length;
  openModal(`<h3>NewersWorld sync finished</h3><p><b>${okN}</b> filled & verified · <b>${bad}</b> problem(s)</p>
    <div class="scroll" style="max-height:50vh"><table>${results.sort((a, b) => a.date.localeCompare(b.date)).map((r) => `<tr><td>${prettyDate(r.date)}</td><td class="${r.ok === false ? "st-failed" : "st-success"}">${esc(NW_LABELS[r.status] || r.status)}${r.error ? " — " + esc(r.error) : ""}</td></tr>`).join("")}</table></div>
    <div class="foot"><button id="nwDone" class="primary">Close</button></div>`);
  $("#nwDone").onclick = closeModal;
  NW.busy = false; setNwBusy(false);
  await nwRead();
}

// ================= entering the page =================
async function nwOpened() {
  await nwPing();
  if (NW.asked || NW.plan) return;
  NW.asked = true;
  openModal(`<h3>Sync NewersWorld with Jira?</h3>
    <p>Compare your Jira worklogs with the NewersWorld timesheet <b>from ${prettyDate($("#nwFrom").value)} till today</b>, import your leave dates, and fill the missing days.</p>
    <p class="muted tiny">${NWA.ready ? "" : "First connect the NewersWorld tab (steps on the page). "}You will see a full preview first. Nothing is saved to NewersWorld until you confirm.</p>
    <div class="foot"><button id="nwLater">Not now</button><button id="nwNow" class="primary">Yes, read &amp; compare</button></div>`);
  $("#nwLater").onclick = closeModal;
  $("#nwNow").onclick = () => { closeModal(); nwRead(); };
}

(async function nwInit() {
  NW.prefs = { ...NW.prefs, ...(await store.get("nwPrefs", {})) };
  const now = new Date();
  $("#nwFrom").value = ymd(now.getFullYear(), now.getMonth(), 1);
  $("#nwTo").value = todayStr(); $("#nwTo").max = todayStr();
  $("#nwHours").value = NW.prefs.hours; $("#nwComments").checked = NW.prefs.comments; $("#nwOverwrite").checked = NW.prefs.overwrite;
  $("#nwRead").onclick = () => nwRead();
  $("#nwLeave").onclick = () => nwRead(true);
  $("#nwSync").onclick = nwSyncConfirm;
  ["nwHours", "nwComments", "nwOverwrite", "nwTask"].forEach((id) => $("#" + id).addEventListener("change", () => { nwReadPrefs(); nwBuildRows(); }));
  document.querySelector('.nav[data-view="nw"]').addEventListener("click", nwOpened);

  $("#nwOpen").onclick = () => { NWA.win = window.open(NWA.url(mondayIso(todayStr())), "jt-newersworld"); };
  try {
    const code = await fetch("/nw-agent.js").then((r) => r.text());
    $("#nwBm").setAttribute("href", "javascript:" + encodeURIComponent(code));
    $("#nwBm").addEventListener("click", (e) => { e.preventDefault(); toast("Don't click here — drag this to your bookmarks bar, then click it inside the NewersWorld tab."); });
    $("#nwCopy").onclick = async () => { await navigator.clipboard.writeText(code); toast("Script copied. Paste it in the NewersWorld tab's DevTools console (type “allow pasting” first)."); };
  } catch { /* offline */ }
  nwPill();
})();
