// Runtime guard (spec §7.1.6): an allowlist of item types. Anything else interrupts the turn.
// Note: Codex's functions.exec calls do not surface as items (M1), so the guard cannot see them.
import type { InFlightToolCall, ToolAllowlist, ToolCallLookup } from "./serverRequests.ts";

export const ALLOWED_ITEM_TYPES: readonly string[] = ["userMessage", "agentMessage", "reasoning", "plan", "contextCompaction"];

export interface GuardAlert { threadId: string; turnId: string; itemType: string; detail: string }
export interface GuardActions { interrupt(threadId: string, turnId: string): Promise<void>; alert(a: GuardAlert): void }

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export class RuntimeGuard {
  #allow: ToolAllowlist;
  #actions: GuardActions;
  #inflight = new Map<string, InFlightToolCall>();
  #interrupted = new Set<string>();

  constructor(allow: ToolAllowlist, actions: GuardActions) {
    this.#allow = allow;
    this.#actions = actions;
  }

  /** null = allowed; otherwise the reason. */
  checkItem(item: unknown): string | null {
    const it = obj(item);
    const type = str(it?.type);
    if (!type) return "Codex started an item with no type";
    if (ALLOWED_ITEM_TYPES.includes(type)) return null;
    if (type === "mcpToolCall") {
      const server = str(it?.server) ?? "?";
      const tool = str(it?.tool) ?? "?";
      return this.#allow.get(server)?.has(tool) ? null : `MCP tool ${server}/${tool} is not allowlisted`;
    }
    return `Codex started a ${type} item`;
  }

  readonly lookup: ToolCallLookup = (threadId, callId, server) => {
    if (callId) {
      const hit = this.#inflight.get(`${threadId}\0${callId}`);
      return hit && hit.server === server ? hit : null;
    }
    const candidates = [...this.#inflight.values()].filter((c) => c.threadId === threadId && c.server === server);
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  };

  onNotification(method: string, params: unknown): void {
    const p = obj(params);
    const threadId = str(p?.threadId);
    if (method === "turn/completed") {
      if (threadId) for (const [k, c] of this.#inflight) if (c.threadId === threadId) this.#inflight.delete(k);
      const doneTurn = str(obj(p?.turn)?.id);
      if (threadId && doneTurn) this.#interrupted.delete(`${threadId}\0${doneTurn}`);
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const turnId = str(p?.turnId);
    const item = obj(p?.item);
    if (!threadId || !turnId) return;
    const reason = this.checkItem(item);
    if (reason) {
      this.#actions.alert({ threadId, turnId, itemType: str(item?.type) ?? "unknown", detail: reason });
      const key = `${threadId}\0${turnId}`;
      if (!this.#interrupted.has(key)) {
        this.#interrupted.add(key);
        // A failed interrupt is forgotten so the next bad item retries it. No raw error text: it may hold paths.
        const failed = (): void => {
          this.#interrupted.delete(key);
          this.#actions.alert({ threadId, turnId, itemType: "interrupt", detail: "Could not interrupt the turn" });
        };
        try {
          this.#actions.interrupt(threadId, turnId).then(undefined, failed);
        } catch {
          failed();
        }
      }
      return;
    }
    if (item?.type !== "mcpToolCall") return;
    const itemId = str(item.id);
    if (!itemId) return;
    const key = `${threadId}\0${itemId}`;
    if (method === "item/started") {
      this.#inflight.set(key, { threadId, itemId, server: str(item.server) ?? "", tool: str(item.tool) ?? "" });
    } else {
      this.#inflight.delete(key);
    }
  }
}
