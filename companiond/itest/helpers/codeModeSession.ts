// One real app-server under the PRODUCTION Codex profile and code-mode config, with the relay, the acceptor, the
// sandboxed validator and the companion's guard and request policy. Same wiring as CodexHost (Task 9), kept small
// so Task 8 can measure before CodexHost exists and Task 10 re-runs the exec-cell gate on exactly this setup.
// Never reads a credential. Never imported by src/ or test/.
import type { AppPaths } from "../../src/app/appPaths.ts";
import { inertOverride, relayOverride } from "../../src/codex/binding.ts";
import { prepareCodeMode } from "../../src/codex/codeMode.ts";
import { findCodex } from "../../src/codex/codexInstall.ts";
import { buildCodexLaunch, type CodexLaunch } from "../../src/codex/codexSeatbelt.ts";
import { RuntimeGuard } from "../../src/codex/guard.ts";
import { DEVELOPER_INSTRUCTIONS } from "../../src/codex/instructions.ts";
import { COMPANION_ALLOWLIST, decideServerRequest } from "../../src/codex/serverRequests.ts";
import { TOOL_NAMES } from "../../src/jail/mcpServer.ts";
import { buildReadonlyLaunch, type LaunchSpec } from "../../src/launch/seatbelt.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { RelayAcceptor } from "../../src/relay/acceptor.ts";
import type { BrokerEvent } from "../../src/relay/broker.ts";
import { buildRelay } from "../../src/relay/relayBuild.ts";
import { ensureRelayDirs, relayPaths, type RelayPaths } from "../../src/relay/relayPaths.ts";
import { buildValidatorLaunch } from "../../src/relay/validatorProfile.ts";
import { startAppServer, type AppServer } from "./appServer.ts";
import { sleep } from "./companion.ts";

export interface TurnResult { status: string; turnId: string | null; agentText: string; itemTypes: string[]; mcpCalls: string[]; methods: string[] }
export interface Session {
  a: AppServer;
  relay: RelayPaths;
  acceptor: RelayAcceptor;
  brokerEvents: BrokerEvent[];
  alerts: string[];
  decisions: string[];
  models: string[];
  threadId: string;
  threadModel: string | null;
  turn(text: string, o?: { timeoutMs?: number; onToolCall?: (turnId: string) => void }): Promise<TurnResult>;
  close(): Promise<void>;
}

/** rawEvents (measurement only, the exec-cell gate): thread/start with experimentalRawEvents, so the exec call and its
 * output arrive as rawResponseItem/completed notifications. An exec cell makes no item of its own (codemode-report
 * M5); the raw items are the only harness-side record of what a cell returned. Production never sets it. */
/** developerInstructions: measurement only (the exec-cell gate). Production always sends DEVELOPER_INSTRUCTIONS, and
 * safety never depends on them (spec §7.6), so the gate may swap them; profile, config and tools stay identical. */
/** launchTransform: MEASUREMENT ONLY (the model-steered fetch probe's negative control). It edits the Codex launch
 * after buildCodexLaunch, in itest code; production code has no such option. */
