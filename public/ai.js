"use strict";
/* AI efficiency report.
   AI efficiency % = (sum of all "AI Time Saved – … (Hours)" fields) ÷ Original estimate × 100, per Jira issue.
   Bands (editable): below 10 % = too low (red) · 10–20 % = on target (green) · 20–40 % = high (blue) · above 40 % = over the max (orange).
   Field ids are discovered by name from /rest/api/3/field, so this works on any Jira that has these fields.
   Uses globals from app.js (S, $, esc, jira, store, toast, …) and window.openIssueFields from fields.js. */

const AI_DEF = { min: 10, good: 20, max: 40 };
const AI = { bands: { ...AI_DEF }, meta: null, rows: [], filter: "all", period: "month", loadedAt: 0, loading: false, err: "" };
const aiNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Jira duration text ("1w 2d 4h 30m", "90m", "2") → seconds. 1d = 8h, 1w = 5d (Jira defaults). */
function jiraSecs(v) {
  const t = String(v ?? "").trim().toLowerCase();
  if (!t) return 0;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t) * 3600);
  const units = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };
  let secs = 0, hit = false;
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/g)) { secs += parseFloat(m[1]) * units[m[2]]; hit = true; }
  return hit ? Math.round(secs) : 0;
}

/** Band for a percentage (null = no Original estimate). */
function aiBand(pct, b = AI.bands) {
  if (pct == null) return { id: "noest", label: "No estimate" };
  if (pct < b.min) return { id: "low", label: `Below ${b.min}%` };
  if (pct <= b.good) return { id: "good", label: "On target" };
  if (pct <= b.max) return { id: "high", label: `High (${b.good}–${b.max}%)` };
  return { id: "over", label: `Above ${b.max}% max` };
}
const aiPct = (savedH, estS) => (estS > 0 ? Math.round(((savedH * 3600) / estS) * 1000) / 10 : null);
const aiTarget = (b = AI.bands) => (b.min + b.good) / 2;                       // middle of the green band
const fmtPct = (p) => (p == null ? "—" : `${p}%`);
const fmtHrs = (h) => (Math.round(h * 100) / 100) + "h";

function aiBadge(pct) {
  const band = aiBand(pct), w = pct == null ? 0 : Math.min(100, (pct / Math.max(AI.bands.max * 1.25, 1)) * 100);
  return `<div class="effc"><span class="eff ${band.id}">${fmtPct(pct)}</span><span class="effl">${esc(band.label)}</span>
    <div class="effbar"><div class="${band.id}" style="width:${w}%"></div><i style="left:${(AI.bands.min / (AI.bands.max * 1.25)) * 100}%"></i><i style="left:${(AI.bands.max / (AI.bands.max * 1.25)) * 100}%"></i></div></div>`;
}

// ---------- field discovery ----------
async function aiMeta() {
  if (AI.meta) return AI.meta;
  const list = await jira("/rest/api/3/field");
  const byNorm = (n) => list.find((f) => aiNorm(f.name) === n);
  const saved = list.filter((f) => aiNorm(f.name).startsWith("aitimesaved") && f.schema?.type === "number")
    .map((f) => ({ id: f.id, name: f.name, kind: /develop/i.test(f.name) ? "dev" : /test/i.test(f.name) ? "test" : /doc/i.test(f.name) ? "doc" : "other" }));
  AI.meta = { saved, used: byNorm("aiused"), tool: byNorm("aitoolused"), dev: saved.find((f) => f.kind === "dev") || saved[0] || null };
  return AI.meta;
}

const aiWl = (a, b) => `worklogAuthor = currentUser() AND worklogDate >= "${ymdOf(a)}" AND worklogDate <= "${ymdOf(b)}"`;
const aiMonthJql = (y, m) => aiWl(new Date(y, m, 1), new Date(y, m + 1, 0));
function aiJql(period) {
  const d = new Date(), wl = aiWl;
  if (period === "month") return aiMonthJql(S.y, S.m);
  if (period === "prev") return wl(new Date(d.getFullYear(), d.getMonth() - 1, 1), new Date(d.getFullYear(), d.getMonth(), 0));
  if (period === "q") return wl(new Date(d.getFullYear(), d.getMonth() - 2, 1), d);
  return "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
}

