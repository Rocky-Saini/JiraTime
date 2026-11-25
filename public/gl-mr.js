"use strict";
/* Merge requests: lists (mine / assigned / review / per project), detail (overview, changes, commits, discussion, pipelines),
   review actions (approve, comment, edit, assign, labels, draft, close / reopen, merge) and creating MRs ("Prepare MR").
   Every change goes through the server's write allow-list in lib/gitlab.js. */

const GLMS = { scope: "mine", state: "opened", q: "", pid: "", page: 1, list: null, total: null, next: "", err: "", busy: false, cur: null, seq: 0 };
const GLM_SCOPES = [["mine", "Created by me"], ["assigned", "Assigned to me"], ["review", "Review requested"], ["project", "In a project"]];
const GLM_MS = {   // detailed_merge_status -> [label, css]
  mergeable: ["Ready to merge", "good"], can_be_merged: ["Ready to merge", "good"], conflict: ["Has conflicts", "low"], cannot_be_merged: ["Has conflicts", "low"],
  need_rebase: ["Needs rebase", "over"], ci_must_pass: ["Pipeline must pass", "over"], ci_still_running: ["Pipeline running", "high"], not_approved: ["Needs approval", "over"],
  draft_status: ["Draft", "noest"], discussions_not_resolved: ["Open threads", "over"], blocked_status: ["Blocked", "low"], checking: ["Checking…", "noest"],
  unchecked: ["Not checked yet", "noest"], broken_status: ["Broken", "low"], not_open: ["Not open", "noest"], requested_changes: ["Changes requested", "over"],
  jira_association_missing: ["Jira key missing", "over"], external_status_checks: ["External checks", "over"], preparing: ["Preparing…", "noest"],
};
const glmMe = () => GL.st?.user?.id;
const glmProj = (pid) => (GL.projects || []).find((p) => p.id === +pid) || null;
const glmIsDraft = (m) => !!(m.draft || m.work_in_progress || /^(draft:|\[draft\]|wip:)/i.test(m.title || ""));
const glmStripDraft = (t) => String(t || "").replace(/^\s*(draft:|\[draft\]|\(draft\)|wip:)\s*/i, "");
const glmState = (m) => m.state === "merged" ? '<span class="b new">merged</span>' : m.state === "closed" ? '<span class="b bad">closed</span>' : glmIsDraft(m) ? '<span class="b skip">draft</span>' : '<span class="b diff">open</span>';
const glmPeople = (l) => (l || []).map((u) => `<span class="gl-chip" title="@${esc(u.username)}">${esc(initials(u.name))} ${esc(u.name)}</span>`).join(" ");

