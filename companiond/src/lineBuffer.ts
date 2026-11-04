export interface LineBufferOptions {
  /** Longest line kept, in bytes. Longer lines are dropped and counted. */
  maxLineBytes?: number;
}

export const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;

export class LineBuffer {
  #chunks: Buffer[] = [];
  #pending = 0;
  #discarding = false;
  #invalidUtf8 = 0;
  #oversized = 0;
  readonly #max: number;
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(options: LineBufferOptions = {}) {
    this.#max = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    let nl = chunk.indexOf(0x0a, start);
    while (nl !== -1) {
      const piece = chunk.subarray(start, nl);
      if (this.#discarding) {
        this.#discarding = false;
      } else if (this.#pending + piece.length > this.#max) {
        this.#oversized++;
      } else {
        const bytes = this.#chunks.length
          ? Buffer.concat([...this.#chunks, piece], this.#pending + piece.length)
          : piece;
        this.#emit(bytes, lines);
      }
      this.#chunks = [];
      this.#pending = 0;
      start = nl + 1;
      nl = chunk.indexOf(0x0a, start);
    }
    const rest = chunk.subarray(start);
    if (rest.length > 0 && !this.#discarding) {
      if (this.#pending + rest.length > this.#max) {
        this.#oversized++;
        this.#discarding = true;
        this.#chunks = [];
        this.#pending = 0;
      } else {
        this.#chunks.push(Buffer.from(rest));
        this.#pending += rest.length;
      }
    }
    return lines;
  }

  #emit(bytes: Buffer, lines: string[]): void {
    let end = bytes.length;
    if (end > 0 && bytes[end - 1] === 0x0d) end--;
    if (end === 0) return;
    try {
      lines.push(this.#decoder.decode(bytes.subarray(0, end)));
    } catch {
      this.#invalidUtf8++;
    }
  }

  get pendingBytes(): number {
    return this.#pending;
  }

  /** Complete lines dropped because they were not valid UTF-8. */
  get invalidUtf8Lines(): number {
    return this.#invalidUtf8;
  }

  /** Lines dropped because they exceeded maxLineBytes. */
  get oversizedLines(): number {
    return this.#oversized;
  }

  reset(): void {
    this.#chunks = [];
    this.#pending = 0;
    this.#discarding = false;
  }
}
