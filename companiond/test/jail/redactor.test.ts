// Token-shaped strings are assembled at run time so the repo never contains them (spec §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, redactText, REDACTION_NOTICE } from "../../src/jail/redactor.ts";

const j = (...p: string[]) => p.join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const random = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ALNUM[(i * 37 + seed) % 62]).join("");

const SHAPES: Array<[string, string]> = [
  ["private-key", j("-----BEGIN ", "RSA PRIVATE KEY-----\n", "SYNTHETIC\n", "-----END ", "RSA PRIVATE KEY-----")],
  ["jwt", j("ey", "JhbGciOiJIUzI1NiJ9", ".", "ey", "JzdWIiOiJzeW50aGV0aWMifQ", ".", "c2lnbmF0dXJlLXN5bnRoZXRpYw")],
  ["aws-key-id", j("AK", "IA", "SYNTHETIC0000000")],
  ["github-token", j("gh", "p_", random(36, 1))],
  ["github-token", j("github", "_pat_", random(50, 2))],
  ["anthropic-key", j("sk", "-ant-", "api03-", random(30, 3))],
  ["openai-key", j("sk", "-proj-", random(30, 4))],
  ["slack-token", j("xo", "xb-", "1234567890-", random(12, 5))],
  ["stripe-key", j("sk", "_live_", random(24, 6))],
  ["google-api-key", j("AI", "za", random(35, 7))],
];

test("common token shapes are masked by kind", () => {
  for (const [kind, secret] of SHAPES) {
    const r = redact(`before ${secret} after`);
    assert.equal(r.text, `before [REDACTED:${kind}] after`, kind);
    assert.equal(r.count, 1, kind);
  }
});

test("key = value pairs, JSON fields, bearer/basic auth and URL credentials", () => {
  assert.equal(redactText(j("DB_PASS", "WORD=", "hunter2-synthetic")), "DB_PASSWORD=[REDACTED:value]");
  assert.equal(redactText(j('{"client_', 'secret": "', "abc123-synthetic", '"}')), '{"client_secret": "[REDACTED:value]"}');
  assert.equal(redactText(j("pass", 'word: "', "hunter2-synthetic", '"')), 'password: "[REDACTED:value]"');
  assert.equal(redactText(j("api", "_key: ", "abcd-synthetic")), "api_key: [REDACTED:value]");
  assert.equal(redactText(j("Bearer ", random(24, 8))), "Bearer [REDACTED:bearer]");
  assert.equal(redactText(j("authorization: bearer ", random(24, 12))), "authorization: bearer [REDACTED:bearer]");
  assert.equal(redactText(j("Authorization: Basic ", "c3ludGhldGljOnN5bnRoZXRpYw==")), "Authorization: Basic [REDACTED:basic-auth]");
  assert.equal(redactText(j("authorization: basic ", "c3ludGhldGljOnN5bnRoZXRpYw==")), "authorization: basic [REDACTED:basic-auth]");
  // Letter-only values are still secrets in config: tight KEY=value, and UPPER_SNAKE keys with ":".
  assert.equal(redactText(j("DB_PASS", "WORD=", "supersecretvalue")), "DB_PASSWORD=[REDACTED:value]");
  assert.equal(redactText(j("export OPENAI_API", "_KEY=", "abcdefghijklmnop")), "export OPENAI_API_KEY=[REDACTED:value]");
  assert.equal(redactText(j("POSTGRES_PASS", "WORD: ", "changeme")), "POSTGRES_PASSWORD: [REDACTED:value]");
  assert.equal(redactText(j("postgres://app:", "s3cret-synthetic", "@db.internal:5432/x")), "postgres://[REDACTED:credentials]@db.internal:5432/x");
  // An earlier rule masking the user part must not leave the password in clear.
  assert.equal(redactText(j("https://", "sk", "-proj-", random(30, 13), ":", "pw-synthetic", "@host/x")), "https://[REDACTED:credentials]@host/x");
});

test("an empty value does not take the next line's key as its value", () => {
  assert.equal(redactText(j("database:\n  pass", "word: ", "s3cr3t-synthetic")), "database:\n  password: [REDACTED:value]");
  assert.equal(redactText(j("EMPTY=\nDB_PASS", "WORD=", "s3cr3t-synthetic")), "EMPTY=\nDB_PASSWORD=[REDACTED:value]");
  assert.equal(redactText("TOKEN=\nNEXT_VAR=foo"), "TOKEN=\nNEXT_VAR=foo");
});

test("code that names a secret is not a secret", () => {
  const code = [
    "password: string;",
    "const token = getToken();",
    "apiKey: process.env.API_KEY,",
    "secretName: z.string().min(1),",
    "if (token === undefined) return;",
    "const onToken = (token) => token;",
    "API_KEY: process.env.API_KEY,",
    "token=getToken();",
  ];
  for (const s of code) assert.equal(redactText(s), s, s);
});

test("long high-entropy strings are masked; ordinary text is not", () => {
  assert.equal(redactText(`id ${random(40, 9)} end`), "id [REDACTED:high-entropy] end");
  const plain = [
    "Fix the failing test in src/app/main.ts:42 and run npm test again.",
    "commit 3f1c2a9b8e7d6c5b4a3928170615f4e3d2c1b0a9", // git sha (hex)
    "test_value_test_value_test_value_test_value",   // long but low entropy
    "/usr/local/lib/node_modules/typescript/lib/tsc.js",
  ];
  for (const s of plain) assert.equal(redactText(s), s, s);
});

test("redaction is idempotent", () => {
  const once = redact(SHAPES.map(([, s]) => s).join("\n") + "\n" + j("TOKEN=", "abcd-synthetic") + "\n" + j("pass", 'word: "', "hunter2-synthetic", '"'));
  const twice = redact(once.text);
  assert.equal(twice.text, once.text);
  assert.equal(twice.count, 0);
});

test("adversarial input stays linear (256 KB in well under a second)", () => {
  for (const s of ["a-".repeat(131072), "x.".repeat(131072), "eyJ-".repeat(65536), "a=".repeat(131072), "ab://".repeat(52429)]) {
    const t0 = performance.now();
    redact(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${s.slice(0, 4)}…: ${Math.round(ms)} ms`);
  }
});

test("the notice says redaction is not a guarantee", () => {
  assert.match(REDACTION_NOTICE, /does not guarantee/);
});

test("the jail's injection point is the redactor, and every jail context uses it", async () => {
  const { redactToolOutput } = await import("../../src/jail/redact.ts");
  const token = j("gh", "p_", random(36, 11));
  assert.equal(redactToolOutput(`x ${token}`), "x [REDACTED:github-token]");
  // Every `redact:` value set in src/jail/ (a JailContext) must be redactToolOutput, so no other jail
  // entry (for example one that companiond's relay starts) can pass an identity redactor.
  const dir = fileURLToPath(new URL("../../src/jail/", import.meta.url));
  let assigned = 0;
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/\bredact:\s*([^,;}\n]+?)\s*[,}]/g)) {
      assert.equal(m[1], "redactToolOutput", `${f}: redact: ${m[1]}`);
      assigned++;
    }
    assert.doesNotMatch(src, /[{,]\s*redact\s*[,}]/, `${f}: shorthand redact property`);
  }
  assert.ok(assigned >= 1, "main.ts sets redact: redactToolOutput");
});