// ================= list tab =================
function glmListUrl() {
  const q = new URLSearchParams({ state: GLMS.state, order_by: "updated_at", sort: "desc", per_page: "30", page: String(GLMS.page) });
  if (GLMS.q) q.set("search", GLMS.q);
  if (GLMS.scope === "project") return GLMS.pid ? `/projects/${GLMS.pid}/merge_requests?${q}` : "";
  if (GLMS.scope === "mine") q.set("scope", "created_by_me");
  else if (GLMS.scope === "assigned") q.set("scope", "assigned_to_me");
  else { q.set("scope", "all"); q.set("reviewer_username", GL.st.username); }
  return `/merge_requests?${q}`;
}
async function glmLoadList() {
  const url = glmListUrl(), seq = ++GLMS.seq;
  if (!url) { GLMS.list = []; GLMS.total = 0; glmFill(); return; }
  GLMS.busy = true; GLMS.err = ""; glmFill();
  try { const r = await glApi(url); if (seq !== GLMS.seq) return; GLMS.list = r.data || []; GLMS.total = r.total; GLMS.next = r.next; }
  catch (e) { if (seq !== GLMS.seq) return; GLMS.err = e.message; GLMS.list = GLMS.list || []; }
  GLMS.busy = false; glmFill();
}
function glmRenderTab() {
  const body = $("#glBody"); if (!body) return;
  const recent = glRanked().slice(0, 60).map((x) => x.p);
  if (GLMS.scope === "project" && !GLMS.pid && recent[0]) GLMS.pid = String(recent[0].id);
  body.innerHTML = `<div class="gl-toolbar card">
      <div class="gl-seg">${GLM_SCOPES.map(([k, l]) => `<button class="${GLMS.scope === k ? "on" : ""}" data-glact="glmscope:${k}">${l}</button>`).join("")}</div>
      ${GLMS.scope === "project" ? `<select id="glmPid" aria-label="Project">${recent.map((p) => `<option value="${p.id}" ${String(p.id) === GLMS.pid ? "selected" : ""}>${esc(p.path)}</option>`).join("")}</select>` : ""}
      <select id="glmState" aria-label="State">${["opened", "merged", "closed", "all"].map((s) => `<option ${s === GLMS.state ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input id="glmQ" placeholder="Search title / description (e.g. FUL2-123)" value="${esc(GLMS.q)}" aria-label="Search merge requests">
      <span class="grow"></span>
      <button class="small" data-glact="glmreload" title="Reload">⟳</button>
      <button class="small primary-s" data-glact="newmr:${GLMS.scope === "project" ? GLMS.pid : ""}">＋ New merge request</button></div>
    <div id="glmList" class="gl-mrlist"></div>`;
  let t;
  $("#glmQ").addEventListener("input", (e) => { clearTimeout(t); t = setTimeout(() => { GLMS.q = e.target.value.trim(); GLMS.page = 1; glmLoadList(); }, 350); });
  $("#glmState").onchange = (e) => { GLMS.state = e.target.value; GLMS.page = 1; glmLoadList(); };
  $("#glmPid")?.addEventListener("change", (e) => { GLMS.pid = e.target.value; GLMS.page = 1; glmLoadList(); });
  if (GLMS.list && GLMS.listKey === glmListUrl()) glmFill(); else glmLoadList();
}
function glmFill() {
  const el = $("#glmList"); if (!el) return;
  GLMS.listKey = glmListUrl();
  if (GLMS.busy && !GLMS.list?.length) { el.innerHTML = '<div class="card"><p class="muted"><span class="spin"></span> Loading merge requests…</p></div>'; return; }
  const rows = (GLMS.list || []).map((m) => {
    const p = glmProj(m.project_id), ms = GLM_MS[m.detailed_merge_status || m.merge_status];
    return `<div class="gl-mr" data-glact="glmopen:${m.project_id}|${m.iid}">
      <div class="gl-mr-a">${glmState(m)}</div>
      <div class="gl-mr-m"><div class="gl-mr-t">${GLD.jira(glmStripDraft(m.title))}</div>
        <div class="muted tiny"><b>${esc(p?.name || m.references?.full?.split("!")[0] || "project " + m.project_id)}</b> !${m.iid} · ${esc(m.author?.name || "")} · <span class="gl-br">${esc(m.source_branch)}</span> → <span class="gl-br">${esc(m.target_branch)}</span>
          ${(m.labels || []).slice(0, 4).map((l) => `<span class="gl-lbl">${esc(l)}</span>`).join("")}</div></div>
      <div class="gl-mr-s">${m.state === "opened" && ms ? `<span class="eff ${ms[1]}">${esc(ms[0])}</span>` : ""}${m.has_conflicts ? ' <span class="eff low">conflicts</span>' : ""}
        <div class="muted tiny">${m.user_notes_count ? `💬 ${m.user_notes_count} · ` : ""}updated ${esc(ago(m.updated_at))}</div></div></div>`;
  }).join("");
  el.innerHTML = `${GLMS.err ? `<div class="warnbox">⚠ ${esc(GLMS.err)}</div>` : ""}
    <div class="card gl-mr-card">${rows || `<p class="muted">${GLMS.scope === "project" && !GLMS.pid ? "Choose a project." : "No merge requests here."}</p>`}</div>
    <div class="row-actions gl-pager">${GLMS.busy ? '<span class="spin"></span>' : ""}<span class="muted tiny">${GLMS.total != null ? `${GLMS.total} merge request${GLMS.total === 1 ? "" : "s"}` : ""}</span><span class="grow"></span>
      ${GLMS.page > 1 ? '<button class="small" data-glact="glmpage:-1">← Newer</button>' : ""}${GLMS.next ? '<button class="small" data-glact="glmpage:1">Older →</button>' : ""}</div>`;
}

// ================= detail =================
async function glmOpen(pid, iid, tab = "overview") {
  pid = +pid; iid = +iid;
  const c = GLMS.cur = { pid, iid, tab, mr: null, appr: null, files: null, commits: null, notes: null, pipes: null, commit: null };
  openModal(`<div class="gl-det gl-wide" data-gldet="${pid}"><h3>Merge request !${iid}</h3><p class="muted"><span class="spin"></span> Loading…</p></div>`);
  try {
    const [mr, appr, role] = await Promise.all([glApi(`/projects/${pid}/merge_requests/${iid}`).then((r) => r.data), glApi(`/projects/${pid}/merge_requests/${iid}/approvals`).then((r) => r.data).catch(() => null), glRole(pid)]);
    if (GLMS.cur !== c) return;
    c.mr = mr; c.appr = appr; c.role = role; glmDraw();
  } catch (e) { openModal(`<h3>Merge request !${iid}</h3><div class="warnbox">⚠ ${esc(e.message)}</div><div class="foot"><button data-glact="closedet">Close</button></div>`); }
}
async function glmReload(tab) {
  const c = GLMS.cur; if (!c) return;
  const [mr, appr] = await Promise.all([glApi(`/projects/${c.pid}/merge_requests/${c.iid}`).then((r) => r.data), glApi(`/projects/${c.pid}/merge_requests/${c.iid}/approvals`).then((r) => r.data).catch(() => null)]);
  Object.assign(c, { mr, appr, notes: null, pipes: null }); if (tab) c.tab = tab; glmDraw();
  const i = (GLMS.list || []).findIndex((m) => m.project_id === c.pid && m.iid === c.iid); if (i >= 0) { GLMS.list[i] = { ...GLMS.list[i], ...mr }; glmFill(); }
}
const GLM_TABS = [["overview", "Overview"], ["changes", "Changes"], ["commits", "Commits"], ["notes", "Discussion"], ["pipes", "Pipelines"]];
function glmDraw() {
  const c = GLMS.cur, m = c.mr, p = glmProj(c.pid), a = c.appr, open = m.state === "opened";
  const ms = GLM_MS[m.detailed_merge_status || m.merge_status];
  const keys = GLD.keys(`${m.title} ${m.description || ""} ${m.source_branch}`);
  const approved = a?.approved_by?.map((x) => x.user) || [];
  const canMerge = m.user?.can_merge, roleName = GL_ROLE[c.role] || "", mine = m.author?.id === glmMe();
  const mergeBtn = canMerge === false
    ? `<button class="small" disabled title="GitLab does not allow you to merge into ${esc(m.target_branch)}${roleName ? ` (your role: ${roleName})` : ""}. A Maintainer / team lead can merge it.">🔒 Merge (not allowed for you)</button>`
    : `<button class="small primary" data-glact="glmmerge" style="width:auto;margin:0">⤵ Merge…</button>`;
  const left = a?.approvals_left ?? null;
  openModal(`<div class="gl-det gl-wide glm" data-gldet="${c.pid}">
    <div class="gl-det-head"><div class="glm-h"><div class="glm-t">${glmState(m)} <h3>${GLD.jira(glmStripDraft(m.title))}</h3></div>
      <div class="muted tiny">${esc(p?.path || m.references?.full || "")} !${m.iid} · opened by <b>${esc(m.author?.name || "")}</b> ${esc(ago(m.created_at))} ·
        <span class="gl-br">${esc(m.source_branch)}</span> → <span class="gl-br">${esc(m.target_branch)}</span></div></div>
      <div class="grow"></div>${glLink(m.web_url, "Open in GitLab ↗", "small gl-ext")}<button class="small ghost" data-glcopy="${esc(m.web_url)}" title="Copy link">⧉</button></div>
    <div class="glm-bar">
      ${open && ms ? `<span class="eff ${ms[1]}" title="GitLab merge status: ${esc(m.detailed_merge_status || m.merge_status)}">${esc(ms[0])}</span>` : ""}
      ${m.head_pipeline ? glPipeBadge({ status: m.head_pipeline.status, web: m.head_pipeline.web_url, ref: m.head_pipeline.ref }) : '<span class="muted tiny">no pipeline</span>'}
      ${roleName ? `<span class="gl-role" title="Your role in this project">👤 ${roleName}</span>` : ""}
      ${a ? `<span class="tiny">${approved.length ? `✔ approved by ${esc(approved.map((u) => u.name).join(", "))}` : "not approved yet"}${left ? ` · <b>${left}</b> more approval${left === 1 ? "" : "s"} needed` : ""}</span>` : ""}
      <span class="grow"></span>
      ${window.GLKIRO ? '<button class="small" data-glact="kiromr" title="Kiro reads the full diff on your laptop and writes a review">🤖 Review with Kiro</button>' : ""}
      ${open && a?.user_can_approve && !a.user_has_approved ? '<button class="small primary-s" data-glact="glmapprove">✔ Approve</button>' : open && a && !a.user_has_approved && !a.user_can_approve ? `<span class="muted tiny" title="${mine ? "GitLab does not let authors approve their own merge request here" : "You are not an eligible approver for this merge request"}">🔒 can't approve</span>` : ""}
      ${open && a?.user_has_approved ? '<button class="small" data-glact="glmunapprove">Revoke approval</button>' : ""}
      ${open ? `<button class="small" data-glact="glmedit">✎ Edit</button><button class="small" data-glact="glmdraft">${glmIsDraft(m) ? "Mark ready" : "Mark as draft"}</button>
        <button class="small danger" data-glact="glmstate:close">Close</button>${mergeBtn}` : ""}
      ${m.state === "closed" ? '<button class="small" data-glact="glmstate:reopen">Reopen</button>' : ""}</div>
    <div class="gl-sub">${GLM_TABS.map(([t, l]) => `<button class="gl-tab ${t === c.tab ? "on" : ""}" data-glact="glmtab:${t}">${l}${t === "notes" && m.user_notes_count ? `<span class="gl-tc">${m.user_notes_count}</span>` : t === "changes" && m.changes_count ? `<span class="gl-tc">${esc(m.changes_count)}</span>` : ""}</button>`).join("")}</div>
    <div id="glmBody" class="gl-det-body tall"></div>
    <div class="foot"><span class="muted tiny">${keys.length ? "Jira: " + keys.map((k) => GLD.jira(k)).join(" ") : ""}</span><span class="grow"></span><button data-glact="closedet">Close</button></div></div>`);
  glmTab();
}
async function glmTab() {
  const c = GLMS.cur, m = c.mr, box = () => (GLMS.cur === c ? $("#glmBody") : null), put = (h) => { const b = box(); if (b) b.innerHTML = h; return b; };
  const base = `/projects/${c.pid}/merge_requests/${c.iid}`;
  try {
    if (c.tab === "overview") {
      put(`<div class="glm-ov"><div class="glm-desc">${m.description ? `<pre class="gl-msg">${GLD.jira(m.description)}</pre>` : '<p class="muted">No description.</p>'}</div>
        <table class="gl-kv glm-side">
          <tr><td>Assignees</td><td>${glmPeople(m.assignees) || '<span class="muted">none</span>'} ${m.state === "opened" ? '<button class="small ghost" data-glact="glmedit">change</button>' : ""}</td></tr>
          <tr><td>Reviewers</td><td>${glmPeople(m.reviewers) || '<span class="muted">none</span>'}</td></tr>
          <tr><td>Labels</td><td>${(m.labels || []).map((l) => `<span class="gl-lbl">${esc(l)}</span>`).join(" ") || '<span class="muted">none</span>'}</td></tr>
          <tr><td>Milestone</td><td>${esc(m.milestone?.title || "—")}</td></tr>
          <tr><td>Merge options</td><td class="tiny">${m.squash ? "squash commits · " : ""}${m.force_remove_source_branch ? "delete source branch" : "keep source branch"}</td></tr>
          ${m.merged_at ? `<tr><td>Merged</td><td>${esc(fmtDateTime(m.merged_at))} by ${esc(m.merged_by?.name || m.merge_user?.name || "")}${m.merge_commit_sha ? ` · <code class="sha">${esc(m.merge_commit_sha.slice(0, 8))}</code>` : ""}</td></tr>` : ""}
          ${m.closed_at ? `<tr><td>Closed</td><td>${esc(fmtDateTime(m.closed_at))} by ${esc(m.closed_by?.name || "")}</td></tr>` : ""}
          <tr><td>Updated</td><td>${esc(fmtDateTime(m.updated_at))}</td></tr>
          ${m.has_conflicts ? `<tr><td>Conflicts</td><td><span class="st-failed">The branches conflict.</span> Resolve them locally: open the repository in <b>Local repos</b>, check out ${esc(m.source_branch)} and merge ${esc(m.target_branch)} into it.</td></tr>` : ""}
        </table></div>`);
    } else if (c.tab === "changes") {
      if (!c.files) {
        put('<p class="muted"><span class="spin"></span> Loading changes…</p>');
        let diffs;
        try { diffs = await glAll(`${base}/diffs`, 10); }
        catch (e) { if (e.status !== 404 && e.status !== 403) throw e; diffs = (await glApi(`${base}/changes`)).data?.changes || []; }   // GitLab < 15.7
        if (!c.commits) c.commits = await glAll(`${base}/commits`, 3).catch(() => []);
        c.files = GLD.fromApi(diffs);
      }
      const draw = () => { const b = put(GLD.summaryHtml(GLD.summary(c.files, c.commits), "Smart review") + GLD.render(c.files)); if (b) GLD.wire(b, draw); };
      draw();
    } else if (c.tab === "commits") {
      if (!c.commits) { put('<p class="muted"><span class="spin"></span> Loading commits…</p>'); c.commits = await glAll(`${base}/commits`, 3); }
      put(`<table class="gl-tbl">${c.commits.map((x) => `<tr class="${c.commit === x.id ? "on" : ""}" data-glact="glmcommit:${x.id}"><td><code class="sha">${esc(x.short_id)}</code></td><td>${GLD.jira(x.title)}<small class="muted">${esc(x.author_name)} · ${esc(fmtDateTime(x.created_at))}</small></td><td>${glLink(x.web_url, "↗")}</td></tr>`).join("") || '<tr><td class="muted">No commits.</td></tr>'}</table>
        <div id="glmCommit"></div>`);
      if (c.commit) glmShowCommit(c.commit);
    } else if (c.tab === "notes") {
      if (!c.notes) { put('<p class="muted"><span class="spin"></span> Loading discussion…</p>'); c.notes = await glAll(`${base}/notes?sort=asc&order_by=created_at`, 5); }
      put(`<div class="glm-notes">${c.notes.map((n) => n.system
          ? `<div class="glm-sys"><span class="muted tiny">• <b>${esc(n.author?.name || "")}</b> ${esc(n.body)} · ${esc(ago(n.created_at))}</span></div>`
          : `<div class="glm-note ${n.author?.id === glmMe() ? "me" : ""}"><div class="gl-avatar sm">${esc(initials(n.author?.name))}</div><div class="glm-nb"><div class="tiny"><b>${esc(n.author?.name || "")}</b> <span class="muted">${esc(ago(n.created_at))}${n.type === "DiffNote" && n.position ? ` · on ${esc(n.position.new_path || n.position.old_path)}${n.position.new_line ? ":" + n.position.new_line : ""}` : ""}${n.resolvable ? (n.resolved ? " · ✓ resolved" : " · open thread") : ""}</span></div>
              <div class="glm-nt">${GLD.jira(n.body)}</div></div></div>`).join("") || '<p class="muted">No comments yet.</p>'}</div>
        <div class="glm-reply"><textarea id="glmNote" rows="3" placeholder="Write a comment… (Markdown works; @name mentions people)"></textarea>
          <div class="row-actions"><span class="muted tiny">Ctrl+Enter to send</span><span class="grow"></span><button class="small primary-s" data-glact="glmnote">💬 Comment</button></div></div>`);
      $("#glmNote")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) glAction("glmnote"); });
    } else if (c.tab === "pipes") {
      if (!c.pipes) { put('<p class="muted"><span class="spin"></span> Loading pipelines…</p>'); c.pipes = (await glApi(`${base}/pipelines?per_page=20`)).data || []; }
      put(`<table class="gl-tbl">${c.pipes.map((x) => `<tr ${window.GLP ? `data-glact="glpopen:${c.pid}|${x.id}"` : ""}><td>${glPipeBadge({ status: x.status, web: x.web_url, ref: x.ref })}</td><td>#${x.id} · ⎇ ${esc(x.ref)} <code class="sha">${esc(String(x.sha || "").slice(0, 8))}</code></td><td class="muted tiny nowrap">${esc(fmtDateTime(x.created_at))}</td><td>${window.GLP ? '<button class="small">Jobs</button>' : ""}</td></tr>`).join("") || '<tr><td class="muted">No pipelines for this merge request.</td></tr>'}</table>`);
    }
  } catch (e) { put(`<div class="warnbox">⚠ ${esc(e.message)}</div>`); }
}
async function glmShowCommit(sha) {
  const c = GLMS.cur; c.commit = sha;
  document.querySelectorAll("#glmBody tr[data-glact^='glmcommit:']").forEach((tr) => tr.classList.toggle("on", tr.dataset.glact === "glmcommit:" + sha));
  const box = $("#glmCommit"); if (!box) return;
  box.innerHTML = '<p class="muted"><span class="spin"></span> Loading commit…</p>';
  try {
    const files = GLD.fromApi(await glAll(`/projects/${c.pid}/repository/commits/${sha}/diff`, 5));
    const draw = () => { if (!$("#glmCommit")) return; box.innerHTML = GLD.render(files); GLD.wire(box, draw); };
    draw(); box.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

// ================= people / label pickers =================
/** Searchable member picker inside el. Returns { ids() }. */
function glmPicker(el, pid, initial, { single = false } = {}) {
  let sel = (initial || []).map((u) => ({ id: u.id, name: u.name, username: u.username })), t, found = [];
  const draw = () => {
    el.querySelector(".glp-sel").innerHTML = sel.map((u) => `<span class="gl-chip">${esc(u.name)} <button type="button" data-rm="${u.id}" title="Remove">×</button></span>`).join("") || '<span class="muted tiny">nobody</span>';
    el.querySelector(".glp-res").innerHTML = found.filter((u) => !sel.some((s) => s.id === u.id)).slice(0, 8).map((u) => `<button type="button" class="glp-opt" data-add="${u.id}">${esc(u.name)} <span class="muted tiny">@${esc(u.username)}</span></button>`).join("");
  };
  el.innerHTML = `<div class="glp-sel"></div><div class="glp-row"><input class="glp-q" placeholder="Search people…"><button type="button" class="small ghost glp-me">＋ me</button></div><div class="glp-res"></div>`;
  el.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-rm]"); if (rm) { sel = sel.filter((u) => u.id !== +rm.dataset.rm); draw(); return; }
    const add = e.target.closest("[data-add]"); if (add) { const u = found.find((x) => x.id === +add.dataset.add); sel = single ? [u] : [...sel, u]; found = []; el.querySelector(".glp-q").value = ""; draw(); return; }
    if (e.target.closest(".glp-me")) { const me = GL.st.user; if (!sel.some((u) => u.id === me.id)) sel = single ? [me] : [...sel, me]; draw(); }
  });
  el.querySelector(".glp-q").addEventListener("input", (e) => {
    clearTimeout(t); const v = e.target.value.trim(); if (!v) { found = []; draw(); return; }
    t = setTimeout(async () => { try { found = (await glApi(`/projects/${pid}/members/all?query=${enc(v)}&per_page=20`)).data || []; } catch { found = []; } draw(); }, 250);
  });
  draw();
  return { ids: () => sel.map((u) => u.id) };
}
async function glmLabelList(el, pid) {
  try { const l = await glAll(`/projects/${pid}/labels?with_counts=false`, 3); el.innerHTML = l.map((x) => `<option value="${esc(x.name)}">`).join(""); } catch { /* optional */ }
}

// ================= edit / merge / state =================
function glmEdit() {
  const c = GLMS.cur, m = c.mr;
  openModal(`<div class="gl-det" data-gldet="${c.pid}"><h3>✎ Edit !${m.iid}</h3><div class="form glm-form">
      <label>Title <input id="glmT" value="${esc(glmStripDraft(m.title))}"></label>
      <label>Description <textarea id="glmD" rows="9">${esc(m.description || "")}</textarea></label>
      <label>Target branch <input id="glmTb" value="${esc(m.target_branch)}" list="glmBrs"></label><datalist id="glmBrs"></datalist>
      <div class="two"><div><span class="lbl">Assignees</span><div id="glmAs" class="glp"></div></div><div><span class="lbl">Reviewers</span><div id="glmRv" class="glp"></div></div></div>
      <label>Labels <span class="muted tiny">comma separated</span><input id="glmL" value="${esc((m.labels || []).join(", "))}" list="glmLbls"></label><datalist id="glmLbls"></datalist>
      <div class="row-actions"><label class="check tiny"><input id="glmDr" type="checkbox" ${glmIsDraft(m) ? "checked" : ""}> Draft</label>
        <label class="check tiny"><input id="glmRs" type="checkbox" ${m.force_remove_source_branch ? "checked" : ""}> Delete source branch when merged</label>
        <label class="check tiny"><input id="glmSq" type="checkbox" ${m.squash ? "checked" : ""}> Squash commits</label></div></div>
    <div class="foot"><button data-glact="glmback">Cancel</button><button class="primary" id="glmSave">Save changes</button></div></div>`);
  const as = glmPicker($("#glmAs"), c.pid, m.assignees), rv = glmPicker($("#glmRv"), c.pid, m.reviewers);
  glmLabelList($("#glmLbls"), c.pid); glmBranchList($("#glmBrs"), c.pid);
  $("#glmSave").onclick = async () => {
    const title = $("#glmT").value.trim(); if (!title) { toast("Title is required"); return; }
    const body = { title: ($("#glmDr").checked ? "Draft: " : "") + title, description: $("#glmD").value, target_branch: $("#glmTb").value.trim() || m.target_branch,
      assignee_ids: as.ids(), reviewer_ids: rv.ids(), labels: $("#glmL").value.split(",").map((x) => x.trim()).filter(Boolean).join(","),
      remove_source_branch: $("#glmRs").checked, squash: $("#glmSq").checked };
    if (!body.assignee_ids.length) body.assignee_ids = [0];          // GitLab: [0] clears the assignees
    if (!body.reviewer_ids.length) body.reviewer_ids = [0];
    $("#glmSave").disabled = true;
    try { await glApi(`/projects/${c.pid}/merge_requests/${c.iid}`, { method: "PUT", body }); toast("Merge request updated"); glmReload("overview"); }
    catch (e) { toast(e.message); $("#glmSave").disabled = false; }
  };
}
async function glmBranchList(el, pid) {
  try { const r = await glApi(`/projects/${pid}/repository/branches?per_page=100&sort=updated_desc`); el.innerHTML = (r.data || []).map((b) => `<option value="${esc(b.name)}">`).join(""); return r.data || []; } catch { return []; }
}
function glmMergeDlg() {
  const c = GLMS.cur, m = c.mr, ms = m.detailed_merge_status || m.merge_status, pipe = m.head_pipeline?.status;
  const blockers = [];
  if (glmIsDraft(m)) blockers.push("It is a draft — mark it ready first.");
  if (m.has_conflicts) blockers.push("It has merge conflicts.");
  if (c.appr?.approvals_left) blockers.push(`It needs ${c.appr.approvals_left} more approval(s).`);
  if (pipe === "failed") blockers.push("The latest pipeline failed.");
  if (["discussions_not_resolved"].includes(ms)) blockers.push("Some threads are not resolved.");
  const running = ["running", "pending", "created"].includes(pipe);
  openModal(`<div class="gl-det" data-gldet="${c.pid}"><h3>⤵ Merge !${m.iid}</h3>
    <p><span class="gl-br">${esc(m.source_branch)}</span> → <span class="gl-br">${esc(m.target_branch)}</span> in ${esc(glmProj(c.pid)?.path || "")}</p>
    ${blockers.length ? `<div class="warnbox"><b>GitLab will probably refuse:</b><ul>${blockers.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>` : '<p class="st-success tiny">✓ No blockers known to JiraTime. GitLab checks again when you merge.</p>'}
    <div class="form"><label class="check"><input id="glmMsq" type="checkbox" ${m.squash ? "checked" : ""}> Squash commits into one</label>
      <label class="check"><input id="glmMrs" type="checkbox" ${m.force_remove_source_branch ? "checked" : ""}> Delete the source branch after merging</label>
      ${running ? '<label class="check"><input id="glmMwp" type="checkbox" checked> Merge automatically when the running pipeline succeeds</label>' : ""}
      <label>Merge commit message <span class="muted tiny">optional</span><textarea id="glmMm" rows="3" placeholder="Default GitLab message"></textarea></label>
      <label class="check"><input id="glmMok" type="checkbox"> I want to merge this into <b>${esc(m.target_branch)}</b> now</label></div>
    <div class="foot"><button data-glact="glmback">Cancel</button><button class="primary" id="glmMgo" disabled>Merge</button></div></div>`);
  $("#glmMok").onchange = (e) => { $("#glmMgo").disabled = !e.target.checked; };
  $("#glmMgo").onclick = async () => {
    const body = { sha: m.sha, squash: $("#glmMsq").checked, should_remove_source_branch: $("#glmMrs").checked };
    if ($("#glmMwp")?.checked) { body.merge_when_pipeline_succeeds = true; body.auto_merge = true; }
    if ($("#glmMm").value.trim()) body[body.squash ? "squash_commit_message" : "merge_commit_message"] = $("#glmMm").value.trim();
    $("#glmMgo").disabled = true; $("#glmMgo").textContent = "Merging…";
    try {
      const r = (await glApi(`/projects/${c.pid}/merge_requests/${c.iid}/merge`, { method: "PUT", body })).data;
      toast(r?.state === "merged" ? "Merged ✓" : "Will merge when the pipeline succeeds"); glmReload("overview");
    } catch (e) {
      const why = e.status === 405 || e.status === 406 ? "GitLab says it cannot be merged right now (draft, conflicts, approvals, pipeline or branch rules)." : e.status === 409 ? "The branch changed since you opened it — reload and check the new commits." : e.status === 401 || e.status === 403 ? "You are not allowed to merge into this branch." : "";
      $("#glmMgo").textContent = "Merge"; $("#glmMgo").disabled = false; toast(`Merge failed: ${why || e.message}`);
    }
  };
}

// ================= create MR =================
/** Rule-based title and description from the compare result. */
function glmDraftText(source, target, commits, files) {
  const keys = GLD.keys(`${source} ${commits.map((c) => c.title).join(" ")}`);
  const own = commits.filter((c) => !/^Merge (branch|remote-tracking branch|pull request)/i.test(c.title));
  const nice = source.replace(/^(feature|feat|bugfix|fix|hotfix|chore|release)[/-]/i, "").replace(/^[A-Z][A-Z0-9_]+-\d+[-_]?/, "").replace(/[-_]+/g, " ").trim();
  const first = own.length === 1 ? own[0].title.replace(/^\w+(\([^)]*\))?:\s*/, "") : "";
  const kind = /^(bugfix|fix|hotfix)\//i.test(source) ? "fix" : /^feat(ure)?\//i.test(source) ? "feat" : "";
  let title = first || (nice ? nice[0].toUpperCase() + nice.slice(1) : source);
  if (keys[0] && !title.includes(keys[0])) title = `${keys[0]}: ${title}`;
  if (kind && !/^\w+(\(|:)/.test(title) && !keys[0]) title = `${kind}: ${title}`;
  const s = GLD.summary(files, commits);
  const desc = [
    "## What", own.length ? own.slice(0, 15).map((c) => `- ${c.title}`).join("\n") + (own.length > 15 ? `\n- … ${own.length - 15} more commits` : "") : "- ",
    keys.length ? `\n## Jira\n${keys.map((k) => `- ${creds.get()?.base ? `[${k}](${creds.get().base}/browse/${k})` : k}`).join("\n")}` : "",
    `\n## Changes\n${s.files} file(s), +${s.added} / -${s.removed} lines` + (Object.keys(s.cats).length ? "\n" + Object.entries(s.cats).map(([c, l]) => `- ${c}: ${l.length}`).join("\n") : ""),
    s.risks.length ? `\n## Review notes\n${s.risks.map((r) => `- ⚠ ${r}`).join("\n")}` : "",
    "\n## Testing\n- [ ] Tested locally\n- [ ] Unit tests added / updated\n- [ ] No config / migration change needed in other environments",
    `\n_Merging \`${source}\` into \`${target}\`._`,
  ].filter(Boolean).join("\n");
  return { title, desc, summary: s };
}
async function glmCreate(p, { source = "", target = "", note = "" } = {}) {
  if (!p) return toast("Choose a project first");
  const local = window.GLL?.localFor(p), lst = local ? window.GLL.state.st[local.id] : null;
  source = source || (lst && lst.branch !== (lst.defaultBranch || p.branch) ? lst.branch : "");
  target = target || p.branch || "master";
  const st = { p, cmp: null, seq: 0 };
  openModal(`<div class="gl-det gl-wide" data-gldet="${p.id}"><div class="gl-det-head"><div><h3>🔀 New merge request</h3><div class="muted tiny">${esc(p.path)}</div></div></div>
    ${note ? `<div class="warnbox tiny">${esc(note)}</div>` : ""}
    <div class="glm-new"><div class="form glm-form">
      <div class="two"><label>From (source branch) <input id="glnS" value="${esc(source)}" list="glnBrs" placeholder="your branch"></label>
        <label>Into (target branch) <input id="glnT" value="${esc(target)}" list="glnBrs"></label></div><datalist id="glnBrs"></datalist>
      <div id="glnCmp" class="glm-cmp muted tiny">Choose the source branch to compare.</div>
      <label>Title <span class="grow"></span><input id="glnTi" placeholder="Title"></label>
      <label>Description <textarea id="glnDe" rows="11" placeholder="Filled from your commits after the compare — edit freely"></textarea></label>
      <div class="two"><div><span class="lbl">Assignee</span><div id="glnAs" class="glp"></div></div><div><span class="lbl">Reviewers</span><div id="glnRv" class="glp"></div></div></div>
      <label>Labels <span class="muted tiny">comma separated</span><input id="glnL" list="glnLbls"></label><datalist id="glnLbls"></datalist>
      <div class="row-actions"><label class="check tiny"><input id="glnDr" type="checkbox"> Create as draft</label>
        <label class="check tiny"><input id="glnRs" type="checkbox" checked> Delete source branch when merged</label>
        <label class="check tiny"><input id="glnSq" type="checkbox"> Squash commits</label></div></div>
      <div class="glm-prev" id="glnPrev"></div></div>
    <div class="foot"><span id="glnWarn" class="muted tiny"></span><span class="grow"></span><button data-glact="closedet">Cancel</button><button class="primary" id="glnGo" disabled>Create merge request</button></div></div>`);
  const as = glmPicker($("#glnAs"), p.id, [GL.st.user], { single: true }), rv = glmPicker($("#glnRv"), p.id, []);
  glmLabelList($("#glnLbls"), p.id);
  const branches = await glmBranchList($("#glnBrs"), p.id);
  if (!$("#glnS")) return;
  if (!source && branches.length) {
    const mine = branches.find((b) => b.name !== target && (b.commit?.author_email === GL.st.user.email || b.commit?.author_name === GL.st.user.name));
    if (mine) $("#glnS").value = mine.name;
  }
  let edited = false;
  ["#glnTi", "#glnDe"].forEach((s) => $(s).addEventListener("input", () => { edited = true; }));
  const compare = async () => {
    const s = $("#glnS").value.trim(), t = $("#glnT").value.trim(), seq = ++st.seq, box = $("#glnCmp");
    $("#glnGo").disabled = true; $("#glnWarn").textContent = ""; $("#glnPrev").innerHTML = "";
    if (!s || !t) { box.textContent = "Choose both branches."; return; }
    if (s === t) { box.innerHTML = '<span class="st-failed">Source and target are the same branch.</span>'; return; }
    box.innerHTML = '<span class="spin"></span> Comparing…';
    try {
      const [cmp, existing] = await Promise.all([
        glApi(`/projects/${p.id}/repository/compare?from=${enc(t)}&to=${enc(s)}&straight=false`).then((r) => r.data),
        glApi(`/projects/${p.id}/merge_requests?state=opened&source_branch=${enc(s)}&target_branch=${enc(t)}&per_page=5`).then((r) => r.data || []).catch(() => []),
      ]);
      if (seq !== st.seq || !$("#glnCmp")) return;
      const files = GLD.fromApi(cmp.diffs || []), commits = cmp.commits || [];
      st.cmp = { s, t, files, commits };
      if (existing.length) { box.innerHTML = `<div class="warnbox">An open merge request already exists for this branch: <button class="small" data-glact="glmopen:${p.id}|${existing[0].iid}">!${existing[0].iid} ${esc(existing[0].title)}</button></div>`; return; }
      if (!commits.length) { box.innerHTML = `<span class="st-failed">${esc(s)} has no commits that are not already in ${esc(t)}.</span>`; return; }
      const d = glmDraftText(s, t, commits, files);
      box.innerHTML = `<b>${commits.length}</b> commit${commits.length === 1 ? "" : "s"} · <b>${files.length}</b> file${files.length === 1 ? "" : "s"} · <span class="st-success">+${d.summary.added}</span> <span class="st-failed">−${d.summary.removed}</span>${cmp.compare_timeout ? " · GitLab stopped the compare early (very large)" : ""}`;
      if (!edited || !$("#glnTi").value) { $("#glnTi").value = d.title; $("#glnDe").value = d.desc; edited = false; }
      const pv = () => { const el = $("#glnPrev"); if (!el) return; el.innerHTML = GLD.summaryHtml(d.summary, "Smart review") + `<h4>Commits</h4><table class="gl-tbl">${commits.slice(0, 50).map((c) => `<tr><td><code class="sha">${esc(c.short_id)}</code></td><td>${GLD.jira(c.title)}<small class="muted">${esc(c.author_name)} · ${esc(ago(c.created_at))}</small></td></tr>`).join("")}</table>` + GLD.render(files); GLD.wire(el, pv); };
      pv();
      $("#glnGo").disabled = false;
    } catch (e) { if (seq === st.seq && $("#glnCmp")) box.innerHTML = `<span class="st-failed">${esc(e.status === 404 ? "Branch not found on GitLab — push it first." : e.message)}</span>`; }
  };
  let t; ["#glnS", "#glnT"].forEach((s) => $(s).addEventListener("input", () => { clearTimeout(t); t = setTimeout(compare, 500); }));
  compare();
  $("#glnGo").onclick = async () => {
    const c = st.cmp, title = $("#glnTi").value.trim(); if (!c || !title) { toast("Title is required"); return; }
    const body = { source_branch: c.s, target_branch: c.t, title: ($("#glnDr").checked ? "Draft: " : "") + glmStripDraft(title), description: $("#glnDe").value,
      assignee_ids: as.ids(), reviewer_ids: rv.ids(), labels: $("#glnL").value.split(",").map((x) => x.trim()).filter(Boolean).join(","),
      remove_source_branch: $("#glnRs").checked, squash: $("#glnSq").checked };
    $("#glnGo").disabled = true; $("#glnGo").textContent = "Creating…";
    try { const mr = (await glApi(`/projects/${p.id}/merge_requests`, { method: "POST", body })).data; toast(`Created !${mr.iid}`); GLMS.list = null; glmOpen(p.id, mr.iid); }
    catch (e) { toast(e.message); $("#glnGo").disabled = false; $("#glnGo").textContent = "Create merge request"; }
  };
}
/** From a local repository: push first if GitLab does not have the branch / commits yet, then open the create dialog. */
async function glmPrepare(p, source, target, repo) {
  let st = null;
  if (repo) st = await gitApi(`/status?repo=${repo.id}`).catch(() => null);
  if (st && (!st.upstream || st.ahead)) {
    GLMS.prep = { p, source, target, repo };
    openModal(`<h3>🔀 Prepare merge request</h3>
      <p>${!st.upstream ? `The branch <b>${esc(source)}</b> is not on GitLab yet.` : `<b>${st.ahead}</b> commit${st.ahead === 1 ? " is" : "s are"} on this laptop but not on GitLab.`} A merge request only contains what GitLab has.</p>
      ${st.files.length ? `<p class="warnbox tiny">You also have ${st.files.length} uncommitted file(s). They are not part of the merge request until you commit them.</p>` : ""}
      <div class="foot"><button data-glact="closedet">Cancel</button><button data-glact="glmprepgo:0">Continue without pushing</button><button class="primary" data-glact="glmprepgo:1">⬆ Push, then continue</button></div>`);
    return;
  }
  glmCreate(p, { source, target, note: st?.files.length ? `You have ${st.files.length} uncommitted file(s) in ${repo.name}; they are not part of this merge request.` : "" });
}

