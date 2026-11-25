"use strict";
/* Work templates (Jira issue + hours + comment) and day plans (a set of templates for one day).
   Used by the calendar page, Fill my month, the day drawer, Quick log, the wizard and the daily auto-log.
   Uses globals from app.js (S, $, esc, store, makeJob, openPreview, ...). */

const TCATS = ["Meetings", "AWS", "Quality", "Other", "My templates"];
// [category, name, hours, comment, quick-log words]
const STARTER = [
  ["Meetings", "DSM / Stand-up", "30m", "Daily stand-up meeting (DSM)", "dsm, standup, stand-up, scrum, daily"],
  ["Meetings", "Sprint ceremonies", "1h", "Sprint planning, review and retrospective", "sprint, planning, retro, grooming, refinement"],
  ["Meetings", "Team support", "1h", "Team support and discussions", "team support, support, meeting, meetings, discussion"],
  ["AWS", "AWS SR raised & follow-up", "1h", "Raised AWS support request (SR) and followed up", "sr, aws sr, support request, aws case, case"],
  ["AWS", "AWS Connect development", "4h", "AWS Connect contact flow development", "connect, aws connect, contact flow, ivr"],
  ["AWS", "Lambda / API development", "4h", "Lambda and API development", "lambda, api, backend"],
  ["AWS", "Deployment / release", "1h", "Deployment and release activities", "deploy, deployment, release, cicd, pipeline"],
  ["Quality", "Unit testing", "2h", "Unit testing", "testing, test, unit test, unit"],
  ["Quality", "SIT / UAT support", "2h", "SIT / UAT support and defect analysis", "sit, uat, qa support"],
  ["Quality", "Bug fixing", "2h", "Bug fixing and defect resolution", "bug, bugs, fix, defect, defects"],
  ["Quality", "Code review", "1h", "Code review and PR feedback", "review, code review, pr, pull request"],
  ["Other", "Production support / incident", "2h", "Production support and incident analysis", "prod, production, incident, prod support, outage"],
  ["Other", "Requirement analysis / design", "1h", "Requirement analysis and design discussion", "requirement, requirements, design, analysis, brd"],
  ["Other", "Documentation / KT", "1h", "Documentation and knowledge transfer", "doc, docs, documentation, kt, knowledge transfer"],
  ["Other", "POC / learning", "2h", "POC and learning", "poc, learning, research, training"],
];

const TT = { templates: [], plans: [], saveT: null };
const tNewId = (p) => p + uid() + Date.now().toString(36).slice(-3);
const starterTpl = ([cat, name, duration, comment, aliases]) => ({ id: tNewId("t"), cat, name, issue: null, duration, comment, aliases });

function tSave(now) {
  clearTimeout(TT.saveT);
  const write = () => { store.set("wtemplates", TT.templates); store.set("dplans", TT.plans); JT.emit("templates"); };
  if (now) write(); else TT.saveT = setTimeout(write, 250);
}

async function tLoad() {
  const t = await store.get("wtemplates", null), p = await store.get("dplans", null);
  if (t) { TT.templates = t; TT.plans = p || []; return; }
  // First run: starter templates + migrate the old "Templates" (hours + comment) and "Monthly plans" (issue rows)
  const list = STARTER.map(starterTpl), plans = [];
  const OLD_DEFAULTS = ["DSM & meeting — 2h", "Development — 4h", "Dev, debug & test — 8h"];
  if (localStorage.getItem("jiratime.templates") !== null)
    for (const o of await store.get("templates", [])) if (o?.name && !OLD_DEFAULTS.includes(o.name))
      list.push({ id: tNewId("t"), cat: "My templates", name: String(o.name).slice(0, 60), issue: null, duration: o.duration || "1h", comment: o.comment || "", aliases: "" });
  for (const op of await store.get("plans", [])) {
    const items = [];
    for (const r of op?.rows || []) {
      if (!r?.issue?.id) continue;
      const issue = { id: String(r.issue.id), key: r.issue.key, summary: r.issue.summary || "" };
      let tpl = list.find((x) => x.issue?.id === issue.id && x.comment === (r.comment || ""));
      if (!tpl) { tpl = { id: tNewId("t"), cat: "My templates", name: (r.comment || issue.key).slice(0, 40), issue, duration: r.duration || "1h", comment: r.comment || "", aliases: "" }; list.push(tpl); }
      items.push({ tid: tpl.id, duration: r.duration || tpl.duration });
    }
    if (items.length) plans.push({ id: tNewId("p"), name: String(op.name || "Imported plan").slice(0, 60), items, days: [] });
  }
  TT.templates = list; TT.plans = plans; tSave(true);
}

