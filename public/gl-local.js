"use strict";
/* Local repositories: clone, folder picker, repository workspace (changes + diff + commit/push, history with graph,
   branches + compare, stashes, merge-conflict studio). Talks to /api/git/* on the local JiraTime server. */

const GLLS = { repos: null, st: {}, cur: null, sub: "changes", sel: null, selStaged: false, diffFiles: null, logF: { ref: "", all: false, author: "", grep: "", since: "", until: "" },
  commits: [], logMore: false, commit: null, tools: null, cf: null, cfIdx: 0, cfChoice: {}, busy: "", lastDest: localStorage.getItem("jiratime.gl.dest") || "" };
const GLL_TPL_DEF = { branch: ["feature/{KEY}-{desc}", "bugfix/{KEY}-{desc}", "hotfix/{KEY}-{desc}", "release/{date}"],
  commit: ["feat({KEY}): ", "fix({KEY}): ", "refactor: ", "test: ", "chore: ", "docs: "] };
const gllTpl = () => { try { return { ...GLL_TPL_DEF, ...JSON.parse(localStorage.getItem("jiratime.gl.tpl") || "{}") }; } catch { return GLL_TPL_DEF; } };

// ================= data =================
async function gllLoad(force) {
  if (GLLS.repos && !force) return GLLS.repos;
  GLLS.repos = (await gitApi("/repos")).repos || [];
  if (!GLLS.tools) gitApi("/tools").then((t) => { GLLS.tools = t; }).catch(() => {});
  return GLLS.repos;
}
function gllLocalFor(p) {
  if (!GLLS.repos || !p) return null;
  let host = ""; try { host = new URL(GL.st.url).hostname.toLowerCase(); } catch { /* */ }
  return GLLS.repos.find((r) => r.projectId === p.id || (r.remotePath === p.path.toLowerCase() && (!r.remoteHost || r.remoteHost === host))) || null;
}
const gllProject = (repo) => (GL.projects || []).find((p) => p.id === repo.projectId || p.path.toLowerCase() === repo.remotePath) || null;
const gllRepo = () => GLLS.repos?.find((r) => r.id === GLLS.cur) || null;
async function gllStatus(id) { const s = await gitApi(`/status?repo=${id}`); GLLS.st[id] = { ...s, at: Date.now() }; return GLLS.st[id]; }

/** Run a git action with a busy indicator; returns the result or null on error (shown to the user). */
async function gllDo(label, fn, { quiet } = {}) {
  GLLS.busy = label; gllBusy();
  try { const r = await fn(); if (!quiet) toast(`${label} ✓`); return r; }
  catch (e) { gllError(label, e.message); return null; }
  finally { GLLS.busy = ""; gllBusy(); }
}
function gllBusy() { const el = $("#gllBusy"); if (el) el.innerHTML = GLLS.busy ? `<span class="spin"></span> ${esc(GLLS.busy)}…` : ""; }
function gllError(label, msg) {
  openModal(`<h3>⚠ ${esc(label)} failed</h3><pre class="gl-out">${esc(msg)}</pre>
    <p class="muted tiny">Nothing else was changed. Fix the cause and try again.</p><div class="foot"><button data-glact="closedet" class="primary">Close</button></div>`);
}

// ================= folder picker =================
function gllPickFolder(start, { title = "Choose a folder", allowRepo = false, button = "Use this folder" } = {}) {
  return new Promise((resolve) => {
    let cur = null, hidden = false;
    const done = (v) => { closeModal(); resolve(v); };
    const draw = async (p) => {
      try { cur = await gitApi(`/fs?path=${enc(p || "")}${hidden ? "&hidden=1" : ""}`); }
      catch (e) { if (p) return draw(""); $("#modalBox").innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
      const crumbs = cur.path.slice(cur.home.length).split("/").filter(Boolean);
      openModal(`<div class="gll-pick"><h3>📁 ${esc(title)}</h3>
        <div class="gll-crumbs"><button class="small ghost" data-p="${esc(cur.home)}">🏠 home</button>${crumbs.map((c, i) => `<span class="muted">/</span><button class="small ghost" data-p="${esc(cur.home + "/" + crumbs.slice(0, i + 1).join("/"))}">${esc(c)}</button>`).join("")}</div>
        <div class="gll-dirs">${cur.parent ? `<div class="gll-dir" data-p="${esc(cur.parent)}">⬆ ..</div>` : ""}${cur.dirs.map((d) => `<div class="gll-dir" data-p="${esc(cur.path + "/" + d.name)}">${d.repo ? "📦" : "📁"} ${esc(d.name)}${d.repo ? ' <span class="muted tiny">git repo</span>' : ""}</div>`).join("") || '<p class="muted tiny">No sub-folders.</p>'}</div>
        <div class="row-actions"><label class="check tiny"><input id="gllHid" type="checkbox" ${hidden ? "checked" : ""}> show hidden</label><div class="grow"></div>
          <input id="gllNew" placeholder="new folder name" style="width:180px"><button class="small" id="gllMk">＋ Create</button></div>
        <p class="tiny">Selected: <code>${esc(cur.path)}</code>${cur.isRepo ? ' <span class="b new">git repository</span>' : ""}</p>
        <div class="foot"><button id="gllCancel">Cancel</button><button id="gllUse" class="primary" ${!allowRepo && cur.isRepo ? "disabled title=\"This folder is a repository — choose its parent\"" : ""}>${esc(button)}</button></div></div>`);
      const box = $("#modalBox");
      box.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("click", () => draw(el.dataset.p)));
      $("#gllHid").onchange = (e) => { hidden = e.target.checked; draw(cur.path); };
      $("#gllCancel").onclick = () => done(null);
      $("#gllUse").onclick = () => done(cur.path);
      $("#gllMk").onclick = async () => { try { const r = await gitApi("/mkdir", { path: cur.path, name: $("#gllNew").value }); draw(r.path); } catch (e) { toast(e.message); } };
    };
    draw(start);
  });
}

// ================= clone =================
async function gllClone(p) {
  await gllLoad().catch(() => {});
  const ex = gllLocalFor(p);
  if (ex) { toast("Already on this laptop"); return gllOpenRepo(ex.id); }
  let dest = GLLS.lastDest, proto = "https";
  const name = p.path.split("/").pop();
  const draw = () => {
    openModal(`<div class="gll-clone"><h3>⬇ Clone ${esc(p.name)}</h3><p class="muted tiny">${esc(p.path)}</p>
      <div class="form">
        <label>Destination folder <span class="gll-dest"><code id="gllDest">${esc(dest || "(choose a folder)")}</code><button class="small" id="gllBrowse">📁 Browse…</button></span></label>
        <label>Folder name <input id="gllName" value="${esc(name)}"></label>
        <label>Protocol <select id="gllProto"><option value="https" ${proto === "https" ? "selected" : ""}>HTTPS (uses your GitLab token)</option>${p.ssh ? `<option value="ssh" ${proto === "ssh" ? "selected" : ""}>SSH (uses your SSH key)</option>` : ""}</select></label>
      </div>
      <p class="tiny muted">Will create <code id="gllTarget">${esc(dest ? dest + "/" + name : "…")}</code>. The token is given to git only for this clone; it is not saved in the repository.</p>
      <div id="gllProg"></div>
      <div class="foot"><button data-glact="closedet">Cancel</button><button id="gllStart" class="primary" ${dest ? "" : "disabled"}>Start clone</button></div></div>`);
    $("#gllBrowse").onclick = async () => { const d = await gllPickFolder(dest, { title: "Clone into which folder?" }); if (d) dest = d; draw(); };
    $("#gllName").oninput = (e) => { $("#gllTarget").textContent = dest ? dest + "/" + e.target.value : "…"; };
    $("#gllProto").onchange = (e) => { proto = e.target.value; };
    $("#gllStart").onclick = () => gllRunClone(p, dest, $("#gllName").value.trim() || name, proto);
  };
  if (!dest) { try { const t = GLLS.tools || await gitApi("/tools"); GLLS.tools = t; const fs = await gitApi(`/fs?path=${enc(t.home)}`); dest = fs.dirs.find((d) => /^(projects|workspace|code|repos|git)$/i.test(d.name)) ? `${t.home}/${fs.dirs.find((d) => /^(projects|workspace|code|repos|git)$/i.test(d.name)).name}` : t.home; } catch { /* choose */ } }
  draw();
}
async function gllRunClone(p, dest, name, proto) {
  const start = $("#gllStart"); start.disabled = true; start.textContent = "Cloning…";
  localStorage.setItem("jiratime.gl.dest", dest); GLLS.lastDest = dest;
  const prog = (pct, line, cls = "") => { const el = $("#gllProg"); if (el) el.innerHTML = `<div class="gll-bar ${cls}"><div style="width:${pct}%"></div></div><div class="tiny muted gll-line">${esc(line || "")}</div>`; };
  prog(2, "Starting git…");
  let job;
  try { job = await gitApi("/clone", { url: proto === "ssh" ? p.ssh : p.http, dest, name, projectId: p.id }); }
  catch (e) { prog(100, e.message, "bad"); start.disabled = false; start.textContent = "Retry"; return; }
  while (job.id && !["done", "failed"].includes(job.status)) {
    await sleep(600);
    try { job = await gitApi(`/job?id=${job.id}`); } catch (e) { job = { status: "failed", error: e.message }; }
    prog(job.percent || 3, job.progress);
  }
  if (job.status === "failed") { prog(100, job.error, "bad"); start.disabled = false; start.textContent = "Retry"; return; }
  await gllLoad(true);
  const repo = job.repo;
  $("#modalBox").innerHTML = `<h3>✅ ${job.existing ? "Already cloned" : "Cloned"} ${esc(p.name)}</h3><p><code>${esc(repo.path)}</code></p>
    <div class="row-actions">
      <button class="primary-s small" data-glact="openlocal:${p.id}">📂 Open repository</button>
      <button class="small" data-glact="gllopen:${repo.id}|folder">Open folder</button>
      ${GLLS.tools?.code ? `<button class="small" data-glact="gllopen:${repo.id}|code">Open in VS Code</button>` : ""}
      <button class="small" data-glcopy="${esc(repo.path)}">Copy path</button></div>
    <div class="foot"><button data-glact="closedet">Close</button></div>`;
  glRerender();
}

