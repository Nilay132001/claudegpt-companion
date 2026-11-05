// SYNTHETIC FIXTURE — run by acceptor.test.ts in its own process group. A grant whose jail cannot be spawned
// (ENOENT) and a validator spawn that throws: the acceptor must report "error" and survive. A kill(0) regression
// would kill this process's whole group, which is why the test runs it detached.
import { RelayAcceptor } from "../../src/relay/acceptor.ts";
import { ensureRelayDirs, relayPaths } from "../../src/relay/relayPaths.ts";
import { tempDir, removeTempDirs } from "../helpers/fixtures.ts";
import { connectRelay } from "./relayClient.ts";

const rp = ensureRelayDirs(relayPaths(tempDir("cgc-pid-")));
const a = new RelayAcceptor({ socketPath: rp.socket, validator: { command: process.execPath, args: ["a\0b"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" } });
const ends: string[] = [];
a.on((e) => {
  if (e.type === "closed") ends.push(e.end);
});
await a.start();
const g = a.grant({ command: "/nonexistent/cgc-jail", args: [], env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
await (await connectRelay(rp.socket, g.token)).closed;
for (let t = 0; t < 3000 && ends.length === 0; t += 20) await new Promise((r) => setTimeout(r, 20));
await new Promise((r) => setTimeout(r, 300)); // let a late 'error' event of the failed spawn arrive
process.stdout.write(`RESULT ${ends.join(",")}\n`);
await a.stop();
removeTempDirs();
process.exit(0);
