"use strict";
/* NewersWorld <-> Jira sync. Uses globals from app.js (S, $, esc, loadMonth, ...).
   NewersWorld is reached through the "JiraTime Agent" bookmarklet running inside your logged-in
   NewersWorld tab (postMessage only). No cookies/tokens are read or stored. */

const NWM = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const toNw = (s) => `${s.slice(8)}-${NWM[+s.slice(5, 7) - 1]}-${s.slice(0, 4)}`;
const nwStrip = (s) => String(s || "").replace(/\s+/g, " ").trim();
const mondayIso = (iso) => ymdOf(mondayOf(new Date(iso + "T00:00:00")));

const NWA = { win: null, ready: false, hint: "", seen: [], allowSuffix: [".tothenew.com"], origin: "https://newersworld.tothenew.com", url: (monday) => `https://newersworld.tothenew.com/#/timesheet?date=${toNw(monday)}` };
const NW = { plan: null, dates: [], rows: [], asked: false, busy: false, prefs: { task: "", hours: "jira", comments: false, overwrite: false } };

// ================= agent channel (postMessage) =================
// Accept the expected NewersWorld origin, or any other *.tothenew.com host (e.g. if the portal redirects to a sibling host).
function nwOriginOk(o) {
  if (o === NWA.origin) return true;
  try { const u = new URL(o); return NWA.allowSuffix.some((s) => u.hostname.endsWith(s) && (u.protocol === "https:" || u.hostname === "localhost")); } catch { return false; }
}

window.addEventListener("message", (e) => {
  if (!e.data || e.data.jt !== "ready") return;
  if (!nwOriginOk(e.origin)) { NWA.seen.push(e.origin); toast(`Agent message came from ${e.origin}, which is not a NewersWorld address. Open NewersWorld with the button on this page.`); return; }
  const first = !NWA.ready;
  NWA.origin = e.origin; NWA.win = e.source; NWA.ready = true; nwPill();
  e.source.postMessage({ jt: "ack" }, NWA.origin);          // lets the agent confirm the link works both ways
  if (first) toast("NewersWorld agent connected ✓");
});

function nwCall(msg, timeoutMs = 30000, target) {
  return new Promise((resolve, reject) => {
    if (!NWA.win || NWA.win.closed) { NWA.ready = false; nwPill(); return reject(new Error("NewersWorld tab is not connected. Open it from here and click the JiraTime Agent bookmark.")); }
    const id = uid();
    const onMsg = (e) => {
      const d = e.data;
      if (!d || d.jt !== "res" || d.id !== id || !nwOriginOk(e.origin)) return;
      NWA.origin = e.origin;
      clearTimeout(timer); window.removeEventListener("message", onMsg); resolve(d.res);
    };
    const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("NewersWorld tab did not answer (timeout). Is the tab still open? Click the bookmark again.")); }, timeoutMs);
    window.addEventListener("message", onMsg);
    NWA.win.postMessage({ jt: "req", id, msg }, target || NWA.origin);
  });
}

async function nwPing() {
  // After an app reload the agent re-announces within ~5s; wait for that before giving up.
  if (!NWA.win || NWA.win.closed) {
    NWA.ready = false;
    const t0 = Date.now();
    while ((!NWA.win || NWA.win.closed) && Date.now() - t0 < 6000) await sleep(200);
  }
  try {
    let r; try { r = await nwCall({ type: "JT_PING" }, 2000); } catch { r = await nwCall({ type: "JT_PING" }, 2000, "*"); }
    NWA.ready = !!r?.ok; NWA.hint = "";
  } catch (e) {
    NWA.ready = false;
    NWA.hint = NWA.win && !NWA.win.closed
      ? "The NewersWorld tab is open but its agent does not answer. Click the JiraTime Agent bookmark in THAT tab (the one opened by the button on this page). If it still fails, delete the old bookmark and drag the ⭐ link again from this page." + (NWA.seen.length ? ` (Messages arrived from: ${[...new Set(NWA.seen)].join(", ")})` : "")
      : "No NewersWorld tab is linked. Click “Open NewersWorld”, then click the bookmark in that tab.";
  }
  nwPill();
  return NWA.ready;
}
function nwPill() {
  const p = $("#nwBridge");
  p.className = "pill " + (NWA.ready ? "ok" : "warn");
  p.textContent = NWA.ready ? "● NewersWorld tab connected (live)" : NWT.manual ? "● Manual mode (copy/paste)" : "Agent not connected";
  if (!NWA.ready && NWT.manual) p.className = "pill ok";
  $("#nwSetup").classList.toggle("hidden", NWA.ready || NWT.manual);
  const mt = $("#nwMode"); if (mt) mt.checked = NWT.manual;
}

