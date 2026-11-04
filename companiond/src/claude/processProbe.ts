import { execFile } from "node:child_process";
import type { ProcessProbe } from "./runningFiles.ts";

/**
 * Real probe. `process.kill(pid, 0)` sends no signal; it only checks the pid exists
 * (EPERM means it exists but belongs to someone else). Start time comes from `/bin/ps -o lstart=`.
 * This is the only file in the M3 folders that may import node:child_process; it never runs git.
 */
export const nodeProcessProbe: ProcessProbe = {
  isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  startTimeMs(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return Promise.resolve(null);
    const env: NodeJS.ProcessEnv = { LC_ALL: "C" };
    if (process.env.TZ) env.TZ = process.env.TZ;
    return new Promise((resolve) => {
      execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env, timeout: 2000 }, (err, stdout) => {
        if (err) return resolve(null);
        const ms = Date.parse(String(stdout).trim().replace(/\s+/g, " "));
        resolve(Number.isFinite(ms) ? ms : null);
      });
    });
  },
};
