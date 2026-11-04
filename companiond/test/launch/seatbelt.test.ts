import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import {
  assertReadablePrefix, buildReadonlyProfile, caseInsensitive, DEFAULT_PROFILE_OPTIONS, denyRegex,
  profileEnv, sbString, type ProfileInput,
} from "../../src/launch/seatbelt.ts";
import fs from "node:fs";
import path from "node:path";
import { isTooBroad, machOLoadPaths, nodeReadPaths, symlinkMetadataPaths } from "../../src/launch/toolchain.ts";
import { DENIED_SEATBELT_SEGMENTS, isDeniedName } from "../../src/jail/denyList.ts";
import { removeTempDirs, tempDir } from "../helpers/fixtures.ts";

test.after(removeTempDirs);

test("symlink hops get metadata-only literal rules in narrow mode, and nothing else", () => {
  const links = ["/opt/homebrew/opt/llhttp", "/opt/homebrew/opt/libuv"];
  const p = buildReadonlyProfile({ ...base, metadataPaths: links });
  const meta = p.slice(p.indexOf("(allow file-read-metadata"), p.indexOf("(allow file-write-data"));
  const read = p.slice(p.indexOf("(allow file-read*"), p.indexOf("(allow file-read-metadata"));
  assert.equal(p.match(/file-write/g)?.length, 1);
  for (const m of links) {
    assert.ok(meta.includes(`(literal "${m}")`), m);
    assert.ok(!p.includes(`(subpath "${m}")`), m);
    assert.ok(!read.includes(`"${m}"`), `${m} must not be in the file-read* rule`);
  }
  assert.ok(!p.includes('(subpath "/opt/homebrew/opt")'));
  assert.throws(() => buildReadonlyProfile({ ...base, metadataPaths: ["/opt/homebrew"] }), /refusing/);
  assert.throws(() => buildReadonlyProfile({ ...base, metadataPaths: ["/tmp"] }), /refusing/);
  assert.throws(() => buildReadonlyProfile({ ...base, metadataPaths: ['/a"b'] }), /not usable/);
});

test("symlinkMetadataPaths records every hop, follows link chains, and leaves out too-broad links", () => {
  const t = tempDir("cgc-links-");
  fs.mkdirSync(path.join(t, "Cellar/foo/1/lib"), { recursive: true });
  fs.writeFileSync(path.join(t, "Cellar/foo/1/lib/libfoo.1.dylib"), "SYNTHETIC FIXTURE\n");
  fs.symlinkSync("libfoo.1.dylib", path.join(t, "Cellar/foo/1/lib/libfoo.dylib"));
  fs.mkdirSync(path.join(t, "opt"));
  fs.symlinkSync("../Cellar/foo/1", path.join(t, "opt/foo"));
  fs.symlinkSync("foo", path.join(t, "opt/foo-alias")); // link to a link
  fs.mkdirSync(path.join(t, "real"));
  const got = symlinkMetadataPaths([
    path.join(t, "opt/foo-alias/lib/libfoo.dylib"), path.join(t, "missing/x.dylib"), "relative/x.dylib",
  ]);
  assert.deepEqual(got, [
    path.join(t, "Cellar/foo/1/lib/libfoo.dylib"), path.join(t, "opt/foo"), path.join(t, "opt/foo-alias"),
  ]);
  for (const g of got) assert.equal(isTooBroad(g), false, g);
  // On macOS /tmp and /var are symlinks into /private: too broad to name, so never recorded.
  const sys = symlinkMetadataPaths(["/tmp/x", "/var/x"]);
  assert.ok(!sys.includes("/tmp") && !sys.includes("/var"));
  assert.equal(symlinkMetadataPaths([t]).length, 0);
});

test("machOLoadPaths reads Node's install names on macOS and returns [] for non-Mach-O files", { skip: process.platform !== "darwin" && "macOS only" }, () => {
  const loads = machOLoadPaths(fs.realpathSync.native(process.execPath));
  assert.ok(loads.some((l) => l.startsWith("/usr/lib/")), loads.join(","));
  const t = tempDir("cgc-macho-");
  assert.deepEqual(machOLoadPaths(path.join(t, "nope")), []);
  fs.writeFileSync(path.join(t, "text"), "SYNTHETIC FIXTURE\n");
  assert.deepEqual(machOLoadPaths(path.join(t, "text")), []);
});

const base: ProfileInput = {
  root: "/private/var/folders/xx/T/cgc-repo-1",
  gitDir: "/private/var/folders/xx/T/cgc-repo-1/.git",
  commonDir: "/private/var/folders/xx/T/cgc-repo-1/.git",
  codeDir: "/opt/companion/companiond",
  nodePath: "/opt/homebrew/Cellar/node/26.7.0/bin/node",
  nodeReadDirs: ["/opt/homebrew/Cellar/node/26.7.0", "/opt/homebrew/Cellar/libuv/1.52.1"],
  nodeReadFiles: [],
  metadataPaths: [],
  gitPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
  developerDir: "/Applications/Xcode.app/Contents/Developer",
  options: { nodeReads: "exact", metadata: "narrow", denyNames: true, opensslConf: "devnull" },
};

