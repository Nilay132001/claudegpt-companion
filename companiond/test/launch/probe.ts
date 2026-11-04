// Shared by test/launch/sandbox.test.ts and scripts/measure-profile.ts.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { buildReadonlyProfile, profileEnv, SANDBOX_EXEC, type ProfileOptions } from "../../src/launch/seatbelt.ts";
import type { Toolchain } from "../../src/launch/toolchain.ts";
import { fixtureGit, makeRepo, makeWorktree, put, tempDir } from "../helpers/fixtures.ts";

export type ProbeKind = "main" | "worktree";

export interface ProbeSetup {
  kind: ProbeKind;
  root: string;
  gitDir: string;
  commonDir: string;
  outsideFile: string;
  mainWorkFile: string;
  home: string;
  tmpDir: string;
  port: number;
  // label → absolute path. `deny` must be refused by the deny regex; `allow` look-alikes must read;
  // `info` is recorded only (how Seatbelt treats a differently-cased root).
  names: { deny: Record<string, string>; allow: Record<string, string>; info: Record<string, string> };
}

// Denied names, nested and at the top, in mixed case where the file system allows it.
const DENY_FILES = [
  "nested/.env.local", "keys/x.pem", "keys/A.KEY", "id_rsa_backup", "my-secret.txt", "cloud/.aws/config",
  "infra/prod.tfvars",
];
// Each differs from a denied name only by a separator (`_` or `-` for `.`), a prefix or a suffix. If the
// `\.` escapes were lost inside `#"..."`, `.` would match any character and these would be refused.
const ALLOW_LOOKALIKES = [
  "_env", "-env", "x.env", "foo.env.bak", "keys/x_pem", "keys/x-pem", "keys/x.pemx", "id-rsa", "cloud/.awsx/config",
  "infra/prod_tfvars", ".envrcx",
];

// A loopback port with no listener at the moment we look.
export function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

export async function makeProbeSetup(kind: ProbeKind): Promise<ProbeSetup> {
  const main = makeRepo({ "config/credentials.json": "CRED_ORIGINAL\n" });
  const root = kind === "main" ? main : makeWorktree(main);
  put(root, ".env", "ENV_ONLY_MARKER\n");
  put(root, "config/credentials.json", "CRED_CHANGED\n"); // tracked, denied, stat-dirty: git must still work
  const deny: Record<string, string> = { ".ENV": path.join(root, ".ENV") };
  for (const rel of DENY_FILES) deny[rel] = put(root, rel, "DENIED_NAME\n");
  const allow: Record<string, string> = {};
  for (const rel of ALLOW_LOOKALIKES) allow[rel] = put(root, rel, "LOOKALIKE\n");
  const upperRoot = root.toUpperCase();
  const info: Record<string, string> = {
    "UPPER-ROOT/README.md": path.join(upperRoot, "README.md"),
    "UPPER-ROOT/.env": path.join(upperRoot, ".env"),
  };
  const [gitDir = "", commonDir = ""] = fixtureGit(root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]).trim().split("\n");
  return {
    kind,
    root,
    gitDir: fs.realpathSync.native(gitDir),
    commonDir: fs.realpathSync.native(commonDir),
    outsideFile: put(tempDir("cgc-out-"), "outside.txt", "outside\n"),
    mainWorkFile: kind === "worktree" ? path.join(main, "README.md") : "",
    home: os.homedir(),
    tmpDir: fs.realpathSync.native(os.tmpdir()),
    port: await unusedPort(),
    names: { deny, allow, info },
  };
}

export interface ProbeRun {
  result: Record<string, string> | null;
  exit: number | null;
  stderrTail: string;
}

export function runProbe(tc: Toolchain, s: ProbeSetup, options: ProfileOptions): ProbeRun {
  const profile = buildReadonlyProfile({
    root: s.root, gitDir: s.gitDir, commonDir: s.commonDir, codeDir: tc.codeDir, nodePath: tc.nodePath,
    nodeReadDirs: tc.nodeReadDirs, nodeReadFiles: tc.nodeReadFiles, metadataPaths: tc.metadataPaths, gitPath: tc.gitPath,
    developerDir: tc.developerDir, options,
  });
  const probe = path.join(tc.codeDir, "test", "launch", "sandboxProbe.ts");
  const r = spawnSync(
    SANDBOX_EXEC,
    [
      "-p", profile, tc.nodePath, probe, s.root, s.outsideFile, tc.gitPath, s.mainWorkFile, s.home, s.tmpDir,
      String(s.port), JSON.stringify(s.names),
    ],
    { cwd: s.root, env: { PATH: "/usr/bin:/bin", ...profileEnv(options) }, encoding: "utf8", timeout: 30_000 },
  );
  const last = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  let result: Record<string, string> | null = null;
  try {
    result = JSON.parse(last) as Record<string, string>;
  } catch {
    result = null;
  }
  return { result, exit: r.status, stderrTail: (r.stderr ?? "").slice(-400) };
}

// "eperm" means Seatbelt itself refused (EPERM or EACCES). ENOENT, ECONNREFUSED or a timeout would be a
// false green: the target was missing or unreachable, not blocked.
const SEATBELT_BLOCK = /^blocked:(EPERM|EACCES)$/;

export function probeFailures(r: Record<string, string>, o: ProfileOptions, kind: ProbeKind): string[] {
  const fails: string[] = [];
  const want = (k: string, mode: "ok" | "eperm" | "not-ok") => {
    const got = r[k];
    if (got === undefined) fails.push(`${k}: missing`);
    else if (mode === "ok" ? got !== "ok" : mode === "eperm" ? !SEATBELT_BLOCK.test(got) : got === "ok") {
      fails.push(`${k}: ${got} (wanted ${mode})`);
    }
  };
  for (const k of ["readInside", "readDev", "gitStatus", "gitDiffNames", "gitGrep"]) want(k, "ok");
  for (const k of [
    "readOutside", "listOutsideParent", "listHome", "writeInside", "mkdirInside", "unlinkInside", "writeOutside",
    "writeTmp", "writeHome", "execShell", "execEnv", "execUsrBinGit", "network",
  ]) want(k, "eperm");
  want("listHomeSsh", "not-ok");
  if (kind === "worktree") want("readMainWorkTree", "eperm");
  if (o.metadata === "narrow") want("statOutside", "eperm");
  if (o.denyNames) {
    want("readDeniedInside", "eperm");
    for (const k of Object.keys(r).filter((k) => k.startsWith("deny:"))) want(k, "eperm");
  }
  for (const k of Object.keys(r).filter((k) => k.startsWith("allow:"))) want(k, "ok");
  // Every denied name and look-alike the setup made must have been tried.
  for (const rel of [".ENV", ...DENY_FILES]) if (r[`deny:${rel}`] === undefined) fails.push(`deny:${rel}: missing`);
  for (const rel of ALLOW_LOOKALIKES) if (r[`allow:${rel}`] === undefined) fails.push(`allow:${rel}: missing`);
  return fails;
}
