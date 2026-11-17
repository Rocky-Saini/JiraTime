"use strict";
/* First-run setup: 1 connect Jira → 2 pick the Jira issue for the templates you use → 3 build your day plan
   → 4 turn on the daily auto-log. Existing users see a one-time banner instead. */

const WZ = { step: 0, use: {}, hours: {}, sug: {}, el: null, planName: "My day" };
const WZ_STEPS = ["Connect Jira", "Your work", "Day plan", "Auto-log"];

function wzOpen(step) {
  WZ.step = step ?? (S.me ? 1 : 0);
  if (!WZ.el) { WZ.el = document.createElement("div"); WZ.el.className = "wiz"; document.body.appendChild(WZ.el); }
  wzRender();
}
function wzClose(done) {
  localStorage.setItem("jiratime.wizardDone", done ? "done" : "skipped");
  WZ.el?.remove(); WZ.el = null; $("#newsBanner")?.classList.add("hidden");
}

/** Suggest a Jira issue for a template from my open / recently used / logged issues.
    Only strong matches count: a multi-word phrase ("aws connect", "team support") or a distinctive word ("dsm", "lambda"). */
const WZ_GENERIC = new Set(["aws", "api", "team", "support", "meeting", "meetings", "review", "test", "testing", "case", "design", "analysis", "fix", "doc", "docs",
  "release", "deploy", "deployment", "daily", "planning", "sprint", "bug", "bugs", "prod", "production", "development", "dev", "backend", "learning", "research",
  "training", "requirement", "requirements", "discussion", "unit", "pipeline", "defect", "defects", "code", "pr", "sr", "connect", "contact", "flow", "raised", "follow"]);
function wzSuggest(t) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const phrases = [...new Set([norm(t.name), ...String(t.aliases || "").split(",").map(norm)].filter(Boolean))];
  let best = null, bestScore = 0;
  for (const i of Object.values(IDX.items)) {
    const hay = ` ${norm(i.summary)} ${norm(i.key)} `;
    let score = 0;
    for (const p of phrases) {
      if (!new RegExp(`\\b${p.replace(/ /g, "\\s+")}`).test(hay)) continue;
      score += p.includes(" ") ? 2 : WZ_GENERIC.has(p) || p.length < 3 ? 0 : 2;
    }
    if (score > bestScore || (score === bestScore && score && (i.used || 0) > (best?.used || 0))) { best = i; bestScore = score; }
  }
  return bestScore >= 2 ? { id: best.id, key: best.key, summary: best.summary } : null;
}