test("profile denies by default, allows exec of node and git only, writes only /dev/null, no network", () => {
  const p = buildReadonlyProfile(base);
  assert.match(p, /^\(version 1\)\n\(deny default\)\n\(import "system\.sb"\)\n/);
  assert.match(p, /\(allow process-exec \(literal "\/opt\/homebrew\/Cellar\/node\/26\.7\.0\/bin\/node"\) \(literal "\/Applications\/Xcode\.app\/Contents\/Developer\/usr\/bin\/git"\)\)/);
  assert.equal(p.match(/process-exec/g)?.length, 1);
  assert.equal(p.match(/file-write/g)?.length, 1);
  assert.match(p, /\(allow file-write-data \(literal "\/dev\/null"\)\)/);
  assert.doesNotMatch(p, /allow network/);
  assert.match(p, /\(deny network\*\)\n$/);
  for (const r of [base.root, base.codeDir, ...base.nodeReadDirs]) assert.ok(p.includes(`(subpath "${r}")`), r);
  assert.ok(!p.includes('"/usr/bin/git"'), "/usr/bin/git must not be allowed (ruling 9)");
  assert.doesNotMatch(p, /opt\/homebrew\/opt|homebrew\/etc/);
});

test("broad Homebrew reads and open metadata appear only when chosen", () => {
  const p = buildReadonlyProfile({ ...base, options: { ...base.options, nodeReads: "homebrew-broad", metadata: "all" } });
  assert.ok(p.includes('(subpath "/opt/homebrew/opt")'));
  assert.ok(p.includes("(allow file-read-metadata)"));
  assert.ok(!buildReadonlyProfile(base).includes("(allow file-read-metadata)"));
});

test("worktree git dirs are readable", () => {
  const p = buildReadonlyProfile({ ...base, gitDir: "/x/main/.git/worktrees/wt", commonDir: "/x/main/.git" });
  assert.ok(p.includes('(subpath "/x/main/.git/worktrees/wt")'));
  assert.ok(p.includes('(subpath "/x/main/.git")'));
  assert.ok(!p.includes('(subpath "/x/main")'));
});

test("deny regex is case-insensitive and anchored under root", () => {
  assert.equal(caseInsensitive("\\.env"), "\\.[eE][nN][vV]");
  assert.equal(caseInsensitive("[^/]*\\.tfvars"), "[^/]*\\.[tT][fF][vV][aA][rR][sS]");
  const re = new RegExp(denyRegex("/r/o+ot"));
  assert.ok(re.test("/r/o+ot/.ENV"));
  assert.ok(re.test("/r/o+ot/a/Secrets.yaml/x"));
  assert.ok(!re.test("/r/o+ot/src/app.ts"));
  assert.ok(!re.test("/r/ooot/.env"));
  assert.ok(!re.test("/r/o+ot/.git/config"));
  assert.ok(buildReadonlyProfile(base).includes('(deny file-read-data (regex #"^'));
  assert.ok(!buildReadonlyProfile({ ...base, options: { ...base.options, denyNames: false } }).includes("regex"));
});

test("caseInsensitive keeps character classes intact and folds the letters inside them", () => {
  assert.equal(caseInsensitive("[^/]*"), "[^/]*");
  assert.equal(caseInsensitive("[^/]*x[^/]*"), "[^/]*[xX][^/]*");
  assert.equal(caseInsensitive("[ab]"), "[aAbB]");
  assert.equal(caseInsensitive("[^ab/]"), "[^aAbB/]");
  assert.equal(caseInsensitive("[a-c]"), "[a-cA-C]");
  assert.equal(caseInsensitive("[]a]"), "[]aA]");
  const re = new RegExp(`^${caseInsensitive("[^a-c/]x")}$`);
  assert.ok(re.test("dX") && re.test("zx"));
  assert.ok(!re.test("Bx") && !re.test("bx") && !re.test("/x"));
  assert.equal(caseInsensitive("[0-9]"), "[0-9]");
  for (const bad of ["[A-z]", "[a-Z]", "[0-z]", "[[:alpha:]]", "[ab"]) assert.throws(() => caseInsensitive(bad), Error, bad);
});

test("caseInsensitive keeps escapes: the escaped char is never wrapped in a class", () => {
  assert.equal(caseInsensitive("a\\.b"), "[aA]\\.[bB]");
  assert.equal(caseInsensitive("\\.env\\.[^/]*"), "\\.[eE][nN][vV]\\.[^/]*");
  assert.equal(caseInsensitive("\\\\x"), "\\\\[xX]");
  assert.equal(caseInsensitive("[\\]a]"), "[\\]aA]");
  const re = new RegExp(`^${caseInsensitive("a\\.b")}$`);
  assert.ok(re.test("A.b"));
  assert.ok(!re.test("a_b") && !re.test("a-b"));
});

