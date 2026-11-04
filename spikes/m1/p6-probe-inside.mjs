// Runs INSIDE the sandbox. Each check reports ok/blocked.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [root, outside, git] = process.argv.slice(2);
const r = {};
const attempt = (k, f) => { try { f(); r[k] = "ok"; } catch (e) { r[k] = "blocked:" + (e.code || e.message).toString().slice(0, 40); } };
attempt("readInsideRoot", () => fs.readFileSync(path.join(root, "inside.txt")));
attempt("readOutsideRoot", () => fs.readFileSync(outside));
attempt("readHomeSsh", () => fs.readdirSync(path.join(process.env.HOME, ".ssh")));
attempt("writeInsideRoot", () => fs.writeFileSync(path.join(root, "pwned.txt"), "x"));
attempt("gitStatus", () => execFileSync(git, ["-C", root, "status", "--short"], { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }));
attempt("execShell", () => execFileSync("/bin/sh", ["-c", "echo hi"]));
await new Promise((res) => {
  const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 3000 });
  s.on("connect", () => { r.network = "ok"; s.destroy(); res(); });
  s.on("error", (e) => { r.network = "blocked:" + e.code; res(); });
  s.on("timeout", () => { r.network = "blocked:timeout"; s.destroy(); res(); });
});
console.log(JSON.stringify(r, null, 2));