function aiRow(is, meta) {
  const f = is.fields || {}, estS = f.timeoriginalestimate ?? f.aggregatetimeoriginalestimate ?? 0;
  const parts = meta.saved.map((m) => ({ ...m, h: Number(f[m.id]) || 0 })), savedH = parts.reduce((a, p) => a + p.h, 0);
  const used = meta.used ? (f[meta.used.id]?.value ?? (typeof f[meta.used.id] === "string" ? f[meta.used.id] : "")) : "";
  const tool = meta.tool ? [].concat(f[meta.tool.id] || []).map((o) => o?.value ?? o).filter(Boolean).join(", ") : "";
  const pct = aiPct(savedH, estS);
  return { id: is.id, key: is.key, summary: f.summary || "", status: f.status?.name || "", type: f.issuetype?.name || "", estS, spentS: f.timespent ?? f.aggregatetimespent ?? 0, parts, savedH, used, tool, pct, band: aiBand(pct).id };
}

async function aiFetch(jql) {
  const meta = await aiMeta();
  const fields = ["summary", "status", "issuetype", "timeoriginalestimate", "aggregatetimeoriginalestimate", "timespent", "aggregatetimespent", ...meta.saved.map((m) => m.id), meta.used?.id, meta.tool?.id].filter(Boolean).join(",");
  const issues = []; let token = null;
  do {
    const r = await jira(`/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&maxResults=100&fields=${encodeURIComponent(fields)}${token ? "&nextPageToken=" + encodeURIComponent(token) : ""}`);
    issues.push(...(r.issues || [])); token = r.nextPageToken || null;
  } while (token && issues.length < 300);
  const rows = issues.map((is) => aiRow(is, meta));
  idxAdd(rows.map((r) => ({ id: r.id, key: r.key, summary: r.summary, status: r.status })), "worklog");
  return rows;
}

/** Overall = Σ AI time saved ÷ Σ Original estimate, over issues that HAVE an estimate (others are counted separately). */
function aiOverall(rows) {
  const est = rows.filter((r) => r.estS > 0), totEst = est.reduce((a, r) => a + r.estS, 0), totSaved = est.reduce((a, r) => a + r.savedH, 0);
  const n = (id) => rows.filter((r) => aiBand(r.pct).id === id).length;
  return { issues: rows.length, withEst: est.length, noEst: rows.length - est.length, totEst, totSaved, pct: aiPct(totSaved, totEst), low: n("low"), good: n("good"), high: n("high"), over: n("over") };
}

// month summaries for the dashboard card (cached per month for 10 minutes)
const AIM = {};
function aiMonthLoad(y, m, force) {
  const key = monthKey(y, m), c = AIM[key];
  if (c?.p) return c.p;
  if (!force && c?.rows && Date.now() - c.at < 10 * 60e3) return Promise.resolve(c.rows);
  const p = aiFetch(aiMonthJql(y, m)).then(
    (rows) => { AIM[key] = { at: Date.now(), rows }; aiCard(); return rows; },
    (e) => { AIM[key] = { at: Date.now(), rows: c?.rows || null, err: e.message }; aiCard(); throw e; });
  AIM[key] = { ...(c || {}), p };
  return p;
}

