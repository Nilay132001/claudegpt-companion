// The production wiring of CodexHost (M4b calls this). Builds the relay for this App Support folder, starts the
// acceptor with the sandboxed validator, and gives CodexHost the production launch (Codex under its own profile,
// code mode closed down). It does not start the host and does not read CODEX_SEATBELT_MEASURED: M4b's daemon
// refuses to start Codex while that says "stopped".
import os from "node:os";
import type { AppPaths } from "../app/appPaths.ts";
import { TOOL_NAMES } from "../jail/mcpServer.ts";
import { discoverToolchain, type Toolchain } from "../launch/toolchain.ts";
import { RelayAcceptor } from "../relay/acceptor.ts";
import type { RelayBroker } from "../relay/broker.ts";
import { buildRelay } from "../relay/relayBuild.ts";
import { ensureRelayDirs, relayPaths } from "../relay/relayPaths.ts";
import { buildValidatorLaunch } from "../relay/validatorProfile.ts";
import { LIVE_SURFACE_CHECK, liveRunner, prepareCodeMode } from "./codeMode.ts";
import { CodexHost } from "./codexHost.ts";
import { findCodex, PINNED_CODEX_VERSION, type CodexInstall } from "./codexInstall.ts";
import { buildCodexLaunch } from "./codexSeatbelt.ts";
import { COMPANION_ALLOWLIST } from "./serverRequests.ts";

export interface CompanionCodex { host: CodexHost; acceptor: RelayAcceptor; close(): Promise<void> }

export async function createCompanionCodex(o: {
  paths: AppPaths;
  install?: CodexInstall;
  toolchain?: Toolchain;
  home?: string;
  tokenTtlMs?: number;
  maxProcesses?: number;
  /** itests only: wrap the broker (for example to remember tokens for the on-disk scan). */
  wrapBroker?: (b: RelayBroker) => RelayBroker;
}): Promise<CompanionCodex> {
  const install = o.install ?? findCodex();
  const tc = o.toolchain ?? discoverToolchain();
  const home = o.home ?? os.homedir();
  const rp = ensureRelayDirs(relayPaths(o.paths.supportDir));
  // The toolchain's developer folder reaches the compiler through the relay build's minimal environment.
  buildRelay({ socketPath: rp.socket, outFile: rp.binary, developerDir: tc.developerDir ?? undefined });
  const acceptor = new RelayAcceptor({ socketPath: rp.socket, validator: buildValidatorLaunch(tc, TOOL_NAMES) });
  await acceptor.start();
  const relay = { binary: rp.binary, socket: rp.socket };
  const host = new CodexHost({
    paths: o.paths,
    codexVersion: install.version,
    pinnedVersion: PINNED_CODEX_VERSION,
    allowlist: COMPANION_ALLOWLIST,
    broker: o.wrapBroker ? o.wrapBroker(acceptor) : acceptor,
    relayBinary: rp.binary,
    tokenTtlMs: o.tokenTtlMs,
    maxProcesses: o.maxProcesses,
    makeLaunch: () => buildCodexLaunch({ install, paths: o.paths, home, sandboxed: true, relay }),
    makeLoginLaunch: () => buildCodexLaunch({ install, paths: o.paths, home, sandboxed: true, relay, login: true }),
    prepare: () => prepareCodeMode({ install, paths: o.paths, live: LIVE_SURFACE_CHECK ? liveRunner(install, o.paths, relay, home) : undefined }),
  });
  return {
    host,
    acceptor,
    close: async () => {
      await host.stop();
      await acceptor.stop();
    },
  };
}