test("caseInsensitive keeps groups and alternation", () => {
  assert.equal(caseInsensitive("(a|bc)"), "([aA]|[bB][cC])");
  assert.equal(caseInsensitive("id_(rsa|dsa)[^/]*"), "[iI][dD]_([rR][sS][aA]|[dD][sS][aA])[^/]*");
  const re = new RegExp(`^${caseInsensitive("x\\.(pem|key)")}$`);
  assert.ok(re.test("X.PEM") && re.test("x.Key"));
  assert.ok(!re.test("x.pemkey") && !re.test("x.(pem|key)"));
});

test("every Seatbelt deny fragment matches one whole path segment, as the tool deny-list does", () => {
  const root = "/r/root";
  const re = new RegExp(denyRegex(root));
  const names = [
    ".env", ".ENV", ".env.local", ".envrc", "x.pem", "a.KEY", "id_rsa", "id_ed25519.pub", "my-credentials.json",
    "Secrets.yaml", "service-account-1.json", "prod.tfvars", "x.tfstate.backup", ".npmrc", ".git-credentials",
    ".ssh", ".aws", ".claude",
    // look-alikes that differ by a separator, a prefix or a suffix: allowed by both
    "_env", "-env", "x.env", "foo.env.bak", ".envrcx", "x_pem", "x-pem", "x.pemx", "id-rsa", ".awsx", "aws",
    "service-account.yaml", "service_account.json", "prod.tfvars.txt", "_npmrc", "app.ts", "README.md",
  ];
  for (const n of names) {
    assert.equal(re.test(`${root}/${n}`), isDeniedName(n), `${n} at top level`);
    assert.equal(re.test(`${root}/a/b/${n}`), isDeniedName(n), `${n} nested`);
    assert.equal(re.test(`${root}/a/${n}/inner.txt`), isDeniedName(n), `${n} as a folder`);
  }
  // A denied name as part of a longer segment is not a match unless the deny-list says so.
  assert.ok(!re.test(`${root}/x.env/y`));
  assert.ok(!re.test(`${root}/a.ssh`));
  // Every fragment, made case-insensitive, is still a valid regex.
  for (const f of DENIED_SEATBELT_SEGMENTS) assert.doesNotThrow(() => new RegExp(caseInsensitive(f)), f);
});

test("unsafe paths are refused", () => {
  assert.throws(() => sbString('/a"b'), /not usable/);
  assert.throws(() => sbString("/a\\b"), /not usable/);
  assert.throws(() => sbString("/a\nb"), /not usable/);
  assert.throws(() => sbString("rel"), /not usable/);
  const broad = [
    "/", "/Users", "/private/var/folders", "/tmp", "/usr/local", "/opt/homebrew", "/opt/local", "/Library",
    "/Applications", os.homedir(),
  ];
  for (const p of broad) {
    assert.throws(() => assertReadablePrefix(p), /refusing/, p);
    assert.equal(isTooBroad(p), true, p);
  }
  assert.throws(() => buildReadonlyProfile({ ...base, root: os.homedir() }), /refusing/);
  assert.throws(() => buildReadonlyProfile({ ...base, nodeReadDirs: ["/"] }), /refusing/);
  assert.throws(() => buildReadonlyProfile({ ...base, nodeReadDirs: ["/usr/local"] }), /refusing/);
});

test("single Node files become literal rules, never a whole folder", () => {
  const p = buildReadonlyProfile({ ...base, nodePath: "/usr/local/bin/node", nodeReadDirs: [], nodeReadFiles: ["/usr/local/bin/node"] });
  assert.ok(p.includes('(literal "/usr/local/bin/node")'));
  assert.ok(!p.includes('(subpath "/usr/local")'));
});

test("profile env sets OPENSSL_CONF only for devnull", () => {
  assert.deepEqual(profileEnv(base.options), { OPENSSL_CONF: "/dev/null" });
  assert.deepEqual(profileEnv({ ...base.options, opensslConf: "default" }), {});
  assert.ok(["devnull", "default"].includes(DEFAULT_PROFILE_OPTIONS.opensslConf));
});

test("the default options are the measured ones (findings doc, M2 profile measurements)", () => {
  assert.deepEqual({ ...DEFAULT_PROFILE_OPTIONS }, { nodeReads: "exact", metadata: "narrow", denyNames: true, opensslConf: "devnull" });
  assert.ok(Object.isFrozen(DEFAULT_PROFILE_OPTIONS));
});

test("node read paths: the node prefix plus one folder per non-system library", () => {
  const got = nodeReadPaths("/opt/n/26/bin/node", [
    "/opt/n/26/bin/node", "/usr/lib/libSystem.B.dylib", "/System/Library/Frameworks/X.framework/X",
    "/nonexistent/keg/lib/libmissing.dylib",
  ]);
  assert.deepEqual(got, { dirs: ["/opt/n/26"], files: [] });
});

test("a Node in /usr/local never makes /usr/local readable", () => {
  const got = nodeReadPaths("/usr/local/bin/node", ["/usr/local/bin/node"]);
  assert.ok(!got.dirs.includes("/usr/local"));
  assert.deepEqual(got.files, ["/usr/local/bin/node"]);
});
