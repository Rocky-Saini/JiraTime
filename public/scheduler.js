"use strict";
/* Daily auto-log ("cron" in the browser) and the evening reminder.
   Runs while a JiraTime tab is open; missed days are offered when the app opens next time.
   Uses globals from app.js and window.JTT (templates.js), window.openDay (day.js). */

const SCH_DEF = { enabled: false, time: "18:30", days: [1, 2, 3, 4, 5], mode: "auto", countdown: 60, planId: "", catchup: true, catchupDays: 7, nwAfter: false, remind: false, remindTime: "17:30" };
const SC = { cfg: { ...SCH_DEF }, state: { lastDone: {}, remindDone: "" }, log: [], busy: false, catchAsked: false, tick: null, errLogged: {} };

const hhmm = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const sDow = (date) => ((new Date(date + "T00:00:00").getDay() + 6) % 7) + 1;
const sPlanFor = (date) => (SC.cfg.planId && JTT.pGet(SC.cfg.planId)) || JTT.planFor(date) || JTT.defaultPlan();
const sLog = (entry) => { SC.log.unshift({ ts: new Date().toISOString(), ...entry }); SC.log = SC.log.slice(0, 100); store.set("autolog", SC.log); renderSchLog(); };
const markDone = (date, result) => { SC.state.lastDone[date] = result; const keys = Object.keys(SC.state.lastDone).sort(); while (keys.length > 60) delete SC.state.lastDone[keys.shift()]; store.set("schedState", SC.state); };

async function sLoad() {
  SC.cfg = { ...SCH_DEF, ...(await store.get("schedule", {})) };
  SC.state = { lastDone: {}, remindDone: "", ...(await store.get("schedState", {})) };
  SC.log = await store.get("autolog", []);
}
const sSave = () => { store.set("schedule", SC.cfg); JT.emit("schedule"); };

function nextRun(from = new Date()) {
  if (!SC.cfg.enabled) return null;
  for (let i = 0; i < 14; i++) {
    const d = addDays(from, i), ds = ymdOf(d);
    if (!SC.cfg.days.includes(sDow(ds)) || holidayOf(ds) || SC.state.lastDone[ds]) continue;
    if (i === 0 && hhmm(from) >= SC.cfg.time) continue;
    return { date: ds, time: SC.cfg.time };
  }
  return null;
}
function nextRunText() {
  if (!SC.cfg.enabled) return "";
  const n = nextRun(); if (!n) return "Auto-log: nothing scheduled";
  const when = n.date === todayStr() ? "today" : n.date === ymdOf(addDays(new Date(), 1)) ? "tomorrow" : prettyDate(n.date);
  return `⏰ Auto-log ${when} ${n.time}`;
}

/** Decide what the auto-log would do for one date. Never adds to a day that already has work. */
async function sPlanDay(date) {
  if (holidayOf(date)) return { skip: `${holidayOf(date).type}: ${holidayOf(date).label}` };
  if (!S.settings.weekend && isWeekend(date)) return { skip: "weekend" };
  const p = sPlanFor(date); if (!p) return { skip: "no day plan", problem: true };
  await ensureDates([date]);
  const secs = monthData(date).byDate[date]?.secs || 0;
  if (secs > 0) return { skip: secs >= S.settings.target * 3600 ? "already complete" : `already ${fmtH(secs)} logged — use Today/Day details to top up` };
  const r = await JTT.planJobs(p, date);
  if (r.missing.length) return { skip: `pick a Jira issue for: ${r.missing.join(", ")}`, problem: true };
  if (!r.jobs.length) return { skip: "plan is empty", problem: true };
  return { plan: p, jobs: r.jobs };
}

// One open tab runs the schedule; Web Locks make sure two tabs never log the same day twice.
async function withLock(fn) {
  if (navigator.locks?.request) return navigator.locks.request("jiratime-autolog", { ifAvailable: true }, (lock) => (lock ? fn() : null));
  return fn();
}
function notify(title, body) {
  try { if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body, tag: "jiratime" }); } catch { /* optional */ }
}