// ================= Local repos tab =================
function gllRenderTab() {
  const body = $("#glBody"); if (!body) return;
  body.innerHTML = `<div class="gll-wrap"><aside class="gll-side card"><div class="gll-side-h"><b>Repositories on this laptop</b><span class="grow"></span>
      <button class="small ghost" title="Refresh" data-glact="gllrefresh">⟳</button></div>
      <div class="gll-side-a"><button class="small primary-s" data-glact="tab:projects" title="Pick a project, then Clone">⬇ Clone from GitLab</button><button class="small" data-glact="glladd">＋ Add folder</button><button class="small" data-glact="gllscan">🔎 Scan</button></div>
      <input id="gllQ" placeholder="Filter repositories…" aria-label="Filter repositories">
      <div id="gllList" class="gll-list"><p class="muted tiny">Loading…</p></div></aside>
    <section class="gll-main" id="gllMain"></section></div>`;
  $("#gllQ").addEventListener("input", gllFillList);
  gllLoad(true).then(() => { gllFillList(); if (!GLLS.cur && GLLS.repos.length) GLLS.cur = GLLS.repos.slice().sort((a, b) => (b.openedAt || "").localeCompare(a.openedAt || ""))[0].id; gllRenderRepo(); })
    .catch((e) => { $("#gllList").innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; });
}
const gllItemInfo = (r) => {
  const s = GLLS.st[r.id];
  if (!s) return esc(r.path.replace(/^\/home\/[^/]+/, "~"));
  if (s.error) return '<span class="st-failed">cannot read (moved or deleted?)</span>';
  return `⎇ ${esc(s.branch)}${s.ahead ? ` <span class="st-processing">↑${s.ahead}</span>` : ""}${s.behind ? ` <span class="st-failed">↓${s.behind}</span>` : ""}${s.files.length ? ` · <span class="st-processing">${s.files.length} changed</span>` : " · clean"}`;
};
/** Draws the repository list, then reads the status of stale entries and updates only their info line. */
function gllFillList() {
  const el = $("#gllList"); if (!el || !GLLS.repos) return;
  const q = ($("#gllQ")?.value || "").toLowerCase();
  const list = GLLS.repos.filter((r) => !q || (r.name + " " + r.path + " " + (r.remotePath || "")).toLowerCase().includes(q)).sort((a, b) => (b.openedAt || "").localeCompare(a.openedAt || "") || a.name.localeCompare(b.name));
  el.innerHTML = list.map((r) => `<div class="gll-item ${r.id === GLLS.cur ? "on" : ""}" data-gllrepo="${r.id}"><div class="gll-in"><span class="gll-ic">${GLLS.st[r.id]?.state ? "⚠" : "📦"}</span><b>${esc(r.name)}</b>${GLLS.st[r.id]?.state ? ` <span class="b bad">${esc(GLLS.st[r.id].state)}</span>` : ""}</div>
      <div class="muted tiny gll-ip">${gllItemInfo(r)}</div></div>`).join("")
    || `<div class="gll-empty"><p>${q ? "No repository matches." : "No repositories yet."}</p>${q ? "" : '<p class="muted tiny">Clone one from <b>Projects</b>, add a folder that is already a git repository, or scan a folder (e.g. ~/projects) to find all of them.</p>'}</div>`;
  const stale = list.filter((r) => !GLLS.st[r.id] || Date.now() - GLLS.st[r.id].at > 60e3).slice(0, 30);
  pool(stale, 3, async (r) => {
    try { await gllStatus(r.id); } catch { GLLS.st[r.id] = { files: [], branch: "?", error: true, at: Date.now() }; }
    const it = document.querySelector(`#gllList [data-gllrepo="${CSS.escape(r.id)}"] .gll-ip`); if (it) it.innerHTML = gllItemInfo(r);
  });
}

// ================= repository workspace =================
const GLL_SUB = [["changes", "Changes"], ["history", "History"], ["branches", "Branches"], ["stash", "Stashes"], ["conflicts", "Conflicts"]];
async function gllRenderRepo() {
  const main = $("#gllMain"); if (!main) return;
  const repo = gllRepo();
  if (!repo) { main.innerHTML = `<div class="card gll-hero"><h3>📦 Your local repositories</h3><p class="muted">Pick a repository on the left, or clone one: open <b>Projects</b>, click a project and press <b>⬇ Clone</b>.</p></div>`; return; }
  repo.openedAt = new Date().toISOString();
  main.innerHTML = `<div class="card"><p class="muted">Reading ${esc(repo.name)}…</p></div>`;
  let st; try { st = await gllStatus(repo.id); } catch (e) { main.innerHTML = `<div class="card"><div class="warnbox">⚠ ${esc(e.message)}</div><button class="small danger" data-glact="gllremove:${repo.id}">Remove from list</button></div>`; return; }
  const p = gllProject(repo), conflicts = st.files.filter((f) => f.conflict).length;
  if (st.state && GLLS.sub !== "conflicts" && conflicts) GLLS.sub = "conflicts";
  main.innerHTML = `<div class="gll-head card">
      <div class="gll-title"><h3>📦 ${esc(repo.name)}</h3><div class="muted tiny"><code>${esc(repo.path)}</code> <button class="small ghost" data-glcopy="${esc(repo.path)}" title="Copy path">⧉</button>${p ? ` · ${glLink(p.web, esc(p.path))}` : repo.remote ? ` · ${esc(repo.remotePath || repo.remote)}` : " · no remote"}</div></div>
      <div class="grow"></div><span id="gllBusy" class="muted tiny"></span>
      <div class="gll-acts">
        <button class="small" data-glact="gllbranchmenu" title="Switch branch">⎇ <b>${esc(st.branch)}</b> ▾</button>
        <button class="small" data-glact="gllfetch" title="git fetch">⟳ Fetch</button>
        <button class="small" data-glact="gllpull" title="git pull">⬇ Pull${st.behind ? ` <span class="gl-tc">${st.behind}</span>` : ""}</button>
        <button class="small ${st.ahead || !st.upstream ? "primary-s" : ""}" data-glact="gllpush" title="git push">⬆ Push${st.ahead ? ` <span class="gl-tc">${st.ahead}</span>` : !st.upstream && !st.detached ? " (new)" : ""}</button>
        ${window.GLM && p ? `<button class="small" data-glact="gllprepmr">🔀 Prepare MR</button>` : ""}
        <button class="small" data-glact="gllopen:${repo.id}|folder" title="Open folder">📂</button>
        ${GLLS.tools?.code ? `<button class="small" data-glact="gllopen:${repo.id}|code" title="Open in VS Code">VS Code</button>` : ""}
        <button class="small ghost" data-glact="gllmore" title="More">⋯</button></div></div>
    ${st.state ? `<div class="warnbox gll-state"><b>${esc(st.state)} in progress</b> — ${conflicts ? `${conflicts} file(s) in conflict. Resolve them in <b>Conflicts</b>.` : "all conflicts resolved."}
      <span class="grow"></span>${conflicts ? "" : `<button class="small primary-s" data-glact="gllcontinue">Continue ${esc(st.state)}</button>`} <button class="small danger" data-glact="gllabort">Abort ${esc(st.state)}</button></div>` : ""}
    <div class="gl-sub">${GLL_SUB.filter(([k]) => k !== "conflicts" || conflicts || st.state).map(([k, l]) => `<button class="gl-tab ${GLLS.sub === k ? "on" : ""}" data-gllsub="${k}">${l}${k === "changes" && st.files.length ? `<span class="gl-tc">${st.files.length}</span>` : k === "stash" && st.stash ? `<span class="gl-tc">${st.stash}</span>` : k === "conflicts" && conflicts ? `<span class="gl-tc bad">${conflicts}</span>` : ""}</button>`).join("")}
      <span class="grow"></span><span class="muted tiny">${st.last ? `last commit ${esc(ago(st.last.at))} · ${esc(st.last.author)}` : "no commits yet"}${st.upstream ? ` · tracking ${esc(st.upstream)}` : st.detached ? " · detached HEAD" : " · not pushed yet"}</span></div>
    <div id="gllSub"></div>`;
  gllFillList();
  ({ changes: gllChanges, history: gllHistory, branches: gllBranches, stash: gllStash, conflicts: gllConflicts }[GLLS.sub] || gllChanges)(st);
}
const gllSt = () => GLLS.st[GLLS.cur];
async function gllReload() { await gllStatus(GLLS.cur).catch(() => {}); return gllRenderRepo(); }

