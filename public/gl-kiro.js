"use strict";
/* 🤖 Kiro tab: chat with Kiro CLI inside a repository on this laptop (analysis, code review, explanations, edits).
   Kiro runs through the JiraTime helper with the user's own Kiro login. Conversations continue per repository. */

const GLK2 = { repo: localStorage.getItem("jiratime.kiro.repo") || "", mode: "ask", st: null, job: null, poll: null, branches: null };
const glkHist = {
  key: (id) => "jiratime.kiro.chat." + id,
  get(id) { try { return JSON.parse(localStorage.getItem(this.key(id)) || "[]"); } catch { return []; } },
  set(id, list) { try { localStorage.setItem(this.key(id), JSON.stringify(list.slice(-60))); } catch { /* full */ } },
};
const GLK_QUICK = [
  ["🧭 Explain this repository", "Explain this repository: what it does, the main modules / folders, how a request flows through it, how it is built, configured and deployed. Keep it practical for a developer who is new to it."],
  ["🐞 Find likely bugs", "Look through the main code paths of this repository and list the most likely bugs or fragile spots (null handling, error handling, concurrency, resource leaks, wrong config defaults), each with file:line and a fix."],
  ["🔐 Security check", "Do a security review of this repository: hard-coded secrets, injection (SQL / command / log), auth and permission checks, unsafe deserialisation, sensitive data in logs, outdated risky dependencies. Give file:line for each finding."],
  ["🧪 What tests are missing", "Which important behaviours in this repository have no tests? List them by priority with the file / class to test and what the test should check."],
];

