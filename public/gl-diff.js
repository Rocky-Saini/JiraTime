"use strict";
/* Shared diff viewer, remote commit viewer, Jira-key links and rule-based "smart summaries" for the GitLab workspace.
   No AI service is connected: summaries are produced by fixed rules from the real diff, and nothing leaves the laptop. */

// ================= parsing =================
/** Unified diff text (git diff / git show) -> [{ oldPath, newPath, status, header[], hunks[], added, removed, binary }] */
function gldParse(text) {
  const files = []; let f = null, h = null, o = 0, n = 0;
  const all = String(text || "").split("\n");
  for (let li = 0; li < all.length; li++) {
    const raw = all[li];
    if (raw === "" && li === all.length - 1) break;                  // final newline
    if (raw.startsWith("diff --git ")) {
      const m = raw.match(/^diff --git a\/(.+?) b\/(.+)$/) || [];
      f = { oldPath: m[1] || "", newPath: m[2] || "", status: "modified", header: [raw], hunks: [], added: 0, removed: 0, binary: false }; files.push(f); h = null; continue;
    }
    if (!f) continue;
    if (!h) {
      if (raw.startsWith("@@")) { /* fall through to hunk */ }
      else {
        f.header.push(raw);
        if (raw.startsWith("new file mode")) f.status = "added";
        else if (raw.startsWith("deleted file mode")) f.status = "deleted";
        else if (raw.startsWith("rename from ")) { f.status = "renamed"; f.oldPath = raw.slice(12); }
        else if (raw.startsWith("rename to ")) f.newPath = raw.slice(10);
        else if (/^Binary files /.test(raw)) f.binary = true;
        continue;
      }
    }
    if (raw.startsWith("@@")) {
      const m = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
      h = { header: raw, ctx: m ? m[3].trim() : "", lines: [] }; o = m ? +m[1] : 0; n = m ? +m[2] : 0; f.hunks.push(h); continue;
    }
    if (raw === "") { h.lines.push({ t: " ", text: "", o: o++, n: n++, raw: " " }); continue; }   // blank context line with its space stripped
    const t = raw[0];
    if (t === "+") { h.lines.push({ t, text: raw.slice(1), n: n++, raw }); f.added++; }
    else if (t === "-") { h.lines.push({ t, text: raw.slice(1), o: o++, raw }); f.removed++; }
    else if (t === "\\") h.lines.push({ t, text: raw, raw });
    else { h.lines.push({ t: " ", text: raw.slice(1), o: o++, n: n++, raw }); }
  }
  return files;
}
/** GitLab API diffs ([{old_path,new_path,diff,new_file,deleted_file,renamed_file}]) -> same shape as gldParse. */
function gldFromApi(list) {
  return (list || []).map((d) => {
    const status = d.new_file ? "added" : d.deleted_file ? "deleted" : d.renamed_file ? "renamed" : "modified";
    const text = `diff --git a/${d.old_path} b/${d.new_path}\n` + (d.diff || "");
    const f = gldParse(text)[0] || { hunks: [], added: 0, removed: 0, header: [] };
    return { ...f, oldPath: d.old_path, newPath: d.new_path, status, binary: !d.diff && !d.too_large && !d.collapsed && !(d.new_file || d.deleted_file), tooLarge: !!(d.too_large || d.collapsed) };
  });
}
/** The patch git apply needs to stage / unstage / discard one hunk. */
const gldHunkPatch = (f, hk) => [...f.header, hk.header, ...hk.lines.map((l) => l.raw)].join("\n") + "\n";