async function sRun(dates, reason, mode = SC.cfg.mode) {
  if (SC.busy || !S.me || runBusy()) return;
  SC.busy = true;
  try {
    await withLock(async () => {
      const done = await store.get("schedState", SC.state); SC.state = { lastDone: {}, remindDone: "", ...done };   // another tab may have run
      const jobs = [], plans = [];
      for (const d of dates) {
        if (SC.state.lastDone[d]) continue;
        let r; try { r = await sPlanDay(d); } catch (e) { r = { skip: "could not read Jira: " + e.message, retry: true }; }
        if (r.skip) {
          if (r.retry) { if (!SC.errLogged[d + r.skip]) { SC.errLogged[d + r.skip] = 1; sLog({ date: d, status: "waiting", note: r.skip }); } continue; }
          markDone(d, { skipped: r.skip, problem: !!r.problem }); sLog({ date: d, status: "skipped", note: r.skip });
          if (r.problem) notify("JiraTime auto-log could not run", `${prettyDate(d)}: ${r.skip}`);
          continue;
        }
        jobs.push(...r.jobs); plans.push([d, r.plan.name]);
      }
      if (!jobs.length) { renderSch(); return; }
      const total = jobs.reduce((a, j) => a + parseDuration(j.duration), 0);
      const go = mode === "auto" ? await countdown(jobs, plans, reason) : await askConfirm(jobs, plans, reason);
      if (go === null) return;                        // another dialog replaced ours: try again on a later tick
      if (!go) { plans.forEach(([d]) => { markDone(d, { skipped: "cancelled by you" }); sLog({ date: d, status: "cancelled", note: "you cancelled (use “Run now” to log it anyway)" }); }); return; }
      await runSubmission(jobs, S.settings.start || "10:00", false);
      for (const [d, name] of plans) {
        const js = jobs.filter((j) => j.date === d), ok = js.filter((j) => j.status === "success").length, bad = js.length - ok;
        markDone(d, { plan: name, ok, bad });          // failures are not retried automatically (use Retry / Run now)
        sLog({ date: d, status: bad ? (ok ? "partial" : "failed") : "logged", note: `${name}: ${ok}/${js.length} worklogs${bad ? `, ${bad} failed` : ""}` });
      }
      const failed = jobs.filter((j) => j.status !== "success").length;
      notify("JiraTime auto-log", failed ? `${failed} worklog(s) failed — open JiraTime to retry` : `Logged ${fmtH(total)} (${plans.map(([d]) => prettyDate(d)).join(", ")})`);
      if (SC.cfg.nwAfter && !failed) await sNewersWorld(plans.map(([d]) => d));
    });
  } finally { SC.busy = false; renderSch(); JT.emit("schedule"); }
}
async function sNewersWorld(dates) {
  if (typeof NWA === "undefined" || typeof nwRead !== "function" || !NWA.ready) { sLog({ date: dates[0], status: "skipped", note: "NewersWorld tab not connected — sync it from the NewersWorld page" }); return; }
  try {
    $("#nwFrom").value = dates.slice().sort()[0]; $("#nwTo").value = todayStr();
    await nwRead();
    if (NW.rows.some((r) => r.fill)) { await nwSync(); sLog({ date: dates[0], status: "logged", note: "NewersWorld synced" }); }
  } catch (e) { sLog({ date: dates[0], status: "failed", note: "NewersWorld: " + e.message }); }
}
const runBusy = () => /running…/.test($("#modalBox").textContent) && modalOpen();

function jobsTable(jobs) {
  return `<div class="scroll" style="max-height:34vh"><table>${jobs.map((j) => `<tr><td>${prettyDate(j.date)}</td><td><b>${esc(j.issue.key)}</b></td><td>${esc(j.duration)}</td><td class="muted">${esc(j.comment)}</td></tr>`).join("")}</table></div>`;
}
function countdown(jobs, plans, reason) {
  return new Promise((resolve) => {
    const left = Math.max(10, +SC.cfg.countdown || 60), deadline = Date.now() + left * 1000;
    let timer;
    const total = jobs.reduce((a, j) => a + parseDuration(j.duration), 0);
    openModal(`<div data-sticky></div><h3>⏰ Auto-log ${esc(reason)}</h3>
      <p>Logging <b>${jobs.length}</b> worklog(s), <b>${fmtH(total)}</b> — ${plans.map(([d, n]) => `${prettyDate(d)} (${esc(n)})`).join(", ")}.</p>
      ${jobsTable(jobs)}
      <p class="cdown">Submitting in <b id="cdN">${left}</b> s</p>
      <div class="foot"><button id="cdCancel">Cancel</button><button id="cdNow" class="primary">Submit now</button></div>`);
    const end = (v) => { clearInterval(timer); resolve(v); };
    $("#cdCancel").onclick = () => { closeModal(); document.title = "JiraTime"; end(false); };
    $("#cdNow").onclick = () => end(true);
    timer = setInterval(() => {
      const sLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)), n = $("#cdN");
      if (!n) { document.title = "JiraTime"; end(null); return; }
      n.textContent = sLeft;
      document.title = sLeft ? `⏰ ${sLeft}s · JiraTime` : "JiraTime";
      if (sLeft <= 0) { document.title = "JiraTime"; end(true); }
    }, 500);
    notify("JiraTime auto-log", `Logging ${fmtH(total)} in ${left} s — open the tab to cancel`);
  });
}
function askConfirm(jobs, plans, reason) {
  return new Promise((resolve) => {
    const total = jobs.reduce((a, j) => a + parseDuration(j.duration), 0);
    openModal(`<div data-sticky></div><h3>⏰ Ready to log ${esc(reason)}</h3>
      <p><b>${jobs.length}</b> worklog(s), <b>${fmtH(total)}</b>.</p>${jobsTable(jobs)}
      <div class="foot"><button id="cfNo">Not now</button><button id="cfYes" class="primary">Log it</button></div>`);
    $("#cfNo").onclick = () => { closeModal(); resolve(false); };
    $("#cfYes").onclick = () => resolve(true);
    notify("JiraTime", `Ready to log ${fmtH(total)} — open JiraTime to confirm`);
  });
}

