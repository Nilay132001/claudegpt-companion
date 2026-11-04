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
const PROGRAM_SUFFIXES = [".textconv", ".command", ".cmd", ".program", ".helper", ".driver"];

export function isProgramKey(key: string): boolean {
  const k = key.toLowerCase();
  return PROGRAM_KEYS.has(k) || PROGRAM_PREFIXES.some((p) => k.startsWith(p)) || PROGRAM_SUFFIXES.some((s) => k.endsWith(s));
}

export function programKeys(entries: ConfigEntry[]): string[] {
  return entries.filter((e) => isProgramKey(e.key)).map((e) => e.key);
}

// The refusal reason is shown in the UI and returned to GPT: keep it short and free of URLs
// (a remote URL can carry a token).
export function describeKeys(keys: readonly string[]): string {
  const clean = [...new Set(keys)].map((k) => k.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s,]*/gi, "<url>"));
  const more = clean.length > 3 ? ` and ${clean.length - 3} more` : "";
  const text = clean.slice(0, 3).join(", ") + more;
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
