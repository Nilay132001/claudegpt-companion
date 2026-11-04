// Read-only, run by the OWNER on their Mac. Prints key names, value kinds and counts only:
// no titles, paths, ids, times, branch names, commands or content. Status, entrypoint and record type
// values are bucketed to an allow-list or a safe shape, else "other".
// Reads: desktop records, `~/.claude/sessions/<digits>.json` (never *.key), the 40 newest transcripts
// (streamed line by line) and their subagent files. Git questions go through M2's SafeGit (config gate first).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { LocateError, SafeGit } from "../../companiond/src/git/safeGit.ts";
import { discoverToolchain } from "../../companiond/src/launch/toolchain.ts";

const home = os.homedir();
const desktop = path.join(home, "Library/Application Support/Claude/claude-code-sessions");
const projects = path.join(home, ".claude/projects");
const running = path.join(home, ".claude/sessions");
const gitPath = discoverToolchain().gitPath;

const kind = (v) => {
  if (v === undefined) return "absent";
  if (v === null) return "null";
  if (typeof v === "number") return v > 1e11 ? "epoch-ms" : "epoch-s";
  if (typeof v === "string") return /^\d+$/.test(v) ? "numeric-string" : Number.isFinite(Date.parse(v)) ? "date-string" : "other-string";
  return typeof v;
};
const bucket = (v, allowed) => (typeof v === "string" && allowed.includes(v) ? v : v === undefined ? "absent" : "other");
const typeName = (v) => (typeof v === "string" && /^[a-z][a-z0-9_-]{0,40}$/.test(v) ? v : "other");
const bump = (m, k) => (m[k] = (m[k] ?? 0) + 1);
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
const statOrNull = (p) => { try { return fs.statSync(p); } catch { return null; } }; // tolerates broken symlinks

const out = {
  records: { n: 0, keys: {}, lastFocusedAt: {}, lastActivityAt: {} },
  running: { n: 0, keys: {}, procStart: {}, status: {}, entrypoint: {} },
  transcripts: {
    n: 0, types: {}, bashResultKeys: {}, bashExitCodeKey: 0, bashErrors: 0, bashErrorTextStartsExitCode: 0,
    subagentResultKeys: {}, moreThanOneCwd: 0, sidechainRecords: 0,
    latestCwd: { none: 0, missing: 0, notDir: 0, notGit: 0, refused: 0, gitFailed: 0, subfolder: 0, toplevel: 0 },
    subagents: { dirs: 0, files: 0, nameAgentDash: 0, nameOther: 0, firstSessionId: { parent: 0, other: 0, absent: 0 } },
  },
};

for (const org of ls(desktop)) for (const acct of ls(path.join(desktop, org))) {
  const d = path.join(desktop, org, acct);
  if (!statOrNull(d)?.isDirectory()) continue;
  for (const f of ls(d)) {
    if (!/^local_.*\.json$/.test(f)) continue;
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(d, f), "utf8")); } catch { continue; }
    out.records.n++;
    for (const k of Object.keys(r)) bump(out.records.keys, k);
    bump(out.records.lastFocusedAt, kind(r.lastFocusedAt));
    bump(out.records.lastActivityAt, kind(r.lastActivityAt));
  }
}

for (const f of ls(running)) {
  if (!/^[0-9]+\.json$/.test(f)) continue; // never *.key, never the socket
  let r;
  try { r = JSON.parse(fs.readFileSync(path.join(running, f), "utf8")); } catch { continue; }
  out.running.n++;
  for (const k of Object.keys(r)) bump(out.running.keys, k);
  bump(out.running.procStart, kind(r.procStart));
  bump(out.running.status, bucket(r.status, ["busy", "idle"]));
  bump(out.running.entrypoint, bucket(r.entrypoint, ["claude-desktop", "cli"]));
}

async function* records(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    try { yield JSON.parse(line); } catch { /* malformed: skip */ }
  }
}

async function classifyCwd(cwd) {
  const st = statOrNull(cwd);
  if (!st) return "missing";
  if (!st.isDirectory()) return "notDir";
  const real = fs.realpathSync.native(cwd);
  try {
    const dirs = await SafeGit.locate({ gitPath, cwd: real });
    return dirs.toplevel === real ? "toplevel" : "subfolder";
  } catch (e) {
    if (e instanceof LocateError) return e.kind === "refused" ? "refused" : e.kind === "not_git" ? "notGit" : "gitFailed";
    return "gitFailed";
  }
}

const files = [];
for (const d of ls(projects)) {
  const dir = path.join(projects, d);
  if (!statOrNull(dir)?.isDirectory()) continue;
  for (const f of ls(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const st = statOrNull(path.join(dir, f));
    if (st?.isFile()) files.push({ file: path.join(dir, f), mtime: st.mtimeMs });
  }
}
files.sort((a, b) => b.mtime - a.mtime);
const T = out.transcripts;
for (const { file } of files.slice(0, 40)) {
  T.n++;
  const id = path.basename(file, ".jsonl");
  const tools = new Map();
  const cwds = new Set();
  let latestCwd = null;
  for await (const r of records(file)) {
    bump(T.types, typeName(r.type));
    if (r.isSidechain === true) T.sidechainRecords++;
    else if (typeof r.cwd === "string") { cwds.add(r.cwd); latestCwd = r.cwd; }
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type === "tool_use") tools.set(b.id, b.name);
      if (b?.type !== "tool_result") continue;
      const name = tools.get(b.tool_use_id);
      const tur = r.toolUseResult;
      if (name === "Bash") {
        if (tur && typeof tur === "object") for (const k of Object.keys(tur)) bump(T.bashResultKeys, k);
        if (tur && typeof tur === "object" && "exitCode" in tur) T.bashExitCodeKey++;
        if (b.is_error === true) {
          T.bashErrors++;
          const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c) => c?.text ?? "").join("\n") : "";
          if (/^Exit code \d+/.test(text)) T.bashErrorTextStartsExitCode++;
        }
      }
      if ((name === "Task" || name === "Agent") && tur && typeof tur === "object") for (const k of Object.keys(tur)) bump(T.subagentResultKeys, k);
    }
  }
  if (cwds.size > 1) T.moreThanOneCwd++;
  T.latestCwd[latestCwd === null ? "none" : await classifyCwd(latestCwd)]++;
  const subDir = path.join(path.dirname(file), id, "subagents");
  if (!statOrNull(subDir)?.isDirectory()) continue;
  T.subagents.dirs++;
  for (const f of ls(subDir)) {
    if (!f.endsWith(".jsonl")) continue;
    T.subagents.files++;
    if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(f)) T.subagents.nameAgentDash++;
    else T.subagents.nameOther++;
    let first = null;
    for await (const r of records(path.join(subDir, f))) { first = r; break; }
    const sid = first?.sessionId;
    T.subagents.firstSessionId[sid === undefined ? "absent" : sid === id ? "parent" : "other"]++;
  }
}
console.log(JSON.stringify(out, null, 2));
