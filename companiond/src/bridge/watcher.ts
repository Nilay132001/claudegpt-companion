import { watch } from "node:fs";

export interface WatchHandle {
  close(): void;
}

/**
 * A change hint for a directory. Hints only speed things up: correctness comes from polling,
 * because fs.watch may coalesce or drop events and may omit the file name.
 */
export type WatchFactory = (dir: string, onChange: () => void, onError: (err: Error) => void) => WatchHandle;

export const nodeWatchFactory: WatchFactory = (dir, onChange, onError) => {
  try {
    const w = watch(dir, { persistent: false, recursive: true }, () => onChange());
    w.on("error", (err: Error) => onError(err));
    return { close: () => w.close() };
  } catch (err) {
    queueMicrotask(() => onError(err as Error));
    return { close() {} };
  }
};
