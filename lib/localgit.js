"use strict";
// Local Git operations for the JiraTime GitLab workspace (local server only).
// Safety rules:
//  - git is started with execFile/spawn and an argument array: no shell, so user text is never interpreted as a command.
//  - Only repositories registered in ~/.config/jiratime/repos.json can be operated on; the folder browser is limited to $HOME.
//  - The GitLab token is passed to git through GIT_CONFIG_* environment variables for that one command;
//    it is never written to .git/config or into the remote URL.
//  - Destructive actions (discard, hard reset) save a backup first. Force push is not offered.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");
const gitlab = require("./gitlab");
const kiro = require("./kiro");

const HOME = fs.realpathSync(os.homedir());
const REG_FILE = path.join(gitlab.CONFIG_DIR, "repos.json");
const BACKUP_DIR = path.join(gitlab.CONFIG_DIR, "backups");
const MAX_OUT = 30 * 1024 * 1024;
const TEST_FILE_REMOTES = process.env.JIRATIME_TEST === "1";      // tests clone from file:// remotes

// ---------- registry ----------
let REG = (() => { try { return JSON.parse(fs.readFileSync(REG_FILE, "utf8")); } catch { return []; } })();
function saveReg() {
  fs.mkdirSync(gitlab.CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = REG_FILE + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(REG, null, 2), { mode: 0o600 }); fs.renameSync(tmp, REG_FILE);
}
const repoId = (p) => crypto.createHash("sha1").update(p).digest("hex").slice(0, 12);
function getRepo(id) {
  const r = REG.find((x) => x.id === id);
  if (!r) throw httpErr(404, "Repository is not registered in JiraTime");
  if (!fs.existsSync(path.join(r.path, ".git"))) throw httpErr(410, `The folder ${r.path} is no longer a git repository (moved or deleted?)`);
  return r;
}