export async function startSession(o: { paths: AppPaths; root?: string | null; jail?: LaunchSpec; rawEvents?: boolean; developerInstructions?: string; launchTransform?: (l: CodexLaunch) => CodexLaunch }): Promise<Session> {
  const install = findCodex();
  const tc = discoverToolchain();
  const relay = ensureRelayDirs(relayPaths(o.paths.supportDir));
  buildRelay({ socketPath: relay.socket, outFile: relay.binary, developerDir: tc.developerDir ?? undefined });
  const acceptor = new RelayAcceptor({ socketPath: relay.socket, validator: buildValidatorLaunch(tc, TOOL_NAMES) });
  const brokerEvents: BrokerEvent[] = [];
  acceptor.on((e) => brokerEvents.push(e));
  await acceptor.start();
  let app: AppServer | null = null;
  try {
    const prep = prepareCodeMode({ install, paths: o.paths });
    if (prep.result.failures.length > 0) throw new Error(`code-mode self-check failed: ${prep.result.failures.join("; ")}`);
    const alerts: string[] = [];
    const decisions: string[] = [];
    const guard = new RuntimeGuard(COMPANION_ALLOWLIST, {
      interrupt: async (threadId, turnId) => {
        await app?.rpc.request("turn/interrupt", { threadId, turnId });
      },
      alert: (x) => alerts.push(`${x.itemType}: ${x.detail}`),
    });
    const launch0 = buildCodexLaunch({ install, paths: o.paths, sandboxed: true, relay: { binary: relay.binary, socket: relay.socket } });
    const a = await startAppServer(o.launchTransform ? o.launchTransform(launch0) : launch0, async (method, params) => {
      const d = decideServerRequest(method, params, COMPANION_ALLOWLIST, guard.lookup);
      decisions.push(`${method}:${d.outcome}`);
      return d.reply;
    }, { experimentalApi: o.rawEvents === true });
    app = a;
    a.rpc.onNotification((m, p) => guard.onNotification(m, p));
    const launch = o.jail ?? (o.root ? await buildReadonlyLaunch({ root: o.root, toolchain: tc }) : null);
    const grant = launch ? acceptor.grant(launch) : null;
    const ts: any = await a.rpc.request("thread/start", {
      cwd: o.paths.emptyCwd, sandbox: "read-only", approvalPolicy: "untrusted", developerInstructions: o.developerInstructions ?? DEVELOPER_INSTRUCTIONS, ephemeral: true,
      config: grant ? relayOverride(relay.binary, grant.token, o.paths.emptyCwd) : inertOverride(),
      ...(o.rawEvents ? { experimentalRawEvents: true } : {}),
    });
    grant?.arm();
    const threadId = String(ts?.thread?.id ?? "");
    const threadModel = typeof ts?.model === "string" ? ts.model : typeof ts?.thread?.model === "string" ? ts.thread.model : null;
    return {
      a, relay, acceptor, brokerEvents, alerts, decisions, models: prep.models, threadId, threadModel,
      turn: (text, t = {}) => runTurn(a, threadId, text, t),
      close: async () => {
        a.kill();
        await acceptor.stop();
      },
    };
  } catch (e) {
    app?.kill();
    await acceptor.stop();
    throw e;
  }
}

async function runTurn(a: AppServer, threadId: string, text: string, o: { timeoutMs?: number; onToolCall?: (turnId: string) => void }): Promise<TurnResult> {
  const n0 = a.notifications.length;
  const r: any = await a.rpc.request("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }] });
  const turnId = typeof r?.turn?.id === "string" ? r.turn.id : null;
  let told = false;
  for (let t = 0; t < (o.timeoutMs ?? 240_000); t += 250) {
    const mine = a.notifications.slice(n0).filter((n) => n.params?.threadId === threadId);
    if (!told && turnId && mine.some((n) => n.method === "item/started" && n.params?.item?.type === "mcpToolCall")) {
      told = true;
      o.onToolCall?.(turnId);
    }
    const done = mine.find((n) => n.method === "turn/completed");
    if (done) {
      const completed = mine.filter((n) => n.method === "item/completed").map((n) => n.params?.item);
      return {
        status: String(done.params?.turn?.status),
        turnId,
        agentText: completed.filter((i) => i?.type === "agentMessage").map((i) => String(i?.text ?? "")).join("\n"),
        itemTypes: [...new Set(mine.filter((n) => n.method === "item/started").map((n) => String(n.params?.item?.type)))],
        mcpCalls: completed.filter((i) => i?.type === "mcpToolCall").map((i) => `${String(i?.tool)}:${String(i?.status)}`),
        methods: [...new Set(mine.map((n) => n.method))],
      };
    }
    await sleep(250);
  }
  return { status: "no turn/completed in time", turnId, agentText: "", itemTypes: [], mcpCalls: [], methods: [] };
}