function wzRender() {
  const head = `<div class="wiz-steps">${WZ_STEPS.map((n, i) => `<span class="${i === WZ.step ? "on" : i < WZ.step ? "done" : ""}">${i + 1} · ${n}</span>`).join("")}</div>`;
  const foot = (next, back = true) => `<div class="foot"><button id="wzSkip">Skip setup</button><div class="grow"></div>${back && WZ.step > (S.me ? 1 : 0) ? '<button id="wzBack">Back</button>' : ""}<button id="wzNext" class="primary">${next}</button></div>`;
  let body = "";
  if (WZ.step === 0) {
    const c = creds.get();
    body = `<h3>Connect your Jira</h3><p class="muted">Create an API token at id.atlassian.com → Security → API tokens. It stays in this browser only.</p>
      <div class="form"><label>Jira site URL <input id="wzBase" placeholder="https://yourcompany.atlassian.net" value="${esc(c?.base || "")}"></label>
      <label>Atlassian email <input id="wzEmail" type="email" value="${esc(c?.email || "")}"></label>
      <label>API token <input id="wzToken" type="password" autocomplete="off"></label>
      <label class="check"><input id="wzRemember" type="checkbox" checked> Remember on this device <span class="muted tiny">(needed for the daily auto-log)</span></label>
      <p id="wzErr" class="st-failed"></p></div>` + foot("Connect", false);
  } else if (WZ.step === 1) {
    const rows = JTT.templates.map((t) => {
      const sug = t.issue ? null : wzSuggest(t), issue = t.issue || sug;
      if (WZ.use[t.id] === undefined) WZ.use[t.id] = !!issue;
      if (sug && !WZ.sug[t.id]) WZ.sug[t.id] = sug;
      return `<div class="wz-row" data-t="${t.id}"><input type="checkbox" class="wzUse" ${WZ.use[t.id] ? "checked" : ""} aria-label="Use ${esc(t.name)}">
        <div><b>${esc(t.name)}</b><small class="muted"> ${esc(t.cat)}</small></div>
        <div class="tiss"><input class="wzQ" placeholder="Pick Jira issue…" value="${esc(issue ? issue.key + " — " + issue.summary : "")}">${sug ? '<span class="sugg">suggested</span>' : ""}<div class="results hidden"></div></div>
        <input class="wzH" value="${esc(WZ.hours[t.id] || t.duration)}" aria-label="Hours"></div>`;
    }).join("");
    body = `<h3>What do you work on?</h3><p class="muted">Tick the work you do and pick its Jira issue. Suggestions come from your open issues and recent worklogs.</p>
      <div class="scroll" style="max-height:52vh">${rows}</div><p id="wzErr" class="st-failed"></p>` + foot("Next");
  } else if (WZ.step === 2) {
    const picked = JTT.templates.filter((t) => WZ.use[t.id]);
    const total = picked.reduce((a, t) => a + parseDuration(WZ.hours[t.id] || t.duration), 0), target = S.settings.target * 3600;
    body = `<h3>Your normal day</h3><p class="muted">This day plan is used for Fill my month, the Today card and the daily auto-log (Mon–Fri).</p>
      <label>Plan name <input id="wzPlanName" value="${esc(WZ.planName)}" maxlength="60"></label>
      <table>${picked.map((t) => `<tr data-t="${t.id}"><td>${esc(t.name)}</td><td class="muted">${esc((t.issue || WZ.sug[t.id])?.key || "")}</td><td><input class="wzH2" value="${esc(WZ.hours[t.id] || t.duration)}" aria-label="Hours"></td></tr>`).join("")}</table>
      <p>Total: <b id="wzTot" class="${total === target ? "st-success" : "st-failed"}">${fmtH(total)}</b> of ${S.settings.target}h <button id="wzFit" class="small">Fit to ${S.settings.target}h</button></p>
      <p id="wzErr" class="st-failed"></p>` + foot("Next");
  } else {
    const c = JTS.cfg;
    body = `<h3>Log it automatically</h3>
      <label class="check"><input id="wzAuto" type="checkbox" checked> Every working day at <input id="wzTime" type="time" value="${esc(c.time)}"> log my day plan</label>
      <p class="muted tiny">Runs while a JiraTime tab is open (keep it as a pinned tab). You get ${c.countdown} seconds to cancel. Days you already logged, holidays and leave are skipped. Missed days are offered next time you open JiraTime.</p>
      <label class="check"><input id="wzRem" type="checkbox" ${c.remind ? "checked" : ""}> Remind me at <input id="wzRemTime" type="time" value="${esc(c.remindTime)}"> if today is incomplete</label>` + foot("Finish");
  }
  WZ.el.innerHTML = `<div class="wiz-box">${head}${body}</div>`;
  wzWire();
}