// ---------- helpers ----------
const httpErr = (status, message) => Object.assign(new Error(message), { status });
const insideHome = (p) => p === HOME || p.startsWith(HOME + path.sep);
function realDir(p) {
  const abs = path.resolve(String(p || "").replace(/^~(?=$|\/)/, HOME));
  let real; try { real = fs.realpathSync(abs); } catch { throw httpErr(404, "Folder not found: " + abs); }
  if (!insideHome(real)) throw httpErr(403, "Only folders inside your home folder can be used");
  if (!fs.statSync(real).isDirectory()) throw httpErr(400, "Not a folder: " + real);
  return real;
}
/** A path inside the repository (relative, no "..", no absolute). */
function relPath(repo, p) {
  const s = String(p || "");
  if (!s || s.includes("\0") || path.isAbsolute(s) || s.split(/[\\/]/).includes("..")) throw httpErr(400, "Invalid file path: " + s);
  const abs = path.resolve(repo.path, s);
  if (!abs.startsWith(repo.path + path.sep)) throw httpErr(400, "Path outside the repository");
  return s;
}
const SHA_RE = /^[0-9a-f]{4,40}$/i;
function checkRev(r) { const s = String(r || ""); if (!s || s.startsWith("-") || s.includes("..") || /[\s~^:?*[\\\0]/.test(s.replace(/\^\{commit\}$/, ""))) throw httpErr(400, "Invalid branch / commit: " + s); return s; }

function baseEnv(extra = {}) {
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_ASKPASS: "true", SSH_ASKPASS: "true",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15", LC_ALL: "C", LANG: "C", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", ...extra };
}
/** Environment that authenticates git against the connected GitLab for HTTPS remotes of that host only. */
async function authEnv(remoteUrl) {
  const c = await gitlab.getCreds();
  if (!c || !remoteUrl) return {};
  let origin; try { origin = new URL(remoteUrl).origin; } catch { return {}; }
  if (origin !== c.url) return {};
  const basic = Buffer.from(`${c.username}:${c.token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${c.url}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}
const scrub = (s, token) => (token ? String(s).split(token).join("****") : String(s));

/** Run git; resolves {code, out, err}. Never throws for a non-zero exit. */
function git(cwd, args, { input, env, timeout = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = execFile("git", args, { cwd, env: env || baseEnv(), timeout, maxBuffer: MAX_OUT, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err && typeof err.code !== "number") {
        if (err.code === "ENOENT") return reject(httpErr(500, "git is not installed on this laptop"));
        if (err.killed) return resolve({ code: 124, out: stdout || "", err: "git took too long and was stopped" });
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return resolve({ code: 125, out: (stdout || "").slice(0, MAX_OUT), err: "output too large" });
        return reject(err);
      }
      resolve({ code: err ? err.code : 0, out: stdout || "", err: stderr || "" });
    });
    if (input != null) { p.stdin.write(input); p.stdin.end(); }
  });
}
async function gitOk(cwd, args, opts) {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw httpErr(409, (r.err || r.out || `git ${args[0]} failed`).trim().split("\n").slice(-6).join("\n"));
  return r.out;
}
async function remoteUrl(dir) { const r = await git(dir, ["remote", "get-url", "origin"]); return r.code === 0 ? r.out.trim() : ""; }
/** "group/sub/project" from https / ssh remote URLs. */
function remotePath(u) {
  const s = String(u || "").trim(); let m;
  if ((m = s.match(/^file:\/\/.*\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i))) return m[1].toLowerCase();       // tests only
  if ((m = s.match(/^[a-z+]+:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/i))) return m[1].toLowerCase();
  if ((m = s.match(/^[^@\s]+@[^:]+:(.+?)(?:\.git)?$/))) return m[1].toLowerCase();
  return "";
}
const remoteHost = (u) => { const s = String(u || ""); let m; if ((m = s.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i))) return m[1].toLowerCase(); if ((m = s.match(/^[^@\s]+@([^:]+):/))) return m[1].toLowerCase(); return ""; };

async function register(dir, extra = {}) {
  const top = (await gitOk(dir, ["rev-parse", "--show-toplevel"])).trim();
  const real = fs.realpathSync(top);
  if (!insideHome(real)) throw httpErr(403, "Repository must be inside your home folder");
  const remote = await remoteUrl(real);
  const id = repoId(real), old = REG.find((r) => r.id === id);
  const rec = { id, path: real, name: path.basename(real), remote, remotePath: remotePath(remote), remoteHost: remoteHost(remote), addedAt: old?.addedAt || new Date().toISOString(), ...extra };
  REG = [...REG.filter((r) => r.id !== id), rec];
  saveReg();
  return rec;
}

// ---------- status ----------
async function gitDir(repo) { return path.resolve(repo.path, (await gitOk(repo.path, ["rev-parse", "--git-dir"])).trim()); }
async function repoState(repo) {
  const g = await gitDir(repo), has = (f) => fs.existsSync(path.join(g, f));
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("MERGE_HEAD")) return "merge";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return "";
}
async function status(repo) {
  const r = await gitOk(repo.path, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  const parts = r.split("\0"); const st = { branch: "", oid: "", upstream: "", ahead: 0, behind: 0, files: [] };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i]; if (!line) continue;
    if (line.startsWith("# branch.head ")) st.branch = line.slice(14);
    else if (line.startsWith("# branch.oid ")) st.oid = line.slice(13);
    else if (line.startsWith("# branch.upstream ")) st.upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) { const m = line.match(/\+(\d+) -(\d+)/); if (m) { st.ahead = +m[1]; st.behind = +m[2]; } }
    else if (line[0] === "1") { const f = line.split(" "); st.files.push(fileRec(f[1], f.slice(8).join(" "))); }
    else if (line[0] === "2") { const f = line.split(" "); st.files.push(fileRec(f[1], f.slice(9).join(" "), parts[++i])); }
    else if (line[0] === "u") { const f = line.split(" "); st.files.push({ ...fileRec(f[1], f.slice(10).join(" ")), conflict: true }); }
    else if (line[0] === "?") st.files.push({ path: line.slice(2), x: "?", y: "?", staged: false, unstaged: true, untracked: true, kind: "untracked" });
  }
  const [state, stash, last, def] = await Promise.all([
    repoState(repo),
    git(repo.path, ["stash", "list"]).then((x) => (x.code ? 0 : x.out.split("\n").filter(Boolean).length)),
    git(repo.path, ["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI"]).then((x) => { if (x.code || !x.out) return null; const [sha, title, author, at] = x.out.trim().split("\x1f"); return { sha, title, author, at }; }),
    git(repo.path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).then((x) => (x.code ? "" : x.out.trim().replace(/^origin\//, ""))),
  ]);
  Object.assign(st, { state, stash, last, defaultBranch: def, remote: repo.remote, path: repo.path, name: repo.name, detached: st.branch === "(detached)" });
  return st;
}
function fileRec(xy, p, orig) {
  const x = xy[0], y = xy[1];
  const kind = x === "A" ? "added" : x === "D" || y === "D" ? "deleted" : x === "R" || y === "R" ? "renamed" : x === "C" ? "copied" : "modified";
  return { path: p, orig: orig || "", x, y, staged: x !== ".", unstaged: y !== ".", kind };
}

// ---------- diff ----------
async function diff(repo, q) {
  const file = relPath(repo, q.path);
  if (q.untracked === "1") {
    const abs = path.join(repo.path, file);
    if (!fs.existsSync(abs)) throw httpErr(404, "File not found");
    if (fs.statSync(abs).size > 3 * 1024 * 1024) return { diff: "", note: "File is larger than 3 MB — not shown" };
    const r = await git(repo.path, ["diff", "--no-index", "--no-color", "--", "/dev/null", file]);
    return { diff: r.out };
  }
  const args = ["diff", "--no-color", "-M", "--no-ext-diff"]; if (q.staged === "1") args.push("--cached"); args.push("--", file);
  const r = await gitOk(repo.path, args);
  return { diff: r.length > 3 * 1024 * 1024 ? "" : r, note: r.length > 3 * 1024 * 1024 ? "Diff larger than 3 MB — not shown" : "" };
}

function backup(repo, files) {
  const dir = path.join(BACKUP_DIR, repo.id, new Date().toISOString().replace(/[:.]/g, "-"));
  let n = 0;
  for (const f of files) {
    const src = path.join(repo.path, f);
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const dst = path.join(dir, f); fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 }); fs.copyFileSync(src, dst); n++;
  }
  return n ? dir : "";
}

// ---------- files in the repository (explorer / editor) ----------
const MAX_EDIT = 2 * 1024 * 1024, MAX_UPLOAD = 25 * 1024 * 1024;
/** Absolute path for a repo-relative path; refuses .git, ".." and symlinks that lead outside the repository. */
function repoFile(repo, rel, { allowRoot = false } = {}) {
  const s = String(rel || "").replace(/^\/+|\/+$/g, "");
  if (!s) { if (allowRoot) return repo.path; throw httpErr(400, "Path required"); }
  relPath(repo, s);
  if (s.split(/[\\/]/)[0] === ".git") throw httpErr(403, "The .git folder cannot be changed here");
  const abs = path.resolve(repo.path, s);
  let probe = abs; while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== repo.path && !real.startsWith(repo.path + path.sep)) throw httpErr(403, "Path leads outside the repository");
  return abs;
}
const validName = (n) => { const s = String(n || "").trim(); if (!s || s.length > 200 || /[\\/\0]/.test(s) || s === "." || s === ".." || s === ".git") throw httpErr(400, "Invalid name: " + s); return s; };
function tree(repo, rel) {
  const dir = repoFile(repo, rel, { allowRoot: true });
  if (!fs.statSync(dir).isDirectory()) throw httpErr(400, "Not a folder");
  const items = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.name === ".git") continue;
    let st; try { st = fs.statSync(path.join(dir, d.name)); } catch { continue; }
    items.push({ name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? null : st.size, at: st.mtime.toISOString() });
  }
  items.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
  return { path: path.relative(repo.path, dir), items: items.slice(0, 3000), more: items.length > 3000 };
}
function readRepoFile(repo, rel) {
  const f = repoFile(repo, rel), st = fs.statSync(f);
  if (!st.isFile()) throw httpErr(400, "Not a file");
  if (st.size > MAX_EDIT) return { path: rel, size: st.size, tooBig: true };
  const buf = fs.readFileSync(f), binary = buf.subarray(0, 8000).includes(0);
  return { path: rel, size: st.size, binary, content: binary ? null : buf.toString("utf8"), at: st.mtime.toISOString() };
}
function writeRepoFile(repo, b) {
  const f = repoFile(repo, b.path), exists = fs.existsSync(f);
  if (b.create && exists) throw httpErr(409, "A file or folder with this name already exists");
  if (exists && !fs.statSync(f).isFile()) throw httpErr(400, "Not a file");
  if (exists && b.at && fs.statSync(f).mtime.toISOString() !== b.at) throw httpErr(409, "The file was changed on disk since you opened it — reload it first");
  const data = b.data != null ? Buffer.from(String(b.data), "base64") : Buffer.from(String(b.content ?? ""), "utf8");
  if (data.length > (b.data != null ? MAX_UPLOAD : MAX_EDIT)) throw httpErr(413, "File too large");
  const bk = exists && !b.create ? backup(repo, [path.relative(repo.path, f)]) : "";
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return { path: path.relative(repo.path, f), size: data.length, at: fs.statSync(f).mtime.toISOString(), backup: bk };
}

/** A patch from the diff viewer: must touch exactly one file of this repo. */
function checkPatch(repo, patch) {
  const s = String(patch || "");
  if (!s.startsWith("diff --git ") || s.length > 5 * 1024 * 1024) throw httpErr(400, "Invalid patch");
  const heads = [...s.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)];
  if (heads.length !== 1) throw httpErr(400, "A patch must change exactly one file");
  relPath(repo, heads[0][1]); relPath(repo, heads[0][2]);
  return heads[0][2];
}

// ---------- branches / log ----------
async function branches(repo) {
  const fmt = ["%(refname)", "%(refname:short)", "%(objectname:short)", "%(upstream:short)", "%(upstream:track)", "%(committerdate:iso-strict)", "%(authorname)", "%(subject)", "%(HEAD)"].join("%1f");
  const out = await gitOk(repo.path, ["for-each-ref", `--format=${fmt}`, "refs/heads", "refs/remotes"]);
  const list = out.split("\n").filter(Boolean).map((l) => {
    const [ref, name, sha, upstream, track, date, author, subject, head] = l.split("\x1f");
    const a = track.match(/ahead (\d+)/), b = track.match(/behind (\d+)/);
    return { ref, name, sha, upstream, ahead: a ? +a[1] : 0, behind: b ? +b[1] : 0, gone: /gone/.test(track), date, author, subject, current: head === "*", remote: ref.startsWith("refs/remotes/") };
  }).filter((b) => !/\/HEAD$/.test(b.name) && b.name !== "origin");
  const def = await git(repo.path, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  return { branches: list, defaultBranch: def.code ? "" : def.out.trim().replace(/^origin\//, "") };
}
async function compare(repo, a, b) {
  a = checkRev(a); b = checkRev(b);
  const [counts, shortstat, names, log, base] = await Promise.all([
    gitOk(repo.path, ["rev-list", "--left-right", "--count", `${a}...${b}`]),
    git(repo.path, ["diff", "--shortstat", `${a}...${b}`]),
    git(repo.path, ["diff", "--name-status", "-M", `${a}...${b}`]),
    git(repo.path, ["log", "--format=%H%x1f%an%x1f%aI%x1f%s", "-n", "200", `${a}..${b}`]),
    git(repo.path, ["merge-base", a, b]),
  ]);
  const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
  const ss = shortstat.out, num = (re) => +(ss.match(re)?.[1] || 0);
  let conflicts = [];
  if (base.code === 0) {
    // git 2.34 "merge-tree": one section per file; a section with conflict markers means that file would conflict
    const mt = await git(repo.path, ["merge-tree", base.out.trim(), a, b]);
    for (const sec of mt.out.split(/\n(?=(?:changed in both|added in (?:both|local|remote)|removed in (?:local|remote)|merged)\n)/)) {
      if (!/^(changed|added) in both/.test(sec) || !/^\+<{7} /m.test(sec)) continue;
      const m = sec.match(/^\s+(?:our|their|base)\s+\d+ [0-9a-f]+ (.+)$/m);
      if (m && !conflicts.includes(m[1])) conflicts.push(m[1]);
    }
  }
  return { a, b, ahead, behind, files: num(/(\d+) files? changed/), added: num(/(\d+) insertions?/), removed: num(/(\d+) deletions?/),
    changes: names.out.split("\n").filter(Boolean).map((l) => { const [s, ...p] = l.split("\t"); return { status: s[0], path: p[p.length - 1], from: p.length > 1 ? p[0] : "" }; }),
    commits: log.out.split("\n").filter(Boolean).map((l) => { const [sha, author, at, title] = l.split("\x1f"); return { sha, author, at, title }; }), conflicts };
}
async function log(repo, q) {
  const n = Math.min(500, Math.max(1, +q.n || 100)), skip = Math.max(0, +q.skip || 0);
  const args = ["log", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D", "-n", String(n), "--skip", String(skip), "--date-order"];
  if (q.author) args.push("--author=" + String(q.author).slice(0, 100));
  if (q.since && /^\d{4}-\d{2}-\d{2}/.test(q.since)) args.push("--since=" + q.since);
  if (q.until && /^\d{4}-\d{2}-\d{2}/.test(q.until)) args.push("--until=" + q.until);
  if (q.grep) args.push("-i", "--grep=" + String(q.grep).slice(0, 200));
  if (q.all === "1") args.push("--all"); else if (q.ref) args.push(checkRev(q.ref));
  const r = await git(repo.path, args);
  if (r.code && /does not have any commits/.test(r.err)) return { commits: [] };
  if (r.code) throw httpErr(409, r.err.trim());
  return { commits: r.out.split("\n").filter(Boolean).map((l) => { const [sha, parents, author, email, at, title, refs] = l.split("\x1f"); return { sha, parents: parents ? parents.split(" ") : [], author, email, at, title, refs }; }) };
}
async function show(repo, sha) {
  if (!SHA_RE.test(sha)) throw httpErr(400, "Invalid commit");
  const [meta, num, patch] = await Promise.all([
    gitOk(repo.path, ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%B", sha]),
    gitOk(repo.path, ["show", "--numstat", "--format=", "-M", sha]),
    git(repo.path, ["show", "--format=", "--no-color", "-M", "--no-ext-diff", sha]),
  ]);
  const [full, parents, author, email, at, committer, cat, body] = meta.split("\x1f");
  const files = num.split("\n").filter(Boolean).map((l) => { const [a, d, ...p] = l.split("\t"); return { added: a === "-" ? null : +a, removed: d === "-" ? null : +d, path: p.join("\t") }; });
  const big = patch.out.length > 4 * 1024 * 1024;
  return { sha: full, parents: parents ? parents.split(" ") : [], author, email, at, committer, committedAt: cat, message: (body || "").trim(), files, diff: big ? "" : patch.out, note: big ? "Diff larger than 4 MB — not shown" : "" };
}

// ---------- conflicts ----------
const MARK_RE = /^(<{7}( |$)|={7}$|>{7}( |$))/m;
async function conflicts(repo) {
  const st = await status(repo);
  const files = [];
  for (const f of st.files.filter((x) => x.conflict)) {
    const abs = path.join(repo.path, f.path);
    let work = ""; try { const s = fs.statSync(abs); work = s.size > 2 * 1024 * 1024 ? null : fs.readFileSync(abs, "utf8"); } catch { work = ""; }
    const stage = async (n) => { const r = await git(repo.path, ["show", `:${n}:${f.path}`]); return r.code ? null : r.out.length > 2 * 1024 * 1024 ? null : r.out; };
    const [base, ours, theirs] = await Promise.all([stage(1), stage(2), stage(3)]);
    files.push({ path: f.path, xy: f.x + f.y, work, base, ours, theirs, tooBig: work === null });
  }
  return { state: st.state, branch: st.branch, files };
}

// ---------- clone jobs ----------
const JOBS = new Map();
const KIRO_CACHE = path.join(HOME, ".cache", "jiratime", "kiro");
function cloneUrlAllowed(u, c) {
  if (TEST_FILE_REMOTES && /^file:\/\//.test(u)) return true;
  try { const x = new URL(u); return x.protocol === "https:" && c && x.origin === c.url; } catch { /* ssh */ }
  const host = remoteHost(u); try { return !!c && host === new URL(c.url).hostname; } catch { return false; }
}
async function startClone(body) {
  const c = await gitlab.getCreds();
  const url = String(body.url || "").trim();
  if (!cloneUrlAllowed(url, c)) throw httpErr(400, "Only repositories of the connected GitLab can be cloned");
  // review copy for Kiro: kept in ~/.cache/jiratime/kiro, files fetched on demand (blobless), hidden from Local repos
  const cache = !!body.kiroCache;
  if (cache) fs.mkdirSync(KIRO_CACHE, { recursive: true });
  const parent = cache ? fs.realpathSync(KIRO_CACHE) : realDir(body.dest);
  const name = (cache ? remotePath(url).replace(/\//g, "__") : String(body.name || remotePath(url).split("/").pop() || "repo")).replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "repo";
  const target = path.join(parent, name);
  if (fs.existsSync(target)) {
    if (fs.existsSync(path.join(target, ".git"))) {
      const r = await remoteUrl(target);
      if (remotePath(r) === remotePath(url)) { const rec = await register(target, { projectId: body.projectId || null, ...(cache ? { kiroCache: true } : {}) }); return { id: null, done: true, existing: true, repo: rec }; }
      throw httpErr(409, `${target} already contains a different git repository`);
    }
    if (fs.readdirSync(target).length) throw httpErr(409, `${target} already exists and is not empty — choose another folder`);
  }
  const id = crypto.randomUUID(), job = { id, status: "running", url, target, progress: "", percent: 0, lines: [], error: "", repo: null, startedAt: Date.now() };
  JOBS.set(id, job);
  const env = baseEnv(await authEnv(url)), token = c?.token;
  const p = spawn("git", ["clone", "--progress", ...(cache ? ["--filter=blob:none"] : []), "--", url, target], { cwd: parent, env, stdio: ["ignore", "pipe", "pipe"] });
  const onData = (buf) => {
    for (const line of scrub(buf.toString(), token).split(/[\r\n]+/).filter(Boolean)) {
      job.progress = line.trim();
      const m = line.match(/(Receiving objects|Resolving deltas|Counting objects|Compressing objects|Updating files):\s+(\d+)%/);
      if (m) job.percent = m[1] === "Receiving objects" ? Math.round(+m[2] * 0.8) : m[1] === "Resolving deltas" ? 80 + Math.round(+m[2] * 0.15) : m[1] === "Updating files" ? 95 + Math.round(+m[2] * 0.05) : job.percent;
      if (!/^\s*(Receiving|Resolving|Counting|Compressing|Updating) /.test(line)) { job.lines.push(line.trim()); job.lines = job.lines.slice(-30); }
    }
  };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("error", (e) => { job.status = "failed"; job.error = e.code === "ENOENT" ? "git is not installed" : e.message; });
  p.on("close", async (code) => {
    if (code === 0) {
      try { job.repo = await register(target, { projectId: body.projectId || null, ...(cache ? { kiroCache: true } : {}) }); job.status = "done"; job.percent = 100; }
      catch (e) { job.status = "failed"; job.error = e.message; }
    } else if (job.status === "running") {
      job.status = "failed";
      const msg = job.lines.filter((l) => /fatal|error|denied|not found|Authentication/i.test(l)).slice(-3).join("\n") || job.lines.slice(-3).join("\n");
      job.error = /Authentication failed|403|could not read Username/i.test(msg) ? "GitLab refused access — the token needs read_repository (and write_repository to push)\n" + msg : msg || `git clone failed (exit ${code})`;
      try { if (fs.existsSync(target) && !fs.existsSync(path.join(target, ".git", "HEAD"))) fs.rmSync(target, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    setTimeout(() => JOBS.delete(id), 30 * 60e3);
  });
  return { id, done: false };
}

// ---------- open in file manager / VS Code ----------
// a background service has a short PATH: also look where snap / Homebrew / user installs put VS Code and friends
const TOOL_PATH = [...new Set([...(process.env.PATH || "").split(":"), "/snap/bin", "/usr/local/bin", "/opt/homebrew/bin", path.join(os.homedir(), ".local", "bin")].filter(Boolean))].join(":");
function which(cmd) { return new Promise((res) => execFile("sh", ["-c", 'command -v "$1"', "sh", cmd], { env: { ...process.env, PATH: TOOL_PATH } }, (e, out) => res(!e && out.trim() ? out.trim() : ""))); }
let TOOLS = null;
async function tools() { if (!TOOLS) TOOLS = { code: await which("code"), open: (await which("xdg-open")) || (await which("open")) }; return TOOLS; }
// ---------- editors on this computer ("Open with …") ----------
/** The desktop session's display / D-Bus variables. A background service does not have them, so GUI apps would not show. */
function sessionEnv() {
  const env = { ...process.env, PATH: TOOL_PATH };
  if (process.platform === "linux") {
    try {
      const out = require("child_process").execFileSync("systemctl", ["--user", "show-environment"], { encoding: "utf8", timeout: 3000 });
      for (const l of out.split("\n")) { const m = l.match(/^(DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|XDG_SESSION_TYPE|XDG_CURRENT_DESKTOP|DESKTOP_SESSION|XDG_DATA_DIRS)=(.*)$/); if (m) env[m[1]] = m[2]; }
    } catch { /* not systemd */ }
    env.XDG_RUNTIME_DIR ||= `/run/user/${process.getuid()}`;
    if (!env.DBUS_SESSION_BUS_ADDRESS && fs.existsSync(env.XDG_RUNTIME_DIR + "/bus")) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${env.XDG_RUNTIME_DIR}/bus`;
    if (!env.WAYLAND_DISPLAY && fs.existsSync(env.XDG_RUNTIME_DIR + "/wayland-0")) env.WAYLAND_DISPLAY = "wayland-0";
    env.DISPLAY ||= ":0";
  }
  return env;
}
const EDITOR_RANK = [/visual studio code|^code$/i, /kiro/i, /cursor/i, /intellij|idea/i, /pycharm/i, /webstorm/i, /goland/i, /android studio/i, /eclipse/i, /sublime/i, /zed/i, /vscodium/i, /fleet/i, /text editor|gedit|kate|mousepad|xed/i];
/** Split a desktop-file Exec line into argv (quotes respected, field codes handled). */
function execArgv(exec, target) {
  const out = []; let cur = "", q = false, had = false;
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i];
    if (ch === '"') { q = !q; had = true; continue; }
    if (ch === "\\" && q && i + 1 < exec.length) { cur += exec[++i]; continue; }
    if (/\s/.test(ch) && !q) { if (cur || had) out.push(cur); cur = ""; had = false; continue; }
    cur += ch;
  }
  if (cur || had) out.push(cur);
  let used = false;
  const argv = out.flatMap((a) => { if (/^%[fFuU]$/.test(a)) { used = true; return [target]; } if (/^%[a-zA-Z]$/.test(a)) return []; return [a.replace(/%%/g, "%")]; });
  if (!used) argv.push(target);
  return argv;
}
let EDITORS = null;
function editors(force) {
  if (EDITORS && !force && Date.now() - EDITORS.at < 5 * 60e3) return EDITORS.list;
  const list = [], seen = new Set();
  if (process.platform === "darwin") {
    const apps = ["Visual Studio Code", "Kiro", "Cursor", "IntelliJ IDEA", "IntelliJ IDEA CE", "IntelliJ IDEA Ultimate", "PyCharm", "PyCharm CE", "WebStorm", "GoLand", "Android Studio", "Eclipse", "Sublime Text", "Zed", "VSCodium", "TextEdit"];
    for (const n of apps) for (const d of ["/Applications", path.join(HOME, "Applications")]) if (fs.existsSync(path.join(d, n + ".app")) && !seen.has(n)) { seen.add(n); list.push({ id: "mac:" + n, name: n, argv: ["open", "-a", n] }); }
  } else {
    const dirs = [path.join(HOME, ".local/share/applications"), "/usr/share/applications", "/usr/local/share/applications", "/var/lib/snapd/desktop/applications", "/var/lib/flatpak/exports/share/applications", path.join(HOME, ".local/share/flatpak/exports/share/applications")];
    for (const d of dirs) {
      let files = []; try { files = fs.readdirSync(d).filter((f) => f.endsWith(".desktop")); } catch { continue; }
      for (const f of files) {
        let txt; try { txt = fs.readFileSync(path.join(d, f), "utf8"); } catch { continue; }
        const main = txt.split(/^\[(?!Desktop Entry\])/m)[0], get = (k) => (main.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim() || "";
        if (get("Type") && get("Type") !== "Application") continue;
        if (/^true$/i.test(get("NoDisplay")) || /^true$/i.test(get("Hidden")) || /^true$/i.test(get("Terminal"))) continue;
        const cats = get("Categories"), name = get("Name"), exec = get("Exec");
        if (!name || !exec || /url.?handler/i.test(f)) continue;
        if (!/(^|;)(IDE|TextEditor)(;|$)/.test(cats) && !(/(^|;)Development(;|$)/.test(cats) && EDITOR_RANK.some((r) => r.test(name)))) continue;
        const argv0 = execArgv(exec, "")[0] || "";
        const bin = argv0.startsWith("/") ? argv0 : "";
        if (bin && !fs.existsSync(bin)) continue;
        const nk = "n:" + name.replace(/\s+\d[\d.]*$/, "").toLowerCase(), dk = bin && !/^\/(usr\/)?(local\/)?s?bin$/.test(path.dirname(bin)) ? "d:" + path.dirname(bin) : "";
        if (seen.has(nk) || (dk && seen.has(dk))) continue;
        seen.add(nk); if (dk) seen.add(dk);
        list.push({ id: "desk:" + path.join(d, f), name, exec });
      }
    }
  }
  const rank = (n) => { const i = EDITOR_RANK.findIndex((r) => r.test(n)); return i < 0 ? 99 : i; };
  list.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  EDITORS = { at: Date.now(), list };
  return list;
}
/** Start an editor on a folder / file; reports an error if it exits right away. */
function launch(argv, target) {
  return new Promise((resolve, reject) => {
    let err = "", settled = false;
    const p = spawn(argv[0], argv.slice(1), { cwd: fs.statSync(target).isDirectory() ? target : path.dirname(target), detached: true, stdio: ["ignore", "ignore", "pipe"], env: sessionEnv() });
    p.stderr.on("data", (c) => { err = (err + c).slice(-2000); });
    p.on("error", (e) => { if (!settled) { settled = true; reject(httpErr(500, `Could not start ${argv[0]}: ${e.message}`)); } });
    p.on("exit", (code) => { if (!settled && code) { settled = true; reject(httpErr(500, `${path.basename(argv[0])} stopped (code ${code})${err.trim() ? ": " + err.trim().split("\n").slice(-3).join(" ") : ""}`)); } });
    setTimeout(() => { if (!settled) { settled = true; p.stderr.destroy(); p.unref(); resolve({ ok: true }); } }, 2500);
  });
}
async function openWith(repo, editorId, rel) {
  const target = rel ? repoFile(repo, rel) : repo.path;
  if (!fs.existsSync(target)) throw httpErr(404, "Not found");
  if (editorId === "folder") { const t = await tools(); if (!t.open) throw httpErr(404, "No file manager opener found"); return launch([t.open, rel && !fs.statSync(target).isDirectory() ? path.dirname(target) : target], target); }
  const ed = editors().find((e) => e.id === editorId) || editors(true).find((e) => e.id === editorId);
  if (!ed) throw httpErr(404, "That editor is not installed any more — refresh the list");
  if (ed.argv) return launch([...ed.argv, target], target);
  // JetBrains IDEs and most editors take the project folder; a file is opened inside its repository
  const isIde = /intellij|idea|pycharm|webstorm|goland|android studio|clion|rider|phpstorm|rubymine|datagrip/i.test(ed.name);
  if (rel && isIde) { const argv = execArgv(ed.exec, repo.path); return launch([...argv, target], repo.path); }
  const argv = execArgv(ed.exec, target);
  if (/(^|\/)(code|kiro|cursor|codium)$/.test(argv[0]) && rel) argv.splice(1, 0, repo.path);        // open the repo window, then the file
  return launch(argv, target);
}
async function openRepo(repo, what) {
  const t = await tools(), bin = what === "code" ? t.code : t.open;
  if (!bin) throw httpErr(404, what === "code" ? "VS Code (the `code` command) is not installed" : "No file manager opener (xdg-open) found");
  return launch([bin, repo.path], repo.path);
}

// ---------- folder browser ----------
function listDir(q) {
  const dir = realDir(q.path || HOME);
  const entries = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || (d.name.startsWith(".") && q.hidden !== "1")) continue;
    entries.push({ name: d.name, repo: fs.existsSync(path.join(dir, d.name, ".git")) });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return { path: dir, home: HOME, parent: dir === HOME ? "" : path.dirname(dir), dirs: entries.slice(0, 1000), isRepo: fs.existsSync(path.join(dir, ".git")) };
}
function scan(rootIn, depth = 4) {
  const root = realDir(rootIn), found = [];
  const walk = (d, lvl) => {
    if (found.length >= 300 || lvl > depth) return;
    let list; try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    if (list.some((x) => x.name === ".git")) { found.push(d); return; }
    for (const x of list) if (x.isDirectory() && !x.name.startsWith(".") && !["node_modules", "target", "build", "dist", "venv"].includes(x.name)) walk(path.join(d, x.name), lvl + 1);
  };
  walk(root, 0);
  return found;
}

