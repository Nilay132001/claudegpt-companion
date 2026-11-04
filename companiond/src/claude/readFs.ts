import * as fsp from "node:fs/promises";
import path from "node:path";

export interface FileStat {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface RangeRead {
  /** Up to `length` bytes; fewer at end of file. */
  buf: Buffer;
  /** Identity of the file actually read (fstat of the open handle). */
  dev: number;
  ino: number;
}

/** The only file-system surface the session code gets. It has no write method. */
export interface ReadFs {
  readdir(dir: string): Promise<string[]>;
  stat(p: string): Promise<FileStat>;
  readRange(file: string, position: number, length: number): Promise<RangeRead>;
  realpath(p: string): Promise<string>;
}

export const nodeReadFs: ReadFs = {
  readdir: (dir) => fsp.readdir(dir),
  stat: (p) => fsp.stat(p),
  async readRange(file, position, length) {
    const fh = await fsp.open(file, "r");
    try {
      const st = await fh.stat();
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, position);
      return { buf: buf.subarray(0, bytesRead), dev: st.dev, ino: st.ino };
    } finally {
      await fh.close();
    }
  },
  realpath: (p) => fsp.realpath(p),
};

export class RefusedPathError extends Error {}

/** Credential files Claude keeps next to running files (spec §6.1). Never opened. */
const REFUSED = /\.key$/i;

/**
 * Wraps a ReadFs so any `.key` file is refused before the call (and a realpath that lands on one is refused
 * after it). `onRefused` gets the basename only. SessionBridge is the one place that wraps; lower-level
 * readers take whatever ReadFs they are given.
 */
export function guardReadFs(inner: ReadFs, onRefused: (basename: string) => void = () => {}): ReadFs {
  const check = (p: string): void => {
    const base = path.basename(p);
    if (REFUSED.test(base)) {
      onRefused(base);
      throw new RefusedPathError(`refused credential file: ${base}`);
    }
  };
  return {
    readdir: (dir) => inner.readdir(dir),
    stat: async (p) => (check(p), inner.stat(p)),
    readRange: async (f, pos, len) => (check(f), inner.readRange(f, pos, len)),
    async realpath(p) {
      check(p);
      const real = await inner.realpath(p);
      check(real);
      return real;
    },
  };
}

export const MAX_JSON_FILE_BYTES = 1024 * 1024;

/** Reads and parses a small JSON file. Returns null if missing, too big, or not JSON. */
export async function readJsonFile(fs: ReadFs, file: string): Promise<unknown> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > MAX_JSON_FILE_BYTES) return null;
    const { buf } = await fs.readRange(file, 0, st.size);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch (err) {
    if (err instanceof RefusedPathError) throw err;
    return null;
  }
}