// ================= syntax highlighting (light, line based) =================
const GLD_KW = {
  js: "async await break case catch class const continue default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while yield null undefined true false",
  java: "abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new package private protected public return short static super switch synchronized this throw throws try void volatile while null true false var record",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false",
  sql: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as distinct null is in like between case when then else end primary key foreign references",
  sh: "if then else elif fi for while do done case esac function return in export local echo exit",
};
const GLD_EXT = { js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js", cjs: "js", json: "js", java: "java", kt: "java", scala: "java", groovy: "java", gradle: "java", cs: "java", py: "py", go: "go", sql: "sql", sh: "sh", bash: "sh", yml: "yaml", yaml: "yaml", properties: "yaml", xml: "xml", html: "xml", vue: "xml" };
const gldKwRe = {};
function gldLang(p) { return GLD_EXT[String(p || "").split(".").pop().toLowerCase()] || ""; }
function gldHl(text, lang) {
  const s = String(text);
  if (!lang || s.length > 600) return esc(s);
  const kw = GLD_KW[lang];
  const re = gldKwRe[lang] ||= new RegExp([
    lang === "py" || lang === "sh" || lang === "yaml" ? "(#.*$)" : lang === "sql" ? "(--.*$)" : "(\\/\\/.*$|\\/\\*.*?(?:\\*\\/|$))",
    "(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
    "(\\b\\d+(?:\\.\\d+)?\\b)",
    kw ? `(\\b(?:${kw.split(" ").join("|")})\\b)` : "(?!x)x",
    lang === "yaml" ? "(^\\s*[\\w.-]+(?=\\s*[:=]))" : lang === "xml" ? "(<\\/?[\\w:-]+|\\/?>)" : "(?!x)x",
  ].join("|"), lang === "sql" ? "gi" : "g");
  let out = "", last = 0;
  s.replace(re, (m, c, str, num, k, key, idx) => {
    const at = typeof idx === "number" ? idx : s.indexOf(m, last);
    out += esc(s.slice(last, at)) + `<span class="${c ? "tk-c" : str ? "tk-s" : num ? "tk-n" : k ? "tk-k" : "tk-a"}">${esc(m)}</span>`;
    last = at + m.length; return m;
  });
  return out + esc(s.slice(last));
}

// ================= rendering =================
const GLD_ST = { added: ["A", "new"], deleted: ["D", "bad"], renamed: ["R", "diff"], modified: ["M", "skip"], copied: ["C", "skip"], untracked: ["U", "new"] };
const GLDS = { mode: localStorage.getItem("jiratime.gl.diffmode") || "split", seq: 0 };

/** HTML for a list of parsed files. opts.hunkActions(fileIndex, hunkIndex) -> html; opts.fileActions(fileIndex) -> html; opts.single = no file list */
function gldRender(files, opts = {}) {
  const id = "gd" + (++GLDS.seq), mode = opts.mode || GLDS.mode, MAXL = 4000;
  const tot = files.reduce((a, f) => [a[0] + f.added, a[1] + f.removed], [0, 0]);
  const list = opts.single || files.length < 2 ? "" : `<div class="gd-files">${files.map((f, i) => {
    const [l, c] = GLD_ST[f.status] || GLD_ST.modified;
    return `<a href="#${id}-f${i}" class="gd-fl" data-gdjump="${id}-f${i}"><span class="b ${c}">${l}</span><span class="gd-fp" title="${esc(f.newPath)}">${esc(f.newPath)}</span><span class="gd-st"><span class="st-success">+${f.added}</span> <span class="st-failed">−${f.removed}</span></span></a>`;
  }).join("")}</div>`;
  let budget = MAXL;
  const body = files.map((f, i) => {
    const [l, c] = GLD_ST[f.status] || GLD_ST.modified, lang = gldLang(f.newPath);
    let inner = "";
    if (f.binary) inner = '<div class="gd-note">Binary file — not shown</div>';
    else if (f.tooLarge) inner = '<div class="gd-note">GitLab did not send this diff (too large). Open it in GitLab.</div>';
    else if (!f.hunks.length) inner = `<div class="gd-note">${f.status === "renamed" ? "Renamed without changes" : "No changes to show"}</div>`;
    else if (budget <= 0) inner = '<div class="gd-note">Diff too long to show here — open the file on its own.</div>';
    else inner = f.hunks.map((hk, j) => { budget -= hk.lines.length; return gldHunk(hk, lang, mode) .replace("<!--act-->", opts.hunkActions ? opts.hunkActions(i, j) : ""); }).join("");
    const nm = f.status === "renamed" && f.oldPath !== f.newPath ? `${esc(f.oldPath)} → ${esc(f.newPath)}` : esc(f.newPath);
    return `<section class="gd-file" id="${id}-f${i}"><header class="gd-fh"><span class="b ${c}">${l}</span><b class="gd-name">${nm}</b>
      <span class="gd-st"><span class="st-success">+${f.added}</span> <span class="st-failed">−${f.removed}</span></span><span class="grow"></span>${opts.fileActions ? opts.fileActions(i) : ""}</header>${inner}</section>`;
  }).join("");
  return `<div class="gd" id="${id}" data-mode="${mode}">
    <div class="gd-bar"><span class="muted tiny">${files.length} file${files.length === 1 ? "" : "s"} · <span class="st-success">+${tot[0]}</span> <span class="st-failed">−${tot[1]}</span></span>
      <span class="grow"></span><input class="gd-q" placeholder="Search in diff…" aria-label="Search in diff">
      <span class="gd-seg"><button class="small ${mode === "split" ? "on" : ""}" data-gdmode="split">Side by side</button><button class="small ${mode === "inline" ? "on" : ""}" data-gdmode="inline">Inline</button></span></div>
    ${list}<div class="gd-body">${body || '<div class="gd-note">No changes</div>'}</div></div>`;
}
function gldHunk(hk, lang, mode) {
  const row = (cls, on, nn, sign, html) => `<tr class="${cls}"><td class="ln">${on ?? ""}</td><td class="ln">${nn ?? ""}</td><td class="sg">${sign}</td><td class="cd">${html}</td></tr>`;
  let rows = "";
  if (mode === "inline") {
    for (const l of hk.lines) rows += l.t === "\\" ? `<tr class="nl"><td colspan="4">${esc(l.text)}</td></tr>` : row(l.t === "+" ? "add" : l.t === "-" ? "del" : "ctx", l.o, l.n, l.t === " " ? "" : l.t, gldHl(l.text, lang));
    return `<div class="gd-hunk"><div class="gd-hh"><code>${esc(hk.header.replace(/ @@.*$/, " @@"))}</code><span class="muted tiny">${esc(hk.ctx)}</span><span class="grow"></span><!--act--></div><table class="gd-t gd-inline">${rows}</table></div>`;
  }
  // side by side: pair each run of removed lines with the following run of added lines
  const L = hk.lines.filter((l) => l.t !== "\\"); let i = 0;
  const cell = (l, side) => l ? `<td class="ln">${side === "o" ? l.o : l.n}</td><td class="cd ${l.t === "-" ? "del" : l.t === "+" ? "add" : ""}">${gldHl(l.text, lang)}</td>` : '<td class="ln"></td><td class="cd empty"></td>';
  while (i < L.length) {
    if (L[i].t === " ") { rows += `<tr>${cell(L[i], "o")}${cell(L[i], "n")}</tr>`; i++; continue; }
    const del = [], add = [];
    while (i < L.length && L[i].t === "-") del.push(L[i++]);
    while (i < L.length && L[i].t === "+") add.push(L[i++]);
    for (let k = 0; k < Math.max(del.length, add.length); k++) rows += `<tr>${cell(del[k], "o")}${cell(add[k], "n")}</tr>`;
  }
  return `<div class="gd-hunk"><div class="gd-hh"><code>${esc(hk.header.replace(/ @@.*$/, " @@"))}</code><span class="muted tiny">${esc(hk.ctx)}</span><span class="grow"></span><!--act--></div><table class="gd-t gd-split">${rows}</table></div>`;
}
/** Wire search / mode / jump for every .gd inside root. rerender(mode) is called when the user switches mode. */
function gldWire(root, rerender) {
  root.querySelectorAll(".gd").forEach((gd) => {
    gd.querySelectorAll("[data-gdmode]").forEach((b) => b.addEventListener("click", () => { GLDS.mode = b.dataset.gdmode; localStorage.setItem("jiratime.gl.diffmode", GLDS.mode); rerender?.(GLDS.mode); }));
    gd.querySelectorAll("[data-gdjump]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); document.getElementById(a.dataset.gdjump)?.scrollIntoView({ behavior: "smooth", block: "start" }); }));
    const q = gd.querySelector(".gd-q"); let t;
    q?.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => {
      const v = q.value.trim().toLowerCase(); let hits = 0;
      gd.querySelectorAll("td.cd").forEach((td) => { const on = v && td.textContent.toLowerCase().includes(v); td.classList.toggle("hit", on); if (on) hits++; });
      gd.querySelectorAll(".gd-file").forEach((s) => s.classList.toggle("nohit", !!v && !s.querySelector("td.hit") && !s.querySelector(".gd-name").textContent.toLowerCase().includes(v)));
      gd.querySelector(".gd-q").title = v ? `${hits} matching lines` : "";
      gd.querySelector("td.hit")?.scrollIntoView({ block: "center" });
    }, 200); });
  });
}

