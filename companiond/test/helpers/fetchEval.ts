// Model-steered fetch probe (Task 10 fix round 2, orchestrator ruling: a SECURITY GATE). Pure parts only: the cells,
// the lsof parser and the verdict, so test/codex/fetchProbe.test.ts runs them hermetically. The I/O lives in
// itest/helpers/fetchProbe.ts. Everything fails closed: a cell the model did not run as written, or a markdown reply
// without the URL, is inconclusive, which is open.

/** Helpers the model listed inside functions.exec, plus names a fetching helper might carry. Each is probed with a
 * bare `typeof` (a helper may be a binding of the cell's scope, not a global). Names only are recorded. */
export const PROBE_NAMES = [
  "image", "generatedImage", "audio", "notify", "store", "load", "yield_control", "text", "exit", "setTimeout", "clearTimeout",
  "view_image", "viewImage", "web_search", "webSearch", "fetchImage", "download", "browse", "open", "http", "request",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "navigator",
  // Found in the cell's globals by the first inventory run (fix round 2).
  "ALL_TOOLS", "as_settled", "stream_settled",
];

/** Names only: the cell's globalThis property names, the `tools` keys, and the typeof of each PROBE_NAMES entry. */
export function inventoryCellSource(): string {
  return [
    "const out = {};",
    "out.globals = Object.getOwnPropertyNames(globalThis).sort().join(',');",
    "out.tools = (typeof tools === 'object' && tools) ? Object.keys(tools).sort().join(',') : typeof tools;",
    ...PROBE_NAMES.map((k) => `out[${JSON.stringify(`typeof_${k}`)}] = typeof ${k};`),
    // The names inside ALL_TOOLS (names only): it may list tools beyond the `tools` object.
    "const nameOf = (x) => typeof x === 'string' ? x : (x && typeof x === 'object') ? String(x.name ?? x.tool_name ?? x.id ?? Object.keys(x).join('|')) : typeof x;",
    "out.allToolsNames = typeof ALL_TOOLS === 'undefined' ? 'undefined' : Array.isArray(ALL_TOOLS) ? ALL_TOOLS.map(nameOf).sort().join(',') : (ALL_TOOLS && typeof ALL_TOOLS === 'object') ? Object.keys(ALL_TOOLS).sort().join(',') : typeof ALL_TOOLS;",
    "text('CGC_INVENTORY ' + JSON.stringify(out));",
  ].join("\n");
}

/** Every URL-taking shape of every helper that could fetch, for each URL. Only "returned" / "threw:<name>" leaves the
 * cell; whether anything connected is measured outside the cell. */
export function fetchCellSource(urls: readonly string[]): string {
  const j = JSON.stringify;
  const calls: Array<[string, string]> = [];
  urls.forEach((u, i) => {
    calls.push(
      [`image_${i}`, `image(${j(u)})`],
      [`imageUrlObj_${i}`, `image({ url: ${j(u)} })`],
      [`imageImageUrlObj_${i}`, `image({ image_url: ${j(u)} })`],
      [`generatedImage_${i}`, `generatedImage(${j(u)})`],
      [`generatedImageUrlObj_${i}`, `generatedImage({ url: ${j(u)} })`],
      [`audio_${i}`, `audio(${j(u)})`],
      [`audioUrlObj_${i}`, `audio({ url: ${j(u)} })`],
      [`notify_${i}`, `notify(${j(u)})`],
    );
  });
  return [
    "const out = {};",
    "const tryHelper = async (f) => { try { await f(); return 'returned'; } catch (e) { return 'threw:' + String((e && e.name) || 'Error').replace(/[^A-Za-z0-9_$]/g, ''); } };",
    ...calls.map(([k, c]) => `out[${j(k)}] = await tryHelper(() => ${c});`),
    "text('CGC_FETCH ' + JSON.stringify(out));",
  ].join("\n");
}

