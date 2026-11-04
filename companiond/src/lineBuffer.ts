export class LineBuffer {
  #rest: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const buf = this.#rest.length ? Buffer.concat([this.#rest, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    let nl = buf.indexOf(0x0a, start);
    while (nl !== -1) {
      let line = buf.subarray(start, nl).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
      start = nl + 1;
      nl = buf.indexOf(0x0a, start);
    }
    this.#rest = Buffer.from(buf.subarray(start));
    return lines;
  }

  get pendingBytes(): number {
    return this.#rest.length;
  }

  reset(): void {
    this.#rest = Buffer.alloc(0);
  }
}
