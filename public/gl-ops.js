"use strict";
/* Pipelines (jobs by stage, job logs, retry with confirmation, environments / deployments), developer activity timeline,
   Jira ↔ GitLab lookup (merge requests, branches, commits for a Jira key; start a branch) and the Ctrl+K command palette. */

// ================= pipelines =================
const GLP = { pid: "", ref: "", status: "", page: 1, list: null, next: "", sub: "pipes", err: "", cur: null, timer: null };
function glpRenderTab() {
  const body = $("#glBody"); if (!body) return;
  const recent = glRanked().slice(0, 80).map((x) => x.p);
  if (!GLP.pid && recent[0]) GLP.pid = String(recent[0].id);
  body.innerHTML = `<div class="gl-toolbar card">
      <select id="glpP" aria-label="Project">${recent.map((p) => `<option value="${p.id}" ${String(p.id) === GLP.pid ? "selected" : ""}>${esc(p.path)}</option>`).join("")}</select>
      <div class="gl-seg"><button class="${GLP.sub === "pipes" ? "on" : ""}" data-glact="glpsub:pipes">Pipelines</button><button class="${GLP.sub === "envs" ? "on" : ""}" data-glact="glpsub:envs">Environments &amp; deployments</button></div>
      ${GLP.sub === "pipes" ? `<input id="glpR" list="glpRefs" placeholder="Branch / tag (all)" value="${esc(GLP.ref)}" style="width:200px"><datalist id="glpRefs"></datalist>
      <select id="glpS" aria-label="Status"><option value="">Any status</option>${["running", "pending", "success", "failed", "canceled", "skipped", "manual"].map((s) => `<option ${s === GLP.status ? "selected" : ""}>${s}</option>`).join("")}</select>` : ""}
      <span class="grow"></span><button class="small" data-glact="glpreload">⟳</button></div>
    <div id="glpOut"></div>`;
  $("#glpP").onchange = (e) => { GLP.pid = e.target.value; GLP.page = 1; GLP.ref = ""; glpRenderTab(); };
  $("#glpR")?.addEventListener("change", (e) => { GLP.ref = e.target.value.trim(); GLP.page = 1; glpLoad(); });
  $("#glpS")?.addEventListener("change", (e) => { GLP.status = e.target.value; GLP.page = 1; glpLoad(); });
  if (GLP.pid && $("#glpRefs")) glApi(`/projects/${GLP.pid}/repository/branches?per_page=60&sort=updated_desc`).then((r) => { const dl = $("#glpRefs"); if (dl) dl.innerHTML = (r.data || []).map((b) => `<option value="${esc(b.name)}">`).join(""); }).catch(() => {});
  glpLoad();
}
async function glpLoad() {
  const out = $("#glpOut"); if (!out || !GLP.pid) return;
  const pid = GLP.pid;
  out.innerHTML = '<div class="card"><p class="muted"><span class="spin"></span> Loading…</p></div>';
  try {
    if (GLP.sub === "envs") {
      const [envs, deps] = await Promise.all([glApi(`/projects/${pid}/environments?per_page=50&states=available`).then((r) => r.data || []), glApi(`/projects/${pid}/deployments?order_by=created_at&sort=desc&per_page=40`).then((r) => r.data || [])]);
      if (pid !== GLP.pid || !$("#glpOut")) return;
      const last = new Map(); deps.forEach((d) => { const n = d.environment?.name; if (n && !last.has(n)) last.set(n, d); });
      out.innerHTML = `<div class="gl-grid glp-envs">${envs.map((e) => { const d = last.get(e.name) || e.last_deployment;
          return `<div class="gl-card glp-env"><div class="glc-top"><b>🌐 ${esc(e.name)}</b><span class="grow"></span>${d ? `<span class="eff ${d.status === "success" ? "good" : d.status === "failed" ? "low" : "noest"}">${esc(d.status)}</span>` : ""}</div>
            <div class="muted tiny">${d ? `⎇ ${esc(d.ref)} · <code class="sha">${esc(String(d.sha || "").slice(0, 8))}</code> · ${esc(d.user?.name || "")} · ${esc(ago(d.updated_at || d.created_at))}` : "no deployment yet"}</div>
            ${e.external_url && /^https:\/\//.test(e.external_url) ? `<a class="tiny" href="${esc(e.external_url)}" target="_blank" rel="noopener noreferrer">${esc(e.external_url)}</a>` : ""}</div>`; }).join("") || '<div class="card"><p class="muted">This project has no environments. Deployments are only known to GitLab when the pipeline uses <code>environment:</code>.</p></div>'}</div>
        <div class="card" style="margin-top:12px"><h4 style="margin:0 0 8px">Recent deployments</h4><table class="gl-tbl">${deps.map((d) => `<tr><td><span class="eff ${d.status === "success" ? "good" : d.status === "failed" ? "low" : "noest"}">${esc(d.status)}</span></td>
          <td><b>${esc(d.environment?.name || "")}</b><small class="muted">⎇ ${esc(d.ref)} · <code class="sha">${esc(String(d.sha || "").slice(0, 8))}</code> ${esc(d.deployable?.commit?.title || "")}</small></td><td class="tiny">${esc(d.user?.name || "")}</td><td class="muted tiny nowrap">${esc(fmtDateTime(d.updated_at || d.created_at))}</td>
          <td>${d.deployable?.pipeline?.id ? `<button class="small" data-glact="glpopen:${pid}|${d.deployable.pipeline.id}">Pipeline</button>` : ""}</td></tr>`).join("") || '<tr><td class="muted">No deployments.</td></tr>'}</table></div>`;
      return;
    }
    const q = new URLSearchParams({ per_page: "25", page: String(GLP.page) }); if (GLP.ref) q.set("ref", GLP.ref); if (GLP.status) q.set("status", GLP.status);
    const r = await glApi(`/projects/${pid}/pipelines?${q}`);
    if (pid !== GLP.pid || !$("#glpOut")) return;
    GLP.list = r.data || []; GLP.next = r.next;
    out.innerHTML = `<div class="card"><table class="gl-tbl glp-tbl"><tr><th>Status</th><th>Pipeline</th><th>Branch / tag</th><th>Started</th><th></th></tr>${GLP.list.map((x) => `<tr data-glact="glpopen:${pid}|${x.id}">
        <td>${glPipeBadge({ status: x.status, web: x.web_url, ref: x.ref })}</td><td>#${x.id}<small class="muted">${esc(x.source || "")}</small></td>
        <td>⎇ <b>${esc(x.ref)}</b> <code class="sha">${esc(String(x.sha || "").slice(0, 8))}</code></td><td class="muted tiny nowrap">${esc(fmtDateTime(x.created_at))}<small>${esc(ago(x.updated_at))}</small></td><td><button class="small">Jobs ›</button></td></tr>`).join("") || '<tr><td colspan="5" class="muted">No pipelines match.</td></tr>'}</table>
      <div class="row-actions gl-pager" style="margin:10px 0 0"><span class="grow"></span>${GLP.page > 1 ? '<button class="small" data-glact="glppage:-1">← Newer</button>' : ""}${GLP.next ? '<button class="small" data-glact="glppage:1">Older →</button>' : ""}</div></div>`;
  } catch (e) { out.innerHTML = `<div class="warnbox">⚠ ${esc(e.message)}</div>`; }
}
const GLP_ICON = { success: "✔", failed: "✖", running: "◔", pending: "…", canceled: "⊘", skipped: "»", manual: "▶", created: "○", waiting_for_resource: "…", preparing: "…", scheduled: "⏲" };
const glpDur = (s) => (s == null ? "" : s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
async function glpOpen(pid, id) {
  pid = +pid; id = +id; clearTimeout(GLP.timer);
  const c = GLP.cur = { pid, id, pipe: null, jobs: null, job: null };
  if (!$("#glpDlg")) openModal(`<div class="gl-det gl-wide" data-gldet="${pid}" id="glpDlg"><h3>Pipeline #${id}</h3><p class="muted"><span class="spin"></span> Loading…</p></div>`);
  try {
    const [pipe, jobs] = await Promise.all([glApi(`/projects/${pid}/pipelines/${id}`).then((r) => r.data), glAll(`/projects/${pid}/pipelines/${id}/jobs`, 3)]);
    if (GLP.cur !== c) return;
    c.pipe = pipe; c.jobs = jobs.sort((a, b) => a.id - b.id); glpDraw();
    if (["running", "pending", "created", "preparing", "waiting_for_resource"].includes(pipe.status)) GLP.timer = setTimeout(() => { if (GLP.cur === c && $("#glpDlg") && !c.job) glpOpen(pid, id); }, 10000);
  } catch (e) { openModal(`<h3>Pipeline #${id}</h3><div class="warnbox">⚠ ${esc(e.message)}</div><div class="foot"><button data-glact="closedet">Close</button></div>`); }
}
function glpDraw() {
  const c = GLP.cur, p = c.pipe, stages = [];
  for (const j of c.jobs) { let s = stages.find((x) => x.name === j.stage); if (!s) stages.push((s = { name: j.stage, jobs: [] })); s.jobs.push(j); }
  const failed = c.jobs.filter((j) => j.status === "failed").length;
  openModal(`<div class="gl-det gl-wide" data-gldet="${c.pid}" id="glpDlg">
    <div class="gl-det-head"><div><h3>${glPipeBadge({ status: p.status, web: p.web_url, ref: p.ref })} Pipeline #${p.id}</h3>
      <div class="muted tiny">${esc(glmProj(c.pid)?.path || "")} · ⎇ ${esc(p.ref)} · <code class="sha">${esc(String(p.sha).slice(0, 8))}</code> · ${esc(p.user?.name || "")} · started ${esc(ago(p.started_at || p.created_at))}${p.duration ? ` · took ${glpDur(p.duration)}` : ""}${p.source ? ` · ${esc(p.source)}` : ""}</div></div>
      <div class="grow"></div>${failed ? `<button class="small" data-glact="glpretrypipe">↻ Retry ${failed} failed job${failed === 1 ? "" : "s"}</button>` : ""}${glLink(p.web_url, "Open in GitLab ↗", "small gl-ext")}</div>
    <div class="glp-stages">${stages.map((s) => `<div class="glp-stage"><div class="glp-sn">${esc(s.name)}</div>${s.jobs.map((j) => `<button class="glp-job st-${esc(j.status)} ${c.job === j.id ? "on" : ""}" data-glact="glpjob:${j.id}" title="${esc(j.status)}">
        <span class="glp-ji">${GLP_ICON[j.status] || "○"}</span><span class="glp-jn">${esc(j.name)}</span><span class="muted tiny">${glpDur(j.duration)}</span>${j.allow_failure && j.status === "failed" ? '<span class="b diff">allowed</span>' : ""}</button>`).join("")}</div>`).join("") || (p.source === "external" ? '<p class="muted">This is an external pipeline (run by another CI system, e.g. Jenkins / DevSecOps) — GitLab has no jobs or logs for it. Use “Open in GitLab” for the link to that system.</p>' : '<p class="muted">No jobs.</p>')}</div>
    <div id="glpLog"></div>
    <div class="foot"><button data-glact="closedet">Close</button></div></div>`);
  if (c.job) glpJob(c.job);
}
/** ANSI colour codes -> one HTML string per line (spans closed at each line end); GitLab section markers removed. */
function glpAnsi(text) {
  const COL = { 30: "a-k", 31: "a-r", 32: "a-g", 33: "a-y", 34: "a-b", 35: "a-m", 36: "a-c", 37: "a-w", 90: "a-k", 91: "a-r", 92: "a-g", 93: "a-y", 94: "a-b", 95: "a-m", 96: "a-c", 97: "a-w" };
  const clean = String(text).replace(/section_(start|end):\d+:[^\r\n]*?\r?\x1b\[0K/g, "").replace(/\r\n/g, "\n").replace(/^.*\r(?!\n)/gm, "");
  let color = "", bold = false;
  return clean.replace(/\n$/, "").split("\n").map((line) => {
    let out = "";
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const m = part.match(/^\x1b\[([0-9;]*)m$/);
      if (!m) { const t = part.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); if (t) { const cls = [color, bold ? "a-bold" : ""].filter(Boolean).join(" "); out += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t); } continue; }
      for (const x of (m[1] || "0").split(";").map(Number)) { if (x === 0) { color = ""; bold = false; } else if (x === 1) bold = true; else if (x === 22) bold = false; else if (x === 39) color = ""; else if (COL[x]) color = COL[x]; }
    }
    return out;
  });
}
async function glpJob(jid) {
  const c = GLP.cur; c.job = +jid;
  document.querySelectorAll(".glp-job").forEach((b) => b.classList.toggle("on", b.dataset.glact === "glpjob:" + jid));
  const box = $("#glpLog"); if (!box) return;
  const j = c.jobs.find((x) => x.id === +jid);
  box.innerHTML = '<p class="muted"><span class="spin"></span> Loading log…</p>';
  try {
    const t = (await glApi(`/projects/${c.pid}/jobs/${jid}/trace`)).data?.trace || "";
    if (GLP.cur !== c || c.job !== +jid) return;
    const lines = glpAnsi(t), firstErr = lines.findIndex((l) => /\b(error|failed|exception|fatal)\b/i.test(l.replace(/<[^>]+>/g, "")));
    box.innerHTML = `<div class="glp-lh"><b>${GLP_ICON[j.status] || ""} ${esc(j.name)}</b> <span class="muted tiny">${esc(j.stage)} · ${esc(j.status)}${j.duration ? " · " + glpDur(j.duration) : ""}${j.runner?.description ? " · runner " + esc(j.runner.description) : ""}${t.length >= 400000 ? " · showing the last 400 KB" : ""}</span>
        <span class="grow"></span><input class="glp-q" placeholder="Search log…">${firstErr >= 0 ? '<button class="small" data-glact="glperr">⚠ First error</button>' : ""}
        ${["failed", "canceled", "success"].includes(j.status) && j.status !== "success" ? `<button class="small primary-s" data-glact="glpretry:${j.id}">↻ Retry job</button>` : ""}${glLink(j.web_url, "↗", "small gl-ext")}</div>
      <pre class="glp-log" id="glpPre">${lines.map((l, i) => `<span class="ll${i === firstErr ? " err" : ""}" data-n="${i + 1}">${l}</span>`).join("") || '<span class="muted">(empty log)</span>'}</pre>`;
    const pre = $("#glpPre"); pre.scrollTop = pre.scrollHeight;
    let tm; box.querySelector(".glp-q").addEventListener("input", (e) => { clearTimeout(tm); tm = setTimeout(() => { const v = e.target.value.toLowerCase(); let first = null;
      pre.querySelectorAll(".ll").forEach((l) => { const on = !!v && l.textContent.toLowerCase().includes(v); l.classList.toggle("hit", on); if (on && !first) first = l; }); first?.scrollIntoView({ block: "center" }); }, 200); });
  } catch (e) { box.innerHTML = `<div class="warnbox">⚠ ${esc(e.message)}</div>`; }
}

// ================= activity =================
const GLA = { src: "me", pid: "", days: 30, act: "", list: null, err: "", seq: 0 };
const GLA_ICON = { pushed: "⬆", "pushed to": "⬆", "pushed new": "⬆", opened: "＋", merged: "⤵", accepted: "⤵", closed: "⊘", "commented on": "💬", approved: "✔", created: "＋", deleted: "🗑", joined: "👋", reopened: "↺", updated: "✎" };
async function glaRenderTab() {
  const body = $("#glBody"); if (!body) return;
  const recent = glRanked().slice(0, 80).map((x) => x.p);
  if (!GLA.pid && recent[0]) GLA.pid = String(recent[0].id);
  body.innerHTML = `<div class="gl-toolbar card">
      <div class="gl-seg"><button class="${GLA.src === "me" ? "on" : ""}" data-glact="glasrc:me">My activity</button><button class="${GLA.src === "proj" ? "on" : ""}" data-glact="glasrc:proj">A project's activity</button></div>
      ${GLA.src === "proj" ? `<select id="glaP">${recent.map((p) => `<option value="${p.id}" ${String(p.id) === GLA.pid ? "selected" : ""}>${esc(p.path)}</option>`).join("")}</select>` : ""}
      <select id="glaD">${[7, 14, 30, 90].map((d) => `<option value="${d}" ${d === GLA.days ? "selected" : ""}>last ${d} days</option>`).join("")}</select>
      <select id="glaA"><option value="">All actions</option>${["pushed", "opened", "merged", "commented", "approved", "closed", "created", "deleted"].map((a) => `<option ${a === GLA.act ? "selected" : ""}>${a}</option>`).join("")}</select>
      <span class="grow"></span><button class="small" data-glact="glareload">⟳</button></div>
    <div id="glaOut"><div class="card"><p class="muted"><span class="spin"></span> Loading activity…</p></div></div>`;
  $("#glaP")?.addEventListener("change", (e) => { GLA.pid = e.target.value; glaLoad(); });
  $("#glaD").onchange = (e) => { GLA.days = +e.target.value; glaLoad(); };
  $("#glaA").onchange = (e) => { GLA.act = e.target.value; glaDraw(); };
  glaLoad();
}
async function glaLoad() {
  const seq = ++GLA.seq, after = ymdOf(addDays(new Date(), -GLA.days - 1));
  try {
    const list = await glAll(GLA.src === "me" ? `/events?after=${after}&sort=desc` : `/projects/${GLA.pid}/events?after=${after}&sort=desc`, GLA.days > 30 ? 6 : 3);
    if (seq !== GLA.seq) return; GLA.list = list; GLA.err = ""; GLA.more = list.truncated;
  } catch (e) { if (seq !== GLA.seq) return; GLA.list = []; GLA.err = e.message; }
  glaDraw();
}
function glaDraw() {
  const el = $("#glaOut"); if (!el || !GLA.list) return;
  const list = GLA.list.filter((e) => !GLA.act || String(e.action_name).startsWith(GLA.act === "commented" ? "commented" : GLA.act) || (GLA.act === "merged" && e.action_name === "accepted"));
  const byAct = {}; GLA.list.forEach((e) => { const a = String(e.action_name).split(" ")[0]; byAct[a] = (byAct[a] || 0) + 1; });
  const keys = GLD.keys(GLA.list.map((e) => `${e.target_title || ""} ${e.push_data?.commit_title || ""} ${e.push_data?.ref || ""}`).join(" "));
  let day = "";
  el.innerHTML = `${GLA.err ? `<div class="warnbox">⚠ ${esc(GLA.err)}</div>` : ""}
    <div class="gla-chips">${Object.entries(byAct).sort((a, b) => b[1] - a[1]).map(([a, n]) => `<span class="gl-chip">${GLA_ICON[a] || "•"} ${esc(a)} <b>${n}</b></span>`).join("")}${keys.length ? `<span class="tiny muted">Jira: ${keys.slice(0, 15).map((k) => GLD.jira(k)).join(" ")}</span>` : ""}</div>
    <div class="card glr-tl">${list.map((e) => {
      const d = ymdOf(new Date(e.created_at)), head = d !== day ? `<div class="glr-day">${esc(prettyDate(d))}</div>` : ""; day = d;
      const p = glmProj(e.project_id), a = String(e.action_name || ""), pd = e.push_data;
      const mr = e.target_type === "MergeRequest" ? e.target_iid : e.note?.noteable_type === "MergeRequest" ? e.note.noteable_iid : null;
      const what = pd ? `${pd.commit_count || 0} commit${pd.commit_count === 1 ? "" : "s"} to ⎇ <b>${esc(pd.ref || "")}</b>${pd.commit_title ? ` — ${GLD.jira(pd.commit_title)}` : ""}${pd.action === "removed" ? ' <span class="b bad">branch deleted</span>' : pd.action === "created" ? ' <span class="b new">new branch</span>' : ""}`
        : `${esc(e.target_type ? e.target_type.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "")} ${e.target_iid ? (e.target_type === "MergeRequest" ? "!" : "#") + e.target_iid : ""} ${GLD.jira(e.target_title || "")}${e.note?.body ? `<small class="muted">“${esc(e.note.body.slice(0, 160))}”</small>` : ""}`;
      return head + `<div class="glr-ev ${pd ? "c" : mr ? "m" : "o"}" ${mr && e.project_id ? `data-glact="glmopen:${e.project_id}|${mr}"` : pd?.commit_to && e.project_id ? `data-glcommit="${e.project_id}:${pd.commit_to}"` : ""}>
        <span class="glr-dot"></span><span class="muted tiny">${new Date(e.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        <span class="gla-a">${GLA_ICON[a] || GLA_ICON[a.split(" ")[0]] || "•"} ${esc(a)}</span> ${GLA.src === "proj" ? `<b>${esc(e.author?.name || "")}</b> ` : ""}${what} <span class="muted tiny">· ${esc(p?.name || "")}</span></div>`;
    }).join("") || '<p class="muted">No activity in this period.</p>'}</div>${GLA.more ? '<p class="muted tiny">Only the latest events are shown; choose fewer days for the full list.</p>' : ""}`;
}

// ================= Jira ↔ GitLab =================
const GLJ = { key: "", res: null, mine: null, seq: 0 };
function gljRenderTab() {
  const body = $("#glBody"); if (!body) return;
  const jiraOk = !!creds.get();
  body.innerHTML = `<div class="card glj-form"><h3>🔗 Jira ↔ GitLab</h3><p class="muted tiny">Type a Jira key to find its merge requests, branches and commits in GitLab and on this laptop.</p>
      <div class="row-actions"><input id="gljK" placeholder="e.g. FUL2-1234" value="${esc(GLJ.key)}" style="flex:1;font-size:16px;text-transform:uppercase"><button class="primary" data-glact="gljgo" style="width:auto;margin:0">Find</button></div>
      <div id="gljMine" class="glj-mine">${jiraOk ? "" : '<span class="muted tiny">Connect Jira (Settings) to see your open Jira issues here.</span>'}</div></div>
    <div id="gljOut"></div>`;
  $("#gljK").addEventListener("keydown", (e) => { if (e.key === "Enter") glAction("gljgo"); });
  if (jiraOk) gljMine();
  if (GLJ.res) gljDraw();
}
async function gljMine() {
  const el = $("#gljMine"); if (!el) return;
  if (!GLJ.mine) {
    try { GLJ.mine = (await jira(`/rest/api/3/search/jql?jql=${enc("assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC")}&fields=summary,status&maxResults=12`)).issues || []; }
    catch { GLJ.mine = []; }
  }
  if ($("#gljMine")) $("#gljMine").innerHTML = GLJ.mine.length ? `<span class="muted tiny">My open Jira issues:</span> ${GLJ.mine.map((i) => `<button class="small glj-i" data-glact="gljkey:${esc(i.key)}" title="${esc(i.fields?.summary || "")}"><b>${esc(i.key)}</b> ${esc((i.fields?.summary || "").slice(0, 40))}</button>`).join("")}` : "";
}
async function gljFind(key) {
  key = String(key || "").trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/.test(key)) { toast("Type a Jira key like FUL2-1234"); return; }
  GLJ.key = key; const seq = ++GLJ.seq;
  const res = GLJ.res = { key, issue: null, mrs: null, branches: null, commits: null, local: null, notes: [] };
  gljDraw();
  const recent = glRanked().slice(0, 30).map((x) => x.p);
  const step = (fn) => fn.then(() => { if (seq === GLJ.seq) gljDraw(); });
  await Promise.allSettled([
    step(creds.get() ? jira(`/rest/api/3/issue/${enc(key)}?fields=summary,status,assignee,issuetype`).then((i) => { res.issue = i?.fields ? i : false; }).catch(() => { res.issue = false; }) : Promise.resolve()),
    step(glAll(`/merge_requests?scope=all&state=all&search=${enc(key)}&order_by=updated_at`, 2).then((l) => { res.mrs = l.filter((m) => `${m.title} ${m.description} ${m.source_branch}`.toUpperCase().includes(key)); }).catch((e) => { res.mrs = []; res.notes.push("Merge requests: " + e.message); })),
    step(pool(recent, 5, (p) => glApi(`/projects/${p.id}/repository/branches?search=${enc(key)}&per_page=20`).then((r) => (r.data || []).filter((b) => b.name.toUpperCase().includes(key)).map((b) => ({ p, b }))).catch(() => [])).then((l) => { res.branches = l.flat(); })),
    step(glAll(`/search?scope=commits&search=${enc(key)}`, 1).then((l) => { res.commits = l; }).catch(() => { res.commits = null; res.notes.push("Commit search across GitLab needs Advanced Search, which this GitLab does not offer — commits are searched in your local repositories and in the merge requests instead."); })),
    step((window.GLL ? GLL.load().catch(() => []) : Promise.resolve([])).then((repos) => pool(repos || [], 3, (r) => gitApi(`/log?repo=${r.id}&grep=${enc(key)}&all=1&n=30`).then((x) => x.commits.map((c) => ({ r, c }))).catch(() => [])).then((l) => { res.local = l.flat(); }))),
  ]);
}
function gljDraw() {
  const el = $("#gljOut"), r = GLJ.res; if (!el || !r) return;
  const wait = '<p class="muted tiny"><span class="spin"></span> searching…</p>';
  const iss = r.issue;
  el.innerHTML = `<div class="card glj-head"><h3>${GLD.jira(r.key)} ${iss ? `— ${esc(iss.fields?.summary || "")}` : ""}</h3>
      ${iss ? `<p class="tiny"><span class="b skip">${esc(iss.fields?.issuetype?.name || "")}</span> <span class="b diff">${esc(iss.fields?.status?.name || "")}</span> ${iss.fields?.assignee ? `· assigned to ${esc(iss.fields.assignee.displayName)}` : "· unassigned"}</p>` : iss === false ? '<p class="muted tiny">Not found in Jira (or no access).</p>' : ""}
      <div class="row-actions"><button class="small primary-s" data-glact="gljbranch">⎇ Start a branch for ${esc(r.key)}</button><button class="small" data-glact="tab:release">🚀 Release analysis for this key</button></div>
      ${r.notes.map((n) => `<p class="muted tiny">ℹ ${esc(n)}</p>`).join("")}</div>
    <div class="glj-cols">
      <div class="card"><h4>⑂ Merge requests ${r.mrs ? `<span class="gl-tc">${r.mrs.length}</span>` : ""}</h4>${r.mrs == null ? wait : r.mrs.map((m) => `<div class="gl-mr" data-glact="glmopen:${m.project_id}|${m.iid}"><div class="gl-mr-a">${glmState(m)}</div><div class="gl-mr-m"><div class="gl-mr-t">${GLD.jira(glmStripDraft(m.title))}</div>
          <div class="muted tiny">${esc(glmProj(m.project_id)?.name || m.references?.full || "")} !${m.iid} · ${esc(m.author?.name || "")} · ${esc(m.source_branch)} → ${esc(m.target_branch)} · ${esc(ago(m.updated_at))}</div></div></div>`).join("") || '<p class="muted tiny">None.</p>'}</div>
      <div class="card"><h4>⎇ Branches <span class="muted tiny">in your 30 recent projects</span> ${r.branches ? `<span class="gl-tc">${r.branches.length}</span>` : ""}</h4>${r.branches == null ? wait : `<table class="gl-tbl">${r.branches.map(({ p, b }) => `<tr><td><b>${esc(b.name)}</b><small class="muted">${esc(p.name)} · ${esc(b.commit?.author_name || "")} · ${esc(ago(b.commit?.committed_date))}</small></td>
          <td class="nowrap">${b.merged ? '<span class="b skip">merged</span>' : `<button class="small" data-glact="gljnewmr:${p.id}|${esc(b.name)}">＋ MR</button>`}</td></tr>`).join("") || '<tr><td class="muted tiny">None.</td></tr>'}</table>`}</div>
      <div class="card"><h4>◉ Commits ${r.commits || r.local ? `<span class="gl-tc">${(r.commits?.length || 0) + (r.local?.length || 0)}</span>` : ""}</h4>
        ${r.commits ? `<table class="gl-tbl">${r.commits.map((c) => `<tr data-glcommit="${c.project_id}:${c.id}"><td><code class="sha">${esc(c.short_id)}</code></td><td>${GLD.jira(c.title)}<small class="muted">${esc(glmProj(c.project_id)?.name || "")} · ${esc(c.author_name)} · ${esc(ago(c.created_at))}</small></td></tr>`).join("") || '<tr><td class="muted tiny">None in GitLab.</td></tr>'}</table>` : ""}
        <h4 class="tiny muted">On this laptop</h4>${r.local == null ? wait : `<table class="gl-tbl">${r.local.map(({ r: repo, c }) => `<tr data-glact="gljlocal:${repo.id}|${c.sha}"><td><code class="sha">${esc(c.sha.slice(0, 8))}</code></td><td>${GLD.jira(c.title)}<small class="muted">${esc(repo.name)} · ${esc(c.author)} · ${esc(ago(c.at))}</small></td></tr>`).join("") || '<tr><td class="muted tiny">None in your local repositories.</td></tr>'}</table>`}</div>
    </div>`;
}
/** Website mode: create the branch on GitLab through the API. */
function gljBranchApi(name) {
  const recent = glRanked().slice(0, 60).map((x) => x.p);
  openModal(`<div class="gl-det" data-gldet="0"><h3>⎇ Start a branch for ${esc(GLJ.res.key)}</h3><p class="muted tiny">The branch is created on GitLab. Pull it in your editor afterwards.</p><div class="form">
      <label>Project <select id="gljP">${recent.map((p) => `<option value="${p.id}">${esc(p.path)}</option>`).join("")}</select></label>
      <label>Branch name <input id="gljN" value="${esc(name)}"></label>
      <label>Start from <input id="gljF" value="${esc(recent[0]?.branch || "master")}" placeholder="branch / tag / SHA"></label></div>
    <div class="foot"><button data-glact="closedet">Cancel</button><button class="primary" id="gljGo">Create branch</button></div></div>`);
  $("#gljP").onchange = (e) => { $("#gljF").value = glmProj(e.target.value)?.branch || "master"; };
  $("#gljGo").onclick = async () => {
    const pid = $("#gljP").value, branch = $("#gljN").value.trim(), ref = $("#gljF").value.trim(); if (!branch || !ref) return;
    $("#gljGo").disabled = true;
    try { await glApi(`/projects/${pid}/repository/branches?branch=${enc(branch)}&ref=${enc(ref)}`, { method: "POST" }); toast(`Created ${branch} on GitLab`); closeModal(); gljFind(GLJ.res.key); }
    catch (e) { toast(e.message); $("#gljGo").disabled = false; }
  };
}
function gljBranchDlg() {
  const r = GLJ.res, repos = window.GLL?.state.repos || [];
  if (glDirect()) {
    const slug0 = String(r.issue?.fields?.summary || "work").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    return gljBranchApi(`${/bug|defect/i.test(r.issue?.fields?.issuetype?.name || "") ? "bugfix" : "feature"}/${r.key}-${slug0}`);
  }
  if (!repos.length) { toast("Clone or add a repository first (Local repos)"); return; }
  const slug = String(r.issue?.fields?.summary || "work").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const type = /bug|defect/i.test(r.issue?.fields?.issuetype?.name || "") ? "bugfix" : "feature";
  const tpl = (() => { try { return JSON.parse(localStorage.getItem("jiratime.gl.tpl") || "{}").branch?.[0]; } catch { return ""; } })() || `${type}/{KEY}-{desc}`;
  const name = tpl.replace("{KEY}", r.key).replace("{desc}", slug).replace("{date}", todayStr().replace(/-/g, ""));
  const cur = window.GLL.state.cur;
  openModal(`<div class="gl-det" data-gldet="0"><h3>⎇ Start a branch for ${esc(r.key)}</h3><div class="form">
      <label>Repository <select id="gljR">${repos.map((x) => `<option value="${esc(x.id)}" ${x.id === cur ? "selected" : ""}>${esc(x.name)} — ${esc(x.path.replace(/^\/home\/[^/]+/, "~"))}</option>`).join("")}</select></label>
      <label>Branch name <input id="gljN" value="${esc(name)}"></label>
      <label>Start from <input id="gljF" value="" placeholder="origin/<default branch>"></label>
      <label class="check tiny"><input id="gljFe" type="checkbox" checked> Fetch from GitLab first</label></div>
    <div class="foot"><button data-glact="closedet">Cancel</button><button class="primary" id="gljGo">Create &amp; switch</button></div></div>`);
  const fillFrom = async () => { const id = $("#gljR").value; try { const s = await gitApi(`/status?repo=${id}`); $("#gljF").value = s.defaultBranch ? "origin/" + s.defaultBranch : s.branch; } catch { /* keep */ } };
  $("#gljR").onchange = fillFrom; fillFrom();
  $("#gljGo").onclick = async () => {
    const id = $("#gljR").value, branch = $("#gljN").value.trim(), from = $("#gljF").value.trim(); if (!branch) return;
    $("#gljGo").disabled = true;
    try {
      if ($("#gljFe").checked) await gitApi("/fetch", { repo: id });
      await gitApi("/checkout", { repo: id, branch, create: true, from: from || undefined });
      toast(`Created ${branch}`); window.GLL.open(id);
    } catch (e) { toast(e.message); $("#gljGo").disabled = false; }
  };
}

// ================= Ctrl+K command palette =================
const GLK = { items: [], sel: 0, q: "" };
function glkItems(q) {
  const out = [], add = (group, icon, label, sub, run) => out.push({ group, icon, label, sub, run });
  const key = (q.trim().match(/^[A-Z][A-Z0-9_]{1,9}-\d{1,7}$/) || [])[0];
  if (key && GL.st?.connected) add("Jira", "🔗", `Find ${key} in GitLab`, "merge requests, branches, commits", () => { GL.tab = "jira"; glGo("jira"); gljFind(key); });
  document.querySelectorAll(".nav[data-view]").forEach((b) => add("JiraTime", "›", b.textContent.trim(), "open page", () => b.click()));
  if (GL.st?.connected) {
    GL_TABS.forEach((t) => add("GitLab", t.icon, `GitLab · ${t.label}`, "tab", () => glGo(t.id)));
    add("Actions", "＋", "New merge request", "", () => { glGo("mrs"); setTimeout(() => glAction("newmr:"), 50); });
    add("Actions", "🚀", "What changed after a release date", "release analysis", () => glGo("release"));
    add("Actions", "⇄", "Compare two releases", "tags / branches / dates", () => glGo("compare"));
    add("Actions", "⟳", "Refresh GitLab data", "", () => { glGo(GL.tab || "overview"); glAction("refresh"); });
    (window.GLL?.state.repos || []).forEach((r) => add("Local repositories", "📦", r.name, r.path.replace(/^\/home\/[^/]+/, "~"), () => window.GLL.open(r.id)));
    (GLMS.list || []).forEach((m) => add("Merge requests", "⑂", `!${m.iid} ${glmStripDraft(m.title)}`, glmProj(m.project_id)?.name || "", () => glmOpen(m.project_id, m.iid)));
    glRanked().forEach(({ p }) => add("Projects", "▤", p.name, p.path, () => { glGo("projects"); setTimeout(() => glOpenProject(p.id), 60); }));
  }
  add("Actions", "🌗", "Switch dark / light theme", "", () => $("#themeBtn")?.click());
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!toks.length) return out.filter((x) => x.group !== "Projects").slice(0, 40).concat(out.filter((x) => x.group === "Projects").slice(0, 8));
  const score = (x) => {
    const hay = `${x.label} ${x.sub}`.toLowerCase(); let s = 0;
    for (const t of toks) { const i = hay.indexOf(t); if (i < 0) return -1; s += i === 0 ? 30 : /[\s/\-·]/.test(hay[i - 1]) ? 20 : 8; }
    return s + (x.group === "Jira" ? 100 : x.group === "GitLab" || x.group === "Actions" ? 6 : 0) - x.label.length / 50;
  };
  return out.map((x) => ({ x, s: score(x) })).filter((y) => y.s >= 0).sort((a, b) => b.s - a.s).slice(0, 60).map((y) => y.x);
}
function glkOpen() {
  let el = $("#glPal");
  if (!el) {
    el = document.createElement("div"); el.id = "glPal"; el.className = "gl-pal hidden";
    el.innerHTML = `<div class="gl-pal-box" role="dialog" aria-label="Command palette"><div class="gl-pal-in"><span>⌕</span><input id="glPalQ" placeholder="Search pages, projects, repositories, actions… or type a Jira key" autocomplete="off"><kbd>Esc</kbd></div><div id="glPalL" class="gl-pal-l" role="listbox"></div>
      <div class="gl-pal-f muted tiny"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Ctrl</kbd><kbd>K</kbd> toggle</span></div></div>`;
    document.body.appendChild(el);
    el.addEventListener("mousedown", (e) => { if (e.target === el) glkClose(); });
    const q = $("#glPalQ");
    q.addEventListener("input", () => { GLK.q = q.value; GLK.sel = 0; glkDraw(); });
    q.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); GLK.sel = (GLK.sel + (e.key === "ArrowDown" ? 1 : -1) + GLK.items.length) % Math.max(1, GLK.items.length); glkDraw(true); }
      else if (e.key === "Enter") { e.preventDefault(); glkRun(GLK.sel); }
      else if (e.key === "Escape") { e.preventDefault(); glkClose(); }
    });
    $("#glPalL").addEventListener("click", (e) => { const it = e.target.closest("[data-k]"); if (it) glkRun(+it.dataset.k); });
    $("#glPalL").addEventListener("mousemove", (e) => { const it = e.target.closest("[data-k]"); if (it && +it.dataset.k !== GLK.sel) { GLK.sel = +it.dataset.k; glkDraw(true); } });
  }
  el.classList.remove("hidden"); GLK.q = ""; GLK.sel = 0; $("#glPalQ").value = ""; glkDraw(); $("#glPalQ").focus();
  if (GL.st?.connected && !GL.projects) glLoadProjects().then(() => { if (!el.classList.contains("hidden")) glkDraw(); }).catch(() => {});
}
function glkClose() { $("#glPal")?.classList.add("hidden"); }
function glkDraw(keepScroll) {
  GLK.items = glkItems(GLK.q); let g = "";
  $("#glPalL").innerHTML = GLK.items.map((x, i) => { const h = x.group !== g ? `<div class="gl-pal-g">${esc(x.group)}</div>` : ""; g = x.group;
    return `${h}<div class="gl-pal-i ${i === GLK.sel ? "on" : ""}" data-k="${i}" role="option"><span class="gl-pal-ic">${esc(x.icon)}</span><span class="gl-pal-t">${esc(x.label)}</span><span class="muted tiny">${esc(x.sub)}</span></div>`; }).join("") || '<p class="muted tiny" style="padding:12px">Nothing found.</p>';
  if (keepScroll) $("#glPalL .gl-pal-i.on")?.scrollIntoView({ block: "nearest" });
}
function glkRun(i) { const it = GLK.items[i]; if (!it) return; glkClose(); if (modalOpen()) closeModal(); it.run(); }
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") { e.preventDefault(); if ($("#glPal") && !$("#glPal").classList.contains("hidden")) glkClose(); else glkOpen(); }
});

