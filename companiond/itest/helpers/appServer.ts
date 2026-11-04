// Starts a REAL app-server for itests and measurement scripts. Never imported by src/ or test/.
import { CLIENT_INFO, CLIENT_METHODS } from "../../src/codex/methods.ts";
import type { CodexLaunch } from "../../src/codex/codexSeatbelt.ts";
import { RpcClient, type ServerReply } from "../../src/codex/rpc.ts";
import { NOT_PERMITTED } from "../../src/codex/serverRequests.ts";
import { nodeSpawn } from "../../src/codex/spawn.ts";

export interface Seen { method: string; params: any }
export interface AppServer { rpc: RpcClient; init: any; requests: Seen[]; notifications: Seen[]; kill(): void }

export async function startAppServer(launch: CodexLaunch, onServerRequest?: (m: string, p: any) => Promise<ServerReply>): Promise<AppServer> {
  const s = nodeSpawn(launch);
  const requests: Seen[] = [];
  const notifications: Seen[] = [];
  const rpc = new RpcClient(s.transport, {
    allowedMethods: CLIENT_METHODS,
    timeoutMs: 60_000,
    onServerRequest: async (method, params) => {
      requests.push({ method, params });
      return onServerRequest ? onServerRequest(method, params) : { error: NOT_PERMITTED };
    },
  });
  rpc.onNotification((method, params) => notifications.push({ method, params }));
  s.onExit((d) => rpc.close(d));
  const init = await rpc.request("initialize", { clientInfo: CLIENT_INFO, capabilities: null });
  rpc.notify("initialized");
  return { rpc, init, requests, notifications, kill: () => s.kill() };
}

export async function threadTools(a: AppServer, threadId: string, serverName: string): Promise<{ tools: string[]; serverInfo: any; error: unknown }> {
  const r: any = await a.rpc.request("mcpServerStatus/list", { threadId, serverName });
  const e = (r?.data ?? []).find((x: any) => x?.name === serverName);
  return { tools: Object.keys(e?.tools ?? {}), serverInfo: e?.serverInfo ?? null, error: e?.toolsError ?? null };
}
