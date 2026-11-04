// Finds the pinned native Codex binary. companiond runs it directly (not the npm shim), so the
// Seatbelt profile can name exact paths.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PINNED_CODEX_VERSION = "0.166.0";

export interface CodexInstall {
  version: string;
  vendorDir: string;
  binary: string;
  codeModeHost: string | null;
  pathDir: string | null;
  resourcesDir: string | null;
}

export class CodexInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexInstallError";
  }
}

const PLATFORM: Record<string, { pkg: string; triple: string }> = {
  "darwin-arm64": { pkg: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
  "darwin-x64": { pkg: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
};

export function readVendorDir(vendorDir: string): CodexInstall {
  const real = fs.realpathSync.native(vendorDir);
  const meta = JSON.parse(fs.readFileSync(path.join(real, "codex-package.json"), "utf8")) as Record<string, unknown>;
  if (typeof meta.version !== "string" || typeof meta.entrypoint !== "string") {
    throw new CodexInstallError("codex-package.json has no version or entrypoint.");
  }
  const inside = (rel: unknown): string | null => {
    if (typeof rel !== "string") return null;
    const p = path.resolve(real, rel);
    if (p !== real && !p.startsWith(real + path.sep)) throw new CodexInstallError("codex-package.json points outside its folder.");
    return fs.existsSync(p) ? fs.realpathSync.native(p) : null;
  };
  const binary = inside(meta.entrypoint);
  if (!binary) throw new CodexInstallError("The Codex binary is missing.");
  const host = path.join(path.dirname(binary), "codex-code-mode-host");
  return {
    version: meta.version,
    vendorDir: real,
    binary,
    codeModeHost: fs.existsSync(host) ? fs.realpathSync.native(host) : null,
    pathDir: inside(meta.pathDir),
    resourcesDir: inside(meta.resourcesDir),
  };
}

export function findCodex(): CodexInstall {
  const p = PLATFORM[`${process.platform}-${process.arch}`];
  if (!p) throw new CodexInstallError(`Codex host runs on macOS only (this is ${process.platform}-${process.arch}).`);
  const require = createRequire(import.meta.url);
  let pkgJson: string;
  try {
    pkgJson = require.resolve(`${p.pkg}/package.json`);
  } catch {
    throw new CodexInstallError(`${p.pkg} is not installed. Run npm ci in companiond.`);
  }
  const install = readVendorDir(path.join(path.dirname(pkgJson), "vendor", p.triple));
  if (install.version !== PINNED_CODEX_VERSION) {
    throw new CodexInstallError(`Codex ${install.version} is installed; companiond is pinned to ${PINNED_CODEX_VERSION}.`);
  }
  return install;
}