// ---------- Changes ----------
function gllChanges(st) {
  const box = $("#gllSub"); if (!box) return;
  const staged = st.files.filter((f) => f.staged && !f.conflict), unstaged = st.files.filter((f) => (f.unstaged || f.untracked) && !f.conflict);
  if (GLLS.sel && !st.files.some((f) => f.path === GLLS.sel)) GLLS.sel = null;
  if (!GLLS.sel) { const f = unstaged[0] || staged[0]; if (f) { GLLS.sel = f.path; GLLS.selStaged = !unstaged.length; } }
  const item = (f, s) => { const [l, c] = GLD_ST[f.untracked ? "untracked" : f.kind] || GLD_ST.modified;
    return `<div class="gll-f ${GLLS.sel === f.path && GLLS.selStaged === s ? "on" : ""}" data-gllf="${esc(f.path)}" data-staged="${s ? 1 : 0}"><span class="b ${c}">${l}</span><span class="gll-fp" title="${esc(f.path)}">${esc(f.path.split("/").pop())}<small class="muted">${esc(f.path.split("/").slice(0, -1).join("/"))}</small></span>
      <span class="gll-fa">${s ? `<button class="small ghost" data-gllx="unstage" title="Unstage">−</button>` : `<button class="small ghost" data-gllx="discard" title="Discard changes">↺</button><button class="small ghost" data-gllx="stage" title="Stage">＋</button>`}</span></div>`; };
  const tpl = gllTpl(), key = (st.branch.match(/[A-Z][A-Z0-9_]+-\d+/) || [""])[0];
  box.innerHTML = `<div class="gll-split"><div class="gll-files card">
      ${!st.files.length ? `<div class="gll-clean">✓ Working tree clean<p class="muted tiny">${st.ahead ? `${st.ahead} commit(s) not pushed yet — press ⬆ Push.` : "Nothing to commit."}</p></div>` : ""}
      ${staged.length ? `<div class="gll-fg"><span>Staged <span class="muted">${staged.length}</span></span><button class="small ghost" data-glact="gllunstageall">Unstage all</button></div>${staged.map((f) => item(f, true)).join("")}` : ""}
      ${unstaged.length ? `<div class="gll-fg"><span>Changes <span class="muted">${unstaged.length}</span></span><button class="small ghost" data-glact="gllstageall">Stage all</button></div>${unstaged.map((f) => item(f, false)).join("")}` : ""}
      <div class="gll-commit">
        <div class="row-actions" style="margin:0 0 6px"><select id="gllCt" aria-label="Commit template"><option value="">Template…</option>${tpl.commit.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
          <button class="small" data-glact="gllsuggest" title="Suggest a message from the staged files (rule-based)">✨ Suggest</button></div>
        <textarea id="gllMsg" rows="3" placeholder="Commit message${key ? ` (e.g. ${key}: what changed)` : ""}">${esc(GLLS.msg || "")}</textarea>
        <label class="check tiny"><input id="gllAmend" type="checkbox"> Amend last commit</label>
        <div class="two"><button class="primary" data-glact="gllcommit" ${staged.length ? "" : "disabled"}>Commit ${staged.length ? `${staged.length} file${staged.length === 1 ? "" : "s"}` : ""}</button>
          <button class="primary alt" data-glact="gllcommitpush" ${staged.length ? "" : "disabled"}>Commit &amp; Push</button></div>
      </div></div>
    <div class="gll-diff card" id="gllDiff">${GLLS.sel ? '<p class="muted">Loading diff…</p>' : '<p class="muted">Select a file to see its changes.</p>'}</div></div>`;
  $("#gllMsg").addEventListener("input", (e) => { GLLS.msg = e.target.value; });
  $("#gllCt").onchange = (e) => { if (!e.target.value) return; const t = e.target.value.replace("{KEY}", key || "KEY"); $("#gllMsg").value = t + ($("#gllMsg").value.replace(/^\w+(\([^)]*\))?: /, "")); GLLS.msg = $("#gllMsg").value; e.target.value = ""; $("#gllMsg").focus(); };
  if (GLLS.sel) gllShowDiff();
}
async function gllShowDiff() {
  const box = $("#gllDiff"), st = gllSt(); if (!box || !st) return;
  const f = st.files.find((x) => x.path === GLLS.sel); if (!f) return;
  try {
    const r = await gitApi(`/diff?repo=${GLLS.cur}&path=${enc(f.path)}${GLLS.selStaged ? "&staged=1" : ""}${f.untracked ? "&untracked=1" : ""}`);
    const files = GLD.parse(r.diff); GLLS.diffFiles = files;
    if (!files.length) { box.innerHTML = `<p class="muted">${esc(r.note || (f.kind === "deleted" ? "File deleted" : "No textual changes (mode / binary)"))}</p>`; return; }
    const hunkActs = (i, j) => f.untracked ? "" : GLLS.selStaged ? `<button class="small" data-gllh="${j}" data-mode="unstage">− Unstage hunk</button>`
      : `<button class="small" data-gllh="${j}" data-mode="discard" title="Discard this hunk (a backup is kept)">↺ Discard</button><button class="small primary-s" data-gllh="${j}" data-mode="stage">＋ Stage hunk</button>`;
    const draw = () => { box.innerHTML = GLD.render(files, { single: true, hunkActions: hunkActs }) + (r.note ? `<p class="muted tiny">${esc(r.note)}</p>` : ""); GLD.wire(box, draw); };
    draw();
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}
async function gllFileAct(act, file, staged) {
  if (act === "discard" && !confirm(`Discard all changes in ${file}?\n\nA backup copy is saved in ~/.config/jiratime/backups first.`)) return;
  const r = await gllDo(act === "stage" ? "Stage" : act === "unstage" ? "Unstage" : "Discard", () => gitApi(`/${act}`, { repo: GLLS.cur, paths: [file] }), { quiet: act !== "discard" });
  if (r) { if (r.backup) toast(`Discarded — backup in ${r.backup}`); GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; if (act !== "discard") { GLLS.sel = file; GLLS.selStaged = act === "stage"; } gllRenderRepo(); }
  void staged;
}
async function gllHunkAct(j, mode) {
  const f = GLLS.diffFiles?.[0]; if (!f) return;
  if (mode === "discard" && !confirm("Discard this hunk? A backup copy of the file is saved first.")) return;
  const r = await gllDo(mode === "stage" ? "Stage hunk" : mode === "unstage" ? "Unstage hunk" : "Discard hunk", () => gitApi("/apply", { repo: GLLS.cur, mode, patch: GLD.hunkPatch(f, f.hunks[j]) }), { quiet: true });
  if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); }
}
/** Rule-based commit message from the staged files and the branch name. */
async function gllSuggest() {
  const st = gllSt(), staged = st.files.filter((f) => f.staged);
  if (!staged.length) return toast("Stage some files first");
  const key = (st.branch.match(/[A-Z][A-Z0-9_]+-\d+/) || [""])[0];
  const cats = {}; staged.forEach((f) => { const c = GLD.category(f.path); (cats[c] ||= []).push(f); });
  const type = /^(bugfix|fix|hotfix)\//.test(st.branch) ? "fix" : cats.Tests && Object.keys(cats).length === 1 ? "test" : cats.Docs && Object.keys(cats).length === 1 ? "docs" : (cats["Build / CI / infra"] || cats.Dependencies) && !cats.Code ? "chore" : /^feature\//.test(st.branch) ? "feat" : "chore";
  const dirs = [...new Set(staged.map((f) => f.path.split("/").slice(0, -1).pop() || f.path.split("/")[0]))];
  const what = staged.length === 1 ? `${staged[0].kind === "added" ? "add" : staged[0].kind === "deleted" ? "remove" : "update"} ${staged[0].path.split("/").pop()}` : `update ${staged.length} files in ${dirs.slice(0, 2).join(", ")}${dirs.length > 2 ? "…" : ""}`;
  const body = staged.length > 1 ? "\n\n" + Object.entries(cats).map(([c, l]) => `- ${c}: ${l.map((f) => f.path.split("/").pop()).slice(0, 6).join(", ")}${l.length > 6 ? "…" : ""}`).join("\n") : "";
  $("#gllMsg").value = `${type}${key ? `(${key})` : ""}: ${what}${body}`; GLLS.msg = $("#gllMsg").value;
  toast("Suggested from your staged files — edit it as you like");
}
async function gllCommit(push) {
  const msg = $("#gllMsg").value.trim(), amend = $("#gllAmend").checked;
  if (!msg) { toast("Write a commit message"); $("#gllMsg").focus(); return; }
  if (amend && !confirm("Amend the last commit? Only do this if it was not pushed yet.")) return;
  const r = await gllDo("Commit", () => gitApi("/commit", { repo: GLLS.cur, message: msg, amend }));
  if (!r) return;
  GLLS.msg = ""; GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() };
  if (push) await gllPush(); else gllRenderRepo();
}
async function gllPush() {
  const st = gllSt();
  if (!st.upstream && !confirm(`Push the new branch "${st.branch}" to GitLab?`)) return;
  const r = await gllDo("Push", () => gitApi("/push", { repo: GLLS.cur }));
  if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; gllRenderRepo(); gllAfterPush(); }
}
function gllAfterPush() {
  const repo = gllRepo(), p = gllProject(repo), st = gllSt();
  if (!p || !window.GLM || !st || st.branch === (st.defaultBranch || p.branch)) return;
  openModal(`<h3>⬆ Pushed ${esc(st.branch)}</h3><p>Open a merge request for this branch?</p>
    <div class="foot"><button data-glact="closedet">Not now</button><button class="primary" data-glact="gllprepmr">🔀 Prepare merge request</button></div>`);
}