function wzWire() {
  const q = (s) => WZ.el.querySelector(s), err = (m) => { const e = q("#wzErr"); if (e) e.textContent = m; };
  q("#wzSkip").onclick = () => { wzClose(false); if (!S.me) setupDialog(); };
  q("#wzBack")?.addEventListener("click", () => { WZ.step--; wzRender(); });
  if (WZ.step === 0) q("#wzNext").onclick = async () => {
    const next = { base: q("#wzBase").value.trim().replace(/\/+$/, ""), email: q("#wzEmail").value.trim(), token: q("#wzToken").value.trim() };
    if (!/^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(next.base)) return err("Site URL must look like https://name.atlassian.net");
    if (!next.email || !next.token) return err("Email and API token are required");
    q("#wzNext").disabled = true; q("#wzNext").textContent = "Connecting…";
    try { await jira(API.myself(), { creds: next }); } catch (e) { q("#wzNext").disabled = false; q("#wzNext").textContent = "Connect"; return err(e.status === 401 ? "Jira rejected these credentials" : e.message); }
    creds.set(next, q("#wzRemember").checked);
    closeModal(); await boot();
    await Promise.allSettled([idxRefreshOpen(true), loadMonth(new Date().getFullYear(), new Date().getMonth() - 1)]);
    WZ.step = 1; wzRender();
  };
  if (WZ.step === 1) {
    WZ.el.querySelectorAll(".wz-row").forEach((row) => {
      const t = JTT.tGet(row.dataset.t);
      attachIssueSearch(row.querySelector(".wzQ"), row.querySelector(".results"), (issue) => { WZ.sug[t.id] = issue; t.issue = issue; WZ.use[t.id] = true; JTT.save(); wzRender(); });
      row.querySelector(".wzUse").onchange = (e) => { WZ.use[t.id] = e.target.checked; };
      row.querySelector(".wzH").oninput = (e) => { WZ.hours[t.id] = e.target.value; };
    });
    q("#wzNext").onclick = () => {
      const picked = JTT.templates.filter((t) => WZ.use[t.id]);
      if (!picked.length) return err("Tick at least one kind of work");
      const noIssue = picked.filter((t) => !(t.issue || WZ.sug[t.id])); if (noIssue.length) return err(`Pick a Jira issue for: ${noIssue.map((t) => t.name).join(", ")}`);
      const badH = picked.filter((t) => !parseDuration(WZ.hours[t.id] || t.duration)); if (badH.length) return err(`Hours look wrong for: ${badH.map((t) => t.name).join(", ")}`);
      picked.forEach((t) => { t.issue = t.issue || WZ.sug[t.id]; });
      JTT.save(true); WZ.step = 2; wzRender();
    };
  }
  if (WZ.step === 2) {
    const sum = () => { let tot = 0; WZ.el.querySelectorAll("tr[data-t]").forEach((tr) => { tot += parseDuration(WZ.hours[tr.dataset.t] || JTT.tGet(tr.dataset.t).duration); }); const el = q("#wzTot"); el.textContent = fmtH(tot); el.className = tot === S.settings.target * 3600 ? "st-success" : "st-failed"; };
    WZ.el.querySelectorAll(".wzH2").forEach((inp) => { inp.oninput = () => { WZ.hours[inp.closest("tr").dataset.t] = inp.value; sum(); }; });
    q("#wzPlanName").oninput = (e) => { WZ.planName = e.target.value; };
    q("#wzFit").onclick = () => {                   // change the biggest item so the day adds up to the target
      const rows = [...WZ.el.querySelectorAll("tr[data-t]")], secsOf = (tr) => parseDuration(WZ.hours[tr.dataset.t] || JTT.tGet(tr.dataset.t).duration);
      const big = rows.sort((a, b) => secsOf(b) - secsOf(a))[0]; if (!big) return;
      const rest = rows.filter((r) => r !== big).reduce((a, r) => a + secsOf(r), 0), want = S.settings.target * 3600 - rest;
      if (want < 15 * 60) return err(`The other items already add up to ${fmtH(rest)} — untick something in the previous step`);
      WZ.hours[big.dataset.t] = secsToDur(want); big.querySelector(".wzH2").value = secsToDur(want); err(""); sum();
    };
    q("#wzNext").onclick = () => {
      const items = JTT.templates.filter((t) => WZ.use[t.id]).map((t) => ({ tid: t.id, duration: WZ.hours[t.id] || t.duration }));
      const bad = items.filter((it) => !parseDuration(it.duration)).map((it) => JTT.tGet(it.tid).name);
      if (bad.length) return err(`Hours look wrong for: ${bad.join(", ")} (e.g. 2h, 30m, 1h 30m)`);
      const name = (WZ.planName || "My day").trim(), existing = JTT.plans.find((p) => p.name === name);
      if (existing) { existing.items = items; JTT.setPlanDays(existing, [1, 2, 3, 4, 5]); JTT.save(true); }
      else JTT.addPlan({ name, items, days: [1, 2, 3, 4, 5] });
      JTT.save(true); WZ.step = 3; wzRender();
    };
  }
  if (WZ.step === 3) q("#wzNext").onclick = async () => {
    const auto = q("#wzAuto").checked, rem = q("#wzRem").checked;
    Object.assign(JTS.cfg, { enabled: auto, time: q("#wzTime").value || "18:30", remind: rem, remindTime: q("#wzRemTime").value || "17:30" });
    store.set("schedule", JTS.cfg); JT.emit("schedule");
    if ((auto || rem) && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});   // do not wait for the prompt
    wzClose(true); toast(auto ? "All set — your day plan will be logged automatically" : "Setup done");
  };
}

window.JTW = {
  open: wzOpen,
  /** Called by app.js when no Jira credentials exist. Returns true if the wizard took over. */
  autoStart() { if (localStorage.getItem("jiratime.wizardDone")) return false; wzOpen(0); return true; },
};

(function wzInit() {
  $("#setWizard")?.addEventListener("click", () => wzOpen());
  $("#tplWizard")?.addEventListener("click", () => wzOpen());
  JT.onReady(() => {
    const b = $("#newsBanner");
    if (!b || !S.me || localStorage.getItem("jiratime.wizardDone") || JTT.plans.length) return;
    b.classList.remove("hidden");
    b.innerHTML = `✨ <b>New:</b> work templates, day plans and a daily auto-log. <button id="nbGo" class="small">Set up in 2 minutes</button> <button id="nbNo" class="small ghost">Not now</button>`;
    $("#nbGo").onclick = () => wzOpen(1);
    $("#nbNo").onclick = () => { localStorage.setItem("jiratime.wizardDone", "dismissed"); b.classList.add("hidden"); };
  });
})();