// ================= actions & tabs =================
Object.assign(GL_ACTIONS, {
  palette: () => glkOpen(),
  glpsub: (s) => { GLP.sub = s; glpRenderTab(); },
  glpreload: () => glpLoad(),
  glppage: (d) => { GLP.page = Math.max(1, GLP.page + +d); glpLoad(); },
  glpopen: (arg) => { const [pid, id] = arg.split("|"); glpOpen(pid, id); },
  glpjob: (id) => glpJob(id),
  glperr: () => document.querySelector("#glpPre .ll.err")?.scrollIntoView({ block: "center" }),
  glpretry: async (jid) => {
    const c = GLP.cur, j = c.jobs.find((x) => x.id === +jid);
    if (!confirm(`Run the job "${j?.name}" again?\n\nIt runs with the same commit and settings. Deploy jobs really deploy again.`)) return;
    try { const n = (await glApi(`/projects/${c.pid}/jobs/${jid}/retry`, { method: "POST" })).data; toast("Job restarted"); c.job = n?.id || null; glpOpen(c.pid, c.id); } catch (e) { toast(e.message); }
  },
  glpretrypipe: async () => {
    const c = GLP.cur; if (!confirm(`Retry all failed jobs of pipeline #${c.id}?`)) return;
    try { await glApi(`/projects/${c.pid}/pipelines/${c.id}/retry`, { method: "POST" }); toast("Failed jobs restarted"); c.job = null; glpOpen(c.pid, c.id); } catch (e) { toast(e.message); }
  },
  glasrc: (s) => { GLA.src = s; GLA.list = null; glaRenderTab(); },
  glareload: () => glaLoad(),
  gljgo: () => gljFind($("#gljK")?.value),
  gljkey: (k) => { if ($("#gljK")) $("#gljK").value = k; gljFind(k); },
  gljbranch: () => gljBranchDlg(),
  gljnewmr: (arg) => { const [pid, ...b] = arg.split("|"); glmCreate(glmProj(pid), { source: b.join("|") }); },
  gljlocal: (arg) => { const [id, sha] = arg.split("|"); window.GLL.open(id); Object.assign(window.GLL.state, { sub: "history", commit: sha, logF: { ...window.GLL.state.logF, all: true } }); },
});
glAddTab({ id: "pipes", icon: "▶", label: "Pipelines", render: () => glpRenderTab(), refresh: () => {} }, "compare");
glAddTab({ id: "activity", icon: "≋", label: "Activity", render: () => glaRenderTab(), refresh: () => {} }, "pipes");
glAddTab({ id: "jira", icon: "🔗", label: "Jira links", render: () => gljRenderTab(), refresh: () => {} }, "activity");
window.GLP = { open: glpOpen };