// ================= transport: live link, or manual copy/paste =================
// Some setups block messages between the two tabs. Manual mode moves the same request/answer through the clipboard.
const NWT = { manual: false };
async function nwOp(type, payload, timeoutMs) {
  if (!NWT.manual && NWA.ready) {
    try { const r = await nwCall({ type, payload }, timeoutMs); if (r?.ok) return r.data; throw new Error(r?.error || "NewersWorld agent failed"); }
    catch (e) { if (!/timeout|not connected/i.test(e.message)) throw e; NWA.ready = false; nwPill(); }
  }
  return nwManual(type, payload);
}
function nwManual(type, payload) {
  return new Promise((resolve, reject) => {
    const id = uid(), req = "JTREQ:" + JSON.stringify({ id, type, payload });
    const write = type === "JT_EXECUTE";
    openModal(`<h3>${write ? "Fill NewersWorld — manual step" : "Read NewersWorld — manual step"}</h3>
      <ol class="steps">
        <li><button id="mCopy" class="small">📋 Copy request</button> <span id="mCopied" class="muted tiny"></span></li>
        <li>Switch to your <b>NewersWorld</b> tab, click the <b>JiraTime Agent</b> bookmark, then <b>Read clipboard</b>${write ? " and <b>Run</b>" : ""}.</li>
        <li>When it says “Result copied”, come back and press <button id="mPaste" class="small">📥 Paste result</button></li>
      </ol>
      <textarea id="mBox" class="mbox" placeholder="…or paste the result here (Ctrl+V)"></textarea>
      <p id="mErr" class="st-failed"></p>
      <div class="foot"><button id="mCancel">Cancel</button></div>`);
    const copy = () => navigator.clipboard.writeText(req).then(() => { $("#mCopied").textContent = "copied ✓"; }).catch(() => { $("#mBox").value = req; $("#mBox").select(); $("#mCopied").textContent = "clipboard blocked — the request is in the box below, press Ctrl+C"; });
    const take = (text) => {
      text = String(text || "").trim(); if (!text.startsWith("JTRES:")) { if (text) $("#mErr").textContent = "That is not a JiraTime result. Copy it again from the NewersWorld tab."; return; }
      let r; try { r = JSON.parse(text.slice(6)); } catch { $("#mErr").textContent = "Result text is incomplete. Copy it again."; return; }
      if (r.id !== id) { $("#mErr").textContent = "This result belongs to an older request. Press “Copy request” again and redo step 2."; return; }
      closeModal(); window.removeEventListener("focus", onFocus);
      r.ok ? resolve(r.data) : reject(new Error(r.error || "NewersWorld agent failed"));
    };
    const onFocus = () => navigator.clipboard.readText().then((t) => { if (t.startsWith("JTRES:")) take(t); }).catch(() => {});
    window.addEventListener("focus", onFocus);
    $("#mCopy").onclick = copy; copy();
    $("#mPaste").onclick = () => navigator.clipboard.readText().then(take).catch(() => { $("#mErr").textContent = "Clipboard blocked — paste into the box (Ctrl+V)."; $("#mBox").focus(); });
    $("#mBox").addEventListener("input", (e) => take(e.target.value));
    $("#mCancel").onclick = () => { closeModal(); window.removeEventListener("focus", onFocus); reject(new Error("Cancelled")); };
  });
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
  if (!NWT.manual && !(await nwPing())) { NWT.manual = true; nwPill(); toast("No live link to the NewersWorld tab — using manual copy/paste mode"); }
  nwReadPrefs(); NW.busy = true; setNwBusy(true, "Reading Jira worklogs…");
  try {
    await ensureRange(from, to);
    const dates = nwWeekdays(from, to);
    if (!dates.length) throw new Error("No weekdays in this range");
    NW.dates = dates;
    const byDate = {}, taskNames = [];
    const mondays = [...new Set(dates.map(mondayIso))];
    setNwBusy(true, `Reading ${mondays.length} NewersWorld week(s)…`);
    const weeks = await nwOp("JT_READ", { mondays }, 120000);
    for (const m of mondays) {
      const w = weeks?.[m];
      if (!w?.ok) throw new Error(w?.status === 401 || w?.status === 403 ? "NewersWorld session expired — log in again in the NewersWorld tab" : w?.error || "Could not read NewersWorld");
      const api = nwNormalizeWeek(w.data, m);
      if (!api) throw new Error("Unexpected NewersWorld response");
      for (const t of api.tasks) if (!taskNames.includes(t.taskName)) taskNames.push(t.taskName);
      for (const d of dates.filter((x) => mondayIso(x) === m)) {
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
  progress("Sending to the NewersWorld tab…");
  const items = rows.map((r) => ({ date: r.date, task: r.task, hours: r.planned, description: nwDescription(r.jd.issues, NW.prefs.comments), wasFilled: !!r.e.alreadyFilled }));
  return (await nwOp("JT_EXECUTE", { items }, 900000)) || [];
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
  try { results = await nwExecute(fill, show); }
  catch (e) {
    if (e.message === "Cancelled") { NW.busy = false; setNwBusy(false); renderNw(); return; }
    results.push({ date: fill[0]?.date || todayStr(), status: "error", ok: false, error: e.message });
  }
  const okN = results.filter((r) => r.status === "filled_saved").length, bad = results.filter((r) => r.ok === false).length;
  openModal(`<h3>NewersWorld sync finished</h3><p><b>${okN}</b> filled & verified · <b>${bad}</b> problem(s)</p>
    <div class="scroll" style="max-height:50vh"><table>${results.sort((a, b) => a.date.localeCompare(b.date)).map((r) => `<tr><td>${prettyDate(r.date)}</td><td class="${r.ok === false ? "st-failed" : "st-success"}">${esc(NW_LABELS[r.status] || r.status)}${r.error ? " — " + esc(r.error) : ""}</td></tr>`).join("")}</table></div>
    <div class="foot"><button id="nwDone" class="primary">Close</button></div>`);
  $("#nwDone").onclick = closeModal;
  NW.busy = false; setNwBusy(false);
  if (NWA.ready && !NWT.manual) { await nwRead(); return; }
  // manual mode: update the table from the results instead of another copy/paste round trip
  const byDate = Object.fromEntries(results.map((r) => [r.date, r]));
  for (const row of NW.rows) {
    const r = byDate[row.date]; if (!r) continue;
    if (r.status === "filled_saved") Object.assign(row, { status: "match", label: "Filled now ✓", fill: false, nwHours: row.planned });
    else if (r.ok === false) Object.assign(row, { status: "bad", label: NW_LABELS[r.status] || r.status });
    else Object.assign(row, { status: "skip", label: NW_LABELS[r.status] || r.status, fill: false });
  }
  renderNw();
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
  NWT.manual = !!(await store.get("nwManual", false));
  $("#nwBridge").insertAdjacentHTML("afterend", '<label class="check tiny"><input id="nwMode" type="checkbox"> Manual mode (copy/paste)</label>');
  $("#nwMode").checked = NWT.manual;
  $("#nwMode").addEventListener("change", (e) => { NWT.manual = e.target.checked; store.set("nwManual", NWT.manual); nwPill(); });
  const now = new Date();
  $("#nwFrom").value = ymd(now.getFullYear(), now.getMonth(), 1);
  $("#nwTo").value = todayStr(); $("#nwTo").max = todayStr();
  $("#nwHours").value = NW.prefs.hours; $("#nwComments").checked = NW.prefs.comments; $("#nwOverwrite").checked = NW.prefs.overwrite;
  $("#nwRead").onclick = () => nwRead();
  $("#nwLeave").onclick = () => nwRead(true);
  $("#nwSync").onclick = nwSyncConfirm;
  ["nwHours", "nwComments", "nwOverwrite", "nwTask"].forEach((id) => $("#" + id).addEventListener("change", () => { nwReadPrefs(); nwBuildRows(); }));
  document.querySelector('.nav[data-view="nw"]').addEventListener("click", nwOpened);

  $("#nwOpen").onclick = () => {
    if (NWA.ready && NWA.win && !NWA.win.closed) { NWA.win.focus(); toast("Already connected — switched to the NewersWorld tab"); return; }   // do not reload a connected tab
    NWA.win = window.open(NWA.url(mondayIso(todayStr())), "jt-newersworld");
  };
  try {
    const code = (await fetch("/nw-agent.js").then((r) => r.text())).replace(/__APP_ORIGIN__/g, location.origin);
    $("#nwBm").setAttribute("href", "javascript:" + encodeURIComponent(code));
    $("#nwBm").addEventListener("click", (e) => { e.preventDefault(); toast("Don't click here — drag this to your bookmarks bar, then click it inside the NewersWorld tab."); });
    $("#nwCopy").onclick = async () => { await navigator.clipboard.writeText(code); toast("Script copied. Paste it in the NewersWorld tab's DevTools console (type “allow pasting” first)."); };
  } catch { /* offline */ }
  $("#nwSetup").insertAdjacentHTML("beforeend", `<p class="muted tiny" style="margin:8px 0 0">This bookmark only works for <b>${esc(location.origin)}</b>. Made it earlier for another address (e.g. localhost)? Delete it and drag the ⭐ link again from this page.</p>`);
  nwPill();
})();
