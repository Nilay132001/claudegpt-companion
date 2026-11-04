// Seatbelt profile for companion-readonly (spec §7.2, M2 rulings 3–5). Runs in companiond.
import path from "node:path";
import { DENIED_SEATBELT_SEGMENTS } from "../jail/denyList.ts";
import { isTooBroad } from "./toolchain.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

export interface ProfileOptions {
  nodeReads: "exact" | "homebrew-broad";
  metadata: "narrow" | "all";
  denyNames: boolean;
  opensslConf: "devnull" | "default";
}

// Set from the Task 8 measurement. See the findings doc, "M2 profile measurements".
// metadata is "all": with exact Node reads, narrow metadata stops dyld from following Homebrew's
// /opt/homebrew/opt/<formula> symlinks to Node's libraries, and Node aborts at start.
export const DEFAULT_PROFILE_OPTIONS: ProfileOptions = Object.freeze({
  nodeReads: "exact",
  metadata: "all",
  denyNames: true,
  opensslConf: "devnull",
});

export interface ProfileInput {
  root: string;
  gitDir: string;
  commonDir: string;
  codeDir: string;
  nodePath: string;
  nodeReadDirs: readonly string[];
  nodeReadFiles: readonly string[];
  gitPath: string;
  developerDir: string | null;
  options: ProfileOptions;
}

const HOMEBREW_BROAD = ["/opt/homebrew/opt", "/opt/homebrew/Cellar", "/opt/homebrew/etc/openssl@3"];
const SYSTEM_READ_SUBPATHS = ["/usr/lib", "/usr/share", "/System", "/Library/Preferences"];
const SYSTEM_READ_LITERALS = ["/", "/usr", "/private/etc/localtime", "/dev/null", "/dev/urandom", "/dev/random"];
const SYSTEM_META_SUBPATHS = ["/usr", "/System", "/Library", "/private/etc", "/private/var/db", "/dev"];
const SYSTEM_META_LITERALS = ["/etc", "/var", "/tmp", "/private", "/private/var"];

export function sbString(p: string): string {
  if (!path.isAbsolute(p) || /["\\\u0000-\u001f\u007f]/.test(p)) {
    throw new Error(`path not usable in a Seatbelt profile: ${JSON.stringify(p)}`);
  }
  return `"${p}"`;
}

export function assertReadablePrefix(p: string): void {
  if (isTooBroad(p)) throw new Error(`refusing to allow reads of a whole system or home folder: ${path.resolve(p)}`);
}

const isAsciiLetter = (c: string | undefined): c is string => c !== undefined && /^[A-Za-z]$/.test(c);
const swapCase = (c: string): string => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());

// SBPL regexes have no case-insensitive flag, so every ASCII letter becomes a two-case class: `a` → `[aA]`.
// Escapes (`\.`) are copied untouched. Inside a bracket class the letters are added in both cases instead
// (`[^ab/]` → `[^aAbB/]`, `[a-c]` → `[a-cA-C]`), so a class is never nested or broken. Groups and
// alternation pass through. Anything this cannot fold safely (POSIX `[:name:]` classes, mixed-case or
// letter-to-symbol ranges, an unterminated class) throws rather than emit a regex that means something else.
export function caseInsensitive(re: string): string {
  const s = [...re];
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i] as string;
    if (ch === "\\") {
      out += ch + (s[i + 1] ?? "");
      i += 2;
    } else if (ch === "[") {
      let j = i + 1;
      let cls = "[";
      if (s[j] === "^") cls += s[j++];
      if (s[j] === "]") cls += s[j++];
      for (;;) {
        const c = s[j];
        if (c === undefined) throw new Error(`unterminated character class in ${JSON.stringify(re)}`);
        if (c === "]") break;
        if (c === "[" && s[j + 1] === ":") throw new Error(`POSIX class not supported in ${JSON.stringify(re)}`);
        if (c === "\\") {
          cls += c + (s[j + 1] ?? "");
          j += 2;
        } else if (s[j + 1] === "-" && s[j + 2] !== undefined && s[j + 2] !== "]") {
          const hi = s[j + 2] as string;
          const letters = isAsciiLetter(c) || isAsciiLetter(hi);
          const sameCaseLetters = isAsciiLetter(c) && isAsciiLetter(hi) && (c === c.toLowerCase()) === (hi === hi.toLowerCase());
          if (letters && !sameCaseLetters) {
            throw new Error(`range ${c}-${hi} cannot be made case-insensitive in ${JSON.stringify(re)}`);
          }
          cls += letters ? `${c}-${hi}${swapCase(c)}-${swapCase(hi)}` : `${c}-${hi}`;
          j += 3;
        } else {
          cls += isAsciiLetter(c) ? `${c.toLowerCase()}${c.toUpperCase()}` : c;
          j += 1;
        }
      }
      out += `${cls}]`;
      i = j + 1;
    } else {
      out += isAsciiLetter(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch;
      i += 1;
    }
  }
  return out;
}

const regexEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One whole path segment under root: `root/` then any folders, then the denied segment, then either the
// end of the path or `/` and anything below it.
export function denyRegex(root: string): string {
  return `^${regexEscape(root)}/(.*/)?(${DENIED_SEATBELT_SEGMENTS.map(caseInsensitive).join("|")})(/.*)?$`;
}

function ancestors(p: string): string[] {
  const out: string[] = [];
  let c = p;
  while (c !== "/") {
    c = path.dirname(c);
    out.push(c);
  }
  return out;
}

const subpath = (p: string) => `(subpath ${sbString(p)})`;
const literal = (p: string) => `(literal ${sbString(p)})`;

export function buildReadonlyProfile(i: ProfileInput): string {
  const o = i.options;
  const own = [i.root, i.gitDir, i.commonDir, i.codeDir, ...i.nodeReadDirs, ...(i.developerDir ? [i.developerDir] : [])];
  for (const p of own) assertReadablePrefix(p);
  const reads = [...new Set([...own, ...(o.nodeReads === "homebrew-broad" ? HOMEBREW_BROAD : [])])];
  const files = [...new Set(i.nodeReadFiles)];
  const readRule = [
    "(allow file-read*",
    ...[...reads, ...SYSTEM_READ_SUBPATHS].map((p) => `  ${subpath(p)}`),
    `  ${[...files, ...SYSTEM_READ_LITERALS].map(literal).join(" ")})`,
  ].join("\n");
  const metaLiterals = [
    ...new Set([...[...reads, ...files, i.nodePath, i.gitPath].flatMap(ancestors), ...files, ...SYSTEM_META_LITERALS]),
  ];
  const metaRule =
    o.metadata === "all"
      ? "(allow file-read-metadata)"
      : [
          "(allow file-read-metadata",
          ...[...reads, ...SYSTEM_META_SUBPATHS].map((p) => `  ${subpath(p)}`),
          `  ${metaLiterals.map(literal).join(" ")})`,
        ].join("\n");
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-fork)",
    `(allow process-exec ${literal(i.nodePath)} ${literal(i.gitPath)})`,
    readRule,
    metaRule,
    '(allow file-write-data (literal "/dev/null"))',
    "(allow sysctl-read)",
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    ...(o.denyNames ? [`(deny file-read-data (regex #"${denyRegex(i.root)}"))`] : []),
    "(deny network*)",
  ];
  return `${lines.join("\n")}\n`;
}

export function profileEnv(o: ProfileOptions): Record<string, string> {
  return o.opensslConf === "devnull" ? { OPENSSL_CONF: "/dev/null" } : {};
}