// ---------- helpers used by the other modules ----------
const tGet = (id) => TT.templates.find((t) => t.id === id);
const pGet = (id) => TT.plans.find((p) => p.id === id);
const isoDow = (date) => ((new Date(date + "T00:00:00").getDay() + 6) % 7) + 1;          // 1 = Mon … 7 = Sun
const planFor = (date) => TT.plans.find((p) => (p.days || []).includes(isoDow(date))) || null;
const defaultPlan = () => TT.plans[0] || null;
const itemDur = (it) => it.duration || tGet(it.tid)?.duration || "0m";
const planSecs = (p) => (p?.items || []).reduce((a, it) => a + (tGet(it.tid) ? parseDuration(itemDur(it)) : 0), 0);
function planProblems(p) {
  const miss = [];
  for (const it of p?.items || []) { const t = tGet(it.tid); if (!t) miss.push("(deleted template)"); else if (!t.issue) miss.push(t.name); }
  return miss;
}
/** Jobs for one date from a day plan. Loads that month first so duplicates are detected. */
async function planJobs(p, date, opts = {}) {
  await ensureDates([date]);
  const jobs = [], missing = [];
  for (const it of p?.items || []) {
    const t = tGet(it.tid); if (!t) continue;
    if (!t.issue) { missing.push(t.name); continue; }
    const dur = itemDur(it); if (!parseDuration(dur)) continue;
    jobs.push(makeJob(t.issue, date, dur, t.comment, opts.include));
  }
  return { jobs, missing };
}

const tNorm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** Best template for free text (Quick log). Returns { tpl, alts } — alts set when the text is ambiguous. */
function matchTemplate(text) {
  const q = tNorm(text); if (!q) return { tpl: null, alts: [] };
  const words = q.split(" ");
  const scored = TT.templates.map((t) => {
    const name = tNorm(t.name), aliases = String(t.aliases || "").split(",").map(tNorm).filter(Boolean);
    let sc = 0;
    if (name === q || aliases.includes(q) || (t.issue && tNorm(t.issue.key) === q)) sc = 100;
    else if (name.startsWith(q)) sc = 80;
    else {
      const hay = new Set([...name.split(" "), ...aliases.flatMap((a) => a.split(" ")), ...tNorm(t.comment).split(" ")]);
      const hit = words.filter((w) => hay.has(w)).length;
      if (hit) sc = 40 + (hit / words.length) * 40 + (aliases.some((a) => q.includes(a)) ? 10 : 0);
    }
    return { t, sc };
  }).filter((x) => x.sc >= 60).sort((a, b) => b.sc - a.sc);
  if (!scored.length) return { tpl: null, alts: [] };
  const top = scored.filter((x) => x.sc === scored[0].sc);
  return top.length > 1 && scored[0].sc < 100 ? { tpl: null, alts: top.map((x) => x.t) } : { tpl: scored[0].t, alts: [] };
}

function tOptions(sel) {
  return TCATS.map((c) => {
    const l = TT.templates.filter((t) => t.cat === c);
    return l.length ? `<optgroup label="${esc(c)}">${l.map((t) => `<option value="${t.id}" ${t.id === sel ? "selected" : ""}>${esc(t.name)} · ${t.issue ? esc(t.issue.key) : "no issue"}</option>`).join("")}</optgroup>` : "";
  }).join("");
}
const planOptions = (sel) => TT.plans.map((p) => `<option value="${p.id}" ${p.id === sel ? "selected" : ""}>${esc(p.name)} · ${fmtH(planSecs(p))}</option>`).join("");