// ================= Jira links =================
const GLD_KEY = /\b([A-Z][A-Z0-9_]{1,9}-\d{1,7})\b/g;
const gldKeys = (text) => [...new Set(String(text || "").match(GLD_KEY) || [])];
function gldJira(text) {
  const base = creds.get()?.base;
  const e = esc(text);
  return base && /^https:\/\/[a-z0-9-]+\.atlassian\.net$/i.test(base) ? e.replace(GLD_KEY, (k) => `<a class="jira-k" href="${esc(base)}/browse/${k}" target="_blank" rel="noopener noreferrer">${k}</a>`) : e;
}

// ================= smart summary (rule based) =================
const GLD_CAT = [
  ["Tests", /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|Test\.java$/i],
  ["DB / migrations", /\.sql$|migration|liquibase|flyway|changelog.*\.(xml|ya?ml)$/i],
  ["Dependencies", /(^|\/)(pom\.xml|package(-lock)?\.json|yarn\.lock|build\.gradle(\.kts)?|requirements\.txt|go\.(mod|sum)|Pipfile)$/i],
  ["Build / CI / infra", /(^|\/)(\.gitlab-ci\.ya?ml|Dockerfile|Jenkinsfile|docker-compose\.ya?ml)$|(^|\/)(helm|k8s|kubernetes|deploy|terraform|charts)\//i],
  ["Configuration", /\.(ya?ml|properties|env|conf|cfg|ini|toml)$|(^|\/)config\//i],
  ["Docs", /\.(md|adoc|txt|rst)$/i],
];
const GLD_SENSITIVE = /(auth|security|token|password|secret|crypt|jwt|oauth|permission|login)/i;
const GLD_SECRET = /(password|passwd|secret|api[_-]?key|access[_-]?key|private[_-]?key|token)\s*[:=]\s*["']?[A-Za-z0-9+/_\-.]{8,}/i;
function gldCategory(p) { for (const [n, re] of GLD_CAT) if (re.test(p)) return n; return "Code"; }
/** Facts and risk flags from parsed files (+ optional commit list). */
function gldSummary(files, commits = []) {
  const cats = {}, risks = [], added = files.reduce((a, f) => a + f.added, 0), removed = files.reduce((a, f) => a + f.removed, 0);
  for (const f of files) (cats[gldCategory(f.newPath)] ||= []).push(f.newPath);
  const addedLines = files.flatMap((f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.t === "+").map((l) => ({ f: f.newPath, text: l.text }))));
  const secret = addedLines.find((l) => GLD_SECRET.test(l.text) && !/\$\{|process\.env|System\.getenv|os\.environ|<.*>/.test(l.text));
  if (secret) risks.push(`Possible hard-coded secret added in ${secret.f}`);
  if (cats["DB / migrations"]) risks.push(`Database / migration change: ${cats["DB / migrations"].slice(0, 3).join(", ")}`);
  if (cats["Dependencies"]) risks.push(`Dependency change: ${cats["Dependencies"].join(", ")}`);
  if (cats["Configuration"]) risks.push(`Configuration change: ${cats["Configuration"].slice(0, 3).join(", ")}${cats["Configuration"].length > 3 ? "…" : ""}`);
  if (cats["Build / CI / infra"]) risks.push(`Build / deployment change: ${cats["Build / CI / infra"].join(", ")}`);
  const sens = files.filter((f) => GLD_SENSITIVE.test(f.newPath)); if (sens.length) risks.push(`Security-related files: ${sens.slice(0, 3).map((f) => f.newPath).join(", ")}`);
  const delTests = files.filter((f) => f.status === "deleted" && gldCategory(f.newPath) === "Tests"); if (delTests.length) risks.push(`${delTests.length} test file(s) deleted`);
  const big = files.filter((f) => f.added + f.removed > 400); if (big.length) risks.push(`Large change in ${big.slice(0, 3).map((f) => `${f.newPath} (${f.added + f.removed} lines)`).join(", ")}`);
  if (removed > 500 && removed > added * 2) risks.push(`Mostly deletions (${removed} lines removed)`);
  const dbg = addedLines.filter((l) => /\b(console\.log|System\.out\.println|printStackTrace\(\)|debugger;|print\()/.test(l.text)); if (dbg.length) risks.push(`${dbg.length} debug print statement(s) added`);
  const todo = addedLines.filter((l) => /\b(TODO|FIXME|HACK)\b/.test(l.text)); if (todo.length) risks.push(`${todo.length} TODO/FIXME added`);
  if (!cats.Tests && (cats.Code || []).length) risks.push("Code changed but no test files changed");
  const keys = gldKeys(commits.map((c) => `${c.title || ""} ${c.message || ""}`).join(" ") + " " + files.map((f) => f.newPath).join(" "));
  return { files: files.length, added, removed, cats, risks, keys, authors: [...new Set(commits.map((c) => c.author_name || c.author).filter(Boolean))] };
}
function gldSummaryHtml(s, title = "Smart summary") {
  return `<div class="gd-sum"><div class="gd-sum-h">✨ ${esc(title)} <span class="muted tiny">rule-based · nothing is sent to an AI service</span></div>
    <p>${s.files} file${s.files === 1 ? "" : "s"} changed, <span class="st-success">+${s.added}</span> / <span class="st-failed">−${s.removed}</span> lines${s.authors.length ? ` by ${esc(s.authors.slice(0, 5).join(", "))}${s.authors.length > 5 ? "…" : ""}` : ""}.
      ${Object.entries(s.cats).map(([c, l]) => `<span class="b skip">${esc(c)} ${l.length}</span>`).join(" ")}</p>
    ${s.keys.length ? `<p class="tiny">Jira: ${s.keys.map((k) => gldJira(k)).join(" ")}</p>` : ""}
    ${s.risks.length ? `<ul class="gd-risk">${s.risks.map((r) => `<li>⚠ ${esc(r)}</li>`).join("")}</ul>` : '<p class="tiny st-success">No risk patterns found.</p>'}</div>`;
}

// ================= remote commit viewer =================
async function gldOpenRemoteCommit(pid, sha) {
  const p = (GL.projects || []).find((x) => x.id === pid);
  openModal(`<div class="gl-det" data-gldet="${pid}"><h3>Commit ${esc(sha.slice(0, 8))}</h3><p class="muted">Loading…</p></div>`);
  try {
    const [c, diffs, mrs] = await Promise.all([
      glApi(`/projects/${pid}/repository/commits/${sha}?stats=true`).then((r) => r.data),
      glAll(`/projects/${pid}/repository/commits/${sha}/diff`, 5),
      glApi(`/projects/${pid}/repository/commits/${sha}/merge_requests`).then((r) => r.data || []).catch(() => []),
    ]);
    const files = gldFromApi(diffs);
    const draw = () => {
      openModal(`<div class="gl-det gl-wide" data-gldet="${pid}">
        <div class="gl-det-head"><div><h3>${gldJira(c.title)}</h3><div class="muted tiny">${esc(p?.path || "")} · <code class="sha">${esc(c.short_id)}</code> <button class="small ghost" data-glcopy="${esc(c.id)}">⧉ copy hash</button></div></div><div class="grow"></div>${glLink(c.web_url, "Open in GitLab ↗", "small gl-ext")}</div>
        <p class="tiny">${esc(c.author_name)} &lt;${esc(c.author_email)}&gt; · ${esc(fmtDateTime(c.authored_date))}${c.committer_name && c.committer_name !== c.author_name ? ` · committed by ${esc(c.committer_name)}` : ""} · ${c.parent_ids?.length > 1 ? "merge commit" : "1 parent"}</p>
        ${c.message && c.message.trim() !== c.title ? `<pre class="gl-msg">${gldJira(c.message.trim())}</pre>` : ""}
        ${mrs.length ? `<p class="tiny">Merge request: ${mrs.map((m) => glLink(m.web_url, `!${m.iid} ${esc(m.title)}`)).join(" · ")}</p>` : ""}
        ${gldSummaryHtml(gldSummary(files, [c]))}
        <div class="gl-det-body tall">${gldRender(files)}</div>
        <div class="foot"><button data-glact="closedet" class="primary">Close</button></div></div>`);
      gldWire($("#modalBox"), draw);
    };
    draw();
  } catch (e) { openModal(`<h3>Commit</h3><div class="warnbox">⚠ ${esc(e.message)}</div><div class="foot"><button data-glact="closedet">Close</button></div>`); }
}

window.GLD = { parse: gldParse, fromApi: gldFromApi, render: gldRender, wire: gldWire, hunkPatch: gldHunkPatch, summary: gldSummary, summaryHtml: gldSummaryHtml,
  jira: gldJira, keys: gldKeys, category: gldCategory, openRemoteCommit: gldOpenRemoteCommit, hl: gldHl, lang: gldLang };