// ---------- History (graph) ----------
function gllGraph(commits) {
  // lanes: each lane waits for one commit hash
  let lanes = []; const rows = [];
  for (const c of commits) {
    let lane = lanes.indexOf(c.sha); const before = lanes.slice();
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; lanes[lane] = c.sha; }
    lanes = lanes.map((x, i) => (x === c.sha && i !== lane ? null : x));
    const [p1, ...others] = c.parents; lanes[lane] = p1 || null;
    for (const p of others) if (!lanes.includes(p)) { const free = lanes.indexOf(null); if (free >= 0 && free !== lane) lanes[free] = p; else lanes.push(p); }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ lane, before, after: lanes.slice(), merge: others.length > 0 });
  }
  return rows;
}
const GLL_COLORS = ["#6366f1", "#16a34a", "#f97316", "#e11d48", "#0ea5e9", "#a855f7", "#eab308", "#14b8a6"];
function gllGraphSvg(r, h = 30) {
  const W = 14, x = (i) => 8 + i * W, mid = h / 2, n = Math.max(r.before.length, r.after.length, r.lane + 1);
  let s = "";
  r.before.forEach((sha, i) => { if (sha) s += `<line x1="${x(i)}" y1="0" x2="${x(i === r.lane || sha === r.before[r.lane] ? r.lane : i)}" y2="${mid}" stroke="${GLL_COLORS[i % 8]}" stroke-width="2"/>`; });
  r.after.forEach((sha, i) => { if (sha) { const from = r.before.indexOf(sha) >= 0 && r.before.indexOf(sha) !== r.lane ? r.before.indexOf(sha) : r.lane; s += `<line x1="${x(i === from ? i : r.lane)}" y1="${mid}" x2="${x(i)}" y2="${h}" stroke="${GLL_COLORS[i % 8]}" stroke-width="2"/>`; } });
  s += `<circle cx="${x(r.lane)}" cy="${mid}" r="${r.merge ? 4 : 5}" fill="${r.merge ? "var(--bg2)" : GLL_COLORS[r.lane % 8]}" stroke="${GLL_COLORS[r.lane % 8]}" stroke-width="2"/>`;
  return `<svg width="${8 + n * W}" height="${h}" class="gll-g">${s}</svg>`;
}
async function gllHistory(st, append) {
  const box = $("#gllSub"); if (!box) return;
  const f = GLLS.logF;
  if (!append) {
    box.innerHTML = `<div class="row-actions gll-logf">
        <input id="gllLg" placeholder="Search messages (e.g. FUL2-123)" value="${esc(f.grep)}"><input id="gllLa" placeholder="Author" value="${esc(f.author)}" style="width:140px">
        <label class="tiny muted">since <input id="gllLs" type="date" value="${esc(f.since)}"></label><label class="tiny muted">until <input id="gllLu" type="date" value="${esc(f.until)}"></label>
        <label class="check tiny"><input id="gllLall" type="checkbox" ${f.all ? "checked" : ""}> all branches</label><button class="small" data-glact="glllog">Apply</button></div>
      <div class="gll-split"><div class="card gll-log" id="gllLog"><p class="muted">Loading history…</p></div><div class="card gll-diff" id="gllCommit"><p class="muted">Select a commit.</p></div></div>`;
    GLLS.commits = [];
  }
  try {
    const q = new URLSearchParams({ repo: GLLS.cur, n: "150", skip: String(GLLS.commits.length) });
    if (f.all) q.set("all", "1"); if (f.author) q.set("author", f.author); if (f.grep) q.set("grep", f.grep); if (f.since) q.set("since", f.since); if (f.until) q.set("until", f.until);
    const r = await gitApi(`/log?${q}`);
    GLLS.commits.push(...r.commits); GLLS.logMore = r.commits.length === 150;
    const rows = gllGraph(GLLS.commits);
    $("#gllLog").innerHTML = (GLLS.commits.map((c, i) => `<div class="gll-c ${GLLS.commit === c.sha ? "on" : ""}" data-gllc="${c.sha}">${gllGraphSvg(rows[i])}
        <div class="gll-ct" title="${esc(c.title)}"><div class="gll-cm">${c.refs ? c.refs.split(", ").filter(Boolean).map((x) => `<span class="gll-ref ${/HEAD ->/.test(x) ? "head" : /tag:/.test(x) ? "tag" : /origin\//.test(x) ? "remote" : ""}">${esc(x.replace("HEAD -> ", "★ ").replace("tag: ", "🏷 "))}</span>`).join("") : ""}${GLD.jira(c.title)}</div>
        <div class="muted tiny">${esc(c.author)} · ${esc(ago(c.at))} · <code>${c.sha.slice(0, 8)}</code></div></div></div>`).join("") || '<p class="muted">No commits match.</p>') +
      (GLLS.logMore ? '<button class="small" data-glact="glllogmore">Load older commits</button>' : "");
    if (!GLLS.commit && GLLS.commits[0]) gllShowCommit(GLLS.commits[0].sha);
    else if (GLLS.commit) gllShowCommit(GLLS.commit);
  } catch (e) { $("#gllLog").innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}
async function gllShowCommit(sha) {
  GLLS.commit = sha;
  document.querySelectorAll("[data-gllc]").forEach((el) => el.classList.toggle("on", el.dataset.gllc === sha));
  const box = $("#gllCommit"); if (!box) return;
  box.innerHTML = '<p class="muted">Loading commit…</p>';
  try {
    const c = await gitApi(`/show?repo=${GLLS.cur}&sha=${sha}`), files = GLD.parse(c.diff), p = gllProject(gllRepo());
    const draw = () => {
      box.innerHTML = `<div class="gll-ch"><b>${GLD.jira(c.message.split("\n")[0])}</b><div class="muted tiny">${esc(c.author)} &lt;${esc(c.email)}&gt; · ${esc(fmtDateTime(c.at))} · <code>${c.sha.slice(0, 10)}</code> <button class="small ghost" data-glcopy="${c.sha}">⧉</button>${c.parents.length > 1 ? ' · <span class="b skip">merge</span>' : ""}</div>
        ${c.message.includes("\n") ? `<pre class="gl-msg">${GLD.jira(c.message.split("\n").slice(1).join("\n").trim())}</pre>` : ""}
        <div class="row-actions" style="margin:8px 0">${p ? glLink(`${p.web}/-/commit/${c.sha}`, "Open in GitLab ↗", "small gl-ext") : ""}
          <button class="small" data-glact="gllrevert:${c.sha}">↶ Revert</button><button class="small" data-glact="glltag:${c.sha}">🏷 Tag</button>
          <button class="small" data-glact="gllbranchat:${c.sha}">⎇ Branch here</button><button class="small danger" data-glact="gllreset:${c.sha}">Reset to here…</button></div></div>
        ${GLD.summaryHtml(GLD.summary(files, [{ title: c.message, author: c.author }]))}${GLD.render(files)}${c.note ? `<p class="muted tiny">${esc(c.note)}</p>` : ""}`;
      GLD.wire(box, draw);
    };
    draw();
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

// ---------- Branches ----------
async function gllBranches(st) {
  const box = $("#gllSub"); if (!box) return;
  box.innerHTML = '<div class="card"><p class="muted">Loading branches…</p></div>';
  let r; try { r = await gitApi(`/branches?repo=${GLLS.cur}`); } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const local = r.branches.filter((b) => !b.remote), remote = r.branches.filter((b) => b.remote && !local.some((l) => l.upstream === b.name));
  const tpl = gllTpl();
  box.innerHTML = `<div class="card"><div class="row-actions"><h4 style="margin:0">Local branches</h4><span class="grow"></span>
      <select id="gllBt" aria-label="Branch template"><option value="">Template…</option>${tpl.branch.map((t) => `<option>${esc(t)}</option>`).join("")}</select>
      <input id="gllBn" placeholder="new-branch-name" style="width:240px"><select id="gllBf" aria-label="From">${[st.branch, r.defaultBranch, ...local.map((b) => b.name)].filter((v, i, a) => v && a.indexOf(v) === i).map((b) => `<option>${esc(b)}</option>`).join("")}${r.defaultBranch ? `<option>origin/${esc(r.defaultBranch)}</option>` : ""}</select>
      <button class="small primary-s" data-glact="gllnewbranch">＋ Create &amp; switch</button></div>
    <table class="gl-tbl gll-bt"><tr><th></th><th>Branch</th><th>Tracking</th><th>Last commit</th><th></th></tr>${local.map((b) => `<tr class="${b.current ? "cur" : ""}"><td>${b.current ? "★" : ""}</td>
      <td><b>${esc(b.name)}</b>${b.name === r.defaultBranch ? ' <span class="b new">default</span>' : ""}</td>
      <td class="tiny">${b.upstream ? `${esc(b.upstream)} ${b.ahead ? `<span class="st-processing">↑${b.ahead}</span>` : ""} ${b.behind ? `<span class="st-failed">↓${b.behind}</span>` : ""}${b.gone ? ' <span class="b bad">gone</span>' : ""}` : '<span class="muted">not pushed</span>'}</td>
      <td class="tiny">${GLD.jira(b.subject.slice(0, 70))}<small class="muted">${esc(b.author)} · ${esc(ago(b.date))}</small></td>
      <td class="nowrap">${b.current ? "" : `<button class="small" data-glact="gllcheckout:${esc(b.name)}">Switch</button>
        <button class="small ghost" data-glact="gllcompare:${esc(b.name)}" title="Compare with ${esc(st.branch)}">⇄</button>
        <button class="small ghost" data-glact="gllmergein:${esc(b.name)}" title="Merge into ${esc(st.branch)}">⤵ merge</button>
        <button class="small ghost" data-glact="gllrebaseon:${esc(b.name)}" title="Rebase ${esc(st.branch)} onto this">rebase</button>
        <button class="small ghost" data-glact="gllrename:${esc(b.name)}" title="Rename">✎</button>
        <button class="small ghost danger" data-glact="glldelbranch:${esc(b.name)}" title="Delete local branch">🗑</button>`}</td></tr>`).join("")}</table></div>
    <div class="card" style="margin-top:12px"><h4 style="margin:0 0 8px">Remote branches <span class="muted tiny">${remote.length} not checked out · use Fetch to refresh</span></h4>
      <input id="gllRq" placeholder="Filter remote branches…" style="width:100%;margin-bottom:8px">
      <table class="gl-tbl" id="gllRt">${remote.slice(0, 400).map((b) => `<tr data-name="${esc(b.name.toLowerCase())}"><td><b>${esc(b.name)}</b></td><td class="tiny">${GLD.jira(b.subject.slice(0, 70))}<small class="muted">${esc(b.author)} · ${esc(ago(b.date))}</small></td>
        <td class="nowrap"><button class="small" data-glact="gllcheckoutr:${esc(b.name)}">Check out</button><button class="small ghost" data-glact="gllcompare:${esc(b.name)}">⇄</button><button class="small ghost danger" data-glact="glldelremote:${esc(b.name)}" title="Delete on GitLab">🗑</button></td></tr>`).join("") || '<tr><td class="muted">None.</td></tr>'}</table></div>
    <div id="gllCmp"></div>`;
  $("#gllBt").onchange = (e) => { const key = (st.branch.match(/[A-Z][A-Z0-9_]+-\d+/) || ["KEY-1"])[0]; $("#gllBn").value = e.target.value.replace("{KEY}", key).replace("{desc}", "short-description").replace("{date}", todayStr().replace(/-/g, "")); e.target.value = ""; $("#gllBn").focus(); $("#gllBn").select(); };
  $("#gllRq").oninput = (e) => { const v = e.target.value.toLowerCase(); document.querySelectorAll("#gllRt tr").forEach((tr) => { tr.style.display = !v || tr.dataset.name?.includes(v) ? "" : "none"; }); };
}
async function gllCompare(other) {
  const st = gllSt(), box = $("#gllCmp") || $("#gllSub"); box.innerHTML = '<div class="card"><p class="muted">Comparing…</p></div>'; box.scrollIntoView({ behavior: "smooth" });
  try {
    const c = await gitApi(`/compare?repo=${GLLS.cur}&a=${enc(st.branch)}&b=${enc(other)}`);
    box.innerHTML = `<div class="card gll-cmp"><h4 style="margin:0">⇄ ${esc(st.branch)} ← ${esc(other)}</h4>
      <div class="stats gl-stats" style="margin-top:10px"><div class="stat"><b>${c.ahead}</b><span>commits only in ${esc(other)}</span></div><div class="stat"><b>${c.behind}</b><span>commits only in ${esc(st.branch)}</span></div>
        <div class="stat"><b>${c.files}</b><span>files changed</span></div><div class="stat"><b><span class="st-success">+${c.added}</span> <span class="st-failed">−${c.removed}</span></b><span>lines</span></div></div>
      ${c.conflicts.length ? `<div class="warnbox">⚠ Merging would conflict in: ${c.conflicts.map((x) => `<code>${esc(x)}</code>`).join(" ")}</div>` : '<p class="tiny st-success">✓ No conflicts expected when merging.</p>'}
      <table class="gl-tbl">${c.changes.slice(0, 200).map((x) => `<tr><td><span class="b ${x.status === "A" ? "new" : x.status === "D" ? "bad" : x.status === "R" ? "diff" : "skip"}">${esc(x.status)}</span></td><td>${esc(x.path)}${x.from ? ` <span class="muted tiny">from ${esc(x.from)}</span>` : ""}</td></tr>`).join("")}</table>
      <h4>Commits in ${esc(other)} not in ${esc(st.branch)}</h4><table class="gl-tbl">${c.commits.map((x) => `<tr><td><code class="sha">${x.sha.slice(0, 8)}</code></td><td>${GLD.jira(x.title)}<small class="muted">${esc(x.author)} · ${esc(ago(x.at))}</small></td></tr>`).join("") || '<tr><td class="muted">None.</td></tr>'}</table>
      <div class="row-actions" style="margin-top:10px"><button class="small primary-s" data-glact="gllmergein:${esc(other)}">⤵ Merge ${esc(other)} into ${esc(st.branch)}</button></div></div>`;
  } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

// ---------- Stashes ----------
async function gllStash() {
  const box = $("#gllSub"); if (!box) return;
  let r; try { r = await gitApi(`/stash?repo=${GLLS.cur}`); } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  box.innerHTML = `<div class="card"><div class="row-actions"><input id="gllSm" placeholder="Stash message (optional)" style="flex:1"><button class="small primary-s" data-glact="gllstashpush">Stash my changes</button></div>
    <table class="gl-tbl">${r.stashes.map((s) => `<tr><td><code>${esc(s.ref)}</code></td><td>${esc(s.msg)}<small class="muted">${esc(ago(s.at))}</small></td>
      <td class="nowrap"><button class="small" data-glact="gllstash:apply|${esc(s.ref)}">Apply</button><button class="small" data-glact="gllstash:pop|${esc(s.ref)}">Pop</button><button class="small ghost danger" data-glact="gllstash:drop|${esc(s.ref)}">Drop</button></td></tr>`).join("") || '<tr><td class="muted">No stashes. Stashing saves your uncommitted changes (including new files) and cleans the working tree.</td></tr>'}</table></div>`;
}

// ---------- Conflict studio ----------
/** Split a file with conflict markers into text and conflict blocks. */
function gllParseConflicts(text) {
  const out = [], lines = String(text).split("\n"); let buf = [], c = null, part = "";
  for (const l of lines) {
    if (!c && /^<{7}( |$)/.test(l)) { if (buf.length) out.push({ t: "text", lines: buf }); buf = []; c = { t: "conflict", oursLabel: l.slice(8).trim(), ours: [], base: [], theirs: [], theirsLabel: "" }; part = "ours"; continue; }
    if (c && /^\|{7}( |$)/.test(l)) { part = "base"; continue; }
    if (c && /^={7}$/.test(l)) { part = "theirs"; continue; }
    if (c && /^>{7}( |$)/.test(l)) { c.theirsLabel = l.slice(8).trim(); out.push(c); c = null; continue; }
    if (c) c[part].push(l); else buf.push(l);
  }
  if (c) { buf = [...buf, `<<<<<<< ${c.oursLabel}`, ...c.ours, "=======", ...c.theirs]; }
  if (buf.length) out.push({ t: "text", lines: buf });
  return out;
}
function gllJoin(blocks, choice) {
  const out = []; let k = 0;
  for (const b of blocks) {
    if (b.t === "text") { out.push(...b.lines); continue; }
    const ch = choice[k++];
    if (!ch) out.push(`<<<<<<< ${b.oursLabel}`, ...b.ours, "=======", ...b.theirs, `>>>>>>> ${b.theirsLabel}`);
    else if (ch.take === "ours") out.push(...b.ours); else if (ch.take === "theirs") out.push(...b.theirs);
    else if (ch.take === "both") out.push(...b.ours, ...b.theirs); else if (ch.take === "edit") out.push(...String(ch.text).split("\n"));
  }
  return out.join("\n");
}
async function gllConflicts(st) {
  const box = $("#gllSub"); if (!box) return;
  try { GLLS.cf = await gitApi(`/conflicts?repo=${GLLS.cur}`); } catch (e) { box.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const cf = GLLS.cf;
  if (!cf.files.length) { box.innerHTML = `<div class="card gll-hero"><h3>✓ No files in conflict</h3><p class="muted">${st.state ? `Press <b>Continue ${esc(st.state)}</b> above to finish, or Abort.` : "Nothing to resolve."}</p></div>`; return; }
  if (GLLS.cfIdx >= cf.files.length) GLLS.cfIdx = 0;
  const f = cf.files[GLLS.cfIdx], blocks = f.work == null ? [] : gllParseConflicts(f.work), confs = blocks.filter((b) => b.t === "conflict");
  const ch = (GLLS.cfChoice[f.path] ||= {}), lang = GLD.lang(f.path), rebase = cf.state === "rebase";
  const curL = rebase ? "Current (the branch you rebase onto)" : "Current (your branch)", incL = rebase ? "Incoming (your commit being replayed)" : "Incoming (the branch you merge in)";
  const code = (lines) => `<pre class="gll-code">${lines.map((l) => GLD.hl(l, lang)).join("\n") || '<span class="muted">(empty)</span>'}</pre>`;
  const explain = (b) => { const o = b.ours.length, t = b.theirs.length; return !o ? "Only the incoming side has lines here." : !t ? "Only the current side has lines here — the other side removed them." : `Both sides changed the same lines (${o} vs ${t}).`; };
  box.innerHTML = `<div class="gll-cfwrap"><aside class="card gll-cfl"><b>${cf.files.length} file${cf.files.length === 1 ? "" : "s"} in conflict</b>
      ${cf.files.map((x, i) => `<div class="gll-f ${i === GLLS.cfIdx ? "on" : ""}" data-gllcf="${i}"><span class="b bad">!</span><span class="gll-fp">${esc(x.path)}</span></div>`).join("")}
      <p class="muted tiny" style="margin-top:10px">${rebase ? "During a rebase “current” is the branch you rebase onto and “incoming” is your own commit." : "“Current” is your branch, “incoming” the branch being merged."}</p></aside>
    <div class="card gll-cfm"><div class="row-actions"><h4 style="margin:0">${esc(f.path)}</h4><span class="grow"></span>
      <button class="small" data-glact="gllcftake:ours">Use whole current file</button><button class="small" data-glact="gllcftake:theirs">Use whole incoming file</button></div>
      ${f.tooBig ? '<div class="warnbox">File too large to edit here — open it in VS Code.</div>' : !confs.length ? '<div class="warnbox">No conflict markers found in this file (binary file, or deleted on one side). Choose a whole file above.</div>' :
        confs.map((b, k) => `<div class="gll-cb ${ch[k] ? "done" : ""}"><div class="gll-cbh"><b>Conflict ${k + 1} of ${confs.length}</b> <span class="muted tiny">${esc(explain(b))}</span><span class="grow"></span>${ch[k] ? `<span class="b new">${esc(ch[k].take)}</span>` : '<span class="b bad">unresolved</span>'}</div>
          <div class="gll-cbs"><div><div class="gll-cbl cur">${esc(curL)} <span class="muted tiny">${esc(b.oursLabel)}</span></div>${code(b.ours)}</div>
            ${b.base.length ? `<div><div class="gll-cbl base">Common base</div>${code(b.base)}</div>` : ""}
            <div><div class="gll-cbl inc">${esc(incL)} <span class="muted tiny">${esc(b.theirsLabel)}</span></div>${code(b.theirs)}</div></div>
          <div class="row-actions gll-cba"><button class="small" data-gllcb="${k}" data-take="ours">Accept current</button><button class="small" data-gllcb="${k}" data-take="theirs">Accept incoming</button>
            <button class="small" data-gllcb="${k}" data-take="both">Accept both</button><button class="small" data-gllcb="${k}" data-take="edit">✎ Edit manually</button></div>
          ${ch[k]?.take === "edit" ? `<textarea class="gll-cbe" data-gllce="${k}" rows="${Math.min(16, Math.max(4, String(ch[k].text).split("\n").length + 1))}">${esc(ch[k].text)}</textarea>` : ""}</div>`).join("")}
      ${confs.length ? `<details class="gll-prev"><summary>Preview the result</summary>${code(gllJoin(blocks, Object.values(confs.map((_, k) => ch[k]))).split("\n"))}</details>` : ""}
      <div class="foot"><span class="muted tiny">${confs.length ? `${Object.keys(ch).length} of ${confs.length} resolved` : ""}</span><span class="grow"></span>
        <button class="primary" data-glact="gllcfsave" ${confs.length && Object.keys(ch).length === confs.length ? "" : "disabled"}>✓ Mark resolved</button></div></div></div>`;
}

// ================= actions =================
Object.assign(GL_ACTIONS, {
  clone: (pid) => { const p = GL.projects.find((x) => x.id === +pid); if (p) gllClone(p); },
  openlocal: async (pid) => { await gllLoad(); const r = gllLocalFor(GL.projects.find((x) => x.id === +pid)); if (r) gllOpenRepo(r.id); },
  gllopen: (arg) => { const [id, what] = arg.split("|"); gllDo(what === "code" ? "Open in VS Code" : "Open folder", () => gitApi("/open", { repo: id, what }), { quiet: true }); },
  gllrefresh: () => { GLLS.st = {}; gllRenderTab(); },
  glladd: async () => { const d = await gllPickFolder(GLLS.lastDest, { title: "Choose a folder that is a git repository", allowRepo: true, button: "Add this repository" }); if (!d) return; const r = await gllDo("Add repository", () => gitApi("/repos/add", { path: d })); if (r) { await gllLoad(true); gllOpenRepo(r.repo.id); } },
  gllscan: async () => { const d = await gllPickFolder(GLLS.lastDest, { title: "Find git repositories inside…", allowRepo: true, button: "Scan this folder" }); if (!d) return; const r = await gllDo("Scan", () => gitApi("/scan", { root: d }), { quiet: true }); if (r) { toast(`Found ${r.added.length} repositor${r.added.length === 1 ? "y" : "ies"}`); GLLS.repos = r.repos; gllRenderTab(); } },
  gllremove: async (id) => { if (!confirm("Remove this repository from JiraTime? The folder is NOT deleted.")) return; await gitApi("/repos/remove", { repo: id }); GLLS.cur = null; await gllLoad(true); gllRenderTab(); },
  gllfetch: async () => { const r = await gllDo("Fetch", () => gitApi("/fetch", { repo: GLLS.cur })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; gllRenderRepo(); } },
  gllpull: () => {
    const st = gllSt();
    if (st.files.some((f) => !f.untracked) && !confirm("You have uncommitted changes. Pull anyway? (Git stops if they would be overwritten; stash or commit first to be safe.)")) return;
    openModal(`<h3>⬇ Pull ${esc(st.branch)}</h3><p class="muted tiny">How should GitLab's new commits be combined with yours?</p>
      <div class="gll-opts"><button class="primary-s small" data-glact="gllpullgo:ff">Fast-forward only (safest)</button><button class="small" data-glact="gllpullgo:merge">Merge</button><button class="small" data-glact="gllpullgo:rebase">Rebase my commits on top</button></div>
      <div class="foot"><button data-glact="closedet">Cancel</button></div>`);
  },
  gllpullgo: async (mode) => { closeModal(); const r = await gllDo("Pull", () => gitApi("/pull", { repo: GLLS.cur, mode })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; if (r.conflicts) { GLLS.sub = "conflicts"; toast("Pull stopped with conflicts — resolve them"); } gllRenderRepo(); } },
  gllpush: () => gllPush(),
  gllcommit: () => gllCommit(false), gllcommitpush: () => gllCommit(true), gllsuggest: () => gllSuggest(),
  gllstageall: async () => { const st = gllSt(); const r = await gllDo("Stage all", () => gitApi("/stage", { repo: GLLS.cur, paths: st.files.filter((f) => (f.unstaged || f.untracked) && !f.conflict).map((f) => f.path) }), { quiet: true }); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllunstageall: async () => { const st = gllSt(); const r = await gllDo("Unstage all", () => gitApi("/unstage", { repo: GLLS.cur, paths: st.files.filter((f) => f.staged).map((f) => f.path) }), { quiet: true }); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllbranchmenu: () => { GLLS.sub = "branches"; gllRenderRepo(); },
  gllnewbranch: async () => {
    const name = $("#gllBn").value.trim(), from = $("#gllBf").value; if (!name) { toast("Type a branch name"); return; }
    const st = gllSt(); if (st.files.length && !confirm("You have uncommitted changes. They are carried over to the new branch. Continue?")) return;
    const r = await gllDo(`Create ${name}`, () => gitApi("/checkout", { repo: GLLS.cur, branch: name, create: true, from })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; GLLS.sub = "changes"; gllRenderRepo(); }
  },
  gllbranchat: async (sha) => { const name = prompt("New branch name (created at this commit):"); if (!name) return; const r = await gllDo(`Create ${name}`, () => gitApi("/checkout", { repo: GLLS.cur, branch: name.trim(), create: true, from: sha })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllcheckout: async (name) => { const st = gllSt(); if (st.files.some((f) => !f.untracked) && !confirm(`You have uncommitted changes on ${st.branch}. Git keeps them if they do not clash; otherwise it refuses. Stash them first if unsure. Switch to ${name}?`)) return; const r = await gllDo(`Switch to ${name}`, () => gitApi("/checkout", { repo: GLLS.cur, branch: name })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllcheckoutr: async (name) => { const r = await gllDo(`Check out ${name}`, () => gitApi("/checkout", { repo: GLLS.cur, branch: name, remote: true })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllcompare: (name) => gllCompare(name),
  gllmergein: async (name) => { const st = gllSt(); if (!confirm(`Merge ${name} into ${st.branch}?`)) return; const r = await gllDo(`Merge ${name}`, () => gitApi("/merge", { repo: GLLS.cur, branch: name })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; if (r.conflicts) { GLLS.sub = "conflicts"; toast("Merge has conflicts — resolve them"); } gllRenderRepo(); } },
  gllrebaseon: async (name) => { const st = gllSt(); if (!confirm(`Rebase ${st.branch} onto ${name}?\n\nYour commits are replayed on top of ${name}. If ${st.branch} was already pushed you would need a force push, which JiraTime does not do.`)) return; const r = await gllDo(`Rebase onto ${name}`, () => gitApi("/rebase", { repo: GLLS.cur, onto: name })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; if (r.conflicts) GLLS.sub = "conflicts"; gllRenderRepo(); } },
  gllrename: async (name) => { const to = prompt(`Rename ${name} to:`, name); if (!to || to === name) return; const r = await gllDo("Rename branch", () => gitApi("/branch/rename", { repo: GLLS.cur, from: name, to: to.trim() })); if (r) gllRenderRepo(); },
  glldelbranch: async (name) => {
    if (!confirm(`Delete the local branch ${name}?`)) return;
    try { await gitApi("/branch/delete", { repo: GLLS.cur, name }); toast(`Deleted ${name}`); gllRenderRepo(); }
    catch (e) { if (/not fully merged/i.test(e.message) && confirm(`${name} has commits that are not merged anywhere. Delete anyway? Those commits can be lost.`)) { await gllDo("Delete branch", () => gitApi("/branch/delete", { repo: GLLS.cur, name, force: true })); gllRenderRepo(); } else if (!/not fully merged/i.test(e.message)) gllError("Delete branch", e.message); }
  },
  glldelremote: async (name) => { const short = name.replace(/^origin\//, ""); if (prompt(`This deletes the branch on GitLab for everyone.\nType the branch name to confirm:\n${short}`) !== short) return; const r = await gllDo(`Delete ${short} on GitLab`, () => gitApi("/branch/delete", { repo: GLLS.cur, name, remote: true })); if (r) gllRenderRepo(); },
  glllog: () => { Object.assign(GLLS.logF, { grep: $("#gllLg").value.trim(), author: $("#gllLa").value.trim(), since: $("#gllLs").value, until: $("#gllLu").value, all: $("#gllLall").checked }); GLLS.commit = null; gllHistory(gllSt()); },
  glllogmore: () => gllHistory(gllSt(), true),
  gllrevert: async (sha) => { if (!confirm(`Create a new commit that undoes ${sha.slice(0, 8)}?`)) return; const r = await gllDo("Revert", () => gitApi("/revert", { repo: GLLS.cur, sha })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; if (r.conflicts) GLLS.sub = "conflicts"; GLLS.commit = null; gllRenderRepo(); } },
  glltag: async (sha) => { const name = prompt("Tag name (e.g. v1.9.0):"); if (!name) return; const push = confirm("Also push the tag to GitLab?"); const r = await gllDo(`Tag ${name}`, () => gitApi("/tag", { repo: GLLS.cur, name: name.trim(), sha, message: name.trim(), push })); if (r) gllRenderRepo(); },
  gllreset: (sha) => {
    openModal(`<h3>Reset ${esc(gllSt().branch)} to ${sha.slice(0, 8)}</h3>
      <div class="gll-opts"><button class="small" data-glact="gllresetgo:soft|${sha}">Soft — keep changes staged</button><button class="small" data-glact="gllresetgo:mixed|${sha}">Mixed — keep changes unstaged</button>
        <button class="small danger" data-glact="gllresetgo:hard|${sha}">Hard — throw away changes (a stash backup is made first)</button></div>
      <p class="muted tiny">Commits after this one disappear from the branch. If they were pushed, GitLab still has them, and pushing would need a force push (not offered).</p>
      <div class="foot"><button data-glact="closedet">Cancel</button></div>`);
  },
  gllresetgo: async (arg) => { const [mode, sha] = arg.split("|"); if (mode === "hard" && !confirm("Hard reset? Uncommitted changes are moved to a stash backup first.")) return; closeModal(); const r = await gllDo(`Reset --${mode}`, () => gitApi("/reset", { repo: GLLS.cur, mode, sha })); if (r) { if (r.backup) toast(`Your changes were saved in ${r.backup}`); GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; GLLS.commit = null; gllRenderRepo(); } },
  gllstashpush: async () => { const r = await gllDo("Stash", () => gitApi("/stash/push", { repo: GLLS.cur, message: $("#gllSm").value || "JiraTime stash" })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; gllRenderRepo(); } },
  gllstash: async (arg) => { const [op, ref] = arg.split("|"); if (op === "drop" && !confirm(`Drop ${ref}? Its changes are lost.`)) return; const r = await gllDo(`Stash ${op}`, () => gitApi(`/stash/${op}`, { repo: GLLS.cur, ref })); if (r) { GLLS.st[GLLS.cur] = { ...r.status, at: Date.now() }; if (r.conflicts) GLLS.sub = "conflicts"; gllRenderRepo(); } },
  gllabort: async () => { const st = gllSt(); if (!confirm(`Abort the ${st.state}? Everything goes back to how it was before it started.`)) return; const r = await gllDo(`Abort ${st.state}`, () => gitApi("/abort", { repo: GLLS.cur })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; GLLS.cfChoice = {}; GLLS.sub = "changes"; gllRenderRepo(); } },
  gllcontinue: async () => { const st = gllSt(); if (!confirm(`Finish the ${st.state} now? A commit is created with the resolved files.`)) return; const r = await gllDo(`Continue ${st.state}`, () => gitApi("/continue", { repo: GLLS.cur })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; GLLS.cfChoice = {}; GLLS.sub = "history"; GLLS.commit = null; gllRenderRepo(); toast("Done — review, then Push when ready"); } },
  gllcftake: async (side) => { const f = GLLS.cf.files[GLLS.cfIdx]; if (!confirm(`Use the whole ${side === "ours" ? "current" : "incoming"} version of ${f.path}?`)) return; const r = await gllDo("Resolve", () => gitApi("/resolve", { repo: GLLS.cur, path: f.path, take: side })); if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; delete GLLS.cfChoice[f.path]; gllRenderRepo(); } },
  gllcfsave: async () => {
    const f = GLLS.cf.files[GLLS.cfIdx], blocks = gllParseConflicts(f.work), n = blocks.filter((b) => b.t === "conflict").length, ch = GLLS.cfChoice[f.path];
    const content = gllJoin(blocks, Array.from({ length: n }, (_, k) => ch[k]));
    const r = await gllDo(`Resolve ${f.path}`, () => gitApi("/resolve", { repo: GLLS.cur, path: f.path, content }));
    if (r) { GLLS.st[GLLS.cur] = { ...r, at: Date.now() }; delete GLLS.cfChoice[f.path]; gllRenderRepo(); }
  },
  gllmore: () => {
    const repo = gllRepo();
    openModal(`<h3>⋯ ${esc(repo.name)}</h3><div class="gll-opts">
      <button class="small" data-glact="glltag:HEAD">🏷 Tag current commit</button><button class="small" data-glact="gllsub:stash">Stash changes</button>
      <button class="small" data-glact="glltpl">Branch &amp; commit templates</button><button class="small danger" data-glact="gllremove:${repo.id}">Remove from JiraTime (keeps the folder)</button></div>
      <div class="foot"><button data-glact="closedet">Close</button></div>`);
  },
  gllsub: (s) => { closeModal(); GLLS.sub = s; gllRenderRepo(); },
  glltpl: () => {
    const t = gllTpl();
    openModal(`<h3>Templates</h3><p class="muted tiny">One per line. {KEY} = Jira key from the branch name, {desc} = description, {date} = today.</p>
      <label>Branch templates<textarea id="gllTb" rows="5" style="width:100%">${esc(t.branch.join("\n"))}</textarea></label>
      <label>Commit message templates<textarea id="gllTc" rows="6" style="width:100%">${esc(t.commit.join("\n"))}</textarea></label>
      <div class="foot"><button data-glact="closedet">Cancel</button><button class="primary" id="gllTs">Save</button></div>`);
    $("#gllTs").onclick = () => { localStorage.setItem("jiratime.gl.tpl", JSON.stringify({ branch: $("#gllTb").value.split("\n").map((x) => x.trim()).filter(Boolean), commit: $("#gllTc").value.split("\n").map((x) => x.replace(/\s+$/, "") + (x.endsWith(" ") ? "" : "")).filter((x) => x.trim()) })); closeModal(); toast("Templates saved"); gllRenderRepo(); };
  },
  gllprepmr: () => { closeModal(); const repo = gllRepo(), p = gllProject(repo), st = gllSt(); if (window.GLM && p) GLM.prepare(p, st.branch, st.defaultBranch || p.branch, repo); },
});

function gllOpenRepo(id) { GLLS.cur = id; GLLS.sub = "changes"; GLLS.sel = null; GLLS.commit = null; if (GL.tab !== "local") glGo("local"); else gllRenderRepo(); closeModal(); }

// delegated clicks inside the workspace
document.addEventListener("click", (e) => {
  const root = e.target.closest("#gllMain, #gllList"); if (!root) return;
  const it = e.target.closest("[data-gllrepo]"); if (it) { gllOpenRepo(it.dataset.gllrepo); return; }
  const sub = e.target.closest("[data-gllsub]"); if (sub) { GLLS.sub = sub.dataset.gllsub; gllRenderRepo(); return; }
  const fx = e.target.closest("[data-gllx]"); if (fx) { const row = fx.closest("[data-gllf]"); e.stopPropagation(); gllFileAct(fx.dataset.gllx, row.dataset.gllf, row.dataset.staged === "1"); return; }
  const f = e.target.closest("[data-gllf]"); if (f) { GLLS.sel = f.dataset.gllf; GLLS.selStaged = f.dataset.staged === "1"; document.querySelectorAll("[data-gllf]").forEach((x) => x.classList.toggle("on", x === f)); gllShowDiff(); return; }
  const hk = e.target.closest("[data-gllh]"); if (hk) { gllHunkAct(+hk.dataset.gllh, hk.dataset.mode); return; }
  const c = e.target.closest("[data-gllc]"); if (c) { gllShowCommit(c.dataset.gllc); return; }
  const cf = e.target.closest("[data-gllcf]"); if (cf) { GLLS.cfIdx = +cf.dataset.gllcf; gllConflicts(gllSt()); return; }
  const cb = e.target.closest("[data-gllcb]"); if (cb) {
    const fl = GLLS.cf.files[GLLS.cfIdx], k = +cb.dataset.gllcb, b = gllParseConflicts(fl.work).filter((x) => x.t === "conflict")[k], ch = (GLLS.cfChoice[fl.path] ||= {});
    ch[k] = cb.dataset.take === "edit" ? { take: "edit", text: ch[k]?.take === "edit" ? ch[k].text : [...b.ours, ...b.theirs].join("\n") } : { take: cb.dataset.take };
    const y = window.scrollY; gllConflicts(gllSt()).then(() => window.scrollTo(0, y)); return;
  }
  const a = e.target.closest("[data-glact]"); if (a) { e.stopPropagation(); glAction(a.dataset.glact); }
}, true);
document.addEventListener("input", (e) => { const t = e.target.closest?.("[data-gllce]"); if (t) { const fl = GLLS.cf.files[GLLS.cfIdx]; GLLS.cfChoice[fl.path][+t.dataset.gllce] = { take: "edit", text: t.value }; } });
// GL actions inside modals (folder picker, clone result, pull options…) go through gitlab.js's modal listener.

glAddTab({ id: "local", icon: "⌂", label: "Local repos", render: () => gllRenderTab(), refresh: () => { gllFillList(); }, count: () => (GLLS.repos ? String(GLLS.repos.length) : "") }, "projects");
window.GLL = { localFor: gllLocalFor, load: gllLoad, clone: gllClone, open: gllOpenRepo, pickFolder: gllPickFolder, parseConflicts: gllParseConflicts, join: gllJoin, graph: gllGraph, get state() { return GLLS; } };
JT.on("view", (v) => { if (v === "gitlab") gllLoad().then(() => { if (GL.tab === "overview") glRerender(); }).catch(() => {}); });
