"use strict";
/* Day details (view / edit / delete the worklogs of one day), the Today card, and Quick log.
   Uses globals from app.js and window.JTT from templates.js. */

const dayTitle = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" });
const ST_LABEL = { done: "Complete", partial: "Partial", missing: "Missing", holiday: "Holiday / leave" };

// ================= day details =================
async function openDay(date) {
  openModal(`<h3>${esc(dayTitle(date))}</h3><p class="muted">Loading worklogs…</p>`);
  try { await ensureDates([date]); }
  catch (e) { openModal(`<h3>${esc(dayTitle(date))}</h3><p class="st-failed">${esc(e.message)}</p><div class="foot"><button id="dyClose" class="primary">Close</button></div>`); $("#dyClose").onclick = closeModal; return; }
  renderDay(date);
}

function renderDay(date) {
  const md = monthData(date), day = md.byDate[date] || { secs: 0, entries: [] }, hol = holidayOf(date);
  const target = S.settings.target * 3600, st = dayStatus(date, md);
  const label = ST_LABEL[st] || (isWeekend(date) ? "Weekend" : "Not logged yet");
  const defP = JTT.planFor(date) || JTT.defaultPlan();
  openModal(`
    <div class="dyhead"><h3>${esc(dayTitle(date))}</h3><span class="b ${st === "done" ? "new" : st === "partial" ? "diff" : st === "missing" ? "bad" : "skip"}">${esc(label)}</span></div>
    ${hol ? `<p class="muted">🏖 ${esc(hol.label)} (${esc(hol.type)})</p>` : ""}
    <p style="margin:10px 0 4px"><b>${fmtH(day.secs)}</b> of ${S.settings.target}h logged</p>
    <div class="progress"><div style="height:100%;width:${Math.min(100, (day.secs / target) * 100)}%;background:${day.secs > target ? "var(--bad)" : "linear-gradient(90deg,var(--acc),var(--acc2))"}"></div></div>
    <div class="scroll"><table class="dytable"><tr><th>Issue</th><th>Hours</th><th>Comment</th><th></th></tr>
      ${day.entries.map((e, i) => `<tr data-i="${i}">
        <td><b>${esc(e.issueKey)}</b><small class="muted">${esc((md.issues[e.issueId]?.summary || "").slice(0, 60))}</small></td>
        <td><input class="dyh" value="${esc(secsToDur(e.secs))}" aria-label="Hours"></td>
        <td><input class="dyc" value="${esc(e.comment)}" aria-label="Comment"></td>
        <td class="nowrap"><button class="small dysave" disabled>Save</button> <button class="small danger dydel" title="Delete this worklog">🗑</button></td></tr>`).join("") ||
        '<tr><td colspan="4" class="muted">No worklogs on this day.</td></tr>'}
    </table></div>
    <h4>Add work</h4>
    <div class="row-actions">
      ${JTT.plans.length ? `<select id="dyPlan" aria-label="Day plan">${JTT.planOptions(defP?.id)}</select><button id="dyFill" class="small">Fill with plan</button>` : '<span class="muted tiny">No day plans yet (Templates page).</span>'}
      <select id="dyTpl" aria-label="Template"><option value="">＋ One template…</option>${JTT.tOptions("")}</select>
    </div>
    <div class="foot"><button id="dyClose">Close</button></div>`);
  const box = $("#modalBox");
  $("#dyClose").onclick = closeModal;
  box.querySelectorAll(".dytable tr[data-i]").forEach((tr) => {
    const e = day.entries[+tr.dataset.i], h = tr.querySelector(".dyh"), c = tr.querySelector(".dyc"), save = tr.querySelector(".dysave");
    const dirty = () => { save.disabled = !(parseDuration(h.value) && (parseDuration(h.value) !== e.secs || c.value.trim() !== e.comment)); h.style.borderColor = parseDuration(h.value) ? "" : "var(--bad)"; };
    h.addEventListener("input", dirty); c.addEventListener("input", dirty);
    save.onclick = () => saveEntry(date, e, h.value, c.value.trim(), save);
    tr.querySelector(".dydel").onclick = () => deleteEntry(date, e);
  });
  $("#dyFill")?.addEventListener("click", async () => {
    const p = JTT.pGet($("#dyPlan").value); if (!p) return;
    const r = await JTT.planJobs(p, date);
    if (r.missing.length) toast(`Skipped (no Jira issue): ${r.missing.join(", ")}`);
    if (r.jobs.length) openPreview(r.jobs); else toast("Nothing to add from this plan");
  });
  $("#dyTpl").onchange = async (ev) => {
    const t = JTT.tGet(ev.target.value); if (!t) return;
    if (!t.issue) { toast(`“${t.name}” has no Jira issue yet (Templates page)`); ev.target.value = ""; return; }
    await ensureDates([date]);
    openPreview([makeJob(t.issue, date, t.duration, t.comment, true)]);
  };
}