// ================= actions =================
Object.assign(GL_ACTIONS, {
  newmr: (pid) => glmCreate(glmProj(pid) || (GLMS.scope === "project" ? glmProj(GLMS.pid) : null) || glRanked()[0]?.p),
  mrsc: (s) => { GLMS.scope = s; GLMS.state = "opened"; GLMS.page = 1; GLMS.list = null; glGo("mrs"); },
  glmscope: (s) => { GLMS.scope = s; GLMS.page = 1; GLMS.list = null; glmRenderTab(); },
  glmreload: () => { GLMS.list = null; glmLoadList(); },
  glmpage: (d) => { GLMS.page = Math.max(1, GLMS.page + +d); glmLoadList(); },
  glmopen: (arg) => { const [pid, iid] = arg.split("|"); glmOpen(pid, iid); },
  glmtab: (t) => { GLMS.cur.tab = t; document.querySelectorAll(".glm .gl-sub .gl-tab").forEach((b) => b.classList.toggle("on", b.dataset.glact === "glmtab:" + t)); glmTab(); },
  glmback: () => glmDraw(),
  glmcommit: (sha) => glmShowCommit(sha),
  glmedit: () => glmEdit(),
  glmmerge: () => glmMergeDlg(),
  glmapprove: async () => { const c = GLMS.cur; try { await glApi(`/projects/${c.pid}/merge_requests/${c.iid}/approve`, { method: "POST", body: { sha: c.mr.sha } }); toast("Approved ✔"); glmReload(); } catch (e) { toast(e.message); } },
  glmunapprove: async () => { const c = GLMS.cur; if (!confirm("Revoke your approval?")) return; try { await glApi(`/projects/${c.pid}/merge_requests/${c.iid}/unapprove`, { method: "POST" }); toast("Approval revoked"); glmReload(); } catch (e) { toast(e.message); } },
  glmdraft: async () => { const c = GLMS.cur, m = c.mr, d = glmIsDraft(m); try { await glApi(`/projects/${c.pid}/merge_requests/${c.iid}`, { method: "PUT", body: { title: d ? glmStripDraft(m.title) : "Draft: " + glmStripDraft(m.title) } }); toast(d ? "Marked as ready" : "Marked as draft"); glmReload(); } catch (e) { toast(e.message); } },
  glmstate: async (ev) => { const c = GLMS.cur; if (ev === "close" && !confirm(`Close !${c.iid} without merging?`)) return; try { await glApi(`/projects/${c.pid}/merge_requests/${c.iid}`, { method: "PUT", body: { state_event: ev } }); toast(ev === "close" ? "Closed" : "Reopened"); glmReload(); } catch (e) { toast(e.message); } },
  glmnote: async () => {
    const c = GLMS.cur, ta = $("#glmNote"), body = ta?.value.trim(); if (!body) return;
    ta.disabled = true;
    try { const n = (await glApi(`/projects/${c.pid}/merge_requests/${c.iid}/notes`, { method: "POST", body: { body } })).data; c.notes = [...(c.notes || []), n]; c.mr.user_notes_count = (c.mr.user_notes_count || 0) + 1; glmTab(); toast("Comment posted"); }
    catch (e) { toast(e.message); ta.disabled = false; }
  },
  glmprepgo: async (push) => {
    const { p, source, target, repo } = GLMS.prep || {}; if (!p) return;
    if (push === "1") {
      closeModal(); toast("Pushing…");
      try { await gitApi("/push", { repo: repo.id }); toast("Pushed ✓"); } catch (e) { openModal(`<h3>⚠ Push failed</h3><pre class="gl-out">${esc(e.message)}</pre><div class="foot"><button data-glact="closedet" class="primary">Close</button></div>`); return; }
    }
    glmCreate(p, { source, target });
  },
});

glAddTab({ id: "mrs", icon: "⑂", label: "Merge requests", render: () => glmRenderTab(), refresh: () => {},
  count: () => (typeof GL.counts?.review === "number" && GL.counts.review ? String(GL.counts.review) : "") }, "local");
window.GLM = { open: glmOpen, create: glmCreate, prepare: glmPrepare, draftText: glmDraftText, state: GLMS };
