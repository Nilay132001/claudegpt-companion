// The exec-cell gate's pure parts (review fix rounds 1–2): the cell source, and judging one attempt from app-server
// notifications. No I/O, so test/codex/execCellGate.test.ts runs them hermetically. Everything fails closed:
//  - exactly one exec call in the attempt, with a call id, whose input is the gate's source byte for byte;
//  - exactly one well-formed `CGC_GATE {…}` line in that call's output (a flat object of strings, no duplicate key);
//  - that object has exactly EXPECTED_KEYS, and every value is in its allowed set.
// "Inconclusive" (the model did not run the cell as written, or its output cannot be read) is open, never a pass.
import { ALLOWED_NESTED } from "../../src/codex/codeMode.ts";

export const GLOBALS = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Deno", "process", "require", "Bun", "navigator", "WebAssembly", "Worker", "SharedArrayBuffer", "importScripts"];
// DNS has no row of its own because a cell has no resolver API at all: node:dns and node:dns/promises are its only
// routes, and both are import rows. "Other keychain entries" cannot be expressed in a bare isolate either (no file
// API); the login keychain import row stands for them (plan review M-6, recorded in the findings).
export const MODULES = ["node:fs", "node:child_process", "node:net", "node:dns", "node:dns/promises", "node:http", "node:os", "node:worker_threads"];
/** The import every other import row is compared with: a file that does not exist. */
export const BASELINE_IMPORT = "file:///nonexistent-cgc.js";
const URL_ROWS = ["importHttps", "importLoopback", "importHomeCanary", "importCodexHomeCanary", "importLoginKeychain", "importRelaySocket", "importDecoySocket"];
const IMPORT_ROWS = [...URL_ROWS, ...MODULES.map((m) => `import_${m}`)];
const LOAD_ROWS = ["loadHomeCanary", "loadCodexHomeCanary"];
const LOAD_ALLOWED = ["refused", "no-data"];
const TYPEOF_ROWS = GLOBALS.map((k) => `typeof_${k}`);
const MUST_BE_UNDEFINED = [...TYPEOF_ROWS, "applyPatch", "execCommand"];
/** Exactly the keys of a complete cell result: a missing or an extra key is open. */
export const EXPECTED_KEYS: readonly string[] = [...TYPEOF_ROWS, "importBaseline", ...IMPORT_ROWS, ...LOAD_ROWS, "applyPatch", "execCommand", "toolNames"];
const INCONCLUSIVE = "(inconclusive, not a pass)";

export interface CellPaths { port: number; homeCanary: string; codexCanary: string; keychain: string; relaySocket: string; decoySocket: string }

export function cellSource(p: CellPaths): string {
  const j = JSON.stringify;
  return [
    "const out = {};",
    `for (const k of ${j(GLOBALS)}) out["typeof_" + k] = typeof globalThis[k];`,
    "const tryImport = async (u) => { try { await import(u); return 'IMPORTED'; } catch (e) { return 'refused:' + String((e && e.name) || typeof e); } };",
    `out.importBaseline = await tryImport(${j(BASELINE_IMPORT)});`,
    `out.importHttps = await tryImport(${j("https://example.com/cgc-gate.js")});`,
    `out.importLoopback = await tryImport(${j(`http://127.0.0.1:${p.port}/cgc-gate.js`)});`,
    `out.importHomeCanary = await tryImport(${j(`file://${p.homeCanary}`)});`,
    `out.importCodexHomeCanary = await tryImport(${j(`file://${p.codexCanary}`)});`,
    `out.importLoginKeychain = await tryImport(${j(`file://${p.keychain}`)});`,
    `out.importRelaySocket = await tryImport(${j(`file://${p.relaySocket}`)});`,
    `out.importDecoySocket = await tryImport(${j(`file://${p.decoySocket}`)});`,
    `for (const m of ${j(MODULES)}) out["import_" + m] = await tryImport(m);`,
    "const tryCall = async (f) => { try { const v = await f(); return JSON.stringify(v ?? null).includes('CGC-GATE-SECRET') ? 'LEAKED' : 'no-data'; } catch { return 'refused'; } };",
    `out.loadHomeCanary = await tryCall(() => load(${j(p.homeCanary)}));`,
    `out.loadCodexHomeCanary = await tryCall(() => load(${j(p.codexCanary)}));`,
    "out.applyPatch = typeof tools.apply_patch;",
    "out.execCommand = typeof tools.exec_command;",
    "out.toolNames = Object.keys(tools).sort().join(',');",
    "text('CGC_GATE ' + JSON.stringify(out));",
  ].join("\n");
}

/** Exact schema: the key set is EXPECTED_KEYS, and every value is in its allowed set. null = inconclusive. */
export function evaluateCell(cell: Readonly<Record<string, string>> | null): string[] {
  if (!cell) return [`no cell result ${INCONCLUSIVE}`];
  const open: string[] = [];
  const has = (k: string) => Object.hasOwn(cell, k);
  for (const k of EXPECTED_KEYS) if (!has(k)) open.push(`${k} is missing from the cell result`);
  for (const k of Object.keys(cell)) if (!EXPECTED_KEYS.includes(k)) open.push(`unexpected key ${k} in the cell result`);
  for (const k of MUST_BE_UNDEFINED) if (has(k) && cell[k] !== "undefined") open.push(`${k}: ${String(cell[k])}`);
  for (const k of LOAD_ROWS) if (has(k) && !LOAD_ALLOWED.includes(String(cell[k]))) open.push(`${k}: ${String(cell[k])}`);
  const base = has("importBaseline") ? cell.importBaseline : undefined;
  if (base !== undefined && !base.startsWith("refused:")) open.push(`importBaseline: ${base}`);
  for (const k of IMPORT_ROWS) if (has(k) && (base === undefined || cell[k] !== base)) open.push(`${k}: ${String(cell[k])} (baseline ${String(base)})`);
  if (has("toolNames")) {
    for (const n of String(cell.toolNames).split(",").filter(Boolean)) if (!ALLOWED_NESTED.includes(n)) open.push(`cell tool ${n} is not allowlisted`);
  }
  return open;
}