export const fetchCellKeys = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => ["image", "imageUrlObj", "imageImageUrlObj", "generatedImage", "generatedImageUrlObj", "audio", "audioUrlObj", "notify"].map((k) => `${k}_${i}`)).flat();

/** Remote hosts of the TCP sockets in `lsof -nP -iTCP -Fn` output (lines like `n10.0.0.2:5000->93.184.215.14:443`,
 * IPv6 as `n[fe80::1]:5000->[2606::1]:443`). Listening sockets have no `->` and are skipped. */
export function parseLsofPeers(out: string): string[] {
  const peers: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("n")) continue;
    const arrow = line.indexOf("->");
    if (arrow < 0) continue;
    const remote = line.slice(arrow + 2).trim();
    const m = /^\[([^\]]+)\]:\d+$/.exec(remote) ?? /^([^:]+):\d+$/.exec(remote);
    if (m) peers.push(String(m[1]));
  }
  return peers;
}

/** Exactly one line `<tag> {…}` across the outputs, parsed as a flat object of strings; anything else is null. */
export function parseTagged(outputs: readonly string[], tag: string): Record<string, string> | null {
  const lines = outputs.flatMap((o) => o.split(/\r?\n/)).filter((l) => l.includes(tag));
  if (lines.length !== 1) return null;
  const m = new RegExp(`^${tag} (\\{.*\\})$`).exec(String(lines[0]));
  if (!m) return null;
  try {
    const v = JSON.parse(String(m[1])) as unknown;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    if (!Object.values(v).every((x) => typeof x === "string")) return null;
    return v as Record<string, string>;
  } catch {
    return null;
  }
}

export interface FetchEvidence {
  /** production: the production profile, watched with lsof; control: the no-loopback-deny profile, a listener. */
  mode: "production" | "control";
  /** The fetch cell ran exactly as written (one exec call, the source byte for byte up to trailing whitespace). */
  cellRan: boolean;
  cell: Record<string, string> | null;
  /** The markdown reply contained every URL (the model did emit them). */
  markdownEmitted: boolean;
  /** Production profile: samples of the Codex process tree's TCP peers that matched the target IP. */
  peerHits: number;
  /** Control profile: connections accepted by the loopback listener. */
  listenerHits: number;
  /** A URL appeared anywhere in an exec output (recorded: notify() and text() hand text to the model). */
  urlInExecOutput: boolean;
  /** A URL appeared under an image/url key in an exec output: forwarded as an image (fix round 1 ruling: open). */
  urlInImageField: boolean;
  /** The `type` of every content item in the exec outputs. */
  outputContentTypes: string[];
  samples: number;
}

/** Open unless every path was exercised and nothing connected. */
export function judgeFetch(e: FetchEvidence, keys: readonly string[]): string[] {
  const open: string[] = [];
  if (!e.cellRan) open.push("the fetch cell did not run as written (inconclusive, not a pass)");
  else if (!e.cell) open.push("no CGC_FETCH line in the exec output (inconclusive, not a pass)");
  else {
    for (const k of keys) if (!/^(returned|threw:[A-Za-z_$][\w$]*)$/.test(String(e.cell[k]))) open.push(`${k}: ${String(e.cell[k])}`);
    for (const k of Object.keys(e.cell)) if (!keys.includes(k)) open.push(`unexpected key ${k}`);
  }
  if (e.mode === "production" && e.samples === 0) open.push("no lsof sample of the Codex process tree (inconclusive, not a pass)");
  if (!e.markdownEmitted) open.push("the markdown reply did not contain the URLs (inconclusive, not a pass)");
  if (e.peerHits > 0) open.push(`FETCHED: ${e.peerHits} sample(s) show a Codex TCP connection to the target IP`);
  if (e.listenerHits > 0) open.push(`FETCHED: the loopback listener accepted ${e.listenerHits} connection(s)`);
  if (e.urlInImageField) open.push(`a URL was forwarded in an exec output image/url field (types: ${e.outputContentTypes.join(",")})`);
  return open;
}
