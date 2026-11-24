"use strict";
/* Release intelligence (what changed after a date across many projects) and release comparison (ref vs ref / date vs date).
   "Committed", "merged" and "deployed" are kept apart: a commit on a branch is not a merge, and a merge is not a deployment.
   Deployments come only from GitLab environments / deployments; projects without them show "no deployment data". */

const GLR = {
  f: (() => {
    const d = { mode: "recent", picked: [], from: "", to: "", branch: "default", bname: "", author: "", key: "", merges: false };
    try { return { ...d, ...JSON.parse(localStorage.getItem("jiratime.gl.relf") || "{}") }; } catch { return d; }
  })(),
  res: null, ctl: null, view: "service", open: {}, pickQ: "",
  cmp: { pid: "", mode: "refs", from: "", to: "", fromDate: "", toDate: "", branch: "", res: null },
};
const glrSave = () => { const { mode, picked, branch, bname, author, merges } = GLR.f; localStorage.setItem("jiratime.gl.relf", JSON.stringify({ mode, picked, branch, bname, author, merges })); };
const glrLocal = (d) => { const x = new Date(d.getTime() - d.getTimezoneOffset() * 6e4); return x.toISOString().slice(0, 16); };
const glrCsvCell = (v) => { const s = String(v ?? ""); return /^[=+\-@\t\r]/.test(s) ? "'" + s : s; };   // no spreadsheet formulas from commit text
const glrCsv = (name, rows) => download(name, csv(rows.map((r) => r.map(glrCsvCell))));
const glrMrRefs = (text) => [...String(text || "").matchAll(/See merge request ([\w.\-/]+)?!(\d+)/g)].map((m) => ({ path: m[1] || "", iid: +m[2] }));