function addTemplate(t) {
  const tpl = { id: tNewId("t"), cat: TCATS.includes(t.cat) ? t.cat : "My templates", name: String(t.name || "New template").slice(0, 60), issue: t.issue || null, duration: t.duration || S.settings.duration, comment: t.comment || "", aliases: t.aliases || "" };
  TT.templates.push(tpl); tSave(); return tpl;
}
/** Weekdays belong to one plan only, so "which plan runs on Monday" is never ambiguous. */
function setPlanDays(p, days) {
  p.days = [...new Set(days)].sort();
  for (const o of TT.plans) if (o !== p) o.days = (o.days || []).filter((d) => !p.days.includes(d));
}
function addPlan(p) {
  const plan = { id: tNewId("p"), name: String(p.name || "New day plan").slice(0, 60), items: p.items || [], days: [] };
  TT.plans.push(plan); setPlanDays(plan, p.days || []); tSave(); return plan;
}
/** Find or create a template for a calendar row (same issue + comment = same template). */
function templateForRow(r) {
  return TT.templates.find((t) => t.issue?.id === String(r.issue.id) && t.comment === (r.comment || "")) ||
    addTemplate({ cat: "My templates", name: (r.comment || r.issue.key).slice(0, 40), issue: { id: String(r.issue.id), key: r.issue.key, summary: r.issue.summary || "" }, duration: r.duration, comment: r.comment });
}

// ---------- export / import (share with the team) ----------
function tExport() {
  const data = { app: "JiraTime", kind: "templates", version: 1, exportedAt: new Date().toISOString(), templates: TT.templates, plans: TT.plans };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "jiratime-templates.json"; a.click(); URL.revokeObjectURL(a.href);
}
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
async function tImport(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { toast("Not a valid JSON file"); return; }
  if (data?.kind !== "templates" || !Array.isArray(data.templates)) { toast("This file is not a JiraTime templates export"); return; }
  const str = (v, n) => String(v ?? "").slice(0, n);
  const idMap = {}; let addedT = 0, addedP = 0;
  for (const t of data.templates.slice(0, 300)) {
    const issue = t?.issue && /^\d+$/.test(String(t.issue.id)) && KEY_RE.test(String(t.issue.key)) ? { id: String(t.issue.id), key: String(t.issue.key), summary: str(t.issue.summary, 200) } : null;
    const dur = parseDuration(t?.duration) ? str(t.duration, 12) : "1h";
    const same = TT.templates.find((x) => x.name === str(t?.name, 60) && x.comment === str(t?.comment, 300) && (x.issue?.key || "") === (issue?.key || ""));
    if (same) { idMap[t.id] = same.id; continue; }
    idMap[t.id] = addTemplate({ cat: str(t?.cat, 30), name: str(t?.name, 60) || "Imported", issue, duration: dur, comment: str(t?.comment, 300), aliases: str(t?.aliases, 200) }).id;
    addedT++;
  }
  for (const p of (Array.isArray(data.plans) ? data.plans : []).slice(0, 50)) {
    const items = (p?.items || []).filter((it) => idMap[it?.tid]).map((it) => ({ tid: idMap[it.tid], duration: parseDuration(it.duration) ? str(it.duration, 12) : "" }));
    if (!items.length) continue;
    const name = str(p?.name, 60) || "Imported plan", sig = JSON.stringify(items);
    if (TT.plans.some((x) => x.name === name && JSON.stringify(x.items.map((it) => ({ tid: it.tid, duration: it.duration || "" }))) === sig)) continue;
    addPlan({ name, items, days: [] }); addedP++;   // weekdays are personal: not imported
  }
  tSave(true); renderTplPage();
  toast(`Imported ${addedT} template(s) and ${addedP} day plan(s)`);
}

