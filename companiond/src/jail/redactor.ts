// Best-effort secret masking (spec §7.4). It reduces risk; it never guarantees every secret is gone.
// Pure, no imports: it runs inside the jailed MCP server and in ContextBuilder.
// Every pattern is linear-time: bounded or non-overlapping quantifiers only, because the jail feeds it
// up to 256 KB of untrusted repo text per tool call.

export interface RedactResult { text: string; count: number }

// Known limit: M3's parser trims transcript text and tool output (TEXT_MAX, TOOL_OUTPUT_MAX) before this
// runs, so a secret cut at that boundary can reach the context partly visible. ContextBuilder itself
// redacts before it clips.
export const REDACTION_NOTICE = "Redaction reduces risk; it does not guarantee every secret is removed.";

const mark = (kind: string) => `[REDACTED:${kind}]`;
const isMarked = (s: string) => s.includes("[REDACTED:");
const WHOLE_MARK = /^\[REDACTED:[a-z-]+\]$/;

/** `after` is the character right after the match ("" at the end of the input). */
interface Rule { kind: string; re: RegExp; replace?: (match: string, groups: Array<string | undefined>, after: string) => string }

const KEY_WORD = /password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|auth/i;
/** An identifier or member path with no digit (`string`, `process.env.API_KEY`): code, not a literal. */
const CODE_REF = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function maskValue(m: string, g: Array<string | undefined>, after: string): string {
  const [key = "", quote = "", sep = "", dq, sq, bare] = g;
  if (!KEY_WORD.test(key)) return m;
  if (dq !== undefined || sq !== undefined) {
    const v = dq ?? sq ?? "";
    const q = dq !== undefined ? '"' : "'";
    return isMarked(v) ? m : `${key}${quote}${sep}${q}${mark("value")}${q}`;
  }
  const v = bare ?? "";
  // A call (`getToken()`) or a member path (`process.env.API_KEY`) is code. A tight `KEY=value` or an
  // UPPER_SNAKE key (env files, YAML) is config: mask it even if the value is letters only. Otherwise a
  // bare identifier with no digit (`password: string`) is code.
  if (isMarked(v) || after === "(" || (CODE_REF.test(v) && v.includes(".") && !/[0-9]/.test(v))) return m;
  const config = sep === "=" || /^[A-Z][A-Z0-9_]*$/.test(key);
  if (!config && CODE_REF.test(v) && !/[0-9]/.test(v)) return m;
  return `${key}${quote}${sep}${mark("value")}`;
}

const RULES: Rule[] = [
  { kind: "private-key", re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g },
  { kind: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "aws-key-id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abprse]-[A-Za-z0-9-]{10,}/g },
  { kind: "slack-webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { kind: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { kind: "google-oauth", re: /\bya29\.[0-9A-Za-z_-]{20,}/g },
  {
    // user and password are captured apart, so a user an earlier rule masked does not shield the password.
    kind: "url-credentials",
    re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/)([^\s:@/]{1,256}):([^\s@/]{1,256})@/gi,
    replace: (m, g) => {
      const [scheme = "", user = "", pass = ""] = g;
      if (WHOLE_MARK.test(`${user}:${pass}`) || WHOLE_MARK.test(pass)) return m;
      return `${scheme}${mark("credentials")}@`;
    },
  },
  { kind: "bearer", re: /\b(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{16,}/gi, replace: (m, g) => (isMarked(m) ? m : `${g[0] ?? ""}${mark("bearer")}`) },
  { kind: "basic-auth", re: /\b(Basic[ \t]+)[A-Za-z0-9+/]{16,}={0,2}/gi, replace: (m, g) => (isMarked(m) ? m : `${g[0] ?? ""}${mark("basic-auth")}`) },
  {
    // KEY=value, key: value, "key": "value". Only literals: a quoted string, or an unquoted value that is
    // not code (no call, no member access; a bare identifier such as a type name counts as code unless
    // the pair is a tight KEY=value or has an UPPER_SNAKE key).
    // The key starts only where a key-character run starts, so a long run is scanned once.
    kind: "value",
    re: /(?<![\w.$-])([A-Za-z_][\w.-]{0,63})(["']?)([ \t]*(?::|=(?![=>]))[ \t]*)(?:"([^"\\\n]{4,1024})"|'([^'\\\n]{4,1024})'|([^\s"'`,;(){}[\]<>]{4,}))/g,
    replace: maskValue,
  },
];

const CANDIDATE = /[A-Za-z0-9+=_-]{32,}/g;
const ENTROPY_BITS = 4.2;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksRandom(s: string): boolean {
  if (!/[A-Za-z]/.test(s) || !/[0-9]/.test(s)) return false;
  if (/^[0-9a-f]+$/i.test(s)) return false; // hex hashes and git SHAs
  return entropy(s) >= ENTROPY_BITS;
}

export function redact(input: string): RedactResult {
  let count = 0;
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (match: string, ...rest: unknown[]) => {
      const source = rest.at(-1) as string;
      const offset = rest.at(-2) as number;
      const groups = rest.slice(0, -2) as Array<string | undefined>;
      const after = source.charAt(offset + match.length);
      const out = rule.replace ? rule.replace(match, groups, after) : isMarked(match) ? match : mark(rule.kind);
      if (out !== match) count++;
      return out;
    });
  }
  text = text.replace(CANDIDATE, (m) => {
    if (!looksRandom(m)) return m;
    count++;
    return mark("high-entropy");
  });
  return { text, count };
}

export function redactText(input: string): string {
  return redact(input).text;
}
