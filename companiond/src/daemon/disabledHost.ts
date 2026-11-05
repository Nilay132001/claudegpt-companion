// Stands in for CodexHost when chat cannot run (COMPANIOND_CODEX=off, not macOS, Codex not installed, the relay did
// not build, or CODEX_SEATBELT_MEASURED is "stopped"). Every chat call is refused; nothing is spawned.
import { HostNotReadyError, type AuthState, type HostEvent, type HostState, type RootBinding } from "../codex/codexHost.ts";

export class DisabledHost {
  #detail: string;
  constructor(detail: string) {
    this.#detail = detail;
  }
  state(): HostState {
    return { state: "failed", detail: this.#detail };
  }
  async start(): Promise<HostState> {
    return this.state();
  }
  async stop(): Promise<void> {}
  clearSecurityStop(): void {}
  async auth(): Promise<AuthState> {
    throw new HostNotReadyError();
  }
  async login(): Promise<{ authUrl: string }> {
    throw new HostNotReadyError();
  }
  async openThread(_threadId: string | null, _binding: RootBinding | null): Promise<string> {
    throw new HostNotReadyError();
  }
  async closeThread(_threadId: string): Promise<void> {}
  async startTurn(_threadId: string, _text: string): Promise<{ turnId: string }> {
    throw new HostNotReadyError();
  }
  async interrupt(_threadId: string): Promise<void> {}
  activeTurn(_threadId: string): string | null {
    return null;
  }
  on(_l: (e: HostEvent) => void): () => void {
    return () => undefined;
  }
}
