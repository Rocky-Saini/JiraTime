"use strict";
/* 🤖 Kiro and ⬛ Cursor tabs: chat with Kiro CLI or Cursor Agent CLI inside a repository on this laptop (analysis, code review, explanations, edits).
   Kiro runs through the JiraTime helper with the user's own Kiro login. Conversations continue per repository. */

const GLK2 = { engine: "kiro", repo: localStorage.getItem("jiratime.kiro.repo") || "", mode: "ask", st: null, job: null, poll: null, branches: null, att: [], prefill: "" };
const glkE = () => (GLK2.engine === "cursor" ? "Cursor" : "Kiro"), glkIco = () => (GLK2.engine === "cursor" ? "⬛" : "🤖");
const glkAgentTab = () => GL.tab === "kiro" || GL.tab === "cursor";
const glkHist = {
  key: (id) => `jiratime.${GLK2.engine === "cursor" ? "cursor" : "kiro"}.chat.` + id,
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
async function glkRenderTab(engine) {
  const body = $("#glBody"); if (!body) return;
  if (engine && engine !== GLK2.engine) { GLK2.engine = engine; GLK2.att = []; clearTimeout(GLK2.poll); GLK2.job = null; }
  if (glDirect() && !GL_GIT && GL.helper?.old) {
    body.innerHTML = `<div class="card gll-hero"><h3>🤖 Update the JiraTime helper</h3><p class="muted">The helper on this laptop is an older version without Kiro. Run this once in a terminal — after that it updates itself:</p>
      <div class="gl-clone" style="max-width:620px;margin:10px auto"><code>${esc(GL_INSTALL)}</code><button class="small" data-glcopy="${esc(GL_INSTALL)}">Copy</button></div>
      <button class="small primary-s" data-glact="helperconnect">⟳ Check again</button></div>`;
    return;
  }
  if (glDirect() && !GL_GIT) {
    body.innerHTML = `<div class="card gll-hero"><h3>🤖 Kiro on your repositories</h3><p class="muted">Kiro works inside repositories on your laptop, through the JiraTime helper. Set the helper up once in <b>Local repos</b>, then come back.</p><button class="small primary-s" data-glact="tab:local">Go to Local repos</button></div>`;
    return;
  }
  body.innerHTML = '<div class="card"><p class="muted"><span class="spin"></span> Checking ${glkE()} CLI…</p></div>';
  let st; try { st = GLK2.st = await gitApi(`/kiro/status?engine=${GLK2.engine}`); } catch (e) { body.innerHTML = `<div class="warnbox">⚠ ${esc(e.message)}</div>`; return; }
  if (!st.installed || !st.loggedIn) {
    const inst = GLK2.engine === "cursor" ? "curl https://cursor.com/install -fsS | bash" : "curl -fsSL https://cli.kiro.dev/install | bash", login = st.login || "kiro-cli login";
    body.innerHTML = `<div class="card gll-hero"><h3>${glkIco()} ${glkE()} CLI ${st.installed ? "is not logged in" : "is not installed"} on this laptop</h3>
      <p class="muted">${st.installed ? "Log in once in a terminal with your own account." : `Install ${glkE()} CLI, then log in once in a terminal (<code>${esc(login)}</code>).`}</p>
      <div class="gl-clone" style="max-width:520px;margin:10px auto"><code>${esc(st.installed ? login : inst)}</code><button class="small" data-glcopy="${esc(st.installed ? login : inst)}">Copy</button></div>
      <button class="small primary-s" data-glact="glkrecheck">⟳ Check again</button></div>`;
    return;
  }
  const repos = (await GLL.load().catch(() => [])) || [];
  if (!repos.some((r) => r.id === GLK2.repo)) GLK2.repo = (GLL.state.cur && repos.some((r) => r.id === GLL.state.cur) ? GLL.state.cur : repos[0]?.id) || "";
  if (!repos.length) { body.innerHTML = `<div class="card gll-hero"><h3>${glkIco()} ${glkE()}</h3><p class="muted">Pick any GitLab project — JiraTime gets a review copy, no clone needed.</p><button class="small primary-s" data-glact="glkpick">＋ Choose a GitLab project</button></div>`; return; }
  body.innerHTML = `<div class="glk-wrap">
    <div class="card glk-bar">
      <label>Repository <select id="glkRepo"><optgroup label="On this laptop">${repos.filter((r) => !r.kiroCache).map((r) => `<option value="${esc(r.id)}" ${r.id === GLK2.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</optgroup>
        ${repos.some((r) => r.kiroCache) ? `<optgroup label="Review copies (any GitLab project)">${repos.filter((r) => r.kiroCache).map((r) => `<option value="${esc(r.id)}" ${r.id === GLK2.repo ? "selected" : ""}>${esc(r.remotePath || r.name)}</option>`).join("")}</optgroup>` : ""}
        <option value="__pick">＋ Any GitLab project…</option></select></label>
      <label>Branch <select id="glkBr"><option>…</option></select></label>
      <div class="glk-git" id="glkGit"></div>
      <div class="gl-seg" title="What ${glkE()} may do"><button class="${GLK2.mode === "ask" ? "on" : ""}" data-glact="glkmode:ask">👁 Read only</button><button class="${GLK2.mode === "edit" ? "on" : ""}" data-glact="glkmode:edit">✎ May edit files</button></div>
      <span class="grow"></span><span class="muted tiny" title="${esc(st.who || "")}">${esc((st.version || "").replace(/^kiro-cli\s*/, "Kiro CLI "))}</span>
      <button class="small" data-glact="glkreview:local">🔍 Review my changes</button><button class="small" data-glact="glknew" title="Start a fresh conversation">＋ New chat</button>
      <button class="small ghost" data-glact="glkcache" title="Review copies of projects that are not cloned on this laptop">🗂 Review copies</button></div>
    <div class="card glk-chat"><div id="glkLog" class="glk-log"></div>
      <div class="glk-quick">${GLK_QUICK.map(([l], i) => `<button class="small ghost" data-glact="glkquick:${i}">${esc(l)}</button>`).join("")}</div>
      <div id="glkAtt" class="glk-att"></div>
      <div class="glk-in"><label class="glk-clip" title="Attach screenshots, images or documents (PDF, Word, Excel, text, logs…)">📎<input type="file" id="glkFile" multiple hidden accept="image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.log,.json,.csv,.xml,.yml,.yaml,.properties,.sql,.java,.js,.ts,.py,.html,.har,.diff,.patch"></label>
        <textarea id="glkQ" rows="3" placeholder="Ask ${glkE()} about this repository… Paste a screenshot with Ctrl+V or drop files here. (Enter = send, Shift+Enter = new line)"></textarea>
        <div class="glk-send"><button class="primary" id="glkGo" style="width:auto;margin:0">Send</button><button class="small danger hidden" id="glkStop">■ Stop</button></div></div>
      <p class="muted tiny glk-note">Runs ${glkE()} CLI on this laptop inside the repository with your own ${glkE()} login. ${GLK2.mode === "edit" ? `<b>${glkE()} may change files</b> — check them in Local repos → Changes before you commit.${GLK2.engine === "cursor" ? " Shell commands run only in Cursor's sandbox." : ""}` : `Read only: ${glkE()} cannot change files.`} Branches, commits and pushes are done by JiraTime, not by the agent.</p></div></div>`;
  $("#glkRepo").onchange = (e) => { if (e.target.value === "__pick") { e.target.value = GLK2.repo; return glkPickProject(); } GLK2.att = []; GLK2.repo = e.target.value; localStorage.setItem("jiratime.kiro.repo", GLK2.repo); glkRenderTab(); };
  $("#glkGo").onclick = () => glkSend();
  $("#glkStop").onclick = () => GLK2.job && gitApi("/kiro/stop", { id: GLK2.job.id }).catch(() => {});
  $("#glkQ").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); glkSend(); } });
  if (GLK2.prefill) { $("#glkQ").value = GLK2.prefill; GLK2.prefill = ""; setTimeout(() => { const q = $("#glkQ"); q?.focus(); q?.setSelectionRange(q.value.length, q.value.length); }, 30); }
  $("#glkFile").onchange = (e) => { glkAddFiles([...e.target.files]); e.target.value = ""; };
  $("#glkQ").addEventListener("paste", (e) => { const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean); if (files.length) { e.preventDefault(); glkAddFiles(files.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `screenshot-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}${i ? "-" + i : ""}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`, { type: f.type })))); } });
  const chat = $(".glk-chat");
  chat.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); chat.classList.add("drag"); } });
  chat.addEventListener("dragleave", (e) => { if (!chat.contains(e.relatedTarget)) chat.classList.remove("drag"); });
  chat.addEventListener("drop", (e) => { e.preventDefault(); chat.classList.remove("drag"); glkAddFiles([...e.dataTransfer.files]); });
  glkAttDraw();
  glkBranches(); glkDraw();
  const act = await gitApi(`/kiro/active?repo=${GLK2.repo}&engine=${GLK2.engine}`).catch(() => null);      // re-attach to a running answer
  if (act?.job) glkAttach(act.job);
}
async function glkBranches() {
  const sel = $("#glkBr"); if (!sel) return;
  try {
    const [st, br] = await Promise.all([gitApi(`/status?repo=${GLK2.repo}`), gitApi(`/branches?repo=${GLK2.repo}`)]);
    const local = br.branches.filter((b) => !b.remote).map((b) => b.name), remote = br.branches.filter((b) => b.remote && !local.includes(b.name.replace(/^origin\//, ""))).map((b) => b.name).slice(0, 300);
    sel.innerHTML = `<optgroup label="On this laptop">${local.map((n) => `<option value="L:${esc(n)}" ${n === st.branch ? "selected" : ""}>${esc(n)}</option>`).join("")}</optgroup>${remote.length ? `<optgroup label="On GitLab">${remote.map((n) => `<option value="R:${esc(n)}">${esc(n)}</option>`).join("")}</optgroup>` : ""}`;
    sel.dataset.cur = st.branch; sel.dataset.dirty = st.files.filter((f) => !f.untracked).length;
    glkGitDraw(st);
    sel.onchange = async () => {
      const [k, name] = [sel.value.slice(0, 1), sel.value.slice(2)];
      sel.disabled = true;
      const st = await GLL.switchBranch(GLK2.repo, name, { remote: k === "R" }).catch((e) => { toast(e.message); return null; });
      if (st) glkSys(`Switched to branch ${st.branch} and pulled the latest${st.state ? ` — ${st.state} in progress, resolve it in Local repos` : ""}`);
      if (!glkAgentTab()) return;
      sel.disabled = false; glkBranches();
    };
  } catch (e) { sel.innerHTML = `<option>${esc(e.message.slice(0, 40))}</option>`; }
}
function glkSys(text) { const h = glkHist.get(GLK2.repo); h.push({ role: "sys", text, at: Date.now() }); glkHist.set(GLK2.repo, h); glkDraw(); }
function glkDraw() {
  const el = $("#glkLog"); if (!el) return;
  const h = glkHist.get(GLK2.repo);
  el.innerHTML = h.map((m) => {
    if (m.role === "sys") return `<div class="glk-sys">— ${esc(m.text)} —</div>`;
    if (m.role === "user") return `<div class="glk-m me"><div class="glk-b">${m.label ? `<span class="b skip">${esc(m.label)}</span> ` : ""}${esc(m.text.length > 600 ? m.text.slice(0, 600) + "…" : m.text)}${m.files?.length ? `<div class="glk-mf">${m.files.map((f) => f.thumb ? `<img src="${esc(f.thumb)}" alt="${esc(f.name)}" title="${esc(f.name)}">` : `<span class="glk-fc">${f.kind === "image" ? "🖼" : "📄"} ${esc(f.name)}</span>`).join("")}</div>` : ""}</div></div>`;
    const sp = glkSplit(m.out || ""), live = m.live;
    return `<div class="glk-m ai"><div class="glk-av ${GLK2.engine}">${glkIco()}</div><div class="glk-b">
      ${sp.activity.length ? `<details class="glk-act" ${live && !sp.answer ? "open" : ""}><summary>${live ? '<span class="spin"></span> ' : ""}${sp.activity.filter((x) => /using tool/.test(x)).length} step${sp.activity.filter((x) => /using tool/.test(x)).length === 1 ? "" : "s"} — files ${glkE()} looked at</summary><div>${sp.activity.slice(-80).map((x) => `<div>${esc(x)}</div>`).join("")}</div></details>` : live ? '<div class="muted tiny"><span class="spin"></span> ${glkE()} is thinking…</div>' : ""}
      ${sp.answer ? `<div class="glk-ans">${glkMd(sp.answer)}</div>` : ""}
      ${m.error ? `<div class="warnbox tiny">⚠ ${esc(m.error)}</div>` : ""}
      ${!live ? `<div class="glk-meta muted tiny">${m.status === "stopped" ? "stopped · " : ""}${esc(m.credits || "")}${sp.answer ? ` <button class="small ghost" data-glkcopy="${h.indexOf(m)}">⧉ Copy</button>` : ""}${sp.answer && m.mr ? (m.posted ? ` <span class="b new">posted on !${m.mr.iid}</span>` : ` <button class="small primary-s" data-glkpost="${h.indexOf(m)}">💬 Post on !${m.mr.iid}</button>`) : ""}</div>` : ""}</div></div>`;
  }).join("") || `<div class="glk-empty"><b>Ask anything about this repository</b><p class="muted tiny">e.g. “Where is the quote id generated?”, “Why could this API return 500?”, “Review the changes on this branch”.</p></div>`;
  el.scrollTop = el.scrollHeight;
}
async function glkSend(text, opts = {}) {
  const q = text ?? $("#glkQ")?.value.trim(); if (!q) return;
  if (GLK2.job) { toast(`${glkE()} is still answering — wait or press Stop`); return; }
  if (GLK2.att.some((a) => a.busy)) { toast("Wait until the attachments are uploaded"); return; }
  const att = opts.review ? [] : GLK2.att.filter((a) => a.id);
  const fresh = opts.fresh ?? !!GLK2.fresh; GLK2.fresh = false;       // first message after "New chat"
  try {
    const job = opts.review ? await gitApi("/kiro/review", { repo: GLK2.repo, engine: GLK2.engine, ...opts.review }) : await gitApi("/kiro/ask", { repo: GLK2.repo, engine: GLK2.engine, prompt: q, mode: GLK2.mode, fresh, attachments: att.map((a) => a.id) });
    if (att.length) { GLK2.att = []; glkAttDraw(); }
    if ($("#glkQ") && text == null) $("#glkQ").value = "";
    const h = glkHist.get(GLK2.repo); h.push({ role: "user", text: q, label: opts.label || (GLK2.mode === "edit" ? "may edit" : ""), files: att.map((a) => ({ name: a.name, kind: a.kind, thumb: a.thumb || "" })), at: Date.now() }); glkHist.set(GLK2.repo, h);
    glkAttach(job, opts.mr);
  } catch (e) { toast(e.message); }
}
function glkAttach(job, mr) {
  const repo = GLK2.repo, eng = GLK2.engine, h = glkHist.get(repo);
  let msg = h.find((m) => m.role === "ai" && m.job === job.id);
  if (!msg) { msg = { role: "ai", job: job.id, out: job.out || "", live: true, at: Date.now(), ...(mr ? { mr } : {}) }; h.push(msg); glkHist.set(repo, h); }
  GLK2.job = job; $("#glkGo")?.classList.add("hidden"); $("#glkStop")?.classList.remove("hidden"); glkDraw();
  let size = job.size || (job.out || "").length;
  clearTimeout(GLK2.poll);
  const tick = async () => {
    let j; try { j = await gitApi(`/kiro/job?id=${job.id}&from=${size}`); } catch (e) { j = { status: "failed", out: "", error: e.message }; }
    const cur = GLK2.engine; GLK2.engine = eng; const list = glkHist.get(repo), m = list.find((x) => x.job === job.id);
    if (m) { m.out = (m.out || "") + (j.out || ""); size = j.size ?? size; if (j.status !== "running") Object.assign(m, { live: false, status: j.status, credits: j.credits, error: j.error }); glkHist.set(repo, list); }
    GLK2.engine = cur;
    if (GLK2.repo === repo && glkAgentTab() && GLK2.engine === eng) glkDraw();
    if (j.status === "running") GLK2.poll = setTimeout(tick, 1200);
    else { if (GLK2.engine !== eng) return; GLK2.job = null; $("#glkGo")?.classList.remove("hidden"); $("#glkStop")?.classList.add("hidden"); if (j.status === "done" && GLK2.mode === "edit") toast(`${glkE()} finished — check Local repos → Changes`); }
  };
  GLK2.poll = setTimeout(tick, 900);
}
/** Open the Kiro tab for a GitLab project (clone first if it is not on this laptop), optionally starting a review. */
async function glkForProject(p, review, engine = GLK2.engine || "kiro") {
  const tab = engine === "cursor" ? "cursor" : "kiro";
  if (glDirect() && !GL_GIT) { glGo(tab); return; }
  await GLL.load().catch(() => {});
  let r = GLL.localFor(p, { cache: true });
  if (!r) { try { r = await GLL.reviewCopy(p); } catch (e) { toast(e.message); return; } }
  GLK2.repo = r.id; localStorage.setItem("jiratime.kiro.repo", r.id); closeModal(); glGo(tab);
  if (review) { await sleep(500); if (glkAgentTab()) glkSend(review.text, { review: review.body, label: review.label, mr: review.mr }); }
}

// ================= attachments =================
/** Small JPEG preview kept in the chat history (data URL, ~10 KB). */
const glkThumb = (file) => new Promise((res) => {
  if (!/^image\//.test(file.type)) return res("");
  const img = new Image(), url = URL.createObjectURL(file);
  img.onload = () => { const s = Math.min(1, 220 / Math.max(img.width, img.height)), c = document.createElement("canvas"); c.width = Math.max(1, img.width * s); c.height = Math.max(1, img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", 0.7)); };
  img.onerror = () => { URL.revokeObjectURL(url); res(""); };
  img.src = url;
});
async function glkAddFiles(files) {
  for (const f of files.slice(0, 10)) {
    if (f.size > 10 * 1048576) { toast(`${f.name}: larger than 10 MB`); continue; }
    if (GLK2.att.length >= 10) { toast("At most 10 attachments per message"); break; }
    const a = { key: Math.random().toString(36).slice(2), name: f.name || "file", kind: /^image\//.test(f.type) ? "image" : "file", busy: true, thumb: await glkThumb(f) };
    GLK2.att.push(a); glkAttDraw();
    try { const r = await gitApi("/kiro/attach", { repo: GLK2.repo, name: a.name, data: await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1] || ""); fr.onerror = () => rej(fr.error); fr.readAsDataURL(f); }) });
      Object.assign(a, { id: r.id, kind: r.kind, busy: false, note: r.kind === "file" && /\.(pdf|docx|xlsx|pptx)$/i.test(a.name) ? "could not extract text" : "" }); }
    catch (e) { a.busy = false; a.err = e.message; }
    glkAttDraw();
  }
}
function glkAttDraw() {
  const el = $("#glkAtt"); if (!el) return;
  el.innerHTML = GLK2.att.map((a) => `<span class="glk-chip ${a.err ? "bad" : ""}" title="${esc(a.err || a.note || a.name)}">${a.thumb ? `<img src="${esc(a.thumb)}" alt="">` : a.kind === "image" ? "🖼" : "📄"}<span>${esc(a.name)}</span>${a.busy ? '<span class="spin"></span>' : a.err ? "⚠" : a.kind === "document" ? '<span class="muted tiny">text read</span>' : ""}<button type="button" data-glkrm="${a.key}" title="Remove">×</button></span>`).join("");
  el.classList.toggle("hidden", !GLK2.att.length);
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-glkrm]"); if (!b) return; GLK2.att = GLK2.att.filter((a) => a.key !== b.dataset.glkrm); glkAttDraw(); });

// ================= git for the chosen repository: fetch / pull / push / commit =================
function glkGitDraw(st) {
  const el = $("#glkGit"); if (!el) return;
  const repo = GLL.state.repos?.find((r) => r.id === GLK2.repo); if (!repo) { el.innerHTML = ""; return; }
  if (repo.kiroCache) { el.innerHTML = `<span class="muted tiny" title="Review copy: read-only snapshot for Kiro">review copy</span><button class="small" data-glkgit="fetch" title="Get the newest branches and commits from GitLab">⟳ Fetch</button>`; return; }
  const changed = st.files.length;
  el.innerHTML = `<button class="small" data-glkgit="fetch" title="git fetch — see what is new on GitLab">⟳ Fetch</button>
    <button class="small" data-glkgit="pull" title="git pull — bring the newest commits of ${esc(st.branch)} from GitLab" ${st.detached ? "disabled" : ""}>⬇ Pull${st.behind ? ` <span class="gl-tc">${st.behind}</span>` : ""}</button>
    <button class="small ${st.ahead || (!st.upstream && !st.detached) ? "primary-s" : ""}" data-glkgit="push" title="git push — send your commits to GitLab" ${st.detached ? "disabled" : ""}>⬆ Push${st.ahead ? ` <span class="gl-tc">${st.ahead}</span>` : !st.upstream && !st.detached ? " (new)" : ""}</button>
    ${changed ? `<button class="small" data-glkgit="commit" title="Open the changes to review, stage and commit them">✎ Commit <span class="gl-tc">${changed}</span></button>` : ""}
    ${st.state ? `<button class="small danger" data-glkgit="commit" title="Resolve it in Local repos">⚠ ${esc(st.state)} in progress</button>` : ""}`;
}
async function glkGit(act) {
  const id = GLK2.repo, el = $("#glkGit"); if (!id) return;
  const busy = (t) => { if (el) el.querySelectorAll("button").forEach((b) => { b.disabled = true; }); toast(t); };
  const done = () => glkBranches();
  try {
    if (act === "commit") { GLL.open(id); return; }
    if (act === "fetch") { busy("Fetching…"); const r = await gitApi("/fetch", { repo: id }); const s = r.status; toast(s.behind ? `${s.behind} new commit${s.behind === 1 ? "" : "s"} on GitLab — press Pull` : "Up to date with GitLab"); return done(); }
    if (act === "pull") {
      let st = await gitApi(`/status?repo=${id}`);
      if (st.files.some((f) => !f.untracked && !f.conflict)) {
        const c = await GLL.ask("Uncommitted changes", "<p>You have uncommitted changes. Git stops if the new commits touch the same files.</p>", [["stash", "📦 Stash them, pull, then put them back", "primary-s"], ["go", "Pull anyway"], ["cancel", "Cancel"]]);
        if (c === "cancel") return done();
        if (c === "stash") { await gitApi("/stash/push", { repo: id, message: "JiraTime: before pull" }); st.stashedForPull = true; }
      }
      busy("Pulling…");
      try { const r = await gitApi("/pull", { repo: id, mode: "ff" }); toast(/up.to.date/i.test(r.output || "") ? "Already up to date" : "Pulled the newest commits"); }
      catch (e) {
        if (!/fast-forward|diverg/i.test(e.message)) throw e;
        const c = await GLL.ask(`${st.branch} changed on GitLab and on this laptop`, "<p>Both sides have commits the other does not have. How should they be combined?</p>", [["merge", "⤵ Merge GitLab's commits into mine", "primary-s"], ["rebase", "Rebase my commits on top of GitLab's"], ["leave", "Leave it for now"]]);
        if (c !== "leave") {
          const r = await gitApi("/pull", { repo: id, mode: c });
          if (r.conflicts) {
            const d = await GLL.ask("Conflicts", `<p>Some files were changed on both sides. Resolve them now, or undo the ${c}.</p>`, [["resolve", "🧩 Resolve conflicts", "primary-s"], ["abort", `Undo the ${c}`, "danger"]]);
            if (d === "abort") await gitApi("/abort", { repo: id }); else { GLL.state.sub = "conflicts"; GLL.open(id); GLL.state.sub = "conflicts"; return; }
          } else toast(`Up to date (${c})`);
        }
      }
      if (st.stashedForPull) {
        const r = await gitApi("/stash/pop", { repo: id, ref: "stash@{0}" }).catch((e) => ({ err: e.message }));
        if (r.conflicts) { toast("Your changes clash with the new commits — resolve them"); GLL.state.sub = "conflicts"; GLL.open(id); return; }
        if (r.err) toast("Pulled. Your changes are still in Stashes: " + r.err); else toast("Pulled and your changes are back");
      }
      return done();
    }
    if (act === "push") {
      const st = await gitApi(`/status?repo=${id}`);
      if (!st.upstream && !await uiConfirm(`Push the new branch “${st.branch}” to GitLab?`, { title: "Push new branch?", ok: "Push", danger: false })) return;
      if (st.files.some((f) => !f.untracked) && !st.ahead && st.upstream) { toast("Nothing to push — commit your changes first"); return GLL.open(id); }
      busy("Pushing…");
      const r = await gitApi("/push", { repo: id }); toast(`Pushed ${r.status.branch} ✓`); done();
      const repo = GLL.state.repos.find((x) => x.id === id), p = repo && GLL.project(repo);
      if (p && window.GLM && r.status.branch !== (r.status.defaultBranch || p.branch) && await uiConfirm(`Open a merge request for ${r.status.branch}?`, { title: "Pushed ✓", ok: "🔀 Prepare merge request", cancel: "Not now", danger: false })) GLM.prepare(p, r.status.branch, r.status.defaultBranch || p.branch, repo);
    }
  } catch (e) { toast(e.message.split("\n").slice(-3).join(" ")); done(); }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-glkgit]"); if (b && !b.disabled) glkGit(b.dataset.glkgit); });

/** Choose any GitLab project for Kiro (a review copy is prepared if it is not on this laptop). */
function glkPickProject() {
  const all = glRanked().map((x) => x.p);
  openModal(`<div class="gl-det" data-gldet="0"><h3>${glkIco()} Which project should ${glkE()} look at?</h3>
    <input id="glkPq" placeholder="Search your ${all.length} GitLab projects…" style="width:100%;margin:6px 0 10px" autocomplete="off"><div id="glkPl" class="glr-pl"></div>
    <p class="muted tiny">Projects not on this laptop get a review copy in JiraTime's cache — your Local repos stay as they are.</p><div class="foot"><button data-glact="closedet">Cancel</button></div></div>`);
  const draw = () => { const q = $("#glkPq").value.toLowerCase().split(/\s+/).filter(Boolean);
    $("#glkPl").innerHTML = all.filter((p) => q.every((t) => p.path.toLowerCase().includes(t))).slice(0, 80).map((p) => { const l = GLL.localFor(p, { cache: true });
      return `<div class="gllf-i" data-glkp="${p.id}"><span>${l && !l.kiroCache ? "📦" : l ? "🗂" : "▤"}</span><span class="gllf-n"><b>${esc(p.name)}</b> <span class="muted tiny">${esc(p.ns)}</span></span><span class="muted tiny">${l && !l.kiroCache ? "on this laptop" : l ? "review copy" : "not downloaded"}</span></div>`; }).join("") || '<p class="muted tiny">No project matches.</p>'; };
  $("#glkPq").oninput = draw; draw(); setTimeout(() => $("#glkPq").focus(), 30);
  $("#glkPl").onclick = (e) => { const it = e.target.closest("[data-glkp]"); if (!it) return; const p = all.find((x) => x.id === +it.dataset.glkp); if (p) glkForProject(p); };
}
async function glkPost(i) {
  const h = glkHist.get(GLK2.repo), m = h[+i]; if (!m?.mr) return;
  const text = glkSplit(m.out).answer;
  if (!await uiConfirm(`Post this review as a comment on merge request !${m.mr.iid}? Everybody on the merge request sees it.`, { title: "Post review on GitLab?", ok: "Post comment", danger: false })) return;
  try {
    await glApi(`/projects/${m.mr.pid}/merge_requests/${m.mr.iid}/notes`, { method: "POST", body: { body: `### ${GLK2.engine === "cursor" ? "⬛" : "🤖"} Code review (${glkE()} via JiraTime)\n\n${text}` } });
    m.posted = true; glkHist.set(GLK2.repo, h); glkDraw(); toast(`Posted on !${m.mr.iid}`);
  } catch (e) { toast(e.message); }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-glkpost]"); if (b) glkPost(b.dataset.glkpost); });

/** List / remove the review copies in JiraTime's cache. */
async function glkCache() {
  openModal('<div class="gl-det" data-gldet="0"><h3>🗂 Review copies</h3><p class="muted"><span class="spin"></span> Measuring…</p></div>');
  let c; try { c = await gitApi("/kiro/cache"); } catch (e) { $("#modalBox").innerHTML = `<div class="warnbox">${esc(e.message)}</div><div class="foot"><button data-glact="closedet">Close</button></div>`; return; }
  const mb = (n) => (n >= 1024 ? (n / 1024).toFixed(1) + " GB" : n + " MB");
  $("#modalBox").innerHTML = `<div class="gl-det" data-gldet="0"><h3>🗂 Review copies</h3>
    <p class="muted tiny">Copies of GitLab projects that JiraTime downloaded for Kiro because they are not cloned on this laptop. Your own clones in Local repos are never touched here.</p>
    <div class="stats gl-stats" style="grid-template-columns:repeat(3,minmax(0,1fr))"><div class="stat"><b>${c.copies.length}</b><span>review copies</span></div><div class="stat"><b>${mb(c.totalMB)}</b><span>on disk</span><small>limit ${mb(c.maxMB)}</small></div><div class="stat"><b>${c.days} days</b><span>auto-clean</span><small>unused copies are removed</small></div></div>
    <table class="gl-tbl">${c.copies.map((x) => `<tr><td><b>${esc(x.name)}</b><small class="muted">${esc(x.path.replace(/^\/home\/[^/]+/, "~"))}</small></td><td class="nowrap">${mb(x.mb)}</td><td class="muted tiny nowrap">used ${esc(ago(x.usedAt))}</td>
      <td>${x.busy ? '<span class="muted tiny">Kiro is working</span>' : `<button class="small ghost danger" data-glkrmcache="${esc(x.id)}">🗑 Remove</button>`}</td></tr>`).join("") || '<tr><td class="muted">No review copies.</td></tr>'}</table>
    <p class="muted tiny">Cleaned automatically: copies not used for ${c.days} days are removed, and the oldest ones go when all copies together pass ${mb(c.maxMB)}. A removed copy is downloaded again the next time you ask Kiro about that project.</p>
    <div class="foot">${c.copies.length ? '<button class="danger" data-glkrmcache="__all">Remove all</button>' : ""}<span class="grow"></span><button data-glact="closedet" class="primary">Close</button></div></div>`;
  $("#modalBox").querySelectorAll("[data-glkrmcache]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation(); const id = b.dataset.glkrmcache, all = id === "__all";
    if (!await uiConfirm(all ? `Remove all ${c.copies.length} review copies (${mb(c.totalMB)})?` : `Remove the review copy of ${c.copies.find((x) => x.id === id)?.name}?`, { title: "Free up disk space?", ok: "Remove" })) return;
    try {
      const r = await gitApi("/kiro/cache/remove", all ? { all: true } : { repo: id });
      toast(all ? `Removed ${r.removed} review cop${r.removed === 1 ? "y" : "ies"}${r.busy ? ` (${r.busy} in use kept)` : ""}` : "Removed");
      await GLL.load(true).catch(() => {});
      if (!GLL.state.repos.some((x) => x.id === GLK2.repo)) GLK2.repo = "";
      if (glkAgentTab()) await glkRenderTab(); glkCache();
    } catch (err) { toast(err.message); }
  }));
}

