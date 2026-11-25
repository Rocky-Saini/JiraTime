"use strict";
// Kiro CLI inside a local repository, for the JiraTime GitLab workspace.
// Runs `kiro-cli chat --no-interactive` in the repository folder with the user's own Kiro login on this laptop.
// Tools: "ask" mode trusts read-only tools only; "edit" mode also trusts file writes. Shell / git commands are never
// trusted (untrusted tools are refused in non-interactive mode) — branches are switched by JiraTime's own git screen.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const READ_TOOLS = ["read", "fs_read", "glob", "grep", "code", "introspect"];
const WRITE_TOOLS = ["write", "fs_write"];
const MAX_PROMPT = 60_000, MAX_OUT = 2_000_000, MAX_DIFF = 3_000_000, TIMEOUT = 20 * 60e3;
const JOBS = new Map(), BUSY = new Map();     // job id -> job ; repo id -> job id
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r(?!\n)/g, "");

/** kiro-cli is often in ~/.local/bin, which a background service's PATH does not contain. */
const EXTRA_PATH = [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"];
const envPath = () => [...new Set([...(process.env.PATH || "").split(":"), ...EXTRA_PATH].filter(Boolean))].join(":");
function findBin() {
  for (const d of envPath().split(":")) { const f = path.join(d, "kiro-cli"); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ } }
  return "";
}
const run = (bin, args, timeout = 20_000) => new Promise((res) => execFile(bin, args, { timeout, env: { ...process.env, PATH: envPath(), NO_COLOR: "1" } }, (e, out, err) => res({ ok: !e, out: strip(out || "") + strip(err || "") })));

let STATUS = null;
async function kiroStatus(force) {
  if (STATUS && !force && Date.now() - STATUS.at < 60e3) return STATUS;
  const bin = findBin();
  if (!bin) return (STATUS = { at: Date.now(), installed: false, loggedIn: false });
  const [v, w] = await Promise.all([run(bin, ["--version"]), run(bin, ["whoami"])]);
  const loggedIn = w.ok && !/not logged in/i.test(w.out);
  return (STATUS = { at: Date.now(), installed: true, version: v.out.trim().split("\n")[0], loggedIn, who: loggedIn ? w.out.trim().split("\n").slice(0, 2).join(" · ") : "" });
}

/** Start one kiro-cli run in repo.path. */
async function startJob(repo, { prompt, mode = "ask", fresh = false, label = "" }) {
  const st = await kiroStatus();
  if (!st.installed) throw Object.assign(new Error("Kiro CLI is not installed on this laptop"), { status: 412 });
  if (!st.loggedIn) { const again = await kiroStatus(true); if (!again.loggedIn) throw Object.assign(new Error("Kiro CLI is not logged in on this laptop — run `kiro-cli login` once in a terminal"), { status: 412 }); }
  prompt = String(prompt || "").trim();
  if (!prompt) throw Object.assign(new Error("Type a message"), { status: 400 });
  if (prompt.length > MAX_PROMPT) throw Object.assign(new Error("Message too long"), { status: 400 });
  const running = BUSY.get(repo.id);
  if (running && JOBS.get(running)?.status === "running") throw Object.assign(new Error("Kiro is still working in this repository — wait or press Stop"), { status: 409 });
  const tools = mode === "edit" ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
  const guard = mode === "edit"
    ? "\n\n(You may edit files in this repository. Do not run shell or git commands; the user commits and switches branches in JiraTime.)"
    : "\n\n(Read-only: do not modify files and do not run shell or git commands. Answer from the repository files.)";
  const args = ["chat", "--no-interactive", `--trust-tools=${tools.join(",")}`, ...(fresh ? [] : ["--resume"]), prompt + guard];
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, repo: repo.id, mode, label, status: "running", out: "", credits: "", startedAt: new Date().toISOString(), endedAt: null, error: "" };
  JOBS.set(id, job); BUSY.set(repo.id, id);
  const p = spawn(findBin(), args, { cwd: repo.path, env: { ...process.env, PATH: envPath(), NO_COLOR: "1", TERM: "dumb" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  job.pid = p.pid;
  let err = "";
  p.stdout.on("data", (c) => { if (job.out.length < MAX_OUT) job.out += strip(c.toString("utf8")); });
  p.stderr.on("data", (c) => { err = (err + strip(c.toString("utf8"))).slice(-20_000); });
  const timer = setTimeout(() => { job.error = "Stopped after 20 minutes"; try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }, TIMEOUT);
  p.on("close", (code) => {
    clearTimeout(timer);
    const m = err.match(/Credits:\s*([\d.]+)\s*•\s*Time:\s*([^\n]+)/);
    job.credits = m ? `${m[1]} credits · ${m[2].trim()}` : "";
    if (job.status === "running") job.status = code === 0 ? "done" : "failed";
    if (job.status === "failed" && !job.error) job.error = err.split("\n").map((l) => l.trim()).filter((l) => l && !/^-+$|mcp server did not load/i.test(l)).slice(-6).join("\n") || `kiro-cli exited with code ${code}`;
    job.endedAt = new Date().toISOString();
    setTimeout(() => JOBS.delete(id), 2 * 3600e3);
  });
  p.on("error", (e) => { job.status = "failed"; job.error = e.message; job.endedAt = new Date().toISOString(); });
  return job;
}
function stopJob(id) {
  const j = JOBS.get(id); if (!j) return { ok: false };
  if (j.status === "running") { j.status = "stopped"; j.endedAt = new Date().toISOString(); try { process.kill(-j.pid, "SIGTERM"); } catch { /* gone */ } }
  return { ok: true };
}
const jobView = (j, from = 0) => ({ id: j.id, status: j.status, mode: j.mode, label: j.label, out: j.out.slice(from), size: j.out.length, credits: j.credits, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt });

/** Review context files go inside .git (never committed, never shown as changes). */
function writeContext(gitDir, name, text) {
  const dir = path.join(gitDir, "jiratime"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name); fs.writeFileSync(f, text); return f;
}

module.exports = { kiroStatus, startJob, stopJob, jobView, writeContext, JOBS, MAX_DIFF };
