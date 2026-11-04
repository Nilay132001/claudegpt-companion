// Runs INSIDE the Seatbelt profile. Prints one JSON object of "ok" / "blocked:<code>".
// It never prints file contents or directory listings.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { denyPathspecs } from "../../src/jail/denyList.ts";

const [root = "", outsideFile = "", gitPath = "", mainWorkFile = "", home = "", tmpDir = "", port = "0", namesJson = "{}"] =
  process.argv.slice(2);
const names = JSON.parse(namesJson) as { deny?: Record<string, string>; allow?: Record<string, string>; info?: Record<string, string> };
const r: Record<string, string> = {};
const attempt = (k: string, f: () => unknown) => {
  try {
    f();
    r[k] = "ok";
  } catch (e) {
    r[k] = `blocked:${String((e as NodeJS.ErrnoException).code ?? "error")}`;
  }
};
const gitEnv = { PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const quiet = { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };

// Positive controls: these must work, or a "blocked" result elsewhere proves nothing.
attempt("readInside", () => fs.readFileSync(path.join(root, "README.md")));
attempt("readDev", () => fs.readFileSync("/dev/null"));
attempt("gitStatus", () => execFileSync(gitPath, ["-C", root, "status", "--porcelain"], quiet));
attempt("gitDiffNames", () => execFileSync(gitPath, ["-C", root, "diff", "--name-only", "HEAD", "--"], quiet));
// The same deny pathspecs SafeGit gives `git grep`, so git is not asked to open a denied file.
attempt("gitGrep", () =>
  execFileSync(gitPath, ["-C", root, "grep", "-n", "-I", "-F", "--untracked", "-e", "SYNTHETIC", "--", ".", ...denyPathspecs()], quiet),
);
// Must be blocked by Seatbelt itself (EPERM/EACCES), on targets that surely exist.
attempt("readDeniedInside", () => fs.readFileSync(path.join(root, ".env")));
attempt("readOutside", () => fs.readFileSync(outsideFile));
attempt("statOutside", () => fs.statSync(outsideFile));
attempt("listOutsideParent", () => fs.readdirSync(path.dirname(outsideFile)));
if (mainWorkFile) attempt("readMainWorkTree", () => fs.readFileSync(mainWorkFile));
attempt("listHome", () => fs.readdirSync(home));
attempt("listHomeSsh", () => fs.readdirSync(path.join(home, ".ssh"))); // may not exist: must only not be "ok"
attempt("writeInside", () => fs.writeFileSync(path.join(root, "PWNED.txt"), "x"));
attempt("mkdirInside", () => fs.mkdirSync(path.join(root, "pwned-dir")));
attempt("unlinkInside", () => fs.unlinkSync(path.join(root, "README.md")));
attempt("writeOutside", () => fs.writeFileSync(path.join(path.dirname(outsideFile), "PWNED.txt"), "x"));
attempt("writeTmp", () => fs.writeFileSync(path.join(tmpDir, "PWNED-cgc-probe.txt"), "x"));
attempt("writeHome", () => fs.writeFileSync(path.join(home, "PWNED-cgc-probe.txt"), "x"));
attempt("execShell", () => execFileSync("/bin/sh", ["-c", "true"]));
attempt("execEnv", () => execFileSync("/usr/bin/env", ["true"]));
attempt("execUsrBinGit", () => execFileSync("/usr/bin/git", ["--version"], quiet));
// Deny-name escaping: each denied name must be refused, each separator look-alike must still read.
for (const [label, p] of Object.entries(names.deny ?? {})) attempt(`deny:${label}`, () => fs.readFileSync(p));
for (const [label, p] of Object.entries(names.allow ?? {})) attempt(`allow:${label}`, () => fs.readFileSync(p));
for (const [label, p] of Object.entries(names.info ?? {})) attempt(`info:${label}`, () => fs.readFileSync(p));
// Loopback to a port nobody listens on: unsandboxed this is ECONNREFUSED; under the profile it must be EPERM.
await new Promise<void>((done) => {
  const s = net.connect({ host: "127.0.0.1", port: Number(port), timeout: 3000 });
  s.on("connect", () => {
    r.network = "ok";
    s.destroy();
    done();
  });
  s.on("error", (e: NodeJS.ErrnoException) => {
    r.network = `blocked:${e.code ?? "error"}`;
    done();
  });
  s.on("timeout", () => {
    r.network = "blocked:timeout";
    s.destroy();
    done();
  });
});
console.log(JSON.stringify(r));
