// The validator's own profile (ruling C1): no network, no exec beyond Node, no reads outside Node and companiond's
// code, no writes. Asserts errno, not exit codes (review M8).
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { SANDBOX_EXEC } from "../../src/launch/seatbelt.ts";
import { discoverToolchain } from "../../src/launch/toolchain.ts";
import { buildValidatorLaunch, buildValidatorProfile } from "../../src/relay/validatorProfile.ts";
import { MARK, removeTempDirs, tempDir } from "../helpers/fixtures.ts";

after(removeTempDirs);
const skip = process.platform !== "darwin" ? "Seatbelt is macOS-only" : false;
const DENIED = /^(EPERM|EACCES)$/;

test("the profile: deny default, no network, exec of Node only, no fork, no writes", { skip }, () => {
  const tc = discoverToolchain();
  const p = buildValidatorProfile(tc);
  assert.match(p, /^\(version 1\)\n\(deny default\)\n/);
  assert.match(p, /\(deny network\*\)\n$/);
  assert.deepEqual(p.match(/\(allow process-exec[^\n]*\)/g), [`(allow process-exec (literal "${tc.nodePath}"))`]);
  assert.doesNotMatch(p, /process-fork|file-write\*|network-outbound|\(allow network/);
  const l = buildValidatorLaunch(tc, ["list_dir", "read_file"]);
  assert.deepEqual([l.command, l.args[0], l.args[2], l.args[3], l.args[4]], [SANDBOX_EXEC, "-p", tc.nodePath, path.join(tc.codeDir, "src", "relay", "validator.ts"), "list_dir,read_file"]);
});

const PROBE = `
import fs from "node:fs"; import net from "node:net"; import { spawnSync } from "node:child_process";
const e = process.env; const out = {};
const conn = (o) => new Promise((r) => { const s = net.connect(o); s.on("connect", () => { s.destroy(); r("OK"); }); s.on("error", (x) => r(x.code)); });
out.tcpLoopback = await conn({ host: "127.0.0.1", port: Number(e.P_PORT) });
out.unixDecoy = await conn({ path: e.P_SOCK });
try { fs.readFileSync(e.P_OUTSIDE); out.readOutside = "OK"; } catch (x) { out.readOutside = x.code; }
try { fs.writeFileSync(e.P_WRITE, "x"); out.write = "OK"; } catch (x) { out.write = x.code; }
const r = spawnSync("/bin/sh", ["-c", "true"]); out.execSh = r.error ? r.error.code : "ran";
process.stdout.write(JSON.stringify(out));
`;

test("under the profile Node runs; network, exec, outside reads and writes fail with EPERM", { skip }, async () => {
  const tc = discoverToolchain();
  const d = tempDir("cgc-v-");
  const outside = path.join(d, "outside.txt");
  fs.writeFileSync(outside, `${MARK}\n`);
  let hits = 0;
  const tcp = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  const sock = path.join(d, "d.sock");
  const unix = net.createServer((s) => { hits++; s.destroy(); });
  await new Promise<void>((r) => unix.listen(sock, r));
  try {
    const r = spawnSync(SANDBOX_EXEC, ["-p", buildValidatorProfile(tc), tc.nodePath, "--input-type=module", "-e", PROBE], {
      // OPENSSL_CONF as buildValidatorLaunch sets it: Node may not read Homebrew's openssl.cnf under the profile.
      env: { P_PORT: String((tcp.address() as net.AddressInfo).port), P_SOCK: sock, P_OUTSIDE: outside, P_WRITE: path.join(d, "PWNED.txt"), PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" },
      cwd: "/", encoding: "utf8", timeout: 30_000,
    });
    assert.equal(r.status, 0, "Node must start under the validator profile");
    const out = JSON.parse(r.stdout) as Record<string, string>;
    for (const k of ["tcpLoopback", "unixDecoy", "readOutside", "write", "execSh"]) assert.match(out[k] ?? "missing", DENIED, k);
    assert.equal(hits, 0);
    assert.equal(fs.existsSync(path.join(d, "PWNED.txt")), false);
  } finally {
    tcp.close();
    unix.close();
  }
});

test("under the profile, execve (replacing the validator's own image) fails with EPERM (review 3)", { skip }, () => {
  const tc = discoverToolchain();
  const probe = `
    let out;
    try { process.execve("/bin/sh", ["sh", "-c", "true"], {}); out = "ran"; } catch (x) { out = x.code ?? String(x); }
    process.stdout.write(JSON.stringify({ execve: out }));
  `;
  const r = spawnSync(SANDBOX_EXEC, ["-p", buildValidatorProfile(tc), tc.nodePath, "-e", probe], {
    env: { PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null" }, cwd: "/", encoding: "utf8", timeout: 30_000,
  });
  assert.equal(r.status, 0, `Node must start; stderr: ${r.stderr}`);
  assert.match((JSON.parse(r.stdout) as { execve: string }).execve, DENIED);
});
