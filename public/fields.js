"use strict";
/* Issue fields editor: Original estimate, Actual Dev dates, AI usage, and any other editable Jira field.
   Field ids/options come from each issue's editmeta, so nothing is hardcoded to one Jira instance. */

const FD = { issue: null, fields: [], cur: {}, edits: {}, extra: [], presets: [] };
// The fields you fill most often (matched by name, in this order).
const FD_KEY_NAMES = ["originalestimate", "actualdevstartdate", "actualdevenddate", "aiused", "aitoolused", "aiassisteddevelopment", "aitimesaveddevelopmenthours", "aiassistedtesting", "aitimesavedtestinghours", "aiassisteddocumentation", "aitimesaveddocumentationhours", "estimatedefforts", "storypoints"];
const fdNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const fdLabel = (o) => String(o?.value ?? o?.name ?? "");

function fdKind(key, m) {
  const t = m.schema?.type, items = m.schema?.items, custom = m.schema?.custom || "";
  if (key === "timetracking") return "estimate";
  if (/textarea|rich/i.test(custom) || key === "description") return null;           // rich text: edit in Jira
  if (t === "number") return "number";
  if (t === "date") return "date";
  if (t === "string") return "text";
  if (t === "option" && Array.isArray(m.allowedValues)) return "option";
  if (t === "user") return "user";
  if (t === "array" && items === "string") return "labels";
  if (t === "array" && ["option", "version", "component"].includes(items) && Array.isArray(m.allowedValues)) return "multi";
  return null;                                                                        // cascading, datetime, etc.
}

function fdCurrent(f, issueFields) {
  const raw = issueFields[f.key];
  if (f.kind === "estimate") return issueFields.timetracking?.originalEstimate || "";
  if (raw == null) return f.kind === "multi" || f.kind === "labels" ? [] : f.kind === "user" ? null : "";
  if (f.kind === "option") return fdLabel(raw);
  if (f.kind === "multi") return raw.map(fdLabel);
  if (f.kind === "user") return { accountId: raw.accountId, displayName: raw.displayName };
  if (f.kind === "labels") return raw;
  return raw;
}

function fdToApi(f, v) {
  switch (f.kind) {
    case "number": return v === "" || v == null ? null : Number(v);
    case "date": case "text": return v || null;
    case "estimate": return { originalEstimate: String(v).trim() };
    case "user": return v ? { accountId: v.accountId } : null;
    case "labels": return v;
    case "option": { if (!v) return null; const o = f.allowed.find((a) => fdLabel(a) === v); if (!o) throw new Error(`"${v}" is not an allowed value for ${f.name}`); return { id: o.id }; }
    case "multi": return v.map((l) => { const o = f.allowed.find((a) => fdLabel(a) === l); if (!o) throw new Error(`"${l}" is not allowed for ${f.name}`); return { id: o.id }; });
  }
}

const fdShow = (v) => v == null || v === "" ? "—" : Array.isArray(v) ? (v.join(", ") || "—") : typeof v === "object" ? v.displayName || v.accountId : String(v);
const fdSame = (a, b) => JSON.stringify(a ?? "") === JSON.stringify(b ?? "");

function fdBuildFields(meta) {
  const list = Object.entries(meta.fields || {}).map(([key, m]) => {
    const kind = fdKind(key, m);
    return kind ? { key, name: key === "timetracking" ? "Original estimate" : m.name, kind, allowed: m.allowedValues || [], required: !!m.required } : null;
  }).filter(Boolean);
  // Some Jira setups do not list time tracking in editmeta although it is editable; always offer it.
  if (!list.some((f) => f.key === "timetracking")) list.unshift({ key: "timetracking", name: "Original estimate", kind: "estimate", allowed: [], required: false });
  return list;
}