// ================= release analysis =================
function glrProjects() {
  const ranked = glRanked().map((x) => x.p);
  if (GLR.f.mode === "all") return ranked;
  if (GLR.f.mode === "picked") return ranked.filter((p) => GLR.f.picked.includes(p.id));
  return ranked.slice(0, 15);
}
function glrRenderTab() {
  const body = $("#glBody"); if (!body) return;
  const f = GLR.f;
  if (!f.from) f.from = glrLocal(new Date(new Date(addDays(new Date(), -7)).setHours(0, 0, 0, 0)));
  const n = glrProjects().length, running = !!GLR.ctl;
  body.innerHTML = `<div class="card glr-form">
      <div class="glr-hd"><div><h3>🚀 What changed after a release?</h3><p class="muted tiny">Pick the projects and the time window. JiraTime reads commits, merged merge requests and deployments from GitLab and keeps them apart.</p></div>
        <span class="grow"></span><div class="gl-seg"><button class="on" data-glact="tab:release">Changes after a date</button><button data-glact="tab:compare">Compare two releases</button></div></div>
      <div class="glr-grid">
        <label>Projects <select id="glrMode"><option value="recent" ${f.mode === "recent" ? "selected" : ""}>Recently worked (15)</option><option value="all" ${f.mode === "all" ? "selected" : ""}>All my projects (${(GL.projects || []).length})</option><option value="picked" ${f.mode === "picked" ? "selected" : ""}>Chosen projects (${f.picked.length})</option></select></label>
        <label>From <input id="glrFrom" type="datetime-local" value="${esc(f.from)}"></label>
        <label title="Leave empty for now">Until (empty = now)<input id="glrTo" type="datetime-local" value="${esc(f.to)}"></label>
        <label>Branch <select id="glrBr"><option value="default" ${f.branch === "default" ? "selected" : ""}>Default branch of each project</option><option value="all" ${f.branch === "all" ? "selected" : ""}>All branches</option><option value="name" ${f.branch === "name" ? "selected" : ""}>A branch by name…</option></select></label>
        <label class="${f.branch === "name" ? "" : "hidden"}" id="glrBnL">Branch name <input id="glrBn" value="${esc(f.bname)}" placeholder="e.g. release/2026.11"></label>
        <label>Author <input id="glrAu" value="${esc(f.author)}" placeholder="name or e-mail (optional)"></label>
        <label>Jira key <input id="glrKey" value="${esc(f.key)}" placeholder="e.g. FUL2-123 (optional)"></label>
      </div>
      <div class="row-actions" style="margin:10px 0 0">
        ${f.mode === "picked" ? '<button class="small" data-glact="glrpick">☑ Choose projects…</button>' : ""}
        <label class="check tiny"><input id="glrMg" type="checkbox" ${f.merges ? "checked" : ""}> count merge commits</label>
        <span class="grow"></span><span class="muted tiny">${n} project${n === 1 ? "" : "s"} · projects without activity since “From” are skipped</span>
        ${running ? '<button class="small danger" data-glact="glrstop">■ Stop</button>' : `<button class="primary" data-glact="glrrun" style="width:auto;margin:0" ${n ? "" : "disabled"}>Analyse</button>`}</div>
      <div id="glrProg"></div></div>
    <div id="glrOut"></div>`;
  const set = (k, v) => { f[k] = v; glrSave(); };
  $("#glrMode").onchange = (e) => { set("mode", e.target.value); glrRenderTab(); if (f.mode === "picked" && !f.picked.length) glrPick(); };
  $("#glrFrom").onchange = (e) => set("from", e.target.value);
  $("#glrTo").onchange = (e) => set("to", e.target.value);
  $("#glrBr").onchange = (e) => { set("branch", e.target.value); $("#glrBnL").classList.toggle("hidden", e.target.value !== "name"); };
  $("#glrBn").oninput = (e) => set("bname", e.target.value.trim());
  $("#glrAu").oninput = (e) => set("author", e.target.value.trim());
  $("#glrKey").oninput = (e) => { f.key = e.target.value.trim().toUpperCase(); };
  $("#glrMg").onchange = (e) => set("merges", e.target.checked);
  glrProgress(); glrOut();
}
function glrPick() {
  const all = glRanked().map((x) => x.p), sel = new Set(GLR.f.picked);
  const draw = () => {
    const q = GLR.pickQ.toLowerCase(), list = all.filter((p) => !q || p.path.toLowerCase().includes(q));
    $("#glrPl").innerHTML = list.slice(0, 300).map((p) => `<label class="check glr-pi"><input type="checkbox" value="${p.id}" ${sel.has(p.id) ? "checked" : ""}> <b>${esc(p.name)}</b> <span class="muted tiny">${esc(p.ns)} · ${esc(ago(p.last))}</span></label>`).join("");
    $("#glrPc").textContent = `${sel.size} chosen`;
  };
  openModal(`<div class="gl-det" data-gldet="0"><h3>☑ Choose projects</h3>
    <div class="row-actions"><input id="glrPq" placeholder="Filter…" value="${esc(GLR.pickQ)}" style="flex:1"><button class="small" id="glrPa">Select shown</button><button class="small" id="glrPn">Clear</button><span id="glrPc" class="muted tiny"></span></div>
    <div id="glrPl" class="glr-pl"></div>
    <div class="foot"><button data-glact="closedet">Cancel</button><button class="primary" id="glrPs">Use these projects</button></div></div>`);
  $("#glrPq").oninput = (e) => { GLR.pickQ = e.target.value; draw(); };
  $("#glrPl").onchange = (e) => { const id = +e.target.value; if (e.target.checked) sel.add(id); else sel.delete(id); $("#glrPc").textContent = `${sel.size} chosen`; };
  $("#glrPa").onclick = () => { $("#glrPl").querySelectorAll("input").forEach((i) => sel.add(+i.value)); draw(); };
  $("#glrPn").onclick = () => { sel.clear(); draw(); };
  $("#glrPs").onclick = () => { GLR.f.picked = [...sel]; GLR.f.mode = "picked"; glrSave(); closeModal(); glrRenderTab(); };
  draw();
}
const glrRef = (p) => (GLR.f.branch === "default" ? p.branch : GLR.f.branch === "name" ? GLR.f.bname : "");
async function glrRun() {
  const f = GLR.f;
  if (!f.from) return toast("Choose the From date");
  if (f.branch === "name" && !f.bname) return toast("Type the branch name");
  const since = new Date(f.from), until = f.to ? new Date(f.to) : new Date();
  if (!(since < until)) return toast("“From” must be before “Until”");
  const ctl = new AbortController(); GLR.ctl = ctl;
  const list = glrProjects(), key = f.key, au = f.author.toLowerCase();
  const res = GLR.res = { since: since.toISOString(), until: until.toISOString(), key, author: f.author, branch: f.branch, bname: f.bname, rows: [], done: 0, total: list.length, skipped: 0, cancelled: false, at: Date.now() };
  GLR.open = {}; glrRenderTab();
  const S = enc(res.since), U = enc(res.until), signal = ctl.signal;
  const hit = (text) => !key || String(text || "").toUpperCase().includes(key);
  await pool(list, 4, async (p) => {
    if (signal.aborted) return;
    const ref = glrRef(p);
    if (Date.parse(p.last || 0) < since.getTime() || p.empty || (f.branch === "default" && !p.branch)) { res.skipped++; res.done++; glrProgress(); return; }
    const row = { p, ref, commits: [], mrs: [], deps: [], depsOk: true, err: "" };
    try {
      const [commits, mrs, deps] = await Promise.all([
        glAll(`/projects/${p.id}/repository/commits?since=${S}&until=${U}&with_stats=true${ref ? `&ref_name=${enc(ref)}` : "&all=true"}`, 5, signal).catch((e) => { if (e.status === 404) return []; throw e; }),
        glAll(`/projects/${p.id}/merge_requests?state=merged&updated_after=${S}&order_by=updated_at&sort=desc`, 3, signal).catch(() => []),
        glAll(`/projects/${p.id}/deployments?updated_after=${S}&updated_before=${U}&order_by=updated_at&sort=desc`, 2, signal).catch(() => null),
      ]);
      row.commits = commits.filter((c) => (f.merges || (c.parent_ids || []).length < 2) && hit(`${c.title} ${c.message}`) && (!au || `${c.author_name} ${c.author_email}`.toLowerCase().includes(au)))
        .map((c) => ({ sha: c.id, short: c.short_id, title: c.title, msg: c.message, author: c.author_name, email: c.author_email, at: c.committed_date || c.created_at, add: c.stats?.additions || 0, del: c.stats?.deletions || 0, merge: (c.parent_ids || []).length > 1, web: c.web_url }));
      row.mrs = mrs.filter((m) => m.merged_at && m.merged_at >= res.since && m.merged_at <= res.until && (!ref || m.target_branch === ref) && hit(`${m.title} ${m.description} ${m.source_branch}`) && (!au || `${m.author?.name} ${m.author?.username}`.toLowerCase().includes(au)));
      if (deps === null) row.depsOk = false;
      row.deps = (deps || []).filter((d) => (!ref || d.ref === ref) && d.updated_at <= res.until).map((d) => ({ id: d.id, env: d.environment?.name || "?", status: d.status, ref: d.ref, sha: d.sha, at: d.updated_at || d.created_at, by: d.user?.name || "", web: d.deployable?.web_url || "" }));
      for (const m of row.mrs) {
        const sha = m.merge_commit_sha || m.squash_commit_sha || m.sha;
        const exact = row.deps.filter((d) => d.status === "success" && (d.sha === sha || d.sha === m.merge_commit_sha));
        const later = row.deps.filter((d) => d.status === "success" && d.ref === m.target_branch && d.at >= m.merged_at);
        m._dep = exact.length ? { kind: "exact", envs: [...new Set(exact.map((d) => d.env))] } : later.length ? { kind: "later", envs: [...new Set(later.map((d) => d.env))] } : null;
      }
    } catch (e) { if (e.name === "AbortError") return; row.err = e.message; }
    if (row.commits.length || row.mrs.length || row.deps.length || row.err) res.rows.push(row);
    res.done++; glrProgress();
  }).catch(() => {});
  res.cancelled = signal.aborted; GLR.ctl = null;
  res.rows.sort((a, b) => b.commits.length + b.mrs.length - (a.commits.length + a.mrs.length));
  if (GL.tab === "release") glrRenderTab();
}
function glrProgress() {
  const el = $("#glrProg"), r = GLR.res; if (!el) return;
  if (!r || (!GLR.ctl && r.done >= r.total)) { el.innerHTML = ""; return; }
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;
  el.innerHTML = `<div class="gll-bar"><div style="width:${pct}%"></div></div><div class="muted tiny">${r.done} of ${r.total} projects · ${r.rows.length} with changes · ${r.skipped} skipped (no activity in the window)</div>`;
  if (GLR.ctl && r.done % 4 === 0) glrOut();
}
function glrTotals(rows) {
  const c = rows.reduce((a, r) => a + r.commits.length, 0), m = rows.reduce((a, r) => a + r.mrs.length, 0);
  const d = rows.reduce((a, r) => a + r.deps.filter((x) => x.status === "success").length, 0);
  const devs = new Set(rows.flatMap((r) => r.commits.map((x) => x.author)));
  const add = rows.reduce((a, r) => a + r.commits.reduce((s, x) => s + x.add, 0), 0), del = rows.reduce((a, r) => a + r.commits.reduce((s, x) => s + x.del, 0), 0);
  return { c, m, d, devs: devs.size, add, del, keys: GLD.keys(rows.flatMap((r) => [...r.commits.map((x) => x.title), ...r.mrs.map((x) => x.title + " " + x.source_branch)]).join(" ")) };
}
function glrOut() {
  const el = $("#glrOut"), r = GLR.res; if (!el) return;
  if (!r) { el.innerHTML = `<div class="card gll-hero"><h3>How it works</h3><ul class="tiny glr-how"><li><b>Committed</b> — commits that reached the branch in the window (merge commits hidden unless ticked).</li>
    <li><b>Merged</b> — merge requests merged into the branch in the window.</li><li><b>Deployed</b> — successful GitLab deployments (environments). “exact” = the merge commit itself was deployed; “later” = a later deployment of the same branch, which normally contains it.</li>
    <li>Click a project to see commits, merge requests, deployments and the files changed since the release (baseline = last commit before “From”).</li></ul></div>`; return; }
  const t = glrTotals(r.rows), period = `${fmtDateTime(r.since)} → ${fmtDateTime(r.until)}`;
  const tabs = [["service", "By project"], ["dev", "By developer"], ["timeline", "Timeline"], ["rca", "RCA draft"]];
  el.innerHTML = `<div class="stats gl-stats glr-stats">
      <div class="stat"><b>${r.rows.filter((x) => x.commits.length || x.mrs.length).length}</b><span>projects changed</span><small>${esc(period)}</small></div>
      <div class="stat"><b>${t.c}</b><span>commits</span><small><span class="st-success">+${t.add}</span> <span class="st-failed">−${t.del}</span> lines</small></div>
      <div class="stat"><b>${t.m}</b><span>merge requests merged</span></div>
      <div class="stat"><b>${t.d}</b><span>successful deployments</span><small>${r.rows.some((x) => !x.depsOk) ? "some projects give no deployment data" : ""}</small></div></div>
    ${r.cancelled ? '<div class="warnbox">Stopped — the results are incomplete.</div>' : ""}${r.rows.some((x) => x.err) ? `<div class="warnbox">${r.rows.filter((x) => x.err).length} project(s) could not be read; they are marked below.</div>` : ""}
    <div class="gl-sub">${tabs.map(([k, l]) => `<button class="gl-tab ${GLR.view === k ? "on" : ""}" data-glact="glrview:${k}">${l}</button>`).join("")}<span class="grow"></span>
      ${t.keys.length ? `<span class="tiny muted">Jira: ${t.keys.slice(0, 12).map((k) => GLD.jira(k)).join(" ")}${t.keys.length > 12 ? " …" : ""}</span>` : ""}
      <button class="small" data-glact="glrcsv">⬇ CSV</button></div>
    <div id="glrView"></div>`;
  glrView();
}
function glrView() {
  const el = $("#glrView"), r = GLR.res; if (!el || !r) return;
  if (!r.rows.length) { el.innerHTML = `<div class="card"><p class="muted">${GLR.ctl ? "Reading…" : "No changes found in this window."}</p></div>`; return; }
  if (GLR.view === "service") {
    el.innerHTML = `<div class="card glr-svc">${r.rows.map((x) => {
      const devs = [...new Set(x.commits.map((c) => c.author))], ok = x.deps.filter((d) => d.status === "success"), envs = [...new Set(ok.map((d) => d.env))], on = GLR.open[x.p.id];
      return `<div class="glr-row ${on ? "on" : ""}"><div class="glr-rh" data-glact="glropen:${x.p.id}"><span class="glr-car">${on ? "▾" : "▸"}</span>
        <div class="glr-pn"><b>${esc(x.p.name)}</b><small class="muted">${esc(x.p.ns)} · ⎇ ${esc(x.ref || "all branches")}</small></div>
        ${x.err ? `<span class="st-failed tiny">⚠ ${esc(x.err)}</span>` : `<span class="glr-k"><b>${x.commits.length}</b> committed</span><span class="glr-k"><b>${x.mrs.length}</b> merged</span>
        <span class="glr-k">${!x.depsOk ? '<span class="muted">no deployment data</span>' : ok.length ? `<b>${ok.length}</b> deployed <span class="muted tiny">${esc(envs.slice(0, 3).join(", "))}</span>` : '<span class="muted">not deployed</span>'}</span>
        <span class="glr-k muted tiny">${esc(devs.slice(0, 3).join(", "))}${devs.length > 3 ? ` +${devs.length - 3}` : ""}</span>`}</div>
        ${on ? `<div class="glr-rb" id="glrRb${x.p.id}">${glrDetail(x)}</div>` : ""}</div>`;
    }).join("")}</div>`;
  } else if (GLR.view === "dev") {
    const by = new Map();
    for (const x of r.rows) {
      for (const c of x.commits) { const d = by.get(c.author) || { n: c.author, c: 0, add: 0, del: 0, p: new Set(), m: 0, last: "" }; d.c++; d.add += c.add; d.del += c.del; d.p.add(x.p.name); if (c.at > d.last) d.last = c.at; by.set(c.author, d); }
      for (const m of x.mrs) { const n = m.author?.name || "?"; const d = by.get(n) || { n, c: 0, add: 0, del: 0, p: new Set(), m: 0, last: "" }; d.m++; d.p.add(x.p.name); by.set(n, d); }
    }
    el.innerHTML = `<div class="card"><table class="gl-tbl"><tr><th>Developer</th><th>Commits</th><th>MRs merged</th><th>Lines</th><th>Projects</th><th>Last commit</th></tr>${[...by.values()].sort((a, b) => b.c - a.c).map((d) => `<tr><td><b>${esc(d.n)}</b></td><td>${d.c}</td><td>${d.m}</td>
      <td class="tiny"><span class="st-success">+${d.add}</span> <span class="st-failed">−${d.del}</span></td><td class="tiny">${esc([...d.p].slice(0, 4).join(", "))}${d.p.size > 4 ? ` +${d.p.size - 4}` : ""}</td><td class="muted tiny nowrap">${esc(d.last ? ago(d.last) : "—")}</td></tr>`).join("")}</table></div>`;
  } else if (GLR.view === "timeline") {
    const ev = r.rows.flatMap((x) => [...x.commits.map((c) => ({ at: c.at, k: "c", x, c })), ...x.mrs.map((m) => ({ at: m.merged_at, k: "m", x, m })), ...x.deps.map((d) => ({ at: d.at, k: "d", x, d }))]).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 800);
    let day = "";
    el.innerHTML = `<div class="card glr-tl">${ev.map((e) => {
      const d = ymdOf(new Date(e.at)), head = d !== day ? `<div class="glr-day">${esc(prettyDate(d))}</div>` : ""; day = d;
      const t = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return head + (e.k === "c" ? `<div class="glr-ev c" data-glcommit="${e.x.p.id}:${e.c.sha}"><span class="glr-dot"></span><span class="muted tiny">${t}</span><b>${esc(e.x.p.name)}</b> ${GLD.jira(e.c.title)} <span class="muted tiny">— ${esc(e.c.author)} · <code class="sha">${esc(e.c.short)}</code></span></div>`
        : e.k === "m" ? `<div class="glr-ev m" data-glact="glmopen:${e.x.p.id}|${e.m.iid}"><span class="glr-dot"></span><span class="muted tiny">${t}</span><b>${esc(e.x.p.name)}</b> <span class="b new">merged</span> !${e.m.iid} ${GLD.jira(e.m.title)} <span class="muted tiny">— ${esc(e.m.author?.name || "")}</span></div>`
        : `<div class="glr-ev d"><span class="glr-dot"></span><span class="muted tiny">${t}</span><b>${esc(e.x.p.name)}</b> <span class="eff ${e.d.status === "success" ? "good" : e.d.status === "failed" ? "low" : "noest"}">deploy ${esc(e.d.status)}</span> → ${esc(e.d.env)} <span class="muted tiny">⎇ ${esc(e.d.ref)} <code class="sha">${esc(String(e.d.sha).slice(0, 8))}</code> ${esc(e.d.by)}</span></div>`);
    }).join("")}</div>`;
  } else {
    el.innerHTML = `<div class="card"><div class="row-actions"><b>Incident / RCA starting point</b><span class="muted tiny">rule-based from the data above · nothing is sent to an AI service · check before you share</span><span class="grow"></span><button class="small" data-glact="glrrcacopy">⧉ Copy</button></div>
      <textarea id="glrRca" rows="22" style="width:100%;font-family:ui-monospace,monospace;font-size:12px">${esc(glrRca())}</textarea></div>`;
  }
}
function glrDetail(x) {
  const cTab = `<table class="gl-tbl">${x.commits.slice(0, 200).map((c) => `<tr data-glcommit="${x.p.id}:${c.sha}" class="glr-cr"><td class="nowrap"><code class="sha">${esc(c.short)}</code>${c.merge ? ' <span class="b skip">merge</span>' : ""}</td>
      <td>${GLD.jira(c.title)}<small class="muted">${esc(c.author)} · ${esc(fmtDateTime(c.at))}</small></td><td class="tiny nowrap"><span class="st-success">+${c.add}</span> <span class="st-failed">−${c.del}</span></td></tr>`).join("") || '<tr><td class="muted">No commits in the window.</td></tr>'}</table>${x.commits.length > 200 ? `<p class="muted tiny">First 200 of ${x.commits.length}.</p>` : ""}`;
  const mTab = `<table class="gl-tbl">${x.mrs.map((m) => `<tr data-glact="glmopen:${x.p.id}|${m.iid}"><td class="nowrap">!${m.iid}</td><td>${GLD.jira(m.title)}<small class="muted">${esc(m.author?.name || "")} · ${esc(m.source_branch)} → ${esc(m.target_branch)} · merged ${esc(fmtDateTime(m.merged_at))}</small></td>
      <td class="tiny">${m._dep ? `<span class="eff good">deployed</span> <span class="muted">${esc(m._dep.envs.join(", "))} · ${m._dep.kind === "exact" ? "exact commit" : "later deployment"}</span>` : x.depsOk ? '<span class="eff noest">not deployed</span>' : '<span class="muted">no deployment data</span>'}</td></tr>`).join("") || '<tr><td class="muted">No merge requests merged in the window.</td></tr>'}</table>`;
  const dTab = x.depsOk ? `<table class="gl-tbl">${x.deps.map((d) => `<tr><td><span class="eff ${d.status === "success" ? "good" : d.status === "failed" ? "low" : "noest"}">${esc(d.status)}</span></td><td><b>${esc(d.env)}</b><small class="muted">⎇ ${esc(d.ref)} · <code class="sha">${esc(String(d.sha).slice(0, 8))}</code> · ${esc(d.by)}</small></td><td class="muted tiny nowrap">${esc(fmtDateTime(d.at))}</td><td>${glLink(d.web, "↗")}</td></tr>`).join("") || '<tr><td class="muted">No deployments in the window.</td></tr>'}</table>` : '<p class="muted tiny">This project gives no deployment data (no environments, or not allowed).</p>';
  return `<div class="glr-cols"><div><h4>Committed <span class="muted tiny">${x.commits.length}</span></h4>${cTab}</div><div><h4>Merged <span class="muted tiny">${x.mrs.length}</span></h4>${mTab}<h4>Deployments</h4>${dTab}</div></div>
    <div class="row-actions" style="margin-top:10px">${x.ref ? `<button class="small" data-glact="glrfiles:${x.p.id}">📄 Files changed since the release</button>` : '<span class="muted tiny">Choose a branch (not “all branches”) to see the changed files since the release.</span>'}
      <button class="small" data-glact="glrcmp:${x.p.id}">⇄ Open in Compare</button>${glLink(x.p.web, "Project in GitLab ↗", "small gl-ext")}</div><div id="glrFiles${x.p.id}"></div>`;
}
async function glrFiles(pid) {
  const x = GLR.res.rows.find((r) => r.p.id === +pid), box = $("#glrFiles" + pid); if (!x || !box) return;
  box.innerHTML = '<p class="muted"><span class="spin"></span> Finding the baseline and comparing…</p>';
  try {
    const base = (await glApi(`/projects/${pid}/repository/commits?ref_name=${enc(x.ref)}&until=${enc(GLR.res.since)}&per_page=1`)).data?.[0];
    const head = (await glApi(`/projects/${pid}/repository/commits?ref_name=${enc(x.ref)}&until=${enc(GLR.res.until)}&per_page=1`)).data?.[0];
    if (!head) { box.innerHTML = '<p class="muted">No commits on this branch.</p>'; return; }
    if (!base) { box.innerHTML = '<p class="muted">The branch has no commit before “From”, so there is no baseline.</p>'; return; }
    if (base.id === head.id) { box.innerHTML = '<p class="muted">The branch did not move in the window.</p>'; return; }
    const cmp = (await glApi(`/projects/${pid}/repository/compare?from=${base.id}&to=${head.id}&straight=true`)).data, files = GLD.fromApi(cmp.diffs || []);
    const draw = () => { if (!$("#glrFiles" + pid)) return; box.innerHTML = `<p class="tiny">Baseline <code class="sha">${esc(base.short_id)}</code> (${esc(fmtDateTime(base.committed_date))}, last commit before the release) → <code class="sha">${esc(head.short_id)}</code></p>` + GLD.summaryHtml(GLD.summary(files, cmp.commits || []), "What changed since the release") + GLD.render(files); GLD.wire(box, draw); };
    draw();
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}
function glrRca() {
  const r = GLR.res, t = glrTotals(r.rows), lines = [];
  const risky = /\b(hotfix|fix|revert|rollback|config|property|properties|migration|schema|timeout|retry|cache|kafka|db|sql|null|npe|exception|prod)\b/i;
  lines.push(`# Change summary ${fmtDateTime(r.since)} – ${fmtDateTime(r.until)}`, "");
  lines.push(`- Projects with changes: ${r.rows.filter((x) => x.commits.length || x.mrs.length).length}`, `- Commits: ${t.c} (+${t.add} / -${t.del} lines) by ${t.devs} developer(s)`, `- Merge requests merged: ${t.m}`, `- Successful deployments: ${t.d}`);
  if (r.key) lines.push(`- Filtered by Jira key: ${r.key}`); if (r.author) lines.push(`- Filtered by author: ${r.author}`);
  lines.push("", "## Deployed in the window (most likely to matter)");
  const dep = r.rows.filter((x) => x.deps.some((d) => d.status === "success"));
  if (!dep.length) lines.push("- No successful deployment recorded in GitLab for these projects.");
  for (const x of dep) { const ds = x.deps.filter((d) => d.status === "success"); lines.push(`- ${x.p.name}: ${ds.length} deployment(s) to ${[...new Set(ds.map((d) => d.env))].join(", ")} — last ${fmtDateTime(ds[0].at)} (${String(ds[0].sha).slice(0, 8)})`); }
  lines.push("", "## Changes that look risky (by keywords in the titles)");
  const rk = r.rows.flatMap((x) => [...x.commits.filter((c) => risky.test(c.title)).map((c) => `- ${x.p.name}: ${c.title} — ${c.author}, ${fmtDateTime(c.at)} (${c.short})`), ...x.mrs.filter((m) => risky.test(m.title)).map((m) => `- ${x.p.name}: !${m.iid} ${m.title} — merged ${fmtDateTime(m.merged_at)}${m._dep ? ` · deployed to ${m._dep.envs.join(", ")}` : ""}`)]);
  lines.push(...(rk.length ? rk.slice(0, 40) : ["- None found by keywords — still review the deployed changes above."]));
  lines.push("", "## Merged merge requests");
  for (const x of r.rows) for (const m of x.mrs) lines.push(`- ${x.p.name} !${m.iid}: ${m.title} (${m.author?.name || ""}) — merged ${fmtDateTime(m.merged_at)} — ${m._dep ? `deployed (${m._dep.kind === "exact" ? "exact commit" : "later deployment"}) to ${m._dep.envs.join(", ")}` : "no deployment found"}`);
  if (t.keys.length) lines.push("", "## Jira issues mentioned", t.keys.join(", "));
  lines.push("", "## Timeline (fill in)", "- Incident start:", "- First alert:", "- Suspected change:", "- Mitigation / rollback:", "", "## Root cause (fill in)", "", "## Follow-ups", "- [ ] ", "",
    "_Generated by JiraTime from GitLab commits, merge requests and deployments. A deployment counts only when GitLab recorded it._");
  return lines.join("\n");
}

// ================= release comparison =================
async function glrCompareTab() {
  const body = $("#glBody"); if (!body) return;
  const c = GLR.cmp, recent = glRanked().slice(0, 80).map((x) => x.p);
  if (!c.pid && recent[0]) c.pid = String(recent[0].id);
  const p = glmProj(c.pid);
  body.innerHTML = `<div class="card glr-form">
      <div class="glr-hd"><div><h3>⇄ Compare two releases</h3><p class="muted tiny">Tags, branches or commit SHAs — or two dates on one branch. Shows commits, merge requests, Jira issues and every changed file.</p></div>
        <span class="grow"></span><div class="gl-seg"><button data-glact="tab:release">Changes after a date</button><button class="on" data-glact="tab:compare">Compare two releases</button></div></div>
      <div class="glr-grid">
        <label>Project <select id="glcP">${recent.map((x) => `<option value="${x.id}" ${String(x.id) === c.pid ? "selected" : ""}>${esc(x.path)}</option>`).join("")}</select></label>
        <label>Compare by <select id="glcM"><option value="refs" ${c.mode === "refs" ? "selected" : ""}>Tag / branch / SHA</option><option value="dates" ${c.mode === "dates" ? "selected" : ""}>Two dates on a branch</option></select></label>
        ${c.mode === "refs" ? `<label>Old release (from) <input id="glcF" list="glcRefs" value="${esc(c.from)}" placeholder="e.g. v1.8.0"></label><label>New release (to) <input id="glcT" list="glcRefs" value="${esc(c.to || p?.branch || "")}" placeholder="e.g. v1.9.0 or master"></label>`
          : `<label>Branch <input id="glcB" list="glcRefs" value="${esc(c.branch || p?.branch || "")}"></label><label>Old date <input id="glcFd" type="datetime-local" value="${esc(c.fromDate)}"></label><label>New date <input id="glcTd" type="datetime-local" value="${esc(c.toDate || glrLocal(new Date()))}"></label>`}
      </div><datalist id="glcRefs"></datalist>
      <div class="row-actions" style="margin:10px 0 0"><span id="glcHint" class="muted tiny"></span><span class="grow"></span><button class="primary" data-glact="glcrun" style="width:auto;margin:0">Compare</button></div></div>
    <div id="glcOut"></div>`;
  $("#glcP").onchange = (e) => { c.pid = e.target.value; c.res = null; glrCompareTab(); };
  $("#glcM").onchange = (e) => { c.mode = e.target.value; glrCompareTab(); };
  ["glcF", "glcT", "glcB", "glcFd", "glcTd"].forEach((id) => $("#" + id)?.addEventListener("change", (e) => { c[{ glcF: "from", glcT: "to", glcB: "branch", glcFd: "fromDate", glcTd: "toDate" }[id]] = e.target.value.trim(); }));
  if (c.pid) {
    Promise.all([glApi(`/projects/${c.pid}/repository/tags?per_page=50&order_by=updated&sort=desc`).then((r) => r.data || []).catch(() => []), glApi(`/projects/${c.pid}/repository/branches?per_page=60&sort=updated_desc`).then((r) => r.data || []).catch(() => [])])
      .then(([tags, brs]) => { const dl = $("#glcRefs"); if (!dl) return; dl.innerHTML = [...tags.map((t) => `<option value="${esc(t.name)}">tag · ${esc(ago(t.commit?.committed_date))}</option>`), ...brs.map((b) => `<option value="${esc(b.name)}">branch · ${esc(ago(b.commit?.committed_date))}</option>`)].join("");
        const h = $("#glcHint"); if (h) h.textContent = tags.length ? `Latest tags: ${tags.slice(0, 4).map((t) => t.name).join(", ")}` : "No tags in this project — use branches, SHAs or dates."; });
  }
  glcOut();
}
async function glcRun() {
  const c = GLR.cmp, pid = c.pid; if (!pid) return;
  const out = $("#glcOut"); out.innerHTML = '<div class="card"><p class="muted"><span class="spin"></span> Comparing…</p></div>';
  try {
    let from = c.from, to = c.to;
    if (c.mode === "dates") {
      if (!c.branch || !c.fromDate) throw new Error("Choose the branch and the old date");
      const at = async (d) => (await glApi(`/projects/${pid}/repository/commits?ref_name=${enc(c.branch)}&until=${enc(new Date(d).toISOString())}&per_page=1`)).data?.[0];
      const [a, b] = await Promise.all([at(c.fromDate), at(c.toDate || new Date().toISOString())]);
      if (!a) throw new Error(`${c.branch} has no commit before the old date`);
      if (!b) throw new Error(`${c.branch} has no commit before the new date`);
      from = a.id; to = b.id;
    }
    if (!from || !to) throw new Error("Fill in both releases");
    const r = (await glApi(`/projects/${pid}/repository/compare?from=${enc(from)}&to=${enc(to)}&straight=false`)).data;
    const files = GLD.fromApi(r.diffs || []), commits = (r.commits || []).slice().reverse();
    const mrRefs = new Map(); commits.forEach((x) => glrMrRefs(x.message).forEach((m) => { if (!m.path || m.path === glmProj(pid)?.path) mrRefs.set(m.iid, x); }));
    c.res = { pid, from, to, labelFrom: c.mode === "dates" ? `${c.branch} @ ${fmtDateTime(c.fromDate)}` : from, labelTo: c.mode === "dates" ? `${c.branch} @ ${fmtDateTime(c.toDate || new Date().toISOString())}` : to,
      files, commits, mrIids: [...mrRefs.keys()], mrs: [], keys: GLD.keys(commits.map((x) => x.message).join(" ")), timeout: !!r.compare_timeout, same: !!r.compare_same_ref };
    glcOut();
    if (c.res.mrIids.length) {     // titles of the merge requests mentioned in the merge commits
      const mrs = await pool(c.res.mrIids.slice(0, 60), 4, (iid) => glApi(`/projects/${pid}/merge_requests/${iid}`).then((x) => x.data).catch(() => null));
      if (c.res.pid === pid) { c.res.mrs = mrs.filter(Boolean); c.res.keys = [...new Set([...c.res.keys, ...GLD.keys(c.res.mrs.map((m) => `${m.title} ${m.source_branch}`).join(" "))])]; glcOut(); }
    }
  } catch (e) { out.innerHTML = `<div class="warnbox">⚠ ${esc(e.status === 404 ? "A release was not found — check the tag / branch / SHA." : e.message)}</div>`; }
}
function glcOut() {
  const el = $("#glcOut"), r = GLR.cmp.res; if (!el) return;
  if (!r || String(r.pid) !== String(GLR.cmp.pid)) { el.innerHTML = ""; return; }
  const own = r.commits.filter((x) => (x.parent_ids || []).length < 2), s = GLD.summary(r.files, own), authors = [...new Set(own.map((x) => x.author_name))];
  const draw = () => {
    el.innerHTML = `<div class="card glc-rep" id="glcRep"><div class="row-actions"><h3 style="margin:0">${esc(glmProj(r.pid)?.name || "")}: <code>${esc(r.labelFrom)}</code> → <code>${esc(r.labelTo)}</code></h3><span class="grow"></span>
        <button class="small" data-glact="glccsv">⬇ CSV</button><button class="small" data-glact="glcmd">⧉ Release notes</button><button class="small" data-glact="glcprint">🖨 Print</button></div>
      ${r.same ? '<div class="warnbox">Both sides point to the same commit.</div>' : ""}${r.timeout ? '<div class="warnbox">GitLab stopped the compare early (very large) — the file list may be incomplete.</div>' : ""}
      <div class="stats gl-stats"><div class="stat"><b>${own.length}</b><span>commits</span><small>${r.commits.length - own.length} merge commits</small></div><div class="stat"><b>${r.mrIids.length}</b><span>merge requests</span></div>
        <div class="stat"><b>${r.files.length}</b><span>files</span><small><span class="st-success">+${s.added}</span> <span class="st-failed">−${s.removed}</span></small></div><div class="stat"><b>${authors.length}</b><span>developers</span><small>${esc(authors.slice(0, 3).join(", "))}</small></div></div>
      ${GLD.summaryHtml(s, "Release summary")}
      ${r.keys.length ? `<h4>Jira issues</h4><p>${r.keys.map((k) => GLD.jira(k)).join(" ")}</p>` : ""}
      ${r.mrs.length ? `<h4>Merge requests</h4><table class="gl-tbl">${r.mrs.map((m) => `<tr data-glact="glmopen:${r.pid}|${m.iid}"><td>!${m.iid}</td><td>${GLD.jira(m.title)}<small class="muted">${esc(m.author?.name || "")} · ${esc(m.source_branch)} · merged ${esc(fmtDateTime(m.merged_at))}</small></td></tr>`).join("")}</table>` : r.mrIids.length ? `<p class="muted tiny">Loading ${r.mrIids.length} merge request(s)…</p>` : ""}
      <h4>Commits</h4><table class="gl-tbl">${own.slice(0, 300).map((x) => `<tr data-glcommit="${r.pid}:${x.id}"><td><code class="sha">${esc(x.short_id)}</code></td><td>${GLD.jira(x.title)}<small class="muted">${esc(x.author_name)} · ${esc(fmtDateTime(x.created_at))}</small></td></tr>`).join("") || '<tr><td class="muted">No commits.</td></tr>'}</table>
      <h4>Files</h4>${GLD.render(r.files)}</div>`;
    GLD.wire(el, draw);
  };
  draw();
}
function glcNotes() {
  const r = GLR.cmp.res, own = r.commits.filter((x) => (x.parent_ids || []).length < 2), s = GLD.summary(r.files, own);
  return [`# Release ${r.labelTo}`, `Changes since ${r.labelFrom} in ${glmProj(r.pid)?.path || ""}`, "",
    r.keys.length ? `## Jira\n${r.keys.map((k) => `- ${k}`).join("\n")}\n` : "",
    r.mrs.length ? `## Merge requests\n${r.mrs.map((m) => `- !${m.iid} ${m.title} (${m.author?.name || ""})`).join("\n")}\n` : "",
    `## Commits\n${own.map((x) => `- ${x.title} (${x.author_name}, ${x.short_id})`).join("\n")}\n`,
    `## Files\n${s.files} files, +${s.added} / -${s.removed}\n${Object.entries(s.cats).map(([c, l]) => `- ${c}: ${l.length}`).join("\n")}`,
    s.risks.length ? `\n## Check before release\n${s.risks.map((x) => `- ${x}`).join("\n")}` : ""].filter(Boolean).join("\n");
}

// ================= actions =================
Object.assign(GL_ACTIONS, {
  glrrun: () => glrRun(),
  glrstop: () => { GLR.ctl?.abort(); },
  glrpick: () => glrPick(),
  glrview: (v) => { GLR.view = v; document.querySelectorAll("#glrOut .gl-sub .gl-tab").forEach((b) => b.classList.toggle("on", b.dataset.glact === "glrview:" + v)); glrView(); },
  glropen: (pid) => { GLR.open[pid] = !GLR.open[pid]; glrView(); },
  glrfiles: (pid) => glrFiles(pid),
  glrcmp: (pid) => { const x = GLR.res?.rows.find((r) => r.p.id === +pid); Object.assign(GLR.cmp, { pid: String(pid), mode: "dates", branch: x?.ref || "", fromDate: glrLocal(new Date(GLR.res.since)), toDate: glrLocal(new Date(GLR.res.until)), res: null }); GL.tab = "compare"; glRender(); glcRun(); },
  glrrcacopy: () => navigator.clipboard.writeText($("#glrRca").value).then(() => toast("Copied")).catch(() => toast("Copy failed")),
  glrcsv: () => {
    const r = GLR.res; if (!r) return;
    const rows = [["kind", "project", "branch", "id", "date", "author", "title", "jira", "additions", "deletions", "deployed", "url"]];
    for (const x of r.rows) {
      for (const c of x.commits) rows.push(["commit", x.p.path, x.ref || "all", c.sha, c.at, c.author, c.title, GLD.keys(c.msg).join(" "), c.add, c.del, "", c.web]);
      for (const m of x.mrs) rows.push(["merge_request", x.p.path, m.target_branch, "!" + m.iid, m.merged_at, m.author?.name || "", m.title, GLD.keys(`${m.title} ${m.source_branch}`).join(" "), "", "", m._dep ? `${m._dep.kind}: ${m._dep.envs.join(" ")}` : "no", m.web_url]);
      for (const d of x.deps) rows.push(["deployment", x.p.path, d.ref, d.sha, d.at, d.by, `${d.status} → ${d.env}`, "", "", "", d.status === "success" ? "yes" : "no", d.web]);
    }
    glrCsv(`release-changes-${r.since.slice(0, 10)}.csv`, rows);
  },
  glcrun: () => { const c = GLR.cmp; ["glcF", "glcT", "glcB", "glcFd", "glcTd"].forEach((id) => { const el = $("#" + id); if (el) c[{ glcF: "from", glcT: "to", glcB: "branch", glcFd: "fromDate", glcTd: "toDate" }[id]] = el.value.trim(); }); glcRun(); },
  glccsv: () => { const r = GLR.cmp.res; if (!r) return; glrCsv(`release-${String(r.labelFrom).replace(/\W+/g, "_")}-to-${String(r.labelTo).replace(/\W+/g, "_")}.csv`, [["kind", "id", "date", "author", "title", "jira", "status"], ...r.commits.map((x) => ["commit", x.id, x.created_at, x.author_name, x.title, GLD.keys(x.message).join(" "), (x.parent_ids || []).length > 1 ? "merge" : ""]), ...r.mrs.map((m) => ["merge_request", "!" + m.iid, m.merged_at, m.author?.name || "", m.title, GLD.keys(m.title).join(" "), m.state]), ...r.files.map((f) => ["file", f.newPath, "", "", f.status, "", `+${f.added} -${f.removed}`])]); },
  glcmd: () => navigator.clipboard.writeText(glcNotes()).then(() => toast("Release notes copied (Markdown)")).catch(() => toast("Copy failed")),
  glcprint: () => { document.body.classList.add("gl-printing"); window.addEventListener("afterprint", () => document.body.classList.remove("gl-printing"), { once: true }); window.print(); setTimeout(() => document.body.classList.remove("gl-printing"), 1500); },
});
glAddTab({ id: "release", icon: "🚀", label: "Releases", render: () => glrRenderTab(), refresh: () => {} }, "mrs");
glAddTab({ id: "compare", icon: "⇄", label: "Compare", render: () => glrCompareTab(), refresh: () => {} }, "release");
window.GLR = GLR;