// ================= small markdown renderer (escaped first) =================
function glkMd(text) {
  const parts = String(text).split(/```/);
  return parts.map((p, i) => {
    if (i % 2) { const nl = p.indexOf("\n"), lang = nl > 0 ? p.slice(0, nl).trim() : "", code = nl >= 0 ? p.slice(nl + 1) : p;
      return `<pre class="glk-code">${lang ? `<span class="glk-lang">${esc(lang)}</span>` : ""}${code.replace(/\n$/, "").split("\n").map((l) => GLD.hl(l, GLD.lang("x." + lang) || lang)).join("\n")}</pre>`; }
    return esc(p).split("\n").map((l) => {
      let h = l.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      if (/^#{1,4} /.test(l)) return `<div class="glk-h">${h.replace(/^#{1,4} /, "")}</div>`;
      if (/^\s*([-*]|\d+\.) /.test(l)) return `<div class="glk-li">${h.replace(/^\s*[-*] /, "• ")}</div>`;
      return h ? `<div>${h}</div>` : '<div class="glk-sp"></div>';
    }).join("");
  }).join("");
}
/** kiro-cli output -> { activity: [lines], answer: text } */
function glkSplit(out) {
  const act = [], ans = []; let inAnswer = false;
  for (const raw of String(out).split("\n")) {
    const l = raw.replace(/\s+$/, "");
    if (!inAnswer && /^> /.test(l)) { inAnswer = true; ans.push(l.slice(2)); continue; }
    if (!inAnswer) { if (/\(using tool: |^\s*[✓✗] |^\s*- Completed|^(Searching|Reading|Writing|Creating|Updating|Running)/.test(l)) act.push(l.trim()); else if (l.trim() && !/^[λ↯\s]+$/.test(l)) act.push(l.trim()); continue; }
    if (/\(using tool: /.test(l)) { act.push(l.trim()); continue; }
    ans.push(l.replace(/^> /, ""));
  }
  return { activity: act.filter((x) => !/^-+$/.test(x)), answer: ans.join("\n").trim() };
}

// ================= tab =================
async function glkRenderTab() {
  const body = $("#glBody"); if (!body) return;
  if (glDirect() && !GL_GIT) {
    body.innerHTML = `<div class="card gll-hero"><h3>🤖 Kiro on your repositories</h3><p class="muted">Kiro works inside repositories on your laptop, through the JiraTime helper. Set the helper up once in <b>Local repos</b>, then come back.</p><button class="small primary-s" data-glact="tab:local">Go to Local repos</button></div>`;
    return;
  }
  body.innerHTML = '<div class="card"><p class="muted"><span class="spin"></span> Checking Kiro CLI…</p></div>';
  let st; try { st = GLK2.st = await gitApi("/kiro/status"); } catch (e) { body.innerHTML = `<div class="warnbox">⚠ ${esc(e.message)}</div>`; return; }
  if (!st.installed || !st.loggedIn) {
    body.innerHTML = `<div class="card gll-hero"><h3>🤖 Kiro CLI ${st.installed ? "is not logged in" : "is not installed"} on this laptop</h3>
      <p class="muted">${st.installed ? "Log in once in a terminal; your company login is used." : "Install Kiro CLI, then log in once in a terminal."}</p>
      <div class="gl-clone" style="max-width:520px;margin:10px auto"><code>${st.installed ? "kiro-cli login" : "curl -fsSL https://cli.kiro.dev/install | bash"}</code><button class="small" data-glcopy="${st.installed ? "kiro-cli login" : "curl -fsSL https://cli.kiro.dev/install | bash"}">Copy</button></div>
      <button class="small primary-s" data-glact="glkrecheck">⟳ Check again</button></div>`;
    return;
  }
  const repos = (await GLL.load().catch(() => [])) || [];
  if (!repos.some((r) => r.id === GLK2.repo)) GLK2.repo = (GLL.state.cur && repos.some((r) => r.id === GLL.state.cur) ? GLL.state.cur : repos[0]?.id) || "";
  if (!repos.length) { body.innerHTML = `<div class="card gll-hero"><h3>🤖 Kiro</h3><p class="muted">Clone or add a repository first — Kiro works inside it.</p><button class="small primary-s" data-glact="tab:projects">Go to Projects</button> <button class="small" data-glact="tab:local">Local repos</button></div>`; return; }
  body.innerHTML = `<div class="glk-wrap">
    <div class="card glk-bar">
      <label>Repository <select id="glkRepo">${repos.map((r) => `<option value="${esc(r.id)}" ${r.id === GLK2.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</select></label>
      <label>Branch <select id="glkBr"><option>…</option></select></label>
      <div class="gl-seg" title="What Kiro may do"><button class="${GLK2.mode === "ask" ? "on" : ""}" data-glact="glkmode:ask">👁 Read only</button><button class="${GLK2.mode === "edit" ? "on" : ""}" data-glact="glkmode:edit">✎ May edit files</button></div>
      <span class="grow"></span><span class="muted tiny" title="${esc(st.who || "")}">Kiro CLI ${esc((st.version || "").replace(/^kiro-cli\s*/, ""))}</span>
      <button class="small" data-glact="glkreview:local">🔍 Review my changes</button><button class="small" data-glact="glknew" title="Start a fresh conversation">＋ New chat</button></div>
    <div class="card glk-chat"><div id="glkLog" class="glk-log"></div>
      <div class="glk-quick">${GLK_QUICK.map(([l], i) => `<button class="small ghost" data-glact="glkquick:${i}">${esc(l)}</button>`).join("")}</div>
      <div class="glk-in"><textarea id="glkQ" rows="3" placeholder="Ask Kiro about this repository… (Enter = send, Shift+Enter = new line)"></textarea>
        <div class="glk-send"><button class="primary" id="glkGo" style="width:auto;margin:0">Send</button><button class="small danger hidden" id="glkStop">■ Stop</button></div></div>
      <p class="muted tiny glk-note">Runs Kiro CLI on this laptop inside the repository with your Kiro login. ${GLK2.mode === "edit" ? "<b>Kiro may change files</b> — check them in Local repos → Changes before you commit." : "Read only: Kiro cannot change files."} Kiro never runs shell / git commands from here.</p></div></div>`;
  $("#glkRepo").onchange = (e) => { GLK2.repo = e.target.value; localStorage.setItem("jiratime.kiro.repo", GLK2.repo); glkRenderTab(); };
  $("#glkGo").onclick = () => glkSend();
  $("#glkStop").onclick = () => GLK2.job && gitApi("/kiro/stop", { id: GLK2.job.id }).catch(() => {});
  $("#glkQ").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); glkSend(); } });
  glkBranches(); glkDraw();
  const act = await gitApi(`/kiro/active?repo=${GLK2.repo}`).catch(() => null);      // re-attach to a running answer
  if (act?.job) glkAttach(act.job);
}
async function glkBranches() {
  const sel = $("#glkBr"); if (!sel) return;
  try {
    const [st, br] = await Promise.all([gitApi(`/status?repo=${GLK2.repo}`), gitApi(`/branches?repo=${GLK2.repo}`)]);
    const local = br.branches.filter((b) => !b.remote).map((b) => b.name), remote = br.branches.filter((b) => b.remote && !local.includes(b.name.replace(/^origin\//, ""))).map((b) => b.name).slice(0, 300);
    sel.innerHTML = `<optgroup label="On this laptop">${local.map((n) => `<option value="L:${esc(n)}" ${n === st.branch ? "selected" : ""}>${esc(n)}</option>`).join("")}</optgroup>${remote.length ? `<optgroup label="On GitLab">${remote.map((n) => `<option value="R:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}`;
    sel.dataset.cur = st.branch; sel.dataset.dirty = st.files.filter((f) => !f.untracked).length;
    sel.onchange = async () => {
      const [k, name] = [sel.value.slice(0, 1), sel.value.slice(2)];
      if (+sel.dataset.dirty && !confirm(`You have uncommitted changes on ${sel.dataset.cur}. Git keeps them if they do not clash, otherwise it refuses. Switch to ${name}?`)) { glkBranches(); return; }
      try { await gitApi("/checkout", k === "R" ? { repo: GLK2.repo, branch: name, remote: true } : { repo: GLK2.repo, branch: name }); toast(`Switched to ${name.replace(/^origin\//, "")}`); glkSys(`Switched to branch ${name.replace(/^origin\//, "")}`); }
      catch (e) { toast(e.message); }
      glkBranches();
    };
  } catch (e) { sel.innerHTML = `<option>${esc(e.message.slice(0, 40))}</option>`; }
}
function glkSys(text) { const h = glkHist.get(GLK2.repo); h.push({ role: "sys", text, at: Date.now() }); glkHist.set(GLK2.repo, h); glkDraw(); }
function glkDraw() {
  const el = $("#glkLog"); if (!el) return;
  const h = glkHist.get(GLK2.repo);
  el.innerHTML = h.map((m) => {
    if (m.role === "sys") return `<div class="glk-sys">— ${esc(m.text)} —</div>`;
    if (m.role === "user") return `<div class="glk-m me"><div class="glk-b">${m.label ? `<span class="b skip">${esc(m.label)}</span> ` : ""}${esc(m.text.length > 600 ? m.text.slice(0, 600) + "…" : m.text)}</div></div>`;
    const sp = glkSplit(m.out || ""), live = m.live;
    return `<div class="glk-m ai"><div class="glk-av">🤖</div><div class="glk-b">
      ${sp.activity.length ? `<details class="glk-act" ${live && !sp.answer ? "open" : ""}><summary>${live ? '<span class="spin"></span> ' : ""}${sp.activity.filter((x) => /using tool/.test(x)).length} step${sp.activity.filter((x) => /using tool/.test(x)).length === 1 ? "" : "s"} — files Kiro looked at</summary><div>${sp.activity.slice(-80).map((x) => `<div>${esc(x)}</div>`).join("")}</div></details>` : live ? '<div class="muted tiny"><span class="spin"></span> Kiro is thinking…</div>' : ""}
      ${sp.answer ? `<div class="glk-ans">${glkMd(sp.answer)}</div>` : ""}
      ${m.error ? `<div class="warnbox tiny">⚠ ${esc(m.error)}</div>` : ""}
      ${!live ? `<div class="glk-meta muted tiny">${m.status === "stopped" ? "stopped · " : ""}${esc(m.credits || "")}${sp.answer ? ` <button class="small ghost" data-glkcopy="${h.indexOf(m)}">⧉ Copy</button>` : ""}</div>` : ""}</div></div>`;
  }).join("") || `<div class="glk-empty"><b>Ask anything about this repository</b><p class="muted tiny">e.g. “Where is the quote id generated?”, “Why could this API return 500?”, “Review the changes on this branch”.</p></div>`;
  el.scrollTop = el.scrollHeight;
}
async function glkSend(text, opts = {}) {
  const q = text ?? $("#glkQ")?.value.trim(); if (!q) return;
  if (GLK2.job) { toast("Kiro is still answering — wait or press Stop"); return; }
  const fresh = opts.fresh ?? !!GLK2.fresh; GLK2.fresh = false;       // first message after "New chat"
  try {
    const job = opts.review ? await gitApi("/kiro/review", { repo: GLK2.repo, ...opts.review }) : await gitApi("/kiro/ask", { repo: GLK2.repo, prompt: q, mode: GLK2.mode, fresh });
    if ($("#glkQ") && text == null) $("#glkQ").value = "";
    const h = glkHist.get(GLK2.repo); h.push({ role: "user", text: q, label: opts.label || (GLK2.mode === "edit" ? "may edit" : ""), at: Date.now() }); glkHist.set(GLK2.repo, h);
    glkAttach(job);
  } catch (e) { toast(e.message); }
}
function glkAttach(job) {
  const repo = GLK2.repo, h = glkHist.get(repo);
  let msg = h.find((m) => m.role === "ai" && m.job === job.id);
  if (!msg) { msg = { role: "ai", job: job.id, out: job.out || "", live: true, at: Date.now() }; h.push(msg); glkHist.set(repo, h); }
  GLK2.job = job; $("#glkGo")?.classList.add("hidden"); $("#glkStop")?.classList.remove("hidden"); glkDraw();
  let size = job.size || (job.out || "").length;
  clearTimeout(GLK2.poll);
  const tick = async () => {
    let j; try { j = await gitApi(`/kiro/job?id=${job.id}&from=${size}`); } catch (e) { j = { status: "failed", out: "", error: e.message }; }
    const list = glkHist.get(repo), m = list.find((x) => x.job === job.id);
    if (m) { m.out = (m.out || "") + (j.out || ""); size = j.size ?? size; if (j.status !== "running") Object.assign(m, { live: false, status: j.status, credits: j.credits, error: j.error }); glkHist.set(repo, list); }
    if (GLK2.repo === repo && GL.tab === "kiro") glkDraw();
    if (j.status === "running") GLK2.poll = setTimeout(tick, 1200);
    else { GLK2.job = null; $("#glkGo")?.classList.remove("hidden"); $("#glkStop")?.classList.add("hidden"); if (j.status === "done" && GLK2.mode === "edit") toast("Kiro finished — check Local repos → Changes"); }
  };
  GLK2.poll = setTimeout(tick, 900);
}
/** Open the Kiro tab for a GitLab project (clone first if it is not on this laptop), optionally starting a review. */
async function glkForProject(p, review) {
  if (glDirect() && !GL_GIT) { glGo("kiro"); return; }
  await GLL.load().catch(() => {});
  const r = GLL.localFor(p);
  if (!r) { toast("Clone the project first — Kiro works on a copy on your laptop"); closeModal(); GLL.clone(p); return; }
  GLK2.repo = r.id; localStorage.setItem("jiratime.kiro.repo", r.id); closeModal(); glGo("kiro");
  if (review) { await sleep(400); if (GL.tab === "kiro") glkSend(review.text, { review: review.body, label: review.label }); }
}

Object.assign(GL_ACTIONS, {
  glkrecheck: async () => { await gitApi("/kiro/status?force=1").catch(() => {}); glkRenderTab(); },
  glkmode: (m) => { GLK2.mode = m; glkRenderTab(); },
  glknew: () => { if (GLK2.job) return toast("Wait for the current answer first"); glkSys("New conversation"); GLK2.fresh = true; toast("The next message starts a new conversation"); },
  glkquick: (i) => { const [l, t] = GLK_QUICK[+i]; glkSend(t, { label: l }); },
  glkreview: () => glkSend("Review my uncommitted changes", { review: { kind: "local" }, label: "🔍 Review my changes" }),
  kiroproject: (pid) => { const p = GL.projects.find((x) => x.id === +pid); if (p) glkForProject(p); },
  kiromr: () => {
    const c = GLMS.cur, m = c?.mr, p = m && glmProj(c.pid); if (!p) return;
    glkForProject(p, { text: `Review merge request !${m.iid}: ${glmStripDraft(m.title)}`, label: `🔍 Review !${m.iid}`, body: { kind: "mr", iid: m.iid, title: glmStripDraft(m.title), description: m.description || "", source: m.source_branch, target: m.target_branch } });
  },
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-glkcopy]"); if (!b) return;
  const m = glkHist.get(GLK2.repo)[+b.dataset.glkcopy]; if (m) navigator.clipboard.writeText(glkSplit(m.out).answer).then(() => toast("Copied")).catch(() => toast("Copy failed"));
});
glAddTab({ id: "kiro", icon: "🤖", label: "Kiro", render: () => glkRenderTab(), refresh: () => {} }, "local");
window.GLKIRO = { forProject: glkForProject, setRepo: (id) => { GLK2.repo = id; localStorage.setItem("jiratime.kiro.repo", id); } };