const fdSecs = (n) => (n ? secsToDur(n) : "0m");
function fdTimeInfo(f) {
  const t = f.timetracking || {};
  const spentS = t.timeSpentSeconds ?? f.aggregatetimespent ?? f.timespent ?? 0;
  const origS = t.originalEstimateSeconds ?? f.timeoriginalestimate ?? 0;
  const remS = t.remainingEstimateSeconds ?? f.timeestimate ?? null;
  return { spentS, origS, remS, spent: t.timeSpent || (spentS ? fdSecs(spentS) : ""), orig: t.originalEstimate || (origS ? fdSecs(origS) : ""), rem: t.remainingEstimate || (remS != null ? fdSecs(remS) : "") };
}
function fdIsFilled(v) { return !(v == null || v === "" || (Array.isArray(v) && !v.length)); }

async function fdLoadIssue(issue) {
  FD.issue = issue; FD.edits = {};
  $("#fdIssue").textContent = `Loading ${issue.key}…`;
  try {
    const [meta, data] = await Promise.all([jira(`/rest/api/3/issue/${encodeURIComponent(issue.key)}/editmeta`), jira(`/rest/api/3/issue/${encodeURIComponent(issue.key)}?fields=*all`)]);
    FD.fields = fdBuildFields(meta);
    FD.cur = Object.fromEntries(FD.fields.map((f) => [f.key, fdCurrent(f, data.fields || {})]));
    FD.time = fdTimeInfo(data.fields || {});
    FD.issue = { id: data.id, key: data.key, summary: data.fields?.summary || issue.summary || "" };
    $("#fdIssue").textContent = `${FD.issue.key} — ${FD.issue.summary}`.slice(0, 90);
  } catch (e) { FD.fields = []; $("#fdIssue").textContent = ""; toast("Could not load issue: " + e.message); }
  fdRender();
}

const fdShown = () => {
  const key = FD_KEY_NAMES.map((n) => FD.fields.find((f) => fdNorm(f.name) === n)).filter(Boolean);
  const extra = FD.extra.map((n) => FD.fields.find((f) => fdNorm(f.name) === n)).filter((f) => f && !key.includes(f));
  // everything that already has a value in Jira is shown automatically
  const filled = FD.fields.filter((f) => !key.includes(f) && !extra.includes(f) && fdIsFilled(FD.cur[f.key])).sort((a, b) => a.name.localeCompare(b.name));
  return { key, extra, filled };
};
const fdVal = (f) => (f.key in FD.edits ? FD.edits[f.key] : FD.cur[f.key]);

function fdInput(f) {
  const v = fdVal(f), k = `data-k="${esc(f.key)}"`;
  switch (f.kind) {
    case "number": return `<input type="number" step="any" ${k} value="${esc(v ?? "")}">`;
    case "date": return `<input type="date" ${k} value="${esc(v ?? "")}">`;
    case "text": case "estimate": return `<input type="text" ${k} value="${esc(v ?? "")}" ${f.kind === "estimate" ? 'placeholder="e.g. 1w 2d 4h"' : ""}>`;
    case "labels": return `<input type="text" ${k} value="${esc((v || []).join(", "))}" placeholder="comma separated">`;
    case "option": return `<select ${k}><option value="">— none —</option>${f.allowed.map((o) => `<option ${fdLabel(o) === v ? "selected" : ""}>${esc(fdLabel(o))}</option>`).join("")}</select>`;
    case "multi": return `<div class="multi" ${k}>${f.allowed.map((o) => `<button type="button" class="${(v || []).includes(fdLabel(o)) ? "on" : ""}" data-l="${esc(fdLabel(o))}">${esc(fdLabel(o))}</button>`).join("")}</div>`;
    case "user": return `<input type="text" ${k} class="fduser" placeholder="Search user…" value="${esc(v?.displayName || "")}"><div class="ures hidden"></div>`;
  }
}

