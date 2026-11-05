// JSON-RPC 2.0 over stdio for the SwiftUI app. stdout carries protocol only.
import type { Readable, Writable } from "node:stream";
import { LineBuffer } from "../lineBuffer.ts";
import { ErrorCodes } from "./protocol.ts";

export type MethodHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class DaemonError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "DaemonError";
    this.code = code;
    this.data = data;
  }
}

type Id = number | string;
const isId = (v: unknown): v is Id => typeof v === "number" || typeof v === "string";
const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export class DaemonServer {
  #out: Writable;
  #handlers: Record<string, MethodHandler>;
  #mapError: (e: unknown) => DaemonError;
  #lines = new LineBuffer();

  constructor(input: Readable, output: Writable, handlers: Record<string, MethodHandler>, mapError: (e: unknown) => DaemonError, onEnd: () => void) {
    this.#out = output;
    this.#handlers = handlers;
    this.#mapError = mapError;
    input.on("data", (c: Buffer) => {
      for (const line of this.#lines.push(c)) void this.#onLine(line);
    });
    input.on("end", onEnd);
  }

  notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  #write(msg: Record<string, unknown>): void {
    this.#out.write(JSON.stringify(msg) + "\n");
  }

  #error(id: Id | null, code: number, message: string, data?: unknown): void {
    this.#write({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
  }

  async #onLine(line: string): Promise<void> {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      this.#error(null, ErrorCodes.parseError, "Parse error");
      return;
    }
    const o = obj(m);
    if (!o || o.jsonrpc !== "2.0" || typeof o.method !== "string") {
      this.#error(isId(o?.id) ? o.id : null, ErrorCodes.invalidRequest, "Invalid request");
      return;
    }
    if (!isId(o.id)) return; // the app sends no notifications; ignore them
    const handler = Object.hasOwn(this.#handlers, o.method) ? this.#handlers[o.method] : undefined;
    if (!handler) {
      this.#error(o.id, ErrorCodes.methodNotFound, "Method not found");
      return;
    }
    const params = o.params === undefined || o.params === null ? {} : obj(o.params);
    if (!params) {
      this.#error(o.id, ErrorCodes.invalidParams, "params must be an object");
      return;
    }
    try {
      const result = await handler(params);
      this.#write({ jsonrpc: "2.0", id: o.id, result: result ?? null });
    } catch (e) {
      const d = this.#mapError(e);
      this.#error(o.id, d.code, d.message, d.data);
    }
  }
}
