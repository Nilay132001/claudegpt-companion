// Token-shaped strings are assembled at run time so the repo never contains them (spec §13).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redact, redactText, REDACTION_NOTICE } from "../../src/jail/redactor.ts";
import { pemBody } from "../helpers/fixtures.ts";

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

test("a PEM body with no header (a page that starts mid-key) is masked line by line", () => {
  const body = pemBody(25, 100);
  const page = [...body, j("-----END ", "RSA PRIVATE KEY-----"), "next: value-ok"].map((l, i) => `${40 + i}\t${l}`).join("\n");
  const out = redactText(page).split("\n");
  for (let i = 0; i < body.length; i++) assert.equal(out[i], `${40 + i}\t[REDACTED:private-key]`, `line ${40 + i}`);
  assert.equal(out[body.length], `${40 + body.length}\t[REDACTED:private-key]`, "lone END line");
  assert.equal(out.at(-1), `${41 + body.length}\tnext: value-ok`);
  assert.doesNotMatch(out.join("\n"), /[A-Za-z0-9+/]{20,}/);
  // Indented (YAML block) and unnumbered bodies too, with CRLF line ends.
  assert.equal(redactText(`key: |\r\n    ${body[0]}\r\n    ${body[1]}\r\n`), "key: |\r\n    [REDACTED:private-key]\r\n    [REDACTED:private-key]\r\n");
});

test("ordinary lines are not taken for a PEM body", () => {
  const plain = [
    "12\tsrc/components/forms/inputs/TextInputField.tsx",
    "src/v2/Components/Forms/Inputs/TextInputField42",
    "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
    "3f1c2a9b8e7d6c5b4a3928170615f4e3d2c1b0a93f1c2a9b8e7d6c5b4a392817",
    "export const value = 1;",
    "13\t",
    "aaaaaaaaaaaaaaaaaaaa==",
  ];
  for (const s of plain) assert.equal(redactText(s), s, s);
});

test("secret key words match whole key segments, and counts are not secrets", () => {
  const plain = [
    '"author": "Synthetic Person, synthetic fixture"',
    "tokenizer: cl100k_base_synthetic",
    "maxTokens: 4096",
    "const tokenCount = 1234;",
    "https://example.com/cb?oauth_callback=https%3A%2F%2Fexample.com%2Fdone",
  ];
  for (const s of plain) assert.equal(redactText(s), s, s);
  // Whole segments, glued prefixes and camelCase still count.
  assert.equal(redactText(j("accessToken: ", "abc123-synthetic")), "accessToken: [REDACTED:value]");
  assert.equal(redactText(j("dbpass", "word=", "abc123")), "dbpassword=[REDACTED:value]");
  assert.equal(redactText(j("AUTH_", "TOKEN=", "12345678")), "AUTH_TOKEN=[REDACTED:value]");
  // Plural, key and digit suffixes after the word are still secret keys, and numbers under a password key
  // are still secrets: only token counts and limits keep their numbers.
  const masked: Array<[string, string]> = [
    [j("SECRET", "KEY=", "abc123xyz"), "SECRETKEY=[REDACTED:value]"],
    [j("secret", "key=", "abc123xyz"), "secretkey=[REDACTED:value]"],
    [j("PASS", "WORD2=", "abc123"), "PASSWORD2=[REDACTED:value]"],
    [j("tok", "en2: ", "abc123xyz"), "token2: [REDACTED:value]"],
    [j("api", "Keys: ", "abc123xyz"), "apiKeys: [REDACTED:value]"],
    [j("pass", "word: ", "12345678"), "password: [REDACTED:value]"],
    [j('"pass', 'word": ', "12345678"), '"password": [REDACTED:value]'],
  ];
  for (const [s, want] of masked) assert.equal(redactText(s), want, s);
});

test("the word basic in prose is not basic auth", () => {
  const s = "This adds basic internationalization support and basic accessibilityfeatures.";
  assert.equal(redactText(s), s);
  // A base64 sign in the payload, or an Authorization key, still masks.
  assert.equal(redactText(j("curl -H 'X: Basic ", "c3ludGhldGljOnN5bnRo", "'")), "curl -H 'X: Basic [REDACTED:basic-auth]'");
  assert.equal(redactText(j("Authorization: Basic ", "syntheticlettersonly")), "Authorization: Basic [REDACTED:basic-auth]");
});

test("the PEM-body and basic-auth rules stay linear on 256 KB", () => {
  const inputs = [
    `${"A1b2".repeat(19)}\n`.repeat(3449),
    "1\t".repeat(131072),
    " ".repeat(262144),
    "Basic ".repeat(43690),
    "authorization: ".repeat(17476),
    `${"a".repeat(80)}\n`.repeat(3236),
  ];
  for (const s of inputs) {
    const t0 = performance.now();
    redact(s);
    const ms = performance.now() - t0;
    assert.ok(ms < 500, `${JSON.stringify(s.slice(0, 8))}…: ${Math.round(ms)} ms`);
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