function fdRender() {
  const box = $("#fdForm");
  if (!FD.issue || !FD.fields.length) { box.innerHTML = '<p class="muted">Search and pick an issue.</p>'; fdFooter(); return; }
  const { key, extra, filled } = fdShown();
  const card = (f, removable) => `<div class="fd ${f.key in FD.edits ? "dirty" : ""}" data-f="${esc(f.key)}"><label>${esc(f.name)}${f.required ? " *" : ""}</label>${fdInput(f)}
    <div class="was">${f.key in FD.edits ? `was: ${esc(fdShow(FD.cur[f.key]))}` : ""}</div>${removable ? `<button class="x" data-rm="${esc(fdNorm(f.name))}" title="Remove from this list">✕</button>` : ""}</div>`;
  const t = FD.time || {}, pct = t.origS ? Math.min(100, Math.round((t.spentS / t.origS) * 100)) : 0;
  const timePanel = `<div class="fd grp">Time tracking</div><div class="fd tt" style="grid-column:1/-1">
    <div class="tt-row"><span><b>${esc(t.spent || "0m")}</b> logged</span><span>Original estimate: <b>${esc(t.orig || "not set")}</b></span><span>Remaining: <b>${esc(t.rem || "—")}</b></span></div>
    <div class="progress" style="margin:8px 0 0"><div style="height:100%;width:${pct}%;background:${t.origS && t.spentS > t.origS ? "var(--bad)" : "linear-gradient(90deg,var(--acc),var(--acc2))"}"></div></div>
    ${t.origS ? `<div class="was">${pct}% of estimate used${t.spentS > t.origS ? " — over estimate" : ""}</div>` : '<div class="was">Set an Original estimate below to track progress.</div>'}
    <div id="fdAi" class="fdai"></div></div>`;
  box.innerHTML = timePanel + (key.length ? '<div class="fd grp">Key fields</div>' + key.map((f) => card(f, false)).join("") : '<div class="fd grp">None of the usual fields exist on this issue — add fields below.</div>') +
    (filled.length ? '<div class="fd grp">Already filled in Jira</div>' + filled.map((f) => card(f, false)).join("") : "") +
    (extra.length ? '<div class="fd grp">Your extra fields</div>' + extra.map((f) => card(f, true)).join("") : "");
  const shown = new Set([...key, ...extra, ...filled].map((f) => f.key));
  $("#fdAdd").innerHTML = '<option value="">＋ Add another field…</option>' + FD.fields.filter((f) => !shown.has(f.key)).sort((a, b) => a.name.localeCompare(b.name)).map((f) => `<option value="${esc(fdNorm(f.name))}">${esc(f.name)}</option>`).join("");
  fdFooter(); fdAiLine();
}

/** Live AI efficiency for the issue being edited (uses the values on screen, saved or not). */
function fdAiLine() {
  const el = $("#fdAi"); if (!el || !window.AIEFF) return;
  const est = FD.fields.find((f) => f.kind === "estimate");
  const estS = est && est.key in FD.edits ? AIEFF.jiraSecs(FD.edits[est.key]) : FD.time?.origS || 0;
  const spentS = FD.time?.spentS || 0;                                            // effort logged with AI
  const savedH = estS ? Math.round(((estS - spentS) / 3600) * 100) / 100 : 0;    // estimate is the effort without AI
  const pct = AIEFF.pct(savedH, estS), b = AIEFF.bands;
  el.innerHTML = `<span class="muted">AI efficiency</span> ${AIEFF.badge(pct)}
    <span class="muted tiny">${estS ? `estimate ${secsToDur(estS)} (without AI) − logged ${secsToDur(spentS)} (with AI) = ${savedH < 0 ? `${-savedH}h over` : `${savedH}h saved`} · target ${b.min}–${b.good}%, max ${b.max}%` : "Set an Original estimate to calculate it"}</span>`;
}

