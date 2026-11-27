"use strict";
/* 🤖 Kiro tab: chat with Kiro CLI inside a repository on this laptop (analysis, code review, explanations, edits).
   Kiro runs through the JiraTime helper with the user's own Kiro login. Conversations continue per repository. */

const GLK2 = { repo: localStorage.getItem("jiratime.kiro.repo") || "", mode: "ask", st: null, job: null, poll: null, branches: null, att: [], prefill: "" };
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
  if (!repos.length) { body.innerHTML = `<div class="card gll-hero"><h3>🤖 Kiro</h3><p class="muted">Pick any GitLab project — JiraTime gets a review copy for Kiro, no clone needed.</p><button class="small primary-s" data-glact="glkpick">＋ Choose a GitLab project</button></div>`; return; }
  body.innerHTML = `<div class="glk-wrap">
    <div class="card glk-bar">
      <label>Repository <select id="glkRepo"><optgroup label="On this laptop">${repos.filter((r) => !r.kiroCache).map((r) => `<option value="${esc(r.id)}" ${r.id === GLK2.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("")}</optgroup>
        ${repos.some((r) => r.kiroCache) ? `<optgroup label="Review copies (any GitLab project)">${repos.filter((r) => r.kiroCache).map((r) => `<option value="${esc(r.id)}" ${r.id === GLK2.repo ? "selected" : ""}>${esc(r.remotePath || r.name)}</option>`).join("")}</optgroup>` : ""}
        <option value="__pick">＋ Any GitLab project…</option></select></label>
      <label>Branch <select id="glkBr"><option>…</option></select></label>
      <div class="gl-seg" title="What Kiro may do"><button class="${GLK2.mode === "ask" ? "on" : ""}" data-glact="glkmode:ask">👁 Read only</button><button class="${GLK2.mode === "edit" ? "on" : ""}" data-glact="glkmode:edit">✎ May edit files</button></div>
      <span class="grow"></span><span class="muted tiny" title="${esc(st.who || "")}">Kiro CLI ${esc((st.version || "").replace(/^kiro-cli\s*/, ""))}</span>
      <button class="small" data-glact="glkreview:local">🔍 Review my changes</button><button class="small" data-glact="glknew" title="Start a fresh conversation">＋ New chat</button></div>
    <div class="card glk-chat"><div id="glkLog" class="glk-log"></div>
      <div class="glk-quick">${GLK_QUICK.map(([l], i) => `<button class="small ghost" data-glact="glkquick:${i}">${esc(l)}</button>`).join("")}</div>
      <div id="glkAtt" class="glk-att"></div>
      <div class="glk-in"><label class="glk-clip" title="Attach screenshots, images or documents (PDF, Word, Excel, text, logs…)">📎<input type="file" id="glkFile" multiple hidden accept="image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.log,.json,.csv,.xml,.yml,.yaml,.properties,.sql,.java,.js,.ts,.py,.html,.har,.diff,.patch"></label>
        <textarea id="glkQ" rows="3" placeholder="Ask Kiro about this repository… Paste a screenshot with Ctrl+V or drop files here. (Enter = send, Shift+Enter = new line)"></textarea>
        <div class="glk-send"><button class="primary" id="glkGo" style="width:auto;margin:0">Send</button><button class="small danger hidden" id="glkStop">■ Stop</button></div></div>
      <p class="muted tiny glk-note">Runs Kiro CLI on this laptop inside the repository with your Kiro login. ${GLK2.mode === "edit" ? "<b>Kiro may change files</b> — check them in Local repos → Changes before you commit." : "Read only: Kiro cannot change files."} Kiro never runs shell / git commands from here.</p></div></div>`;
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
      sel.disabled = true;
      const st = await GLL.switchBranch(GLK2.repo, name, { remote: k === "R" }).catch((e) => { toast(e.message); return null; });
      if (st) glkSys(`Switched to branch ${st.branch} and pulled the latest${st.state ? ` — ${st.state} in progress, resolve it in Local repos` : ""}`);
      if (GL.tab !== "kiro") return;
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
    return `<div class="glk-m ai"><div class="glk-av">🤖</div><div class="glk-b">
      ${sp.activity.length ? `<details class="glk-act" ${live && !sp.answer ? "open" : ""}><summary>${live ? '<span class="spin"></span> ' : ""}${sp.activity.filter((x) => /using tool/.test(x)).length} step${sp.activity.filter((x) => /using tool/.test(x)).length === 1 ? "" : "s"} — files Kiro looked at</summary><div>${sp.activity.slice(-80).map((x) => `<div>${esc(x)}</div>`).join("")}</div></details>` : live ? '<div class="muted tiny"><span class="spin"></span> Kiro is thinking…</div>' : ""}
      ${sp.answer ? `<div class="glk-ans">${glkMd(sp.answer)}</div>` : ""}
      ${m.error ? `<div class="warnbox tiny">⚠ ${esc(m.error)}</div>` : ""}
      ${!live ? `<div class="glk-meta muted tiny">${m.status === "stopped" ? "stopped · " : ""}${esc(m.credits || "")}${sp.answer ? ` <button class="small ghost" data-glkcopy="${h.indexOf(m)}">⧉ Copy</button>` : ""}${sp.answer && m.mr ? (m.posted ? ` <span class="b new">posted on !${m.mr.iid}</span>` : ` <button class="small primary-s" data-glkpost="${h.indexOf(m)}">💬 Post on !${m.mr.iid}</button>`) : ""}</div>` : ""}</div></div>`;
  }).join("") || `<div class="glk-empty"><b>Ask anything about this repository</b><p class="muted tiny">e.g. “Where is the quote id generated?”, “Why could this API return 500?”, “Review the changes on this branch”.</p></div>`;
  el.scrollTop = el.scrollHeight;
}
async function glkSend(text, opts = {}) {
  const q = text ?? $("#glkQ")?.value.trim(); if (!q) return;
  if (GLK2.job) { toast("Kiro is still answering — wait or press Stop"); return; }
  if (GLK2.att.some((a) => a.busy)) { toast("Wait until the attachments are uploaded"); return; }
  const att = opts.review ? [] : GLK2.att.filter((a) => a.id);
  const fresh = opts.fresh ?? !!GLK2.fresh; GLK2.fresh = false;       // first message after "New chat"
  try {
    const job = opts.review ? await gitApi("/kiro/review", { repo: GLK2.repo, ...opts.review }) : await gitApi("/kiro/ask", { repo: GLK2.repo, prompt: q, mode: GLK2.mode, fresh, attachments: att.map((a) => a.id) });
    if (att.length) { GLK2.att = []; glkAttDraw(); }
    if ($("#glkQ") && text == null) $("#glkQ").value = "";
    const h = glkHist.get(GLK2.repo); h.push({ role: "user", text: q, label: opts.label || (GLK2.mode === "edit" ? "may edit" : ""), files: att.map((a) => ({ name: a.name, kind: a.kind, thumb: a.thumb || "" })), at: Date.now() }); glkHist.set(GLK2.repo, h);
    glkAttach(job, opts.mr);
  } catch (e) { toast(e.message); }
}
function glkAttach(job, mr) {
  const repo = GLK2.repo, h = glkHist.get(repo);
  let msg = h.find((m) => m.role === "ai" && m.job === job.id);
  if (!msg) { msg = { role: "ai", job: job.id, out: job.out || "", live: true, at: Date.now(), ...(mr ? { mr } : {}) }; h.push(msg); glkHist.set(repo, h); }
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
  let r = GLL.localFor(p, { cache: true });
  if (!r) { try { r = await GLL.reviewCopy(p); } catch (e) { toast(e.message); return; } }
  GLK2.repo = r.id; localStorage.setItem("jiratime.kiro.repo", r.id); closeModal(); glGo("kiro");
  if (review) { await sleep(500); if (GL.tab === "kiro") glkSend(review.text, { review: review.body, label: review.label, mr: review.mr }); }
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

/** Choose any GitLab project for Kiro (a review copy is prepared if it is not on this laptop). */
function glkPickProject() {
  const all = glRanked().map((x) => x.p);
  openModal(`<div class="gl-det" data-gldet="0"><h3>🤖 Which project should Kiro look at?</h3>
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
    await glApi(`/projects/${m.mr.pid}/merge_requests/${m.mr.iid}/notes`, { method: "POST", body: { body: `### 🤖 Code review (Kiro via JiraTime)\n\n${text}` } });
    m.posted = true; glkHist.set(GLK2.repo, h); glkDraw(); toast(`Posted on !${m.mr.iid}`);
  } catch (e) { toast(e.message); }
}
document.addEventListener("click", (e) => { const b = e.target.closest("[data-glkpost]"); if (b) glkPost(b.dataset.glkpost); });