async function saveEntry(date, e, hours, comment, btn) {
  const secs = parseDuration(hours); if (!secs) { toast("Hours look wrong (e.g. 2h, 1h 30m)"); return; }
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    await jira(API.editWorklog(e.issueId, e.id), { method: "PUT", body: JSON.stringify({ timeSpentSeconds: secs, comment }) });
    S.history.unshift({ id: uid(), ts: new Date().toISOString(), date, issueKey: e.issueKey, issueId: String(e.issueId), duration: secsToDur(secs), comment, status: "edited", error: `was ${secsToDur(e.secs)}`, worklogId: e.id });
    await store.set("history", S.history);
    await reloadMonths([date.slice(0, 7)]);
    renderCalendar(); renderDay(date); toast("Worklog updated");
  } catch (err) { btn.disabled = false; btn.textContent = "Save"; toast("Update failed: " + err.message); }
}

async function deleteEntry(date, e) {
  if (!confirm(`Delete ${fmtH(e.secs)} on ${e.issueKey} (${prettyDate(date)}) from Jira?`)) return;
  try {
    await jira(API.delWorklog(e.issueId, e.id), { method: "DELETE" });
  } catch (err) { if (err.status !== 404) { toast("Delete failed: " + err.message); return; } }
  S.history.forEach((h) => { if (String(h.worklogId) === String(e.id)) h.deleted = true; });
  await store.set("history", S.history);
  await reloadMonths([date.slice(0, 7)]).catch(() => {});
  renderCalendar(); renderDay(date); toast("Worklog deleted");
}

// ================= today card =================
function renderToday() {
  const el = $("#todayCard"); if (!el || !window.JTT) return;
  if (!S.me) { el.classList.add("hidden"); return; }
  const t = todayStr(), md = monthView(t.slice(0, 7)), secs = md.byDate[t]?.secs || 0, target = S.settings.target * 3600, hol = holidayOf(t);
  const next = window.JTS?.nextRunText?.() || "";
  el.classList.remove("hidden");
  if (hol) { el.innerHTML = `<div class="tc-l">🏖 <b>Today</b> is ${esc(hol.type)}: ${esc(hol.label)} <span class="muted tiny">${esc(next)}</span></div>`; return; }
  if (isWeekend(t) && !S.settings.weekend) { el.innerHTML = `<div class="tc-l">🌴 <b>Weekend</b> — nothing to log today. <span class="muted tiny">${esc(next)}</span></div>`; return; }
  const defP = JTT.planFor(t) || JTT.defaultPlan(), done = secs >= target;
  el.innerHTML = `<div class="tc-l"><b>Today</b> · ${esc(dayTitle(t))}
      <div class="tc-bar"><div style="width:${Math.min(100, Math.round((secs / target) * 100))}%"></div></div>
      <span><b>${fmtH(secs)}</b> / ${S.settings.target}h logged${done ? " ✓" : ""}</span> <span class="muted tiny">${esc(next)}</span></div>
    <div class="tc-r">${done ? "" : JTT.plans.length
      ? `<select id="tcPlan" aria-label="Day plan">${JTT.planOptions(defP?.id)}</select><button id="tcFill" class="small primary-s">Fill rest with plan</button>`
      : '<button id="tcMake" class="small">Create a day plan</button>'}<button id="tcOpen" class="small">Open day</button></div>`;
  $("#tcOpen").onclick = () => openDay(t);
  $("#tcMake")?.addEventListener("click", () => document.querySelector('.nav[data-view="templates"]')?.click());
  $("#tcFill")?.addEventListener("click", async () => {
    const p = JTT.pGet($("#tcPlan").value); if (!p) return;
    const r = await JTT.planJobs(p, t);     // issues already logged today are left unticked (skip duplicates)
    if (r.missing.length) toast(`Skipped (no Jira issue): ${r.missing.join(", ")}`);
    if (r.jobs.length) openPreview(r.jobs);
  });
}

