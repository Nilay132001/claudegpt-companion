// Test-only stdio MCP client.
import { spawn } from "node:child_process";
import { LineBuffer } from "../../src/lineBuffer.ts";

export interface McpClient {
  request(method: string, params?: unknown): Promise<any>;
  stderr(): string;
  close(): Promise<void>;
}

export function startClient(command: string, args: string[], env: Record<string, string>, cwd?: string): McpClient {
  const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  const lb = new LineBuffer();
  const waiting = new Map<number, (m: any) => void>();
  let next = 1;
  let err = "";
  child.stdout.on("data", (c: Buffer) => {
    for (const line of lb.push(c)) {
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  return {
    request(method, params) {
      const id = next++;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${method}; stderr: ${err}`)), 20_000);
        waiting.set(id, (m) => {
          clearTimeout(t);
          resolve(m);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    stderr: () => err,
    close() {
      return new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("close", () => resolve());
        child.stdin.end();
      });
    },
  };
}

export async function callTool(c: McpClient, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const m = await c.request("tools/call", { name, arguments: args });
  return { text: m.result.content[0].text, isError: m.result.isError === true };
}