const STR = String.raw`"(?:[^"\\\u0000-\u001f]|\\.)*"`;
/** A flat JSON object of string values, parsed pair by pair so a duplicate key is seen (JSON.parse keeps the last). */
function parseFlatObject(s: string): { cell: Record<string, string> | null; problem: string | null } {
  if (s === "{}") return { cell: {}, problem: null };
  const pair = new RegExp(`(${STR}):(${STR})`, "y");
  const m = new Map<string, string>();
  for (let i = 1; ; ) {
    pair.lastIndex = i;
    const r = pair.exec(s);
    if (!r) return { cell: null, problem: "a malformed CGC_GATE line" };
    let k: string;
    let v: string;
    try {
      k = JSON.parse(String(r[1])) as string;
      v = JSON.parse(String(r[2])) as string;
    } catch {
      return { cell: null, problem: "a malformed CGC_GATE line" };
    }
    if (m.has(k)) return { cell: null, problem: `a duplicate key ${k} in the CGC_GATE line` };
    m.set(k, v);
    i = pair.lastIndex;
    if (s[i] === ",") {
      i++;
      continue;
    }
    if (s[i] === "}" && i === s.length - 1) return { cell: Object.fromEntries(m), problem: null };
    return { cell: null, problem: "a malformed CGC_GATE line" };
  }
}

/** Exactly one `CGC_GATE {…}` line across the exec output. Every line that mentions CGC_GATE counts. */
export function parseCellOutput(outputs: readonly string[]): { cell: Record<string, string> | null; lines: number; problems: string[] } {
  const lines = outputs.flatMap((o) => o.split(/\r?\n/)).filter((l) => l.includes("CGC_GATE"));
  if (lines.length !== 1) return { cell: null, lines: lines.length, problems: [`${lines.length === 0 ? "no" : lines.length} CGC_GATE line${lines.length === 1 ? "" : "s"} in the exec output ${INCONCLUSIVE}`] };
  const m = /^CGC_GATE (\{.*\})$/.exec(String(lines[0]));
  const p = m ? parseFlatObject(String(m[1])) : { cell: null, problem: "a malformed CGC_GATE line" };
  return { cell: p.cell, lines: 1, problems: p.problem ? [`${p.problem} ${INCONCLUSIVE}`] : [] };
}

interface Seen { method: string; params: any }

/** Every string inside a value (an exec output may be a string, a list of content items, or an object of them). */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v !== null && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

/** This thread's exec calls and their outputs, from rawResponseItem/completed notifications (the exec cell makes no
 * item of its own: codemode-report M5). The single exec call must carry the gate's source exactly. */
export function execOutputs(notifications: readonly Seen[], threadId: string, src: string): { execCalls: number; outputs: string[]; problems: string[] } {
  const raw = notifications.filter((n) => n.method === "rawResponseItem/completed" && n.params?.threadId === threadId).map((n) => n.params?.item);
  const id = (i: any): string => (typeof i?.call_id === "string" ? i.call_id : typeof i?.callId === "string" ? i.callId : "");
  const calls = raw.filter((i) => (i?.type === "custom_tool_call" || i?.type === "function_call") && /(^|\.)exec$/.test(String(i?.name ?? "")));
  const outs = raw.filter((i) => i?.type === "custom_tool_call_output" || i?.type === "function_call_output");
  const problems: string[] = [];
  if (calls.length !== 1) problems.push(`${calls.length} exec calls in the attempt (exactly 1 expected) ${INCONCLUSIVE}`);
  if ([...calls, ...outs].some((i) => id(i) === "")) problems.push(`an exec call or output without a call id ${INCONCLUSIVE}`);
  const only = calls.length === 1 ? calls[0] : null;
  if (only) {
    if (typeof only.input !== "string") problems.push(`unrecognised exec input shape ${INCONCLUSIVE}`);
    else if (only.input !== src) problems.push(`the exec input differs from the gate's source ${INCONCLUSIVE}`);
  }
  const callId = only ? id(only) : "";
  const outputs = callId === "" ? [] : outs.filter((i) => id(i) === callId).flatMap((i) => strings(i?.output));
  return { execCalls: calls.length, outputs, problems };
}

/** One attempt: its exec call and output must be exactly the gate's, then the cell result must match the schema. */
export function judgeAttempt(notifications: readonly Seen[], threadId: string, src: string): { cell: Record<string, string> | null; execCalls: number; lines: number; open: string[] } {
  const ex = execOutputs(notifications, threadId, src);
  const parsed = parseCellOutput(ex.outputs);
  if (ex.problems.length > 0) return { cell: null, execCalls: ex.execCalls, lines: parsed.lines, open: ex.problems };
  if (parsed.problems.length > 0) return { cell: null, execCalls: ex.execCalls, lines: parsed.lines, open: parsed.problems };
  return { cell: parsed.cell, execCalls: ex.execCalls, lines: parsed.lines, open: evaluateCell(parsed.cell) };
}
