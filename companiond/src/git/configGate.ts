// Repo config gate (spec §7.3 as extended by M2).
export interface ConfigEntry {
  scope: string;
  key: string;
}

// `git config --list --null --show-scope --no-includes` prints "<scope>\0<key>\n<value>\0" per entry,
// or "<scope>\0<key>\0" for a key with no value. Section and key names are case-insensitive.
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split("\0");
  const entries: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const scope = parts[i] ?? "";
    const body = parts[i + 1] ?? "";
    const nl = body.indexOf("\n");
    entries.push({ scope, key: (nl === -1 ? body : body.slice(0, nl)).toLowerCase() });
  }
  return entries;
}

const PROGRAM_KEYS = new Set([
  "core.fsmonitor", "core.pager", "core.sshcommand", "core.askpass", "core.gitproxy", "core.editor",
  "sequence.editor", "diff.external",
]);
const PROGRAM_PREFIXES = ["filter.", "include.", "includeif.", "pager."];
// Matched on the variable name (the last dot-separated segment) with no dot required before the suffix,
// so core.alternateRefsCommand, gpg.ssh.defaultKeyCommand, uploadpack.packObjectsHook and
// sendemail.sendmailCmd are caught as well as diff.x.command.
const PROGRAM_NAME_SUFFIX = /(command|cmd|program|helper|driver|textconv|hook)$/i;

export function isProgramKey(key: string): boolean {
  const k = key.toLowerCase();
  const name = k.slice(k.lastIndexOf(".") + 1);
  return PROGRAM_KEYS.has(k) || PROGRAM_PREFIXES.some((p) => k.startsWith(p)) || PROGRAM_NAME_SUFFIX.test(name);
}

export function programKeys(entries: ConfigEntry[]): string[] {
  return entries.filter((e) => isProgramKey(e.key)).map((e) => e.key);
}

// Keys that move the tree git reads away from the root the tool layer checks. With core.worktree set,
// `git diff -- a.txt` diffs <worktree>/a.txt while the tool layer's contained open checks <root>/a.txt.
const REPO_SHAPE_KEYS = new Set(["core.worktree"]);

export function isRepoShapeKey(key: string): boolean {
  return REPO_SHAPE_KEYS.has(key.toLowerCase());
}

export function repoShapeKeys(entries: ConfigEntry[]): string[] {
  return entries.filter((e) => isRepoShapeKey(e.key)).map((e) => e.key);
}

// The refusal reason is shown in the UI and returned to GPT: keep it short and free of URLs
// (a remote URL can carry a token). Subsection names are chosen by whoever wrote the repo's config, so
// every code point outside [\w.:*@/-] becomes "?" (no control chars, newlines, quotes or bidi marks),
// and the 80-character cap counts code points.
const UNSAFE_KEY_CHAR = /[^\w.:*@/-]/gu;

export function describeKeys(keys: readonly string[]): string {
  const clean = [...new Set(keys)].map((k) =>
    k.replace(UNSAFE_KEY_CHAR, "?").replace(/[a-z][a-z0-9+.-]*:\/\/[^\s,]*/gi, "<url>"),
  );
  const more = clean.length > 3 ? ` and ${clean.length - 3} more` : "";
  const text = [...(clean.slice(0, 3).join(", ") + more)];
  return text.length > 80 ? `${text.slice(0, 79).join("")}…` : text.join("");
}