// ---------- router ----------
const reply = (status, obj) => ({ status, body: JSON.stringify(obj), headers: {} });
const ok = (obj) => reply(200, obj);

async function netOp(repo, args, timeout = 300_000) {
  const c = await gitlab.getCreds(), env = baseEnv(await authEnv(repo.remote));
  const r = await git(repo.path, args, { env, timeout });
  const out = scrub((r.out + "\n" + r.err).trim(), c?.token);
  if (r.code !== 0) {
    const hint = /Authentication failed|could not read Username|403/i.test(out) ? "GitLab refused access — check that the token has write_repository (push) / read_repository (pull).\n" : "";
    throw httpErr(409, hint + out.split("\n").slice(-8).join("\n"));
  }
  return out;
}

// ---------- review-copy cache (~/.cache/jiratime/kiro) ----------
const CACHE_DAYS = +process.env.JIRATIME_KIRO_CACHE_DAYS || 14;                 // unused this long -> removed
const CACHE_MAX_MB = +process.env.JIRATIME_KIRO_CACHE_MB || 5000;               // over this -> least recently used removed
const dirMB = (d) => new Promise((res) => execFile("du", ["-sk", d], { timeout: 60_000 }, (e, out) => res(e ? 0 : Math.round((parseInt(out, 10) || 0) / 1024))));
const busyRepo = (id) => [...kiro.JOBS.values()].some((j) => j.repo === id && j.status === "running");
function touchRepo(r) { if (!r.kiroCache) return; r.usedAt = new Date().toISOString(); saveReg(); }
/** Folders in the cache that the list does not know (e.g. made by another JiraTime setup) are adopted so they can age out. */
async function cacheAdopt() {
  let dirs = []; try { dirs = fs.readdirSync(KIRO_CACHE, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    const dir = path.join(KIRO_CACHE, d.name); if (REG.some((r) => r.path === fs.realpathSync(dir))) continue;
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    try { const rec = await register(dir, { kiroCache: true }); rec.usedAt = fs.statSync(path.join(dir, ".git")).mtime.toISOString(); saveReg(); } catch { /* broken copy: leave it */ }
  }
}
async function cacheList() {
  await cacheAdopt();
  const list = REG.filter((r) => r.kiroCache);
  const out = await Promise.all(list.map(async (r) => ({ id: r.id, name: r.remotePath || r.name, path: r.path, usedAt: r.usedAt || r.addedAt, mb: fs.existsSync(r.path) ? await dirMB(r.path) : 0, busy: busyRepo(r.id) })));
  out.sort((a, b) => String(b.usedAt).localeCompare(String(a.usedAt)));
  return { copies: out, totalMB: out.reduce((a, x) => a + x.mb, 0), days: CACHE_DAYS, maxMB: CACHE_MAX_MB, folder: KIRO_CACHE };
}
function cacheRemove(id) {
  const r = REG.find((x) => x.id === id && x.kiroCache); if (!r) throw httpErr(404, "Review copy not found");
  if (busyRepo(r.id)) throw httpErr(409, "Kiro is working in this copy right now — try again when it is done");
  const real = fs.existsSync(r.path) ? fs.realpathSync(r.path) : r.path, root = fs.existsSync(KIRO_CACHE) ? fs.realpathSync(KIRO_CACHE) : KIRO_CACHE;
  if (!real.startsWith(root + path.sep)) throw httpErr(403, "Not inside the review-copy folder");
  fs.rmSync(real, { recursive: true, force: true });
  REG = REG.filter((x) => x.id !== r.id); saveReg();
  return { ok: true };
}
/** Remove copies not used for CACHE_DAYS, then the least recently used ones while the folder is over CACHE_MAX_MB. */
async function cacheCleanup() {
  const removed = [];
  try {
    for (const r of REG.filter((x) => x.kiroCache && !fs.existsSync(x.path))) { REG = REG.filter((x) => x !== r); saveReg(); }
    const old = Date.now() - CACHE_DAYS * 864e5;
    for (const r of REG.filter((x) => x.kiroCache && Date.parse(x.usedAt || x.addedAt) < old)) { try { cacheRemove(r.id); removed.push(r.remotePath || r.name); } catch { /* busy */ } }
    let { copies, totalMB } = await cacheList();
    for (const c of copies.slice().reverse()) { if (totalMB <= CACHE_MAX_MB) break; try { cacheRemove(c.id); totalMB -= c.mb; removed.push(c.name); } catch { /* busy */ } }
  } catch (e) { console.warn("[kiro cache] cleanup:", e.message); }
  if (removed.length) console.log(`[kiro cache] removed ${removed.length} review copies: ${removed.join(", ")}`);
  return removed;
}
setTimeout(cacheCleanup, 60_000).unref();
setInterval(cacheCleanup, 6 * 3600e3).unref();

/** Prepare the diff + commit list for a Kiro review and start the run. */
async function kiroReview(repo, b) {
  const gd = await gitDir(repo), kind = b.kind || "local";
  let diffText = "", logText = "", what = "";
  if (kind === "local") {
    diffText = (await git(repo.path, ["diff", "HEAD", "--no-color", "--find-renames"], { timeout: 60_000 })).out;
    const untracked = (await git(repo.path, ["ls-files", "--others", "--exclude-standard"])).out.trim();
    if (untracked) diffText += "\n# New files not yet added to git (read them directly):\n" + untracked.split("\n").map((f) => "#   " + f).join("\n") + "\n";
    what = "the uncommitted changes in this working tree";
  } else {
    const target = checkRev(b.target), source = checkRev(b.source), iid = +b.iid || 0;
    const env = baseEnv(await authEnv(repo.remote)), ag = (args, o = {}) => git(repo.path, args, { env, timeout: 180_000, ...o });   // blobless copies fetch files on demand
    if (repo.remote) await netOp(repo, ["fetch", "origin", "--prune"]);
    let mrRef = "";
    if (iid && repo.remote) {   // GitLab keeps every MR (also from forks) at refs/merge-requests/<iid>/head
      const f = await ag(["fetch", "origin", `+refs/merge-requests/${iid}/head:refs/remotes/origin/jiratime-mr/${iid}`]);
      if (f.code === 0) mrRef = `origin/jiratime-mr/${iid}`;
    }
    const ref = async (n) => ((await git(repo.path, ["rev-parse", "--verify", "--quiet", `origin/${n}^{commit}`])).code === 0 ? `origin/${n}` : (await git(repo.path, ["rev-parse", "--verify", "--quiet", `${n}^{commit}`])).code === 0 ? n : "");
    const [t, sr0] = await Promise.all([ref(target), mrRef ? Promise.resolve(mrRef) : ref(source)]), sr = sr0;
    if (!t) throw httpErr(404, `Branch ${target} not found (also not on origin)`);
    if (!sr) throw httpErr(404, `Branch ${source} not found (also not on origin) — push it first`);
    if (repo.kiroCache) {   // review copy: show Kiro the code of the merge request itself
      const co = await ag(["checkout", "-f", "--detach", sr]);
      if (co.code) throw httpErr(409, "Could not check out the merge request code: " + (co.err || co.out).trim().split("\n").slice(-3).join(" "));
    }
    const d = await ag(["diff", "--no-color", "--find-renames", `${t}...${sr}`]);
    if (d.code) throw httpErr(409, "git diff failed: " + (d.err || d.out).trim().split("\n").slice(-3).join(" "));
    diffText = d.out;
    logText = (await ag(["log", "--no-color", "--format=%h %an %ad%n    %s%n%b", "--date=short", `${t}..${sr}`])).out;
    what = kind === "mr" ? `merge request !${+b.iid || "?"} "${String(b.title || "").slice(0, 200)}" (${source} → ${target})` : `branch ${source} compared with ${target}`;
  }
  if (!diffText.trim()) throw httpErr(400, kind === "local" ? "There are no uncommitted changes to review" : "The branches have no differences");
  const cut = diffText.length > kiro.MAX_DIFF;
  const dFile = kiro.writeContext(gd, "review.diff", cut ? diffText.slice(0, kiro.MAX_DIFF) + "\n# … diff cut here (too large)\n" : diffText);
  const lFile = logText ? kiro.writeContext(gd, "review-commits.txt", logText) : "";
  const desc = String(b.description || "").trim().slice(0, 6000);
  const prompt = [
    `Review ${what} in this repository.`,
    `The complete diff is in the file ${dFile}${lFile ? ` and the commit list in ${lFile}` : ""}. Read them, and open the surrounding code in the repository wherever you need context.`,
    desc ? `Merge request description:\n${desc}` : "",
    "Review it the way a strict senior developer / team lead does before approving. Check every changed line for:",
    "- null / empty handling (Optional, null returns from maps, DB, HTTP / SOA responses, collections, String operations, unboxing);",
    "- exception handling (swallowed or generic catch, lost stack trace, wrong HTTP status, missing finally / try-with-resources, retries, timeouts);",
    "- logging (useful context, no PII / secrets / tokens / full payloads in logs, right log level);",
    "- input validation and security (injection, auth / permission checks, secrets in code, unsafe deserialisation);",
    "- concurrency and resources (thread safety, shared state, connections / streams closed, transactions);",
    "- performance (calls inside loops, N+1 queries, large payloads, missing caching / pagination);",
    "- API and data contract changes, config / feature flags, backward compatibility, DB migrations;",
    "- code quality (duplication, naming, dead code, magic values) and missing or weak tests.",
    "Answer in Markdown with these sections:",
    "1. **Summary** — what the change does, in 2–4 lines.",
    "2. **Must fix** — 🔴 blockers and 🟠 major issues. For each: `file:line`, what is wrong and why it matters, and the corrected code in a fenced code block.",
    "3. **Should fix** — 🟡 minor issues, same format, shorter.",
    "4. **Risks for release** — config, DB / migration, API contract, dependency, feature-flag changes and what to check after deploying.",
    "5. **Tests to add** — concrete test cases.",
    "6. **Verdict** — Approve / Approve with comments / Request changes, with one line why.",
    "Only report real findings in the changed code (no generic advice); say 'none found' for an empty section.",
    b.extra ? `Also: ${String(b.extra).slice(0, 2000)}` : "",
    cut ? "Note: the diff file was cut because it is very large; say which parts you could not review." : "",
  ].filter(Boolean).join("\n\n");
  return kiro.startJob(repo, { prompt, mode: "ask", fresh: true, label: kind === "mr" ? `Review !${+b.iid || ""}` : kind === "local" ? "Review my changes" : `Review ${b.source}` });
}

async function handle(req) {
  const h = req.headers || {}, p = req.path;
  if (!p.startsWith("/api/git/")) return null;
  if (h["sec-fetch-site"] && h["sec-fetch-site"] !== "same-origin") return reply(403, { error: "Forbidden" });
  const q = Object.fromEntries(new URLSearchParams(req.query || ""));
  let b = {};
  if (req.method === "POST") {
    if (!String(h["content-type"] || "").startsWith("application/json")) return reply(415, { error: "JSON required" });
    try { b = JSON.parse(req.body || "{}"); } catch { return reply(400, { error: "Invalid JSON" }); }
  }
  const R = () => getRepo(b.repo || q.repo);
  try {
    const route = `${req.method} ${p.slice(8)}`;
    switch (route) {
      case "GET /tree": return ok(tree(R(), q.path));
      case "GET /file": return ok(readRepoFile(R(), q.path));
      case "POST /file/write": return ok(writeRepoFile(R(), b));
      case "POST /file/upload": { const r = R(), dir = String(b.dir || "").replace(/^\/+|\/+$/g, ""); return ok(writeRepoFile(r, { path: (dir ? dir + "/" : "") + validName(b.name), data: b.data, create: !b.overwrite })); }
      case "POST /file/mkdir": { const r = R(), d = repoFile(r, b.path); if (fs.existsSync(d)) throw httpErr(409, "Already exists"); fs.mkdirSync(d, { recursive: true }); return ok({ path: path.relative(r.path, d) }); }
      case "POST /file/rename": { const r = R(), from = repoFile(r, b.from), to = repoFile(r, path.join(path.dirname(String(b.from)), validName(b.to))); if (!fs.existsSync(from)) throw httpErr(404, "Not found"); if (fs.existsSync(to)) throw httpErr(409, "That name is already used"); fs.renameSync(from, to); return ok({ path: path.relative(r.path, to) }); }
      case "POST /file/delete": {
        const r = R(), f = repoFile(r, b.path); if (!fs.existsSync(f)) throw httpErr(404, "Not found");
        const st = fs.statSync(f), rel = path.relative(r.path, f);
        const files = st.isDirectory() ? (await git(r.path, ["ls-files", "--cached", "--others", "--", rel])).out.split("\n").filter(Boolean) : [rel];
        const bk = backup(r, files);
        fs.rmSync(f, { recursive: true, force: true });
        return ok({ backup: bk });
      }
      case "GET /kiro/status": return ok(await kiro.kiroStatus(q.force === "1"));
      case "POST /kiro/attach": { const r = R(); return ok(await kiro.saveAttachment(await gitDir(r), b.name, b.data)); }
      case "POST /kiro/ask": { const r = R(); touchRepo(r); const extra = b.attachments?.length ? kiro.attachmentPrompt(await gitDir(r), b.attachments) : ""; return ok(kiro.jobView(await kiro.startJob(r, { prompt: String(b.prompt || "").trim() + extra, mode: b.mode === "edit" ? "edit" : "ask", fresh: !!b.fresh, label: String(b.label || "").slice(0, 80) }))); }
      case "POST /kiro/review": { const r = R(); touchRepo(r); return ok(kiro.jobView(await kiroReview(r, b))); }
      case "GET /kiro/cache": return ok(await cacheList());
      case "POST /kiro/cache/remove": { if (b.all) { const { copies } = await cacheList(); let n = 0, busy = 0; for (const c of copies) { try { cacheRemove(c.id); n++; } catch { busy++; } } return ok({ removed: n, busy }); } return ok(cacheRemove(String(b.repo || ""))); }
      case "POST /kiro/cache/cleanup": return ok({ removed: await cacheCleanup() });
      case "GET /kiro/job": { const j = kiro.JOBS.get(q.id); if (!j) throw httpErr(404, "Kiro run not found (the helper restarted?)"); return ok(kiro.jobView(j, +q.from || 0)); }
      case "GET /kiro/active": { const r = R(), j = [...kiro.JOBS.values()].filter((x) => x.repo === r.id).sort((x, y) => y.startedAt.localeCompare(x.startedAt))[0]; return ok({ job: j && j.status === "running" ? kiro.jobView(j) : null }); }
      case "POST /kiro/stop": return ok(kiro.stopJob(String(b.id || "")));
      case "GET /tools": return ok({ ...(await tools()), git: (await git(HOME, ["--version"])).out.trim(), home: HOME });
      case "GET /fs": return ok(listDir(q));
      case "POST /mkdir": { const parent = realDir(b.path), name = String(b.name || "").trim(); if (!/^[A-Za-z0-9._ -]{1,100}$/.test(name) || name.startsWith(".")) throw httpErr(400, "Invalid folder name"); const d = path.join(parent, name); fs.mkdirSync(d, { recursive: false, mode: 0o755 }); return ok(listDir({ path: d })); }
      case "GET /repos": return ok({ repos: REG });
      case "POST /repos/add": return ok({ repo: await register(realDir(b.path), b.projectId ? { projectId: b.projectId } : {}) });
      case "POST /repos/remove": REG = REG.filter((r) => r.id !== b.repo); saveReg(); return ok({ repos: REG });
      case "POST /scan": { const dirs = scan(b.root, 4), added = []; for (const d of dirs) { try { added.push(await register(d)); } catch { /* skip */ } } return ok({ added, repos: REG }); }
      case "POST /clone": return ok(await startClone(b));
      case "GET /job": { const j = JOBS.get(q.id); if (!j) throw httpErr(404, "Clone job not found"); return ok(j); }
      case "GET /status": return ok(await status(R()));
      case "GET /diff": return ok(await diff(R(), q));
      case "POST /stage": { const r = R(); const files = (b.paths || []).map((x) => relPath(r, x)); if (!files.length) throw httpErr(400, "No files"); await gitOk(r.path, ["add", "--", ...files]); return ok(await status(r)); }
      case "POST /unstage": { const r = R(); const files = (b.paths || []).map((x) => relPath(r, x)); if (!files.length) throw httpErr(400, "No files"); const hasHead = (await git(r.path, ["rev-parse", "--verify", "HEAD"])).code === 0; await gitOk(r.path, hasHead ? ["restore", "--staged", "--", ...files] : ["rm", "--cached", "-r", "--", ...files]); return ok(await status(r)); }
      case "POST /discard": {
        const r = R(), st = await status(r), files = (b.paths || []).map((x) => relPath(r, x));
        const recs = files.map((f) => st.files.find((x) => x.path === f)).filter(Boolean);
        if (!recs.length) throw httpErr(400, "Nothing to discard");
        const where = backup(r, recs.map((x) => x.path));
        const tracked = recs.filter((x) => !x.untracked).map((x) => x.path), untracked = recs.filter((x) => x.untracked).map((x) => x.path);
        if (tracked.length) await gitOk(r.path, ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...tracked]);
        for (const f of untracked) fs.rmSync(path.join(r.path, f), { force: true });
        return ok({ ...(await status(r)), backup: where });
      }
      case "POST /apply": {
        const r = R(), file = checkPatch(r, b.patch), mode = b.mode;
        if (!["stage", "unstage", "discard"].includes(mode)) throw httpErr(400, "Invalid mode");
        const where = mode === "discard" ? backup(r, [file]) : "";
        const args = mode === "stage" ? ["apply", "--cached", "--recount", "-"] : mode === "unstage" ? ["apply", "--cached", "-R", "--recount", "-"] : ["apply", "-R", "--recount", "-"];
        await gitOk(r.path, args, { input: b.patch });
        return ok({ ...(await status(r)), backup: where });
      }
      case "POST /commit": {
        const r = R(), msg = String(b.message || "").trim();
        if (!msg) throw httpErr(400, "Write a commit message");
        if (msg.length > 20000) throw httpErr(400, "Commit message too long");
        const args = ["commit", "-F", "-"]; if (b.amend) args.push("--amend"); if (b.all) args.push("-a");
        const out = await gitOk(r.path, args, { input: msg + "\n" });
        return ok({ output: out.trim(), status: await status(r) });
      }
      case "POST /fetch": { const r = R(); return ok({ output: await netOp(r, ["fetch", "--prune", "origin"]), status: await status(r) }); }
      case "POST /pull": {
        const r = R(), mode = b.mode === "rebase" ? "--rebase" : b.mode === "merge" ? "--no-rebase" : "--ff-only";
        try { return ok({ output: await netOp(r, ["pull", mode, "origin"]), status: await status(r) }); }
        catch (e) { const st = await status(r); if (st.state || st.files.some((f) => f.conflict)) return ok({ output: e.message, status: st, conflicts: true }); throw e; }
      }
      case "POST /push": {
        const r = R(), st = await status(r);
        if (st.detached) throw httpErr(400, "You are not on a branch (detached HEAD) — create or check out a branch first");
        if (st.state) throw httpErr(400, `Finish the ${st.state} first`);
        const args = st.upstream ? ["push", "origin", `HEAD:refs/heads/${st.upstream.replace(/^origin\//, "")}`] : ["push", "--set-upstream", "origin", st.branch];
        if (!st.upstream) checkRev(st.branch);
        return ok({ output: await netOp(r, args), status: await status(r) });
      }
      case "GET /branches": return ok(await branches(R()));
      case "GET /compare": return ok(await compare(R(), q.a, q.b));
      case "POST /checkout": {
        const r = R(), name = checkRev(b.branch);
        if (b.create) { await gitOk(r.path, ["check-ref-format", "--branch", name]); await gitOk(r.path, ["switch", "-c", name, ...(b.from ? [checkRev(b.from)] : [])]); }
        else if (b.remote) await gitOk(r.path, ["switch", "--track", name]);
        else await gitOk(r.path, ["switch", name]);
        return ok(await status(r));
      }
      case "POST /branch/delete": {
        const r = R(), name = checkRev(b.name);
        if (b.remote) return ok({ output: await netOp(r, ["push", "origin", "--delete", name.replace(/^origin\//, "")]) });
        await gitOk(r.path, ["branch", b.force ? "-D" : "-d", name]); return ok(await branches(r));
      }
      case "POST /branch/rename": { const r = R(), a = checkRev(b.from), n = checkRev(b.to); await gitOk(r.path, ["check-ref-format", "--branch", n]); await gitOk(r.path, ["branch", "-m", a, n]); return ok(await branches(r)); }
      case "POST /merge": { const r = R(), br = checkRev(b.branch); const x = await git(r.path, ["merge", "--no-edit", br]); const st = await status(r); if (x.code && !st.state) throw httpErr(409, (x.err || x.out).trim()); return ok({ output: (x.out + x.err).trim(), status: st, conflicts: !!st.state }); }
      case "POST /rebase": { const r = R(), onto = checkRev(b.onto); const x = await git(r.path, ["rebase", onto]); const st = await status(r); if (x.code && !st.state) throw httpErr(409, (x.err || x.out).trim()); return ok({ output: (x.out + x.err).trim(), status: st, conflicts: !!st.state }); }
      case "POST /abort": { const r = R(), st = await status(r); if (!st.state) throw httpErr(400, "Nothing to abort"); await gitOk(r.path, [st.state === "rebase" ? "rebase" : st.state === "merge" ? "merge" : st.state, "--abort"]); return ok(await status(r)); }
      case "POST /continue": {
        const r = R(), st = await status(r);
        if (st.files.some((f) => f.conflict)) throw httpErr(400, "Resolve and mark all conflicted files first");
        if (st.state === "merge") await gitOk(r.path, ["commit", "--no-edit"]);
        else if (st.state === "rebase") await gitOk(r.path, ["rebase", "--continue"]);
        else if (st.state) await gitOk(r.path, [st.state, "--continue"]);
        else throw httpErr(400, "No merge or rebase in progress");
        return ok(await status(r));
      }
      case "GET /log": return ok(await log(R(), q));
      case "GET /show": return ok(await show(R(), q.sha));
      case "GET /stash": { const r = R(); const x = await git(r.path, ["stash", "list", "--format=%gd%x1f%s%x1f%cI"]); return ok({ stashes: x.out.split("\n").filter(Boolean).map((l) => { const [ref, msg, at] = l.split("\x1f"); return { ref, msg, at }; }) }); }
      case "POST /stash/push": { const r = R(); await gitOk(r.path, ["stash", "push", "--include-untracked", "-m", String(b.message || "JiraTime stash").slice(0, 200)]); return ok(await status(r)); }
      case "POST /stash/pop": case "POST /stash/apply": case "POST /stash/drop": {
        const r = R(), ref = String(b.ref || "stash@{0}"); if (!/^stash@\{\d+\}$/.test(ref)) throw httpErr(400, "Invalid stash");
        const x = await git(r.path, ["stash", p.split("/").pop(), ref]); const st = await status(r);
        if (x.code && !st.files.some((f) => f.conflict)) throw httpErr(409, (x.err || x.out).trim());
        return ok({ status: st, output: (x.out + x.err).trim(), conflicts: st.files.some((f) => f.conflict) });
      }
      case "POST /revert": { const r = R(); if (!SHA_RE.test(b.sha)) throw httpErr(400, "Invalid commit"); const x = await git(r.path, ["revert", "--no-edit", b.sha]); const st = await status(r); if (x.code && !st.state) throw httpErr(409, (x.err || x.out).trim()); return ok({ status: st, conflicts: !!st.state }); }
      case "POST /tag": { const r = R(), name = String(b.name || ""); if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(name) || name.startsWith("-")) throw httpErr(400, "Invalid tag name"); const target = b.sha ? (SHA_RE.test(b.sha) ? b.sha : checkRev(b.sha)) : "HEAD"; await gitOk(r.path, ["tag", "-a", name, "-m", String(b.message || name).slice(0, 2000), target]); if (b.push) await netOp(r, ["push", "origin", `refs/tags/${name}`]); return ok({ ok: true }); }
      case "POST /reset": {
        const r = R(), mode = b.mode; if (!["soft", "mixed", "hard"].includes(mode)) throw httpErr(400, "Invalid reset mode");
        const target = SHA_RE.test(b.sha) ? b.sha : checkRev(b.sha); let backupRef = "";
        if (mode === "hard") { const st = await status(r); if (st.files.length) { await gitOk(r.path, ["stash", "push", "--include-untracked", "-m", `JiraTime backup before reset --hard to ${target}`]); backupRef = "stash@{0}"; } }
        await gitOk(r.path, ["reset", `--${mode}`, target]); return ok({ status: await status(r), backup: backupRef });
      }
      case "GET /conflicts": return ok(await conflicts(R()));
      case "POST /resolve": {
        const r = R(), file = relPath(r, b.path), st = await status(r);
        if (!st.files.some((f) => f.path === file && f.conflict)) throw httpErr(400, "This file is not in conflict");
        if (typeof b.content === "string") {
          if (MARK_RE.test(b.content) && !b.force) throw httpErr(400, "The file still contains conflict markers (<<<<<<< ======= >>>>>>>)");
          backup(r, [file]); fs.writeFileSync(path.join(r.path, file), b.content);
        } else if (b.take === "ours" || b.take === "theirs") await gitOk(r.path, ["checkout", `--${b.take}`, "--", file]);
        await gitOk(r.path, ["add", "--", file]);
        return ok(await status(r));
      }
      case "GET /editors": return ok({ editors: editors(q.force === "1").map(({ id, name }) => ({ id, name })) });
      case "POST /open": return ok(b.editor ? await openWith(R(), String(b.editor), b.path ? String(b.path) : "") : await openRepo(R(), b.what));
      default: return reply(404, { error: "Unknown git action" });
    }
  } catch (e) {
    if (!e.status) console.warn("[git]", e.message);
    return reply(e.status || 500, { error: e.message });
  }
}

module.exports = { handle, _remotePath: remotePath };
