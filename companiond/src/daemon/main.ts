// companiond entry point, spawned by the SwiftUI app (spec §2) as
// `node --disable-warning=ExperimentalWarning src/daemon/main.ts` (node:sqlite is experimental).
// stdout = protocol; stderr = short codes only (never message bodies, transcript text, paths or tokens).
import os from "node:os";
import { AppDirError, appPaths, ensureAppDirs } from "../app/appPaths.ts";
import { SessionBridge } from "../bridge/sessionBridge.ts";
import { ChatService } from "../chat/chatService.ts";
import { defaultClaudePaths } from "../claude/paths.ts";
import { CodexInstallError } from "../codex/codexInstall.ts";
import { CODEX_SEATBELT_MEASURED } from "../codex/codexSeatbelt.ts";
import { createCompanionCodex } from "../codex/companionCodex.ts";
import { buildReadonlyLaunch } from "../launch/seatbelt.ts";
import { discoverToolchain, type Toolchain } from "../launch/toolchain.ts";
import { Privacy, safeGitInspector } from "../privacy/privacy.ts";
import { RelaySetupError } from "../relay/relayPaths.ts";
import { Store } from "../store/store.ts";
import { DisabledHost } from "./disabledHost.ts";
import { buildHandlers, toDaemonError, wireEvents, type DaemonHost } from "./handlers.ts";
import { DaemonServer } from "./server.ts";

const VERSION = "0.4.0";
const log = (code: string) => process.stderr.write(`companiond: ${code}\n`);
const errName = (e: unknown) => (e instanceof Error ? e.name : "error");

// Shutdown runs whatever has been set up so far, newest first, then exits. A crash, an unhandled rejection or a
// closed stdout (EPIPE when the app quits) logs a short code and the error name only, never Node's default stack
// trace (which holds paths and message text), and still shuts down cleanly.
const cleanup: Array<() => unknown> = [];
let stopping = false;
async function shutdown(code = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const f of cleanup.reverse()) await Promise.resolve().then(f).catch(() => undefined);
  log("stopped");
  process.exit(code);
}
const fatal = (what: string) => (e: unknown) => {
  log(`${what} (${errName(e)})`);
  void shutdown(1);
};
process.on("uncaughtException", fatal("fatal"));
process.on("unhandledRejection", fatal("fatal"));
process.stdout.on("error", fatal("stdout error"));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => void shutdown());

process.umask(0o077);
const home = os.homedir();
let paths: ReturnType<typeof ensureAppDirs>;
let store: Store;
try {
  paths = ensureAppDirs(appPaths(home)); // 0700 folders owned by this user; Store.open refuses anything else
  store = Store.open(paths.dbPath);
} catch (e) {
  log(`startup failed (${errName(e)})`);
  process.exit(1);
}
cleanup.push(() => store.close());
let toolchain: Toolchain | null = null;
try {
  toolchain = process.platform === "darwin" ? discoverToolchain() : null;
} catch (e) {
  log(`no toolchain (${errName(e)})`);
}
const gitPath = toolchain?.gitPath ?? "/usr/bin/git";
const privacy = new Privacy(store, safeGitInspector(gitPath), home);
const bridge = new SessionBridge({ paths: defaultClaudePaths(home), isApproved: privacy.isApproved, gitPath, initialPin: store.getPin() });
cleanup.push(() => bridge.stop());

/** Production Codex: always createCompanionCodex (Codex under its Seatbelt profile, sandboxed: true, relay + acceptor
 * + sandboxed validator). Off while CODEX_SEATBELT_MEASURED is "stopped" (spec §7.1.9: no weaker fallback). */
async function makeHost(): Promise<{ host: DaemonHost; close: () => Promise<void> }> {
  const off = (detail: string) => {
    const host = new DisabledHost(detail);
    return { host, close: () => host.stop() };
  };
  if (process.env.COMPANIOND_CODEX === "off") return off("Chat is off (COMPANIOND_CODEX=off).");
  // Not "Security check failed": nothing for the owner to acknowledge, Codex simply may not start.
  if (CODEX_SEATBELT_MEASURED !== "ok") return off("Chat is off: Codex cannot run under its Seatbelt profile yet.");
  if (!toolchain) return off("Chat needs macOS with the Xcode command-line tools.");
  try {
    const cc = await createCompanionCodex({ paths, toolchain, home });
    return { host: cc.host, close: cc.close };
  } catch (e) {
    // These messages are written for the user and hold no paths; anything else shows its name only.
    const known = e instanceof CodexInstallError || e instanceof RelaySetupError || e instanceof AppDirError;
    log(`codex unavailable (${errName(e)})`);
    return off(known ? e.message : `Codex could not start (${errName(e)}).`);
  }
}

const { host, close: closeHost } = await makeHost();
cleanup.push(closeHost); // host.stop() kills every Codex process; the acceptor stops after it
const chat = new ChatService({
  host, bridge, store, sharingMode: () => privacy.sharingMode(), isApproved: privacy.isApproved,
  launchFor: async (root) => {
    if (!toolchain) throw new Error("Repository tools need macOS.");
    return buildReadonlyLaunch({ root, toolchain });
  },
});

const deps = { host, bridge, chat, privacy, store, version: VERSION, shutdown: () => void shutdown() };
const server = new DaemonServer(process.stdin, process.stdout, buildHandlers(deps), toDaemonError, () => void shutdown());
wireEvents(deps, (m, p) => server.notify(m, p));
bridge.start();
void host.start().then((s) => log(`host ${s.state}`));
log("started");