function aiCard() {
  const el = $("#aiCard"); if (!el) return;
  const key = monthKey(S.y, S.m), c = AIM[key], mon = MONTHS[S.m].slice(0, 3);
  if (!S.me) { el.innerHTML = `<b class="eff noest">—</b><span>AI efficiency</span><small>connect Jira</small>`; return; }
  if (!c || (!c.rows && !c.p && !c.err) || (Date.now() - c.at > 10 * 60e3 && !c.p)) aiMonthLoad(S.y, S.m).catch(() => {});
  const cur = AIM[key];
  if (!cur?.rows) {
    el.innerHTML = cur?.err ? `<b class="eff noest">⚠</b><span>AI efficiency · ${mon}</span><small>could not load — click to open</small>`
      : `<b class="eff noest">…</b><span>AI efficiency · ${mon}</span><small>loading</small>`;
    return;
  }
  const o = aiOverall(cur.rows), band = aiBand(o.pct);
  el.innerHTML = `<b class="eff ${band.id}">${fmtPct(o.pct)}</b><span>AI efficiency · ${mon}</span>
    <small>${o.withEst ? `${fmtHrs(o.totSaved)} saved / ${fmtHrs(o.totEst / 3600)} estimate` : "no issue has an Original estimate"}${o.noEst ? ` · ${o.noEst} without estimate` : ""}${o.low + o.over ? `<br><span class="st-failed">${o.low + o.over} issue${o.low + o.over > 1 ? "s" : ""} outside ${AI.bands.min}–${AI.bands.max}%</span>` : ""}</small>`;
  el.title = `AI efficiency for issues you logged work on in ${MONTHS[S.m]} ${S.y}\n= Σ AI Time Saved (dev+test+doc) ÷ Σ Original estimate, over issues that have an estimate.\nClick to open the AI efficiency report.`;
}

async function aiLoad(force) {
  if (AI.loading || !S.me) return;
  const tag = AI.period + monthKey(S.y, S.m);
  if (!force && AI.rows.length && Date.now() - AI.loadedAt < 5 * 60e3 && AI.loadedFor === tag) return aiRender();
  const cached = AI.period === "month" && AIM[monthKey(S.y, S.m)];
  if (!force && cached?.rows && Date.now() - cached.at < 5 * 60e3) { AI.rows = cached.rows; AI.loadedAt = cached.at; AI.loadedFor = tag; return aiRender(); }
  AI.loading = true; AI.err = ""; aiRender();
  try {
    AI.rows = AI.period === "month" ? await aiMonthLoad(S.y, S.m, true) : await aiFetch(aiJql(AI.period));
    AI.loadedAt = Date.now(); AI.loadedFor = tag;
  } catch (e) { AI.err = e.message; }
  AI.loading = false; aiRender();
}

/** Reload one issue after its fields were saved on the Issue fields page. */
async function aiRefreshIssue(key) {
  if (!AI.meta || (!AI.rows.some((r) => r.key === key) && !Object.values(AIM).some((c) => c.rows?.some((r) => r.key === key)))) return;
  try {
    const meta = AI.meta, fields = ["summary", "status", "issuetype", "timeoriginalestimate", "aggregatetimeoriginalestimate", "timespent", "aggregatetimespent", ...meta.saved.map((m) => m.id), meta.used?.id, meta.tool?.id].filter(Boolean).join(",");
    const r = await jira(`/rest/api/3/search/jql?jql=${encodeURIComponent(`key = "${key}"`)}&maxResults=1&fields=${encodeURIComponent(fields)}`);
    if (r.issues?.[0]) {
      const row = aiRow(r.issues[0], meta), swap = (list) => list.map((x) => (x.key === key ? row : x));
      AI.rows = swap(AI.rows); for (const c of Object.values(AIM)) if (c.rows) c.rows = swap(c.rows);
      aiRender(); aiCard();
    }
  } catch { /* the next refresh picks it up */ }
}

/** What to set so the issue lands in the middle of the green band (only the Development field changes). */
function aiSuggest(r) {
  const meta = AI.meta; if (!meta?.dev || !r.estS) return null;
  const want = (aiTarget() / 100) * (r.estS / 3600), others = r.parts.filter((p) => p.id !== meta.dev.id).reduce((a, p) => a + p.h, 0);
  const dev = Math.round((want - others) * 4) / 4;                      // quarter hours
  if (dev < 0) return null;
  const values = { [meta.dev.name]: dev };
  if (meta.used && dev > 0 && !/yes/i.test(r.used)) values[meta.used.name] = "Yes";
  return { dev, values };
}

