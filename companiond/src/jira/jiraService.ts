// The daemon's Jira state (owner ruling B): the credential in memory only, handed to CodexHost as a JiraBinding (the
// secret goes to companion-jira's fd 3 through the relay) and to the --check run. Nothing here logs, stores or
// returns the token.
import { spawn } from "node:child_process";
import type { JiraBinding } from "../codex/codexHost.ts";
import type { LaunchSpec } from "../launch/seatbelt.ts";
import type { JiraErrorKind } from "./client.ts";
import { encodeSecret, parseCredentials, redactedCredentials, type JiraCredentials } from "./credentials.ts";

export type JiraStatus = { configured: boolean; site: string | null; email: string | null };
export type JiraCheck = { ok: boolean; detail: string };
export type CheckRunner = (secret: string) => Promise<{ ok: boolean; kind?: string }>;

export const CHECK_DETAILS: Record<"ok" | "setup" | "timeout" | JiraErrorKind, string> = {
  ok: "Connected. GPT can read Jira.",
  setup: "Jira is not set up.",
  timeout: "Jira did not answer in time.",
  auth: "Jira refused the token. It needs read:jira-work and read:jira-user.",
  notFound: "Jira answered, but the token cannot see your profile.",
  badRequest: "Jira refused the request.",
  rateLimited: "Jira is rate-limiting requests. Try again in a minute.",
  network: "Jira could not be reached.",
  site: "That Jira site could not be found.",
  tooLarge: "Jira's answer was too large.",
  server: "Jira had an error. Try again later.",
};

export interface JiraServiceOptions {
  host: { setJira(j: JiraBinding | null): void };
  /** null when there is no macOS toolchain: the credential is kept, but no thread gets Jira. */
  binding: ((secret: string) => JiraBinding) | null;
  runCheck: CheckRunner | null;
}

export class JiraService {
  #o: JiraServiceOptions;
  #creds: JiraCredentials | null = null;

  constructor(o: JiraServiceOptions) {
    this.#o = o;
  }

  toJSON(): unknown {
    return this.#creds ? redactedCredentials(this.#creds) : null;
  }

  status(): JiraStatus {
    return this.#creds ? { configured: true, site: this.#creds.site, email: this.#creds.email } : { configured: false, site: null, email: null };
  }

  configure(p: { site: unknown; email: unknown; token: unknown }): JiraStatus {
    const c = parseCredentials(p); // throws JiraInputError before anything changes
    this.#creds = c;
    this.#o.host.setJira(this.#o.binding ? this.#o.binding(encodeSecret(c)) : null);
    return this.status();
  }

  clear(): JiraStatus {
    this.#creds = null;
    this.#o.host.setJira(null);
    return this.status();
  }

  async check(): Promise<JiraCheck> {
    if (!this.#creds || !this.#o.runCheck) return { ok: false, detail: CHECK_DETAILS.setup };
    try {
      const r = await this.#o.runCheck(encodeSecret(this.#creds));
      if (r.ok) return { ok: true, detail: CHECK_DETAILS.ok };
      const kind = r.kind && Object.hasOwn(CHECK_DETAILS, r.kind) && r.kind !== "ok" ? (r.kind as keyof typeof CHECK_DETAILS) : "network";
      return { ok: false, detail: CHECK_DETAILS[kind] };
    } catch {
      return { ok: false, detail: CHECK_DETAILS.network };
    }
  }
}

/** Runs `companion-jira --check` under its profile with the secret on fd 3; reads one line (≤ 4 KB) from stdout. */
export function spawnCheck(launch: LaunchSpec, secret: string, timeoutMs = 20_000): Promise<{ ok: boolean; kind?: string }> {
  return new Promise((resolve) => {
    let done = false;
    let out = "";
    const p = spawn(launch.command, launch.args, { env: launch.env, cwd: launch.cwd, stdio: ["ignore", "pipe", "ignore", "pipe"] });
    const finish = (r: { ok: boolean; kind?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (p.exitCode === null && p.pid !== undefined) p.kill("SIGKILL");
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, kind: "timeout" }), timeoutMs);
    p.on("error", () => finish({ ok: false, kind: "network" }));
    const fd3 = p.stdio[3] as import("node:stream").Writable | null;
    fd3?.on("error", () => {});
    fd3?.end(secret);
    p.stdout?.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.length > 4096) finish({ ok: false, kind: "network" });
    });
    // "close" (not "exit"): it fires after stdout has been fully read, so the answer line is never lost.
    p.on("close", () => {
      try {
        const o = JSON.parse(out.trim()) as { ok?: unknown; kind?: unknown };
        finish({ ok: o.ok === true, kind: typeof o.kind === "string" ? o.kind : undefined });
      } catch {
        finish({ ok: false, kind: "network" });
      }
    });
  });
}
