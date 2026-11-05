// Where the relay lives (spec §7.1.9, M4a): App Support run/ and bin/, outside CODEX_HOME, so Codex can neither
// replace the binary nor touch the socket (its profile writes only CODEX_HOME). Both folders must be real
// folders owned by this user with mode 0700; anything else is refused, never repaired (review M7).
import fs from "node:fs";
import path from "node:path";

/** sizeof(sockaddr_un.sun_path) on macOS, NUL included (review M5). */
export const SUN_PATH_MAX = 104;

export interface RelayPaths { runDir: string; socket: string; binDir: string; binary: string }

export class RelaySetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelaySetupError";
  }
}

export function relayPaths(supportDir: string): RelayPaths {
  const runDir = path.join(supportDir, "run");
  const binDir = path.join(supportDir, "bin");
  const r: RelayPaths = { runDir, socket: path.join(runDir, "relay.sock"), binDir, binary: path.join(binDir, "cgc-relay") };
  if (Buffer.byteLength(r.socket) >= SUN_PATH_MAX) throw new RelaySetupError("The companion's folder path is too long for its relay socket.");
  return r;
}

export function checkPrivateDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new RelaySetupError("A relay folder is not a real folder.");
  if (st.uid !== (process.getuid?.() ?? -1)) throw new RelaySetupError("A relay folder belongs to another user.");
  if ((st.mode & 0o777) !== 0o700) throw new RelaySetupError("A relay folder is not private (0700).");
}

export function ensureRelayDirs(r: RelayPaths): RelayPaths {
  for (const d of [r.runDir, r.binDir]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    checkPrivateDir(d);
  }
  return r;
}
