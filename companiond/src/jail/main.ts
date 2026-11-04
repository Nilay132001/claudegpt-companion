// Entry point of companion-readonly. Runs inside sandbox-exec (Task 9); env is set by buildReadonlyLaunch.
import path from "node:path";
import { RepoRefusedError, SafeGit } from "../git/safeGit.ts";
import { serveStdio, type ServerState } from "./mcpServer.ts";
import { redactToolOutput } from "./redact.ts";

const rootEnv = process.env.COMPANION_ROOT ?? "";
const gitEnv = process.env.COMPANION_GIT ?? "";

let state: ServerState;
if (!path.isAbsolute(rootEnv) || !path.isAbsolute(gitEnv)) {
  state = { kind: "refused", reason: "Repository refused: COMPANION_ROOT and COMPANION_GIT must be absolute paths." };
} else {
  try {
    const git = await SafeGit.open({ root: rootEnv, gitPath: gitEnv });
    state = { kind: "ready", ctx: { root: git.root, git, redact: redactToolOutput } };
  } catch (e) {
    state = { kind: "refused", reason: e instanceof RepoRefusedError ? e.message : "Repository refused: git could not run here." };
  }
}

await serveStdio(state, process.stdin, process.stdout);
