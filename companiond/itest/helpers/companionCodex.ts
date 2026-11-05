// itest-only: the production CodexHost wiring with the broker wrapped (for example to remember tokens for the
// on-disk scan). Production code has no broker hook; it calls createCompanionCodex. Never imported by src/ or test/.
import os from "node:os";
import { companionHostOptions, startCompanionRelay, type CompanionCodex, type CompanionCodexOptions } from "../../src/codex/companionCodex.ts";
import { CodexHost } from "../../src/codex/codexHost.ts";
import { findCodex } from "../../src/codex/codexInstall.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import type { RelayBroker } from "../../src/relay/broker.ts";

export async function createItestCompanionCodex(o: CompanionCodexOptions & { wrapBroker?: (b: RelayBroker) => RelayBroker }): Promise<CompanionCodex> {
  const install = o.install ?? findCodex();
  const { acceptor, relay } = await startCompanionRelay(o.paths, o.toolchain ?? discoverToolchain());
  const broker = o.wrapBroker ? o.wrapBroker(acceptor) : acceptor;
  const host = new CodexHost(companionHostOptions({ ...o, install, home: o.home ?? os.homedir() }, broker, relay));
  return {
    host,
    acceptor,
    close: async () => {
      await host.stop();
      await acceptor.stop();
    },
  };
}
