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

/** kiro-cli / cursor-agent are often in ~/.local/bin, which a background service's PATH does not contain. */
const EXTRA_PATH = [path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin", "/snap/bin"];
const envPath = () => [...new Set([...(process.env.PATH || "").split(":"), ...EXTRA_PATH].filter(Boolean))].join(":");
const ENGINES = {
  kiro: { name: "Kiro", bins: ["kiro-cli"], login: "kiro-cli login" },
  cursor: { name: "Cursor", bins: ["cursor-agent", "agent"], login: "cursor-agent login" },
};
const engOf = (e) => (ENGINES[e] ? e : "kiro");
function findBin(engine = "kiro") {
  for (const name of ENGINES[engOf(engine)].bins) for (const d of envPath().split(":")) { const f = path.join(d, name); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ } }
  return "";
}
const run = (bin, args, timeout = 20_000) => new Promise((res) => execFile(bin, args, { timeout, env: { ...process.env, PATH: envPath(), NO_COLOR: "1" } }, (e, out, err) => res({ ok: !e, out: strip(out || "") + strip(err || "") })));

const STATUS = {};
async function kiroStatus(force, engine = "kiro") {
  engine = engOf(engine);
  const c = STATUS[engine]; if (c && !force && Date.now() - c.at < 60e3) return c;
  const bin = findBin(engine), base = { engine, name: ENGINES[engine].name, login: ENGINES[engine].login };
  if (!bin) return (STATUS[engine] = { ...base, at: Date.now(), installed: false, loggedIn: false });
  const [v, w] = await Promise.all([run(bin, ["--version"]), run(bin, [engine === "kiro" ? "whoami" : "status"])]);
  const loggedIn = w.ok && !/not logged in|not authenticated|login required/i.test(w.out);
  return (STATUS[engine] = { ...base, at: Date.now(), installed: true, version: (engine === "cursor" ? "Cursor Agent " : "") + v.out.trim().split("\n")[0], loggedIn, who: loggedIn ? w.out.replace(/✓\s*/g, "").trim().split("\n").slice(0, 2).join(" · ") : "" });
}

// Cursor keeps a chat id per conversation; remember the last one per repository (fresh = start a new one)
const SESS_FILE = path.join(process.env.JIRATIME_CONFIG_DIR || path.join(os.homedir(), ".config", "jiratime"), "agent-sessions.json");
const SESS = (() => { try { return JSON.parse(fs.readFileSync(SESS_FILE, "utf8")); } catch { return {}; } })();
const saveSess = () => { try { fs.writeFileSync(SESS_FILE, JSON.stringify(SESS), { mode: 0o600 }); } catch { /* optional */ } };