/** Fill values by field name (from the AI report). Nothing is saved until the user presses Save. */
function fdApplyValues(values) {
  const done = [], skip = [];
  for (const [name, v] of Object.entries(values || {})) {
    const f = FD.fields.find((x) => fdNorm(x.name) === fdNorm(name));
    if (!f) { skip.push(name); continue; }
    if (f.kind === "option" && v && !f.allowed.some((o) => fdLabel(o) === v)) { skip.push(name); continue; }
    fdSet(f, f.kind === "number" ? Number(v) : v); done.push(f.name);
    if (!fdShown().key.includes(f) && !FD.extra.includes(fdNorm(f.name))) FD.extra.push(fdNorm(f.name));
  }
  fdRender();
  if (done.length) toast(`Filled ${done.join(", ")} — review and press Save changes`);
  if (skip.length) toast(`Not available on this issue: ${skip.join(", ")}`);
}

function fdFooter() {
  const n = Object.keys(FD.edits).length;
  $("#fdCount").textContent = n ? `${n} change${n > 1 ? "s" : ""}` : "";
  $("#fdSave").disabled = !n; $("#fdBulk").disabled = !n;
}

function fdSet(f, v) {
  if (fdSame(v, FD.cur[f.key])) delete FD.edits[f.key]; else FD.edits[f.key] = v;
  const card = $(`#fdForm [data-f="${CSS.escape(f.key)}"]`);
  if (card) { card.classList.toggle("dirty", f.key in FD.edits); card.querySelector(".was").textContent = f.key in FD.edits ? "was: " + fdShow(FD.cur[f.key]) : ""; }
  fdFooter(); fdAiLine();
}

// ---------- save ----------
function fdConfirm() {
  const rows = Object.entries(FD.edits).map(([k, v]) => { const f = FD.fields.find((x) => x.key === k); return `<tr><td>${esc(f.name)}</td><td class="muted">${esc(fdShow(FD.cur[k]))}</td><td>→</td><td><b>${esc(fdShow(v))}</b></td></tr>`; }).join("");
  openModal(`<h3>Update ${esc(FD.issue.key)}?</h3><table>${rows}</table>
    <div class="foot"><button id="fdNo">Cancel</button><button id="fdYes" class="primary">Save to Jira</button></div>`);
  $("#fdNo").onclick = closeModal; $("#fdYes").onclick = fdSave;
}

async function fdSave() {
  try {
    const fields = {};
    for (const [k, v] of Object.entries(FD.edits)) fields[k] = fdToApi(FD.fields.find((f) => f.key === k), v);
    await jira(`/rest/api/2/issue/${encodeURIComponent(FD.issue.key)}`, { method: "PUT", body: JSON.stringify({ fields }) });
    closeModal(); toast(`Saved ${Object.keys(fields).length} field(s) on ${FD.issue.key}`);
    JT.emit("issue", { key: FD.issue.key });
    await fdLoadIssue(FD.issue);
  } catch (e) {
    openModal(`<h3>Jira rejected the update</h3><p class="st-failed">${esc(e.message)}</p><p class="muted tiny">Common reasons: the field is not on this issue's edit screen, or a required value is missing.</p><div class="foot"><button id="fdOk" class="primary">Close</button></div>`);
    $("#fdOk").onclick = closeModal;
  }
}

// ---------- dev dates from my worklogs ----------
async function fdDatesFromWorklogs() {
  if (!FD.issue || !S.me) return;
  try {
    const wl = await jira(API.issueWorklogs(FD.issue.id));
    const dates = (wl.worklogs || []).filter((w) => w.author?.accountId === S.me.accountId).map((w) => String(w.started).slice(0, 10)).sort();
    if (!dates.length) { toast("You have no worklogs on this issue"); return; }
    const start = FD.fields.find((f) => fdNorm(f.name) === "actualdevstartdate"), end = FD.fields.find((f) => fdNorm(f.name) === "actualdevenddate");
    if (!start && !end) { toast("This issue has no Actual Dev Start/End Date fields"); return; }
    if (start) fdSet(start, dates[0]); if (end) fdSet(end, dates[dates.length - 1]);
    fdRender(); toast(`Dev dates: ${prettyDate(dates[0])} → ${prettyDate(dates[dates.length - 1])}`);
  } catch (e) { toast(e.message); }
}

