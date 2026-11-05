// Entry point of companion-jira (owner ruling B). companiond spawns it under its Seatbelt profile with the credential
// as one line on fd 3 (then EOF): never argv or env. stdout = MCP (or the one --check line); stderr is unused.
import fs from "node:fs";
import { serveLines } from "../mcpStdio.ts";
import { JiraClient, JiraError } from "./client.ts";
import { decodeSecret, type JiraCredentials } from "./credentials.ts";
import { handleJiraMessage, type JiraServerState } from "./mcpServer.ts";

const NOT_SET_UP = "Jira is not set up in the companion.";

function readSecret(): JiraCredentials | null {
  try {
    const raw = fs.readFileSync(3, { encoding: "utf8" }); // reads to EOF; companiond closes its end after one line
    fs.closeSync(3);
    return decodeSecret(raw);
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const creds = readSecret();
  if (process.argv.includes("--check")) {
    let line: Record<string, unknown>;
    if (!creds) line = { ok: false, kind: "setup" };
    else {
      try {
        await new JiraClient(creds).myself();
        line = { ok: true };
      } catch (e) {
        line = { ok: false, kind: e instanceof JiraError ? e.kind : "network" };
      }
    }
    process.stdout.write(`${JSON.stringify(line)}\n`);
    return;
  }
  const state: JiraServerState = creds ? { kind: "ready", api: new JiraClient(creds) } : { kind: "refused", reason: NOT_SET_UP };
  await serveLines(process.stdin, process.stdout, (m) => handleJiraMessage(state, m));
}

main().catch(() => {
  process.exitCode = 1;
});