/** Cursor stream-json events -> the same text layout as kiro-cli (tool lines, then "> answer"). */
function cursorText(ev, st) {
  const out = [];
  if (ev.type === "system" && ev.session_id) st.session = ev.session_id;
  if (ev.type === "tool_call" && ev.subtype === "started") {
    const tc = ev.tool_call || {}, k = Object.keys(tc).find((x) => /ToolCall$/.test(x)) || "tool", a = tc[k]?.args || {};
    const what = a.path || a.filePath || a.targetFile || a.globPattern || a.pattern || a.query || a.command || a.targetDirectory || "";
    out.push(`${k.replace(/ToolCall$/, "").replace(/^./, (c) => c.toUpperCase())}: ${String(what).slice(0, 200)} (using tool: ${k.replace(/ToolCall$/, "")})`);
  }
  if (ev.type === "assistant") {
    let t = (ev.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = t.match(/^>\s*Auto routed to ([^\n]+)\n*/); if (m) { out.push(`Model: ${m[1].trim()}`); t = t.slice(m[0].length); }
    if (t) { if (!st.answered) { st.answered = true; return out.join("\n") + (out.length ? "\n" : "") + "\n> " + t; } return out.join("\n") + t; }
  }
  if (ev.type === "result") { st.result = ev; if (!st.answered && ev.result) { st.answered = true; out.push("\n> " + String(ev.result).replace(/^>\s*Auto routed to [^\n]+\n*/, "")); } }
  return out.length ? (st.answered ? "\n" : "") + out.join("\n") + "\n" : "";
}

/** Start one agent run (Kiro CLI or Cursor Agent) in repo.path. */
async function startJob(repo, { prompt, mode = "ask", fresh = false, label = "", engine = "kiro" }) {
  engine = engOf(engine); const E = ENGINES[engine];
  const st = await kiroStatus(false, engine);
  if (!st.installed) throw Object.assign(new Error(`${E.name} CLI is not installed on this laptop`), { status: 412 });
  if (!st.loggedIn) { const again = await kiroStatus(true, engine); if (!again.loggedIn) throw Object.assign(new Error(`${E.name} CLI is not logged in on this laptop — run \`${E.login}\` once in a terminal`), { status: 412 }); }
  prompt = String(prompt || "").trim();
  if (!prompt) throw Object.assign(new Error("Type a message"), { status: 400 });
  if (prompt.length > MAX_PROMPT) throw Object.assign(new Error("Message too long"), { status: 400 });
  const running = BUSY.get(repo.id);
  if (running && JOBS.get(running)?.status === "running") throw Object.assign(new Error(`${JOBS.get(running).engine === "cursor" ? "Cursor" : "Kiro"} is still working in this repository — wait or press Stop`), { status: 409 });
  const guard = mode === "edit"
    ? "\n\n(You may edit files in this repository. Do not run shell or git commands; the user commits and switches branches in JiraTime.)"
    : "\n\n(Read-only: do not modify files and do not run shell or git commands. Answer from the repository files.)";
  const sKey = `${engine}:${repo.id}`;
  let args;
  if (engine === "kiro") {
    const tools = mode === "edit" ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
    args = ["chat", "--no-interactive", `--trust-tools=${tools.join(",")}`, ...(fresh ? [] : ["--resume"]), prompt + guard];
  } else {
    // ask mode is read-only; edit mode may write files, shell commands run only inside Cursor's sandbox and are never force-approved
    if (fresh) delete SESS[sKey];
    args = ["-p", "--trust", "--output-format", "stream-json", ...(mode === "edit" ? ["--sandbox", "enabled"] : ["--mode", "ask"]), ...(SESS[sKey] ? ["--resume", SESS[sKey]] : []), prompt + guard];
  }
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, repo: repo.id, engine, mode, label, status: "running", out: "", credits: "", startedAt: new Date().toISOString(), endedAt: null, error: "" };
  JOBS.set(id, job); BUSY.set(repo.id, id);
  const p = spawn(findBin(engine), args, { cwd: repo.path, env: { ...process.env, PATH: envPath(), NO_COLOR: "1", TERM: "dumb", NO_OPEN_BROWSER: "1" }, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  job.pid = p.pid;
  let err = "", buf = "";
  const cst = {};
  p.stdout.on("data", (c) => {
    if (job.out.length >= MAX_OUT) return;
    if (engine === "kiro") { job.out += strip(c.toString("utf8")); return; }
    buf += c.toString("utf8"); const lines = buf.split("\n"); buf = lines.pop();
    for (const l of lines) { let ev; try { ev = JSON.parse(l); } catch { continue; } job.out += cursorText(ev, cst); }
  });
  p.stderr.on("data", (c) => { err = (err + strip(c.toString("utf8"))).slice(-20_000); });
  const timer = setTimeout(() => { job.error = "Stopped after 20 minutes"; try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ } }, TIMEOUT);
  p.on("close", (code) => {
    clearTimeout(timer);
    if (engine === "kiro") { const m = err.match(/Credits:\s*([\d.]+)\s*•\s*Time:\s*([^\n]+)/); job.credits = m ? `${m[1]} credits · ${m[2].trim()}` : ""; }
    else {
      if (buf.trim()) { try { job.out += cursorText(JSON.parse(buf), cst); } catch { /* partial */ } }
      if (cst.session) { SESS[sKey] = cst.session; saveSess(); }
      const r = cst.result; job.credits = r ? `Cursor · ${Math.round((r.duration_ms || 0) / 1000)}s` : "";
      if (r?.is_error && !job.error) job.error = String(r.result || "Cursor reported an error").slice(0, 600);
    }
    if (job.status === "running") job.status = code === 0 && !job.error ? "done" : "failed";
    if (job.status === "failed" && !job.error) job.error = err.split("\n").map((l) => l.trim()).filter((l) => l && !/^-+$|mcp server did not load/i.test(l)).slice(-6).join("\n") || `${E.name} CLI exited with code ${code}`;
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
const jobView = (j, from = 0) => ({ id: j.id, engine: j.engine, status: j.status, mode: j.mode, label: j.label, out: j.out.slice(from), size: j.out.length, credits: j.credits, error: j.error, startedAt: j.startedAt, endedAt: j.endedAt });

// ---------- attachments (screenshots, documents) ----------
const MAX_ATTACH = 10 * 1024 * 1024;
const IMG_EXT = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
const TEXT_EXT = ["txt", "md", "log", "json", "csv", "xml", "yml", "yaml", "properties", "ini", "conf", "env", "sql", "java", "kt", "js", "ts", "tsx", "jsx", "py", "go", "sh", "html", "css", "diff", "patch", "har"];
const attDir = (gitDir) => path.join(gitDir, "jiratime", "attach");
const runOut = (bin, args) => new Promise((res) => execFile(bin, args, { timeout: 60_000, maxBuffer: 30 * 1024 * 1024, env: { ...process.env, PATH: envPath() } }, (e, out) => res(e ? null : String(out))));
/** Save one upload inside .git/jiratime/attach. PDF / Word / Excel are also turned into text so Kiro can read them. */
async function saveAttachment(gitDir, name, b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (!buf.length) throw Object.assign(new Error("Empty file"), { status: 400 });
  if (buf.length > MAX_ATTACH) throw Object.assign(new Error("File too large (max 10 MB)"), { status: 413 });
  const safe = String(name || "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-80) || "file";
  const ext = safe.includes(".") ? safe.split(".").pop().toLowerCase() : "";
  const dir = attDir(gitDir); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) { try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 7 * 864e5) fs.unlinkSync(path.join(dir, f)); } catch { /* skip */ } }
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${safe}`, file = path.join(dir, id);
  fs.writeFileSync(file, buf);
  let kind = IMG_EXT.includes(ext) ? "image" : TEXT_EXT.includes(ext) ? "text" : "file", text = null;
  if (ext === "pdf") text = await runOut("pdftotext", ["-layout", file, "-"]);
  else if (["docx", "pptx", "xlsx"].includes(ext)) {
    const part = ext === "docx" ? ["word/document.xml"] : ext === "pptx" ? ["ppt/slides/*.xml"] : ["xl/sharedStrings.xml", "xl/worksheets/*.xml"];
    const xml = await runOut("unzip", ["-p", file, ...part]);
    if (xml) text = xml.replace(/<\/(w:p|a:p|row)>/g, "\n").replace(/<(w:tab|c)\b[^>]*\/?>/g, "\t").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n");
  }
  if (text != null) { fs.writeFileSync(file + ".txt", text); kind = "document"; }
  return { id, name: String(name || safe).slice(0, 120), kind, size: buf.length, converted: text != null };
}
/** Prompt lines for the attachments the user picked (ids are checked: only files in the attach folder). */
function attachmentPrompt(gitDir, ids) {
  const dir = attDir(gitDir), lines = [];
  for (const id of (Array.isArray(ids) ? ids : []).slice(0, 10)) {
    if (!/^[a-z0-9]+-[0-9a-f]{6}-[A-Za-z0-9._-]+$/.test(String(id))) continue;
    const f = path.join(dir, id); if (!fs.existsSync(f)) continue;
    const name = id.replace(/^[a-z0-9]+-[0-9a-f]{6}-/, ""), ext = name.split(".").pop().toLowerCase();
    if (IMG_EXT.includes(ext)) lines.push(`- Image "${name}": ${f} — open it with your read tool and look at it carefully (screenshot / diagram / error).`);
    else if (fs.existsSync(f + ".txt")) lines.push(`- Document "${name}": its text is in ${f}.txt (original file: ${f}).`);
    else lines.push(`- File "${name}": ${f}`);
  }
  return lines.length ? `\n\nThe user attached these files — read them before answering:\n${lines.join("\n")}` : "";
}

/** Review context files go inside .git (never committed, never shown as changes). */
function writeContext(gitDir, name, text) {
  const dir = path.join(gitDir, "jiratime"); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name); fs.writeFileSync(f, text); return f;
}

module.exports = { saveAttachment, attachmentPrompt, kiroStatus, startJob, stopJob, jobView, writeContext, JOBS, MAX_DIFF };