function aiRender() {
  if (!$("#aiTable")) return;
  const b = AI.bands, rows = AI.rows, meta = AI.meta;
  $("#aiMin").value = b.min; $("#aiGood").value = b.good; $("#aiMax").value = b.max;
  $("#aiRule").innerHTML = `<span class="eff low">&lt; ${b.min}%</span> too low · <span class="eff good">${b.min}–${b.good}%</span> on target · <span class="eff high">${b.good}–${b.max}%</span> high · <span class="eff over">&gt; ${b.max}%</span> above max`;
  if (AI.loading) $("#aiInfo").textContent = "Loading from Jira…";
  else if (AI.err) $("#aiInfo").innerHTML = `<span class="st-failed">⚠ ${esc(AI.err)}</span>`;
  else $("#aiInfo").textContent = AI.loadedAt ? `${rows.length} issues · updated ${new Date(AI.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  const warn = meta && !meta.saved.length ? '<div class="warnbox">No “AI Time Saved … (Hours)” number fields were found in this Jira, so every issue shows 0 h saved.</div>' : "";
  $("#aiWarn").innerHTML = warn;

  const n = (id) => rows.filter((r) => r.band === id).length;
  const o = aiOverall(rows), totEst = o.totEst, totSaved = o.totSaved, overall = o.pct;
  $("#aiStats").innerHTML = [
    ["all", rows.length, "Issues", ""], ["low", n("low"), `Below ${b.min}%`, "low"], ["good", n("good"), "On target", "good"],
    ["high", n("high"), `High ${b.good}–${b.max}%`, "high"], ["over", n("over"), `Above ${b.max}%`, "over"], ["noest", n("noest"), "No estimate", "noest"],
  ].map(([id, v, l, c]) => `<button class="stat aistat ${c} ${AI.filter === id ? "on" : ""}" data-f="${id}"><b>${v}</b><span>${esc(l)}</span></button>`).join("") +
    `<div class="stat" title="Σ AI Time Saved ÷ Σ Original estimate, over the ${o.withEst} issue(s) that have an estimate"><b class="eff ${aiBand(overall).id}">${fmtPct(overall)}</b><span>Overall (${fmtHrs(totSaved)} saved of ${fmtHrs(totEst / 3600)})</span></div>`;

  const order = { over: 0, low: 1, noest: 2, high: 3, good: 4 };
  const list = rows.filter((r) => AI.filter === "all" || r.band === AI.filter).sort((x, y) => order[x.band] - order[y.band] || (y.pct ?? -1) - (x.pct ?? -1));
  const base = creds.get()?.base || "";
  $("#aiTable").innerHTML = `<tr><th>Issue</th><th>Status</th><th>Original estimate</th><th>Logged</th><th>AI time saved</th><th>AI efficiency</th><th>AI used</th><th></th></tr>` +
    (list.map((r) => {
      const sug = (r.band === "low" || r.band === "over") ? aiSuggest(r) : null;
      const action = r.band === "noest" ? `<button class="small aifix" data-k="${esc(r.key)}">Add estimate</button>`
        : sug ? `<button class="small aifix primary-s" data-k="${esc(r.key)}" data-sug="1" title="Opens Issue fields with this value filled in; you review and save">Set dev ${fmtHrs(sug.dev)} → ${aiTarget()}%</button>`
        : `<button class="small aifix" data-k="${esc(r.key)}">Fields</button>`;
      return `<tr class="airow ${r.band}">
        <td><a href="${esc(base)}/browse/${esc(r.key)}" target="_blank" rel="noopener noreferrer"><b>${esc(r.key)}</b></a><small class="muted">${esc(r.summary.slice(0, 70))}</small></td>
        <td class="muted">${esc(r.status)}</td>
        <td>${r.estS ? secsToDur(r.estS) : '<span class="st-failed">not set</span>'}</td>
        <td class="muted">${r.spentS ? secsToDur(r.spentS) : "—"}</td>
        <td title="${esc(r.parts.map((p) => `${p.name}: ${fmtHrs(p.h)}`).join("\n"))}"><b>${fmtHrs(r.savedH)}</b><small class="muted">${esc(r.parts.filter((p) => p.h).map((p) => `${p.kind} ${fmtHrs(p.h)}`).join(" · "))}</small></td>
        <td>${aiBadge(r.pct)}</td>
        <td class="muted">${esc(r.used || "—")}${r.tool ? `<small>${esc(r.tool)}</small>` : ""}</td>
        <td class="nowrap">${action}</td></tr>`;
    }).join("") || `<tr><td colspan="8" class="muted">${AI.loading ? "Loading…" : rows.length ? "No issues in this group." : "No issues found for this period."}</td></tr>`);
}

function aiCsv() {
  const head = ["issue", "summary", "status", "original_estimate_h", "logged_h", ...(AI.meta?.saved || []).map((m) => m.name), "ai_saved_h", "ai_efficiency_pct", "band", "ai_used", "ai_tool"];
  download(`ai-efficiency-${AI.period}-${todayStr()}.csv`, csv([head, ...AI.rows.map((r) => [r.key, r.summary, r.status, r.estS / 3600, r.spentS / 3600, ...r.parts.map((p) => p.h), r.savedH, r.pct ?? "", aiBand(r.pct).label, r.used, r.tool])]));
}

window.AIEFF = { band: aiBand, pct: aiPct, jiraSecs, badge: aiBadge, get bands() { return AI.bands; }, target: aiTarget, renderCard: aiCard, overall: aiOverall, monthLoad: aiMonthLoad };

(async function aiInit() {
  AI.bands = { ...AI_DEF, ...(await store.get("aiBands", {})) };
  AI.period = await store.get("aiPeriod", "month");
  $("#aiPeriod").value = AI.period;
  aiRender();
  JT.on("view", (v) => { if (v === "ai") aiLoad(false); });
  JT.on("issue", (d) => d?.key && aiRefreshIssue(d.key));
  $("#aiRefresh").onclick = () => { AI.meta = null; aiLoad(true); };
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#aiCard")) return;
    AI.period = "month"; $("#aiPeriod").value = "month"; store.set("aiPeriod", "month"); AI.filter = "all";
    document.querySelector('.nav[data-view="ai"]').click();
  });
  JT.onReady(aiCard);
  $("#syncBtn").addEventListener("click", () => { if (S.me) aiMonthLoad(S.y, S.m, true).catch(() => {}); });
  $("#aiCsv").onclick = aiCsv;
  $("#aiPeriod").onchange = (e) => { AI.period = e.target.value; store.set("aiPeriod", AI.period); AI.filter = "all"; aiLoad(true); };
  const bandsChanged = () => {
    const min = +$("#aiMin").value, good = +$("#aiGood").value, max = +$("#aiMax").value;
    if (!(min >= 0 && min < good && good <= max && max <= 100)) { toast("Bands must be: minimum < green up to ≤ maximum ≤ 100"); aiRender(); return; }
    AI.bands = { min, good, max }; store.set("aiBands", AI.bands);
    AI.rows.forEach((r) => { r.band = aiBand(r.pct).id; });
    aiRender(); aiCard(); JT.emit("aibands");
  };
  ["aiMin", "aiGood", "aiMax"].forEach((id) => $("#" + id).addEventListener("change", bandsChanged));
  $("#aiReset").onclick = () => { AI.bands = { ...AI_DEF }; store.set("aiBands", AI.bands); AI.rows.forEach((r) => { r.band = aiBand(r.pct).id; }); aiRender(); aiCard(); JT.emit("aibands"); };
  $("#aiStats").addEventListener("click", (e) => { const s = e.target.closest("[data-f]"); if (s) { AI.filter = AI.filter === s.dataset.f ? "all" : s.dataset.f; aiRender(); } });
  $("#aiTable").addEventListener("click", (e) => {
    const btn = e.target.closest(".aifix"); if (!btn) return;
    const r = AI.rows.find((x) => x.key === btn.dataset.k); if (!r) return;
    const sug = btn.dataset.sug ? aiSuggest(r) : null;
    window.openIssueFields?.({ id: r.id, key: r.key, summary: r.summary }, sug?.values);
  });
})();
