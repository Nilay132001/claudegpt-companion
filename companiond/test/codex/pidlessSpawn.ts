// SYNTHETIC FIXTURE — run by spawn.test.ts in its own process group. nodeSpawn() of a program that does not exist
// gives a child with no pid; kill() on it must not signal pid 0 (this process's whole group). A regression kills
// this process, which is why the test runs it detached.
import { nodeSpawn } from "../../src/codex/spawn.ts";

const s = nodeSpawn({ command: "/nonexistent/cgc-codex", args: ["app-server"], env: { PATH: "/usr/bin:/bin" }, cwd: "/" });
const exits: string[] = [];
s.onExit((d) => exits.push(d));
s.kill(); // before the spawn error arrives: pid is undefined
await new Promise((r) => setTimeout(r, 300)); // let the failed spawn's 'error' event arrive
s.kill(); // after it: still no pid
await new Promise((r) => setTimeout(r, 100));
process.stdout.write(`RESULT pid=${s.pid === undefined ? "none" : "set"} exits=${exits.join(",")}\n`);
process.exit(0);