// ---------- Templates page ----------
function tCard(t) {
  return `<div class="tcard ${t.issue ? "" : "noissue"}" data-t="${t.id}">
    <div class="tr1"><input class="tname" value="${esc(t.name)}" maxlength="60" aria-label="Template name">
      <input class="tdur" value="${esc(t.duration)}" title="Hours, e.g. 2h, 30m, 1h 30m" aria-label="Hours">
      <select class="tcat" aria-label="Category">${TCATS.map((c) => `<option ${c === t.cat ? "selected" : ""}>${c}</option>`).join("")}</select>
      <button class="small tdel" title="Delete template">🗑</button></div>
    <div class="tiss"><input class="tq" placeholder="⚠ Pick the Jira issue for this work…" value="${esc(t.issue ? t.issue.key + " — " + t.issue.summary : "")}" aria-label="Jira issue"><div class="results hidden"></div></div>
    <input class="tcmt" value="${esc(t.comment)}" placeholder="Worklog comment" maxlength="300" aria-label="Comment">
    <input class="tali" value="${esc(t.aliases || "")}" placeholder="Quick-log words, comma separated (e.g. dsm, standup)" maxlength="200" aria-label="Quick-log words">
  </div>`;
}
function pCard(p) {
  const secs = planSecs(p), target = S.settings.target * 3600, miss = planProblems(p);
  const days = S.settings.weekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  return `<div class="pcard" data-p="${p.id}">
    <div class="tr1"><input class="pname" value="${esc(p.name)}" maxlength="60" aria-label="Plan name">
      <span class="ptot ${secs === target ? "ok" : secs > target ? "over" : "under"}">${fmtH(secs)} / ${S.settings.target}h</span>
      <button class="small pdel" title="Delete plan">🗑</button></div>
    <div class="pdays"><span class="muted tiny">Default for</span>${days.map((d) => `<button class="small dchip ${(p.days || []).includes(d) ? "on" : ""}" data-dow="${d}">${DOW[d - 1]}</button>`).join("")}</div>
    <div class="pitems">${(p.items || []).map((it, i) => { const t = tGet(it.tid); return `<div class="pitem" data-i="${i}"><select class="pit" aria-label="Template">${tOptions(it.tid)}</select><input class="pdur" value="${esc(itemDur(it))}" aria-label="Hours"><button class="small prm" title="Remove">✕</button>${t && !t.issue ? '<span class="b bad">no issue</span>' : ""}</div>`; }).join("") || '<p class="muted tiny">No templates in this plan yet.</p>'}</div>
    <select class="padd" aria-label="Add template"><option value="">＋ Add template…</option>${tOptions("")}</select>
    ${miss.length ? `<div class="warnbox tiny">Pick a Jira issue for: ${esc(miss.join(", "))}</div>` : ""}
    <div class="row-actions" style="margin:8px 0 0"><button class="small puse">Use on selected dates</button><button class="small ptoday">Fill today</button><button class="small prows">Load into calendar rows</button></div>
  </div>`;
}
function renderTplPage() {
  const box = $("#tplList"); if (!box) return;
  const groups = TCATS.map((c) => [c, TT.templates.filter((t) => t.cat === c)]).filter(([, l]) => l.length);
  box.innerHTML = groups.map(([c, l]) => `<div class="tgroup"><h4>${esc(c)} <span class="muted tiny">${l.length}</span></h4>${l.map(tCard).join("")}</div>`).join("") || '<p class="muted">No templates yet.</p>';
  box.querySelectorAll(".tcard").forEach((el) => {
    const t = tGet(el.dataset.t);
    attachIssueSearch(el.querySelector(".tq"), el.querySelector(".results"), (issue) => { t.issue = issue; tSave(); renderTplPage(); });
  });
  $("#planList2").innerHTML = TT.plans.map(pCard).join("") || '<p class="muted">No day plans yet. A day plan is the set of templates for one day, e.g. “DSM 30m + AWS Connect 5h + Testing 2h 30m”.</p>';
  const noIssue = TT.templates.filter((t) => !t.issue).length;
  $("#tplInfo").textContent = `${TT.templates.length} templates · ${noIssue} without a Jira issue · ${TT.plans.length} day plans`;
}
function fillCalSelects() {
  if (!$("#tplSel")) return;
  $("#tplSel").innerHTML = '<option value="">＋ From template…</option>' + tOptions("");
  $("#planSel").innerHTML = '<option value="">Day plan…</option>' + planOptions("");
}
const goView = (v) => document.querySelector(`.nav[data-view="${v}"]`)?.click();