// ---------- presets (reusable sets of values, e.g. "AI used with Kiro") ----------
function fdRenderPresets() { $("#fdPreset").innerHTML = '<option value="">Presets…</option>' + FD.presets.map((p, i) => `<option value="${i}">${esc(p.name)} (${Object.keys(p.values).length})</option>`).join(""); }
async function fdPresetSave() {
  const entries = Object.entries(FD.edits); if (!entries.length) { toast("Change some fields first, then save them as a preset"); return; }
  const name = await uiPrompt("Preset name?", "AI used – Kiro"); if (!name) return;
  FD.presets.push({ name, values: Object.fromEntries(entries.map(([k, v]) => [FD.fields.find((f) => f.key === k).name, v])) });
  await store.set("fdPresets", FD.presets); fdRenderPresets(); toast("Preset saved");
}
function fdPresetApply(p) {
  let n = 0, miss = [];
  for (const [name, v] of Object.entries(p.values)) {
    const f = FD.fields.find((x) => fdNorm(x.name) === fdNorm(name));
    if (!f) { miss.push(name); continue; }
    if (f.kind === "option" && v && !f.allowed.some((o) => fdLabel(o) === v)) { miss.push(name); continue; }
    fdSet(f, v); n++;
    if (!fdShown().key.includes(f) && !FD.extra.includes(fdNorm(f.name))) FD.extra.push(fdNorm(f.name));
  }
  fdRender(); toast(`Preset applied (${n} field${n === 1 ? "" : "s"})${miss.length ? `; not available here: ${miss.join(", ")}` : ""}`);
}

// ---------- apply the same changes to other issues ----------
function fdBulkDialog() {
  const map = new Map();
  Object.values(S.months).forEach((md) => Object.values(md.issues || {}).forEach((i) => map.set(String(i.id), i)));
  S.pinned.forEach((p) => map.set(String(p.id), p));
  map.delete(String(FD.issue.id));
  const list = [...map.values()];
  openModal(`<h3>Apply to other issues</h3>
    <p class="muted">Same values for: ${Object.keys(FD.edits).map((k) => esc(FD.fields.find((f) => f.key === k).name)).join(", ")}.<br>Issues you logged work on (loaded months) and pinned ones:</p>
    <div class="scroll" style="max-height:38vh">${list.map((i) => `<label class="check" style="margin:4px 0"><input type="checkbox" class="bk" value="${esc(i.id)}" data-k="${esc(i.key)}"> <b>${esc(i.key)}</b> <span class="muted">${esc((i.summary || "").slice(0, 70))}</span></label>`).join("") || '<p class="muted">No other issues found.</p>'}</div>
    <div class="foot"><button id="bkNo">Cancel</button><button id="bkGo" class="primary">Apply</button></div>`);
  $("#bkNo").onclick = closeModal;
  $("#bkGo").onclick = async () => {
    const targets = [...document.querySelectorAll(".bk:checked")].map((c) => ({ id: c.value, key: c.dataset.k }));
    if (!targets.length) return;
    const out = [];
    for (const t of targets) {
      try {
        const meta = fdBuildFields(await jira(`/rest/api/3/issue/${encodeURIComponent(t.key)}/editmeta`));
        const fields = {}, skipped = [];
        for (const [k, v] of Object.entries(FD.edits)) {
          const src = FD.fields.find((f) => f.key === k), f = meta.find((x) => x.key === k) || meta.find((x) => fdNorm(x.name) === fdNorm(src.name));
          if (!f) { skipped.push(src.name); continue; }
          fields[f.key] = fdToApi(f, v);
        }
        if (!Object.keys(fields).length) { out.push([t.key, false, "none of the fields exist on this issue"]); continue; }
        await jira(`/rest/api/2/issue/${encodeURIComponent(t.key)}`, { method: "PUT", body: JSON.stringify({ fields }) });
        out.push([t.key, true, skipped.length ? `skipped: ${skipped.join(", ")}` : "updated"]);
      } catch (e) { out.push([t.key, false, e.message]); }
      await sleep(S.settings.delay);
    }
    openModal(`<h3>Done</h3><table>${out.map(([k, ok, m]) => `<tr><td>${esc(k)}</td><td class="${ok ? "st-success" : "st-failed"}">${ok ? "OK" : "Failed"} — ${esc(m)}</td></tr>`).join("")}</table><div class="foot"><button id="bkOk" class="primary">Close</button></div>`);
    $("#bkOk").onclick = closeModal;
  };
}