// ================= quick log =================
const QL_DUR = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b(?:\s*(\d+)\s*(?:m|min|mins|minutes)\b)?|(\d+)\s*(?:m|min|mins|minutes)\b/i;
const QL_WD = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7 };
const QL_MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "2h DSM, 6h AWS Connect: contact flow fixes yesterday" -> { dates, items } */
function qlParse(text, now = new Date()) {
  let t = ` ${String(text || "").replace(/\s+/g, " ")} `;
  const dates = new Set(), today = ymdOf(now), notes = [];
  const take = (re, fn) => { t = t.replace(re, (...m) => { fn(m); return " "; }); };
  const addDate = (d) => { if (/^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + "T00:00:00"))) dates.add(d); else notes.push("bad date"); };
  const workdaysBetween = (a, b) => { for (let x = new Date(a); ymdOf(x) <= ymdOf(b); x.setDate(x.getDate() + 1)) if (!isOffDay(ymdOf(x))) dates.add(ymdOf(x)); };
  take(/\bthis week\b/gi, () => workdaysBetween(mondayOf(now), now));
  take(/\blast week\b/gi, () => { const m = addDays(mondayOf(now), -7); workdaysBetween(m, addDays(m, 4)); });
  take(/\b(day before yesterday|parso|parson)\b/gi, () => dates.add(ymdOf(addDays(now, -2))));
  take(/\b(yesterday|kal)\b/gi, () => dates.add(ymdOf(addDays(now, -1))));
  take(/\b(today|aaj)\b/gi, () => dates.add(today));
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => addDate(`${m[1]}-${m[2]}-${m[3]}`));
  take(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g, (m) => { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : now.getFullYear(); addDate(`${y}-${pad(+m[2])}-${pad(+m[1])}`); });
  take(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/gi, (m) => addDate(`${m[3] || now.getFullYear()}-${pad(QL_MON.indexOf(m[2].toLowerCase()) + 1)}-${pad(+m[1])}`));
  take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:\s+(\d{4}))?/gi, (m) => addDate(`${m[3] || now.getFullYear()}-${pad(QL_MON.indexOf(m[1].toLowerCase()) + 1)}-${pad(+m[2])}`));
  take(/\b(last\s+)?(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/gi, (m) => {
    const want = QL_WD[m[2].toLowerCase()], cur = ((now.getDay() + 6) % 7) + 1;
    let back = (cur - want + 7) % 7; if (m[1] && back === 0) back = 7;
    dates.add(ymdOf(addDays(now, -back)));
  });
  if (!dates.size) dates.add(today);

  const items = [];
  for (const raw of t.split(/,|;|\+|\n|\band\b/i).map((x) => x.trim()).filter(Boolean)) {
    let part = raw, comment = "";
    const ci = part.indexOf(":"); if (ci >= 0) { comment = part.slice(ci + 1).trim(); part = part.slice(0, ci).trim(); }
    let secs = 0;
    const dm = part.match(QL_DUR);
    if (dm) { secs = dm[3] ? +dm[3] * 60 : Math.round(parseFloat(dm[1]) * 3600 + (+dm[2] || 0) * 60); part = (part.slice(0, dm.index) + " " + part.slice(dm.index + dm[0].length)).replace(/\s+/g, " ").trim(); }
    let tpl = null, issue = null, error = "";
    const km = part.match(/\b([A-Z][A-Z0-9_]*-\d+)\b/i);
    if (km) {
      const key = km[1].toUpperCase();
      tpl = JTT.templates.find((x) => x.issue?.key === key) || null;
      issue = tpl?.issue || issueByKey(key) || { key, lookup: true };
    } else if (part) {
      const m = JTT.matchTemplate(part);
      if (m.tpl) { tpl = m.tpl; issue = tpl.issue; if (!issue) error = `“${tpl.name}” has no Jira issue (Templates page)`; }
      else error = m.alts.length ? `“${part}” matches ${m.alts.map((a) => a.name).join(" / ")} — be more specific` : `no template matches “${part}”`;
    } else error = "what did you work on?";
    if (!secs && tpl) secs = parseDuration(tpl.duration);
    if (!secs && !error) error = "how many hours?";
    items.push({ raw, secs, tpl, issue, comment: comment || tpl?.comment || "", error });
  }
  return { dates: [...dates].sort(), items, notes };
}