function planToRows(p) {
  const rows = (p.items || []).map((it) => ({ it, t: tGet(it.tid) })).filter((x) => x.t).map(({ it, t }) => newRow({ issue: t.issue, duration: itemDur(it), comment: t.comment }));
  if (!rows.length) { toast("This plan has no templates"); return false; }
  S.rows = rows; renderRows(); renderSelection(); renderSuggestion();
  const miss = planProblems(p); if (miss.length) toast(`Pick a Jira issue in the rows for: ${miss.join(", ")}`);
  return true;
}
async function planOnDates(p, dates) {
  if (!S.me) { toast("Connect Jira first"); return; }
  if (!dates.length) { toast("Select dates on the calendar first"); return; }
  const jobs = [], missing = new Set();
  for (const d of dates) { const r = await planJobs(p, d); jobs.push(...r.jobs); r.missing.forEach((m) => missing.add(m)); }
  if (missing.size) toast(`Skipped (no Jira issue): ${[...missing].join(", ")}`);
  if (jobs.length) openPreview(jobs);
}

window.JTT = {
  get templates() { return TT.templates; }, get plans() { return TT.plans; }, STARTER, TCATS,
  tGet, pGet, isoDow, planFor, defaultPlan, planJobs, planSecs, planProblems, hasPlans: () => TT.plans.length > 0,
  matchTemplate, addTemplate, addPlan, setPlanDays, save: tSave, tOptions, planOptions, render: renderTplPage, planOnDates, importFile: tImport, exportData: () => ({ templates: TT.templates, plans: TT.plans }),
};

