import { foldName } from "./fold.ts";

// Spec §7.2 deny-list. Every pattern runs on a folded name; both sets apply to every path segment.
const DENIED_DIRS = new Set([
  ".git", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "node_modules", ".venv", "venv", ".codex", ".claude",
]);

const DENIED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env$/,
  /^\.env\./,
  /^\.envrc$/,
  /\.(pem|key|p8|p12|pfx|jks|keystore|crt|der|ppk|kdbx)$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /credentials/,
  /secret/,
  /^service-account.*\.json$/,
  /\.tfvars$/,
  /\.tfstate/,
  /^\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)$/,
];

export function isDeniedName(name: string): boolean {
  const n = foldName(name);
  return DENIED_DIRS.has(n) || DENIED_FILE_PATTERNS.some((re) => re.test(n));
}

export function isDeniedRelPath(rel: string): boolean {
  if (rel === "") return false;
  return rel.split("/").some((seg) => seg !== "" && isDeniedName(seg));
}

// The same names as globs, for git pathspec excludes (search). The post-filter stays the real check.
export const DENIED_NAME_GLOBS: readonly string[] = [
  ".env", ".env.*", ".envrc",
  "*.pem", "*.key", "*.p8", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.crt", "*.der", "*.ppk", "*.kdbx",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "id_dsa*",
  "*credentials*", "*secret*", "service-account*.json", "*.tfvars", "*.tfstate*",
  ".npmrc", ".pypirc", ".netrc", ".pgpass", ".git-credentials", ".htpasswd",
  ".git", ".ssh", ".aws", ".gnupg", ".docker", ".kube", "node_modules", ".venv", "venv", ".codex", ".claude",
];

export function denyPathspecs(): string[] {
  return DENIED_NAME_GLOBS.flatMap((g) => [`:(exclude,icase,glob)**/${g}`, `:(exclude,icase,glob)**/${g}/**`]);
}

// Regex fragments for Seatbelt `file-read-data` denies (Task 8 measures whether they are kept).
// Each matches one whole path segment. Lower-case ASCII only: seatbelt.ts makes them case-insensitive.
// `.git`, `node_modules`, `.venv` and `venv` are left out: git, running inside the same profile, reads them.
export const DENIED_SEATBELT_SEGMENTS: readonly string[] = [
  "\\.env",
  "\\.env\\.[^/]*",
  "\\.envrc",
  "[^/]*\\.(pem|key|p8|p12|pfx|jks|keystore|crt|der|ppk|kdbx)",
  "id_(rsa|ed25519|ecdsa|dsa)[^/]*",
  "[^/]*credentials[^/]*",
  "[^/]*secret[^/]*",
  "service-account[^/]*\\.json",
  "[^/]*\\.tfvars",
  "[^/]*\\.tfstate[^/]*",
  "\\.(npmrc|pypirc|netrc|pgpass|git-credentials|htpasswd)",
  "\\.(ssh|aws|gnupg|docker|kube|codex|claude)",
];
