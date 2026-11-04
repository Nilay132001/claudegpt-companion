// Spawning the app-server. Injected into CodexHost so unit tests use an in-process fake.
import { spawn } from "node:child_process";
import type { CodexLaunch } from "./codexSeatbelt.ts";
import type { RpcTransport } from "./rpc.ts";

export interface SpawnedServer { transport: RpcTransport; kill(): void; onExit(cb: (detail: string) => void): void }
export type SpawnFn = (launch: CodexLaunch) => SpawnedServer;

export const nodeSpawn: SpawnFn = (l) => {
  const child = spawn(l.command, l.args, { cwd: l.cwd, env: l.env, stdio: ["pipe", "pipe", "pipe"] });
  return {
    transport: { input: child.stdout, output: child.stdin, stderr: child.stderr },
    kill: () => {
      child.kill("SIGTERM");
    },
    onExit: (cb) => {
      child.on("exit", (code, signal) => cb(`exit ${code ?? signal ?? "?"}`));
      child.on("error", () => cb("spawn failed"));
    },
  };
};