/** Days before today that were scheduled, are not logged and have no auto-log record. */
async function sMissed() {
  const out = [], today = todayStr();
  for (let i = 1; i <= SC.cfg.catchupDays; i++) {
    const d = ymdOf(addDays(new Date(), -i));
    if (d >= today || SC.state.lastDone[d] || !SC.cfg.days.includes(sDow(d)) || holidayOf(d) || (!S.settings.weekend && isWeekend(d))) continue;
    out.push(d);
  }
  if (!out.length) return [];
  try { await ensureDates(out); } catch { return []; }
  return out.filter((d) => !(monthData(d).byDate[d]?.secs > 0)).sort();
}
async function sCatchUp() {
  if (SC.catchAsked || !SC.cfg.enabled || !SC.cfg.catchup || !S.me) return;
  SC.catchAsked = true;
  const missed = await sMissed(); if (!missed.length) return;
  const wait = () => new Promise((r) => { const t = setInterval(() => { if (!modalOpen()) { clearInterval(t); r(); } }, 1000); });
  if (modalOpen()) await wait();
  openModal(`<div data-sticky></div><h3>Missed auto-log days</h3>
    <p>JiraTime was closed at the scheduled time on <b>${missed.map(prettyDate).join(", ")}</b>. These days have no worklog yet.</p>
    <div class="foot"><button id="cuSkip">Skip these days</button><button id="cuNo">Later</button><button id="cuYes" class="primary">Log them now</button></div>`);
  $("#cuNo").onclick = closeModal;
  $("#cuSkip").onclick = () => { missed.forEach((d) => { markDone(d, { skipped: "skipped by you" }); sLog({ date: d, status: "skipped", note: "skipped by you" }); }); closeModal(); renderSch(); };
  $("#cuYes").onclick = () => { closeModal(); sRun(missed, "for missed days", "ask"); };
}

async function sTick() {
  if (!JT.ready || !S.me) return;
  const now = new Date(), today = todayStr(), t = hhmm(now);
  if (SC.cfg.enabled && SC.cfg.days.includes(sDow(today)) && t >= SC.cfg.time && !SC.state.lastDone[today] && !SC.busy && !modalOpen()) await sRun([today], "for today");
  if (SC.cfg.remind && t >= SC.cfg.remindTime && SC.state.remindDone !== today && !isOffDay(today)) {
    SC.state.remindDone = today; store.set("schedState", SC.state);
    try {
      await ensureDates([today]);
      const secs = monthData(today).byDate[today]?.secs || 0, target = S.settings.target * 3600;
      if (secs < target) {
        notify("JiraTime reminder", `Today: ${fmtH(secs)} of ${S.settings.target}h logged`);
        toast(`⏰ Reminder: ${fmtH(secs)} of ${S.settings.target}h logged today`);
      }
    } catch { /* ignore */ }
  }
}