function qlHint() {
  const v = $("#qlInput").value.trim(), hint = $("#qlHint");
  if (!v) { hint.innerHTML = '<span class="muted">e.g. <i>2h DSM, 6h AWS Connect today</i> · <i>4h bug fixing: login issue yesterday</i> · <i>8h FUL2-1234 this week</i></span>'; return; }
  const r = qlParse(v);
  hint.innerHTML = `<span class="ok">📅 ${r.dates.length > 3 ? `${r.dates.length} days` : r.dates.map(prettyDate).join(", ")}</span>` +
    r.items.map((i) => i.error ? `<span class="bad">✗ ${esc(i.error)}</span>` : `<span class="ok">✓ ${fmtH(i.secs)} → ${esc(i.tpl?.name || i.issue.key)}${i.issue?.key ? " · " + esc(i.issue.key) : ""}</span>`).join("");
}

async function qlSubmit() {
  if (!S.me) { toast("Connect Jira first"); return; }
  const r = qlParse($("#qlInput").value);
  if (!r.items.length) { toast("Type what you worked on, e.g. 2h DSM"); return; }
  const bad = r.items.find((i) => i.error); if (bad) { toast(bad.error); return; }
  try {
    for (const it of r.items) if (it.issue?.lookup) {
      const is = await jira(API.issueByKey(it.issue.key));
      it.issue = { id: String(is.id), key: is.key, summary: is.fields?.summary || "" }; idxAdd([it.issue], "recent");
    }
    await ensureDates(r.dates);
  } catch (e) { toast(e.status === 404 ? "Issue not found in Jira" : e.message); return; }
  openPreview(r.dates.flatMap((d) => r.items.map((it) => makeJob(it.issue, d, secsToDur(it.secs), it.comment))));
}

window.openDay = openDay;
window.JTD = { qlParse, renderToday, openDay };

(function dayInit() {
  JT.onReady(renderToday);
  JT.on("data", (d) => { if (!d || d.key === todayStr().slice(0, 7)) renderToday(); });
  JT.on("templates", renderToday); JT.on("schedule", renderToday);
  setInterval(renderToday, 60000);                       // also rolls over at midnight
  const q = $("#qlInput");
  q.addEventListener("input", qlHint);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); qlSubmit(); } });
  $("#qlGo").onclick = qlSubmit;
  qlHint();
})();
