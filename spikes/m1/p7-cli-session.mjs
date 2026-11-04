// Read-only. Prints counts/booleans only — no titles, paths, ids or content.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const base = path.join(home, "Library/Application Support/Claude/claude-code-sessions");
const projects = path.join(home, ".claude/projects");
const recs = [];
for (const org of fs.readdirSync(base)) for (const acct of fs.readdirSync(path.join(base, org))) {
  const d = path.join(base, org, acct);
  if (!fs.statSync(d).isDirectory()) continue;
  for (const f of fs.readdirSync(d)) if (/^local_.*\.json$/.test(f)) { try { recs.push(JSON.parse(fs.readFileSync(path.join(d, f), "utf8"))); } catch {} }
}
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, "-");
const firstRecords = (file, n = 30) => fs.readFileSync(file, "utf8").split("\n").slice(0, n).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const stats = { records: recs.length, withLastAssistant: 0, lastAssistantDiffers: 0, bothFilesExist: 0, newerFileMentionsOlderSessionId: 0, transcriptSessionIdMatchesFilename: 0, transcriptsChecked: 0, recordsMentionDesktopSessionId: 0 };
for (const r of recs) {
  const dir = path.join(projects, enc(r.cwd || ""));
  const cur = path.join(dir, `${r.cliSessionId}.jsonl`);
  if (fs.existsSync(cur)) {
    stats.transcriptsChecked++;
    const recsIn = firstRecords(cur);
    if (recsIn.some((x) => x.sessionId === r.cliSessionId)) stats.transcriptSessionIdMatchesFilename++;
    if (recsIn.some((x) => JSON.stringify(x).includes(r.sessionId))) stats.recordsMentionDesktopSessionId++;
  }
  if (!r.lastAssistantCliSessionId) continue;
  stats.withLastAssistant++;
  if (r.lastAssistantCliSessionId === r.cliSessionId) continue;
  stats.lastAssistantDiffers++;
  const other = path.join(dir, `${r.lastAssistantCliSessionId}.jsonl`);
  if (fs.existsSync(cur) && fs.existsSync(other)) {
    stats.bothFilesExist++;
    const [older, newer] = fs.statSync(cur).mtimeMs < fs.statSync(other).mtimeMs ? [r.cliSessionId, other] : [r.lastAssistantCliSessionId, cur];
    if (fs.readFileSync(newer, "utf8").includes(older)) stats.newerFileMentionsOlderSessionId++;
  }
}
console.log(JSON.stringify(stats, null, 2));