Object.assign(GL_ACTIONS, {
  glkpick: () => glkPickProject(),
  glkrecheck: async () => { await gitApi("/kiro/status?force=1").catch(() => {}); glkRenderTab(); },
  glkmode: (m) => { GLK2.mode = m; glkRenderTab(); },
  glknew: () => { if (GLK2.job) return toast("Wait for the current answer first"); glkSys("New conversation"); GLK2.fresh = true; toast("The next message starts a new conversation"); },
  glkquick: (i) => { const [l, t] = GLK_QUICK[+i]; glkSend(t, { label: l }); },
  glkreview: () => glkSend("Review my uncommitted changes", { review: { kind: "local" }, label: "🔍 Review my changes" }),
  kiroproject: (pid) => { const p = GL.projects.find((x) => x.id === +pid); if (p) glkForProject(p); },
  kiromr: () => {
    const c = GLMS.cur, m = c?.mr, p = m && glmProj(c.pid); if (!p) return;
    glkForProject(p, { mr: { pid: c.pid, iid: m.iid }, text: `Review merge request !${m.iid}: ${glmStripDraft(m.title)}`, label: `🔍 Review !${m.iid}`, body: { kind: "mr", iid: m.iid, title: glmStripDraft(m.title), description: m.description || "", source: m.source_branch, target: m.target_branch } });
  },
});
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-glkcopy]"); if (!b) return;
  const m = glkHist.get(GLK2.repo)[+b.dataset.glkcopy]; if (m) navigator.clipboard.writeText(glkSplit(m.out).answer).then(() => toast("Copied")).catch(() => toast("Copy failed"));
});
glAddTab({ id: "kiro", icon: "🤖", label: "Kiro", render: () => glkRenderTab(), refresh: () => {} }, "local");
window.GLKIRO = { forProject: glkForProject, setRepo: (id) => { if (GLK2.repo !== id) GLK2.att = []; GLK2.repo = id; localStorage.setItem("jiratime.kiro.repo", id); }, prefill: (t) => { GLK2.prefill = t; } };