// ---------- entry points ----------
window.openIssueFields = async (issue, values) => {
  document.querySelector('.nav[data-view="fields"]').click();
  await fdLoadIssue(issue);
  if (values && FD.fields.length) fdApplyValues(values);
};

(async function fdInit() {
  JT.on("aibands", fdAiLine);
  FD.extra = await store.get("fdExtra", []); FD.presets = await store.get("fdPresets", []); fdRenderPresets();
  attachIssueSearch($("#fdSearch"), $("#fdRes"), (i) => { $("#fdSearch").value = ""; fdLoadIssue(i); });
  $("#fdSave").onclick = fdConfirm; $("#fdBulk").onclick = fdBulkDialog; $("#fdDates").onclick = fdDatesFromWorklogs; $("#fdPresetSave").onclick = fdPresetSave;
  $("#fdPreset").onchange = (e) => { const p = FD.presets[e.target.value]; e.target.value = ""; if (p && FD.issue) fdPresetApply(p); else if (p) toast("Pick an issue first"); };
  $("#fdAdd").onchange = async (e) => { if (!e.target.value) return; FD.extra.push(e.target.value); await store.set("fdExtra", FD.extra); fdRender(); };

  const form = $("#fdForm"), field = (el) => FD.fields.find((f) => f.key === el.closest(".fd")?.dataset.f);
  form.addEventListener("change", (e) => {
    const f = field(e.target); if (!f || f.kind === "multi" || f.kind === "user") return;
    const v = e.target.value;
    fdSet(f, f.kind === "labels" ? v.split(",").map((s) => s.trim()).filter(Boolean) : f.kind === "number" ? (v === "" ? "" : Number(v)) : v);
  });
  form.addEventListener("click", async (e) => {
    const rm = e.target.closest("[data-rm]");
    if (rm) { FD.extra = FD.extra.filter((n) => n !== rm.dataset.rm); await store.set("fdExtra", FD.extra); fdRender(); return; }
    const b = e.target.closest(".multi button"); if (!b) return;
    const f = field(b), cur = new Set(fdVal(f) || []);
    cur.has(b.dataset.l) ? cur.delete(b.dataset.l) : cur.add(b.dataset.l);
    fdSet(f, [...cur]); b.classList.toggle("on");
  });
  // user picker
  let timer;
  form.addEventListener("input", (e) => {
    if (!e.target.classList.contains("fduser")) return;
    const f = field(e.target), res = e.target.nextElementSibling; clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = e.target.value.trim(); if (!q) { fdSet(f, null); res.classList.add("hidden"); return; }
      try {
        const users = await jira(`/rest/api/3/user/assignable/search?query=${encodeURIComponent(q)}&issueKey=${encodeURIComponent(FD.issue.key)}&maxResults=8`);
        res.innerHTML = users.map((u) => `<div data-a="${esc(u.accountId)}" data-n="${esc(u.displayName)}">${esc(u.displayName)}</div>`).join("") || '<div class="muted">No users</div>';
        res.classList.remove("hidden");
      } catch { res.classList.add("hidden"); }
    }, 300);
  });
  form.addEventListener("mousedown", (e) => {
    const d = e.target.closest(".ures [data-a]"); if (!d) return;
    const f = field(d), input = d.closest(".fd").querySelector(".fduser");
    input.value = d.dataset.n; d.parentElement.classList.add("hidden"); fdSet(f, { accountId: d.dataset.a, displayName: d.dataset.n });
  });
})();