Object.assign(GL_ACTIONS, {
  glkcache: () => glkCache(),
  glkpick: () => glkPickProject(),
  glkrecheck: async () => { await gitApi(`/kiro/status?force=1&engine=${GLK2.engine}`).catch(() => {}); glkRenderTab(); },
  glkmode: (m) => { GLK2.mode = m; glkRenderTab(); },
  glknew: () => { if (GLK2.job) return toast("Wait for the current answer first"); glkSys("New conversation"); GLK2.fresh = true; toast("The next message starts a new conversation"); },
  glkquick: (i) => { const [l, t] = GLK_QUICK[+i]; glkSend(t, { label: l }); },
  glkreview: () => glkSend("Review my uncommitted changes", { review: { kind: "local" }, label: "🔍 Review my changes" }),
  kiroproject: (pid) => { const p = GL.projects.find((x) => x.id === +pid); if (p) glkForProject(p, null, "kiro"); },
  cursormr: () => GL_ACTIONS.kiromr("cursor"),
  cursorproject: (pid) => { const p = GL.projects.find((x) => x.id === +pid); if (p) glkForProject(p, null, "cursor"); },
  kiromr: (engine) => {
    const c = GLMS.cur, m = c?.mr, p = m && glmProj(c.pid); if (!p) return;
    glkForProject(p, { mr: { pid: c.pid, iid: m.iid }, text: `Review merge request !${m.iid}: ${glmStripDraft(m.title)}`, label: `🔍 Review !${m.iid}`, body: { kind: "mr", iid: m.iid, title: glmStripDraft(m.title), description: m.description || "", source: m.source_branch, target: m.target_branch } }, engine === "cursor" ? "cursor" : "kiro");
  },
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-glkcopy]"); if (!b) return;
  const m = glkHist.get(GLK2.repo)[+b.dataset.glkcopy]; if (m) navigator.clipboard.writeText(glkSplit(m.out).answer).then(() => toast("Copied")).catch(() => toast("Copy failed"));
});
glAddTab({ id: "kiro", icon: "🤖", label: "Kiro", render: () => glkRenderTab("kiro"), refresh: () => {} }, "local");
glAddTab({ id: "cursor", icon: "⬛", label: "Cursor", render: () => glkRenderTab("cursor"), refresh: () => {} }, "kiro");
window.GLKIRO = { forProject: glkForProject, setRepo: (id) => { if (GLK2.repo !== id) GLK2.att = []; GLK2.repo = id; localStorage.setItem("jiratime.kiro.repo", id); }, prefill: (t) => { GLK2.prefill = t; } };
