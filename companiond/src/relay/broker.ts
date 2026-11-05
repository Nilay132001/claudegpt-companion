// The contract between CodexHost and the relay acceptor (spec §7.1.9). Types and limits only.
import type { LaunchSpec } from "../launch/seatbelt.ts";

/** "dropped": the relay went away while companiond wrote its proof — nothing was bound, so it is rebound (re-review N-5). */
export type BindingEnd = "normal" | "idle" | "violation" | "limit" | "jail" | "revoked" | "error" | "dropped";
export type BrokerEvent =
  | { type: "refused"; reason: string } // a connection failed the handshake: CodexHost stops everything
  | { type: "socketReplaced" } // the socket file is not ours any more: CodexHost stops everything
  | { type: "bound"; grantId: string }
  | { type: "closed"; grantId: string; end: BindingEnd };

/** A one-time token for one thread's binding. arm() starts the short TTL; revoke() ends it, live or not. */
export interface RelayGrant { readonly id: string; readonly token: string; arm(ttlMs?: number): void; revoke(): void }
/** M6: a grant may bring its own validator (its tool allowlist) and a secret that the acceptor writes to the granted
 * server's fd 3 at spawn (never argv or env). companiond keeps no copy once the grant is gone. */
export interface GrantOptions { validator?: LaunchSpec; secret?: string }
export interface RelayBroker {
  grant(launch: LaunchSpec, o?: GrantOptions): RelayGrant;
  on(l: (e: BrokerEvent) => void): () => void;
  /** false after a replaced socket or a listener error: nothing may be bound until restart() succeeds. */
  healthy(): boolean;
  /** Re-runs every start check (folder, stale or live socket) and listens again; throws if any fails. */
  restart(): Promise<void>;
}

/** Ruling I1: a token is good for a few seconds after thread/start, and never longer than GRANT_MAX_AGE_MS. */
export const DEFAULT_TOKEN_TTL_MS = 10_000;
export const GRANT_MAX_AGE_MS = 120_000;