// ---------- Automation page ----------
function renderSch() {
  const c = SC.cfg; if (!$("#schOn")) return;
  $("#schOn").checked = c.enabled; $("#schTime").value = c.time; $("#schMode").value = c.mode; $("#schCd").value = c.countdown;
  $("#schCatch").checked = c.catchup; $("#schNw").checked = c.nwAfter; $("#schRemind").checked = c.remind; $("#schRemTime").value = c.remindTime;
  $("#schPlan").innerHTML = `<option value="">Weekday default (set on Templates page)</option>${JTT.planOptions(c.planId)}`;
  const days = S.settings.weekend ? [1, 2, 3, 4, 5, 6, 7] : [1, 2, 3, 4, 5];
  $("#schDays").innerHTML = days.map((d) => `<button class="small dchip ${c.days.includes(d) ? "on" : ""}" data-dow="${d}">${DOW[d - 1]}</button>`).join("");
  const n = nextRun();
  $("#schNext").innerHTML = c.enabled ? (n ? `Next run: <b>${n.date === todayStr() ? "today" : prettyDate(n.date)} at ${n.time}</b>` : "No upcoming run (all selected days are done or holidays)") : "Auto-log is off.";
  // what each weekday will log
  $("#schPreview").innerHTML = days.filter((d) => c.days.includes(d)).map((d) => {
    const p = (c.planId && JTT.pGet(c.planId)) || JTT.plans.find((x) => (x.days || []).includes(d)) || JTT.defaultPlan();
    const miss = p ? JTT.planProblems(p) : [];
    return `<tr><td>${DOW[d - 1]}</td><td>${p ? esc(p.name) : '<span class="st-failed">no day plan</span>'}</td><td>${p ? fmtH(JTT.planSecs(p)) : ""}</td><td>${miss.length ? `<span class="st-failed">needs issue: ${esc(miss.join(", "))}</span>` : p ? '<span class="st-success">ready</span>' : ""}</td></tr>`;
  }).join("") || '<tr><td class="muted">Pick at least one day.</td></tr>';
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  $("#schNotif").textContent = perm === "granted" ? "Desktop notifications: on" : perm === "denied" ? "Desktop notifications are blocked in this browser" : "Enable desktop notifications";
  $("#schNotif").disabled = perm !== "default";
  renderSchLog();
}
function renderSchLog() {
  const el = $("#schLog"); if (!el) return;
  el.innerHTML = SC.log.slice(0, 30).map((l) => `<tr><td>${new Date(l.ts).toLocaleString()}</td><td>${prettyDate(l.date)}</td><td class="st-${l.status === "logged" ? "success" : l.status === "failed" ? "failed" : "pending"}">${esc(l.status)}</td><td>${esc(l.note)}</td></tr>`).join("") || '<tr><td class="muted">Nothing yet.</td></tr>';
}

window.JTS = { nextRun, nextRunText, run: sRun, tick: sTick, get cfg() { return SC.cfg; }, get state() { return SC.state; }, missed: sMissed };

(async function schInit() {
  await sLoad();
  renderSch();
  const set = (k, v) => { SC.cfg[k] = v; sSave(); renderSch(); };
  $("#schOn").onchange = (e) => {
    if (e.target.checked && !JTT.hasPlans()) { e.target.checked = false; toast("Create a day plan first (Templates page)"); return; }
    set("enabled", e.target.checked);
    if (e.target.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission().then(renderSch);
  };
  $("#schTime").onchange = (e) => set("time", e.target.value || "18:30");
  $("#schMode").onchange = (e) => set("mode", e.target.value);
  $("#schCd").onchange = (e) => set("countdown", Math.min(600, Math.max(10, +e.target.value || 60)));
  $("#schPlan").onchange = (e) => set("planId", e.target.value);
  $("#schCatch").onchange = (e) => set("catchup", e.target.checked);
  $("#schNw").onchange = (e) => set("nwAfter", e.target.checked);
  $("#schRemind").onchange = (e) => { set("remind", e.target.checked); if (e.target.checked && "Notification" in window && Notification.permission === "default") Notification.requestPermission().then(renderSch); };
  $("#schRemTime").onchange = (e) => set("remindTime", e.target.value || "17:30");
  $("#schDays").addEventListener("click", (e) => { const b = e.target.closest("[data-dow]"); if (!b) return; const d = +b.dataset.dow; set("days", SC.cfg.days.includes(d) ? SC.cfg.days.filter((x) => x !== d) : [...SC.cfg.days, d].sort()); });
  $("#schNotif").onclick = () => Notification.requestPermission().then(renderSch);
  $("#schTest").onclick = async () => {
    const d = todayStr(), r = await sPlanDay(d).catch((e) => ({ skip: e.message }));
    if (r.skip) { toast(`Today would be skipped: ${r.skip}`); return; }
    openModal(`<h3>Dry run — today</h3><p>Plan <b>${esc(r.plan.name)}</b> would log:</p>${jobsTable(r.jobs)}<p class="muted tiny">Nothing was sent.</p><div class="foot"><button id="dtOk" class="primary">Close</button></div>`);
    $("#dtOk").onclick = closeModal;
  };
  $("#schRunNow").onclick = () => { if (!JTT.hasPlans()) { toast("Create a day plan first"); return; } delete SC.state.lastDone[todayStr()]; sRun([todayStr()], "for today (manual run)", "ask"); };
  JT.on("templates", () => {     // a fixed plan can make yesterday's "could not run" days runnable again
    let n = 0; for (const [d, v] of Object.entries(SC.state.lastDone)) if (v?.problem) { delete SC.state.lastDone[d]; n++; }
    if (n) store.set("schedState", SC.state);
    renderSch();
  }); JT.on("view", (v) => { if (v === "automation") renderSch(); });

  JT.onReady(() => { setTimeout(sCatchUp, 1500); sTick(); });
  SC.tick = setInterval(sTick, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) sTick(); });
})();
