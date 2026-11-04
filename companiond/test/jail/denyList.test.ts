import { test } from "node:test";
import assert from "node:assert/strict";
import { foldName } from "../../src/jail/fold.ts";
import {
  DENIED_NAME_GLOBS,
  DENIED_SEATBELT_SEGMENTS,
  denyPathspecs,
  isDeniedName,
  isDeniedRelPath,
} from "../../src/jail/denyList.ts";

test("fold maps case, Kelvin sign, long s and fullwidth letters to ASCII lower case", () => {
  assert.equal(foldName(".ENV.Local"), ".env.local");
  assert.equal(foldName("a.Key"), "a.key");
  assert.equal(foldName("ſecret.txt"), "secret.txt");
  assert.equal(foldName("ｓecret.yaml"), "secret.yaml");
  assert.equal(foldName("Café"), "café");
});

const denied = [
  ".env", ".ENV", ".ENV.local", ".env.example", ".envrc",
  "server.PEM", "a.key", "a.Key", "x.p8", "x.p12", "x.pfx", "x.jks", "x.keystore", "x.crt", "x.der",
  "x.ppk", "vault.kdbx", "id_rsa", "id_ed25519.pub", "ID_ECDSA", "id_dsa",
  "credentials.json", "aws-Credentials", "secrets.yaml", "ſecret.txt", "ｓecret.yaml",
  "service-account-prod.json", "prod.tfvars", "terraform.tfstate", "terraform.tfstate.backup",
  ".npmrc", ".pypirc", ".netrc", ".pgpass", ".git-credentials", ".htpasswd",
  ".git", ".GIT", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "node_modules", "NODE_MODULES",
  ".venv", "venv", ".codex", ".claude",
];
const allowed = [
  "README.md", "environment.ts", "envoy.yaml", ".gitignore", ".github", "keyboard.ts", "key.ts",
  "monkey.ts", "src", "package.json", "service.json", "id.ts", "tfvars.md",
];

test("denied names are denied in any case or Unicode look-alike", () => {
  for (const n of denied) assert.equal(isDeniedName(n), true, n);
});

test("ordinary names are allowed", () => {
  for (const n of allowed) assert.equal(isDeniedName(n), false, n);
});

test("every segment of a relative path is checked", () => {
  assert.equal(isDeniedRelPath(".git/config"), true);
  assert.equal(isDeniedRelPath("src/.ENV"), true);
  assert.equal(isDeniedRelPath("docs/secret-plan/a.md"), true);
  assert.equal(isDeniedRelPath("a/node_modules/b/index.js"), true);
  assert.equal(isDeniedRelPath("src/app.ts"), false);
  assert.equal(isDeniedRelPath(""), false);
});

test("every glob names something the deny-list denies", () => {
  for (const g of DENIED_NAME_GLOBS) assert.equal(isDeniedName(g.replaceAll("*", "x")), true, g);
});

test("pathspecs exclude each glob as a file and as a folder", () => {
  const specs = denyPathspecs();
  assert.equal(specs.length, DENIED_NAME_GLOBS.length * 2);
  assert.ok(specs.includes(":(exclude,icase,glob)**/.env"));
  assert.ok(specs.includes(":(exclude,icase,glob)**/.env/**"));
});

test("Seatbelt fragments agree with the deny-list, except the four git-needed names", () => {
  const res = DENIED_SEATBELT_SEGMENTS.map((f) => new RegExp(`^(?:${f})$`, "i"));
  const sb = (n: string) => res.some((r) => r.test(n));
  const toolLayerOnly = new Set([".git", ".GIT", "node_modules", "NODE_MODULES", ".venv", "venv"]);
  // ASCII names only: Unicode look-alikes are caught by the tool layer's fold, not by Seatbelt.
  for (const n of denied.filter((x) => /^[\x20-\x7e]+$/.test(x))) {
    assert.equal(sb(n), !toolLayerOnly.has(n), n);
  }
  for (const n of allowed) assert.equal(sb(n), false, n);
});