(async function tInit() {
  await tLoad();
  fillCalSelects(); renderTplPage(); renderSelection();
  JT.on("view", (v) => { if (v === "templates") renderTplPage(); });
  JT.on("templates", () => { fillCalSelects(); renderSelection(); });
  window.addEventListener("beforeunload", () => { if (TT.saveT) tSave(true); });

  // calendar page
  $("#tplSel").onchange = (e) => {
    const t = tGet(e.target.value); e.target.value = ""; if (!t) return;
    let row = S.rows.find((r) => !r.issue && !r.comment);
    if (!row) { row = newRow(); S.rows.push(row); }
    Object.assign(row, { issue: t.issue, duration: t.duration, comment: t.comment });
    renderRows(); renderSelection(); renderSuggestion();
    if (!t.issue) toast(`“${t.name}” has no Jira issue yet — pick one in the row (or on the Templates page)`);
  };
  $("#tplSave").onclick = async () => {
    const r = S.rows.find((x) => x.issue && parseDuration(x.duration)) || S.rows[0];
    if (!r || (!r.issue && !r.comment)) { toast("Fill a row first (issue, hours, comment)"); return; }
    const name = await uiPrompt("Template name?", (r.comment || r.issue?.key || "My template").slice(0, 40)); if (!name) return;
    addTemplate({ cat: "My templates", name, issue: r.issue ? { id: String(r.issue.id), key: r.issue.key, summary: r.issue.summary || "" } : null, duration: r.duration, comment: r.comment });
    toast("Template saved (Templates page)");
  };
  $("#planSel").onchange = (e) => { const p = pGet(e.target.value); e.target.value = ""; if (p) planToRows(p); };
  $("#planSave").onclick = async () => {
    const valid = S.rows.filter((r) => r.issue && parseDuration(r.duration));
    if (!valid.length) { toast("Pick at least one issue first"); return; }
    const name = await uiPrompt("Day plan name?", "My day"); if (!name) return;
    addPlan({ name, items: valid.map((r) => ({ tid: templateForRow(r).id, duration: r.duration })) });
    toast("Day plan saved — set its weekdays on the Templates page");
  };

  // Templates page: buttons
  $("#tplNew").onclick = () => { addTemplate({ cat: "My templates", name: "New template" }); tSave(true); renderTplPage(); $("#tplList .tgroup:last-child .tcard:last-child .tname")?.select(); };
  $("#planNew").onclick = () => { addPlan({ name: "New day plan" }); tSave(true); renderTplPage(); };
  $("#tplStarters").onclick = () => {
    let n = 0; for (const s of STARTER) if (!TT.templates.some((t) => t.name === s[1])) { TT.templates.push(starterTpl(s)); n++; }
    tSave(true); renderTplPage(); toast(n ? `Added ${n} starter template(s)` : "All starter templates are already there");
  };
  $("#tplExport").onclick = tExport;
  $("#tplImport").onclick = () => $("#tplFile").click();
  $("#tplFile").onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) tImport(f); };

  // Templates page: template cards (delegated)
  const tl = $("#tplList");
  tl.addEventListener("input", (e) => {
    const t = tGet(e.target.closest(".tcard")?.dataset.t); if (!t) return;
    const c = e.target.classList;
    if (c.contains("tname")) t.name = e.target.value.slice(0, 60);
    else if (c.contains("tcmt")) t.comment = e.target.value.slice(0, 300);
    else if (c.contains("tali")) t.aliases = e.target.value.slice(0, 200);
    else if (c.contains("tdur")) { t.duration = e.target.value; e.target.style.borderColor = parseDuration(t.duration) ? "" : "var(--bad)"; }
    else return;
    tSave();
  });
  tl.addEventListener("change", (e) => {
    const t = tGet(e.target.closest(".tcard")?.dataset.t); if (!t) return;
    if (e.target.classList.contains("tcat")) { t.cat = e.target.value; tSave(true); renderTplPage(); }
    if (e.target.classList.contains("tq") && !e.target.value.trim()) { t.issue = null; tSave(true); renderTplPage(); }
  });
  tl.addEventListener("click", async (e) => {
    if (!e.target.classList.contains("tdel")) return;
    const t = tGet(e.target.closest(".tcard").dataset.t), used = TT.plans.filter((p) => p.items.some((it) => it.tid === t.id));
    if (!await uiConfirm(`Delete “${t.name}”?${used.length ? ` It is also removed from ${used.length} day plan(s).` : ""}`)) return;
    TT.templates = TT.templates.filter((x) => x !== t);
    used.forEach((p) => { p.items = p.items.filter((it) => it.tid !== t.id); });
    tSave(true); renderTplPage();
  });

  // Templates page: plan cards (delegated)
  const pl = $("#planList2");
  const planOf = (el) => pGet(el.closest(".pcard")?.dataset.p);
  pl.addEventListener("input", (e) => {
    const p = planOf(e.target); if (!p) return;
    if (e.target.classList.contains("pname")) { p.name = e.target.value.slice(0, 60); tSave(); }
    if (e.target.classList.contains("pdur")) {
      const it = p.items[+e.target.closest(".pitem").dataset.i]; it.duration = e.target.value;
      e.target.style.borderColor = parseDuration(it.duration) ? "" : "var(--bad)";
      e.target.closest(".pcard").querySelector(".ptot").textContent = `${fmtH(planSecs(p))} / ${S.settings.target}h`;
      tSave();
    }
  });
  pl.addEventListener("change", (e) => {
    const p = planOf(e.target); if (!p) return;
    if (e.target.classList.contains("pit")) { const it = p.items[+e.target.closest(".pitem").dataset.i]; it.tid = e.target.value; it.duration = ""; }
    else if (e.target.classList.contains("padd")) { if (!e.target.value) return; p.items.push({ tid: e.target.value, duration: "" }); }
    else return;
    tSave(true); renderTplPage();
  });
  pl.addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    const p = planOf(b); if (!p) return;
    if (b.classList.contains("pdel")) { if (!await uiConfirm(`Delete day plan “${p.name}”?`)) return; TT.plans = TT.plans.filter((x) => x !== p); tSave(true); renderTplPage(); }
    else if (b.classList.contains("prm")) { p.items.splice(+b.closest(".pitem").dataset.i, 1); tSave(true); renderTplPage(); }
    else if (b.classList.contains("dchip")) { const d = +b.dataset.dow, days = p.days || []; setPlanDays(p, days.includes(d) ? days.filter((x) => x !== d) : [...days, d]); tSave(true); renderTplPage(); }
    else if (b.classList.contains("puse")) planOnDates(p, sortedSelected());
    else if (b.classList.contains("ptoday")) planOnDates(p, [todayStr()]);
    else if (b.classList.contains("prows")) { if (planToRows(p)) goView("dashboard"); }
  });
})();
