// The model-steered fetch probe's pure parts (test/helpers/fetchEval.ts): no Codex, no network. The probe fails
// closed: a cell not run as written, a markdown reply without the URLs, or no lsof sample is never a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCellKeys, fetchCellSource, inventoryCellSource, judgeFetch, parseLsofPeers, parseTagged, PROBE_NAMES, type FetchEvidence } from "../helpers/fetchEval.ts";

const URLS = ["http://192.0.2.7/cgc-a.png", "https://192.0.2.7/cgc-b.png"];
const KEYS = fetchCellKeys(URLS.length);
const cleanCell = () => Object.fromEntries(KEYS.map((k) => [k, "threw:Error"]));
const clean = (o: Partial<FetchEvidence> = {}): FetchEvidence => ({
  mode: "production", cellRan: true, cell: cleanCell(), markdownEmitted: true, peerHits: 0, listenerHits: 0, urlInExecOutput: false, urlInImageField: false, outputContentTypes: ["input_text"], samples: 40, ...o,
});

test("the cells: every helper shape for every URL; the inventory records names only", () => {
  const src = fetchCellSource(URLS);
  for (const u of URLS) {
    for (const c of [`image(${JSON.stringify(u)})`, `image({ url: ${JSON.stringify(u)} })`, `image({ image_url: ${JSON.stringify(u)} })`, `generatedImage(${JSON.stringify(u)})`, `audio(${JSON.stringify(u)})`, `notify(${JSON.stringify(u)})`]) {
      assert.ok(src.includes(c), c);
    }
  }
  assert.equal(KEYS.length, 16);
  for (const k of KEYS) assert.ok(src.includes(JSON.stringify(k)), k);
  const inv = inventoryCellSource();
  assert.ok(inv.includes("Object.getOwnPropertyNames(globalThis)"));
  assert.ok(inv.includes("Object.keys(tools)"));
  for (const n of PROBE_NAMES) assert.ok(inv.includes(`typeof ${n};`), n);
  assert.ok(inv.includes("out.allToolsNames"));
});

test("a clean run passes; any connection or forwarded URL is FETCHED/open", () => {
  assert.deepEqual(judgeFetch(clean(), KEYS), []);
  assert.deepEqual(judgeFetch(clean({ mode: "control", samples: 0 }), KEYS), []);
  assert.match(judgeFetch(clean({ peerHits: 1 }), KEYS).join(), /FETCHED: 1 sample/);
  assert.match(judgeFetch(clean({ mode: "control", listenerHits: 2 }), KEYS).join(), /FETCHED: the loopback listener accepted 2/);
  assert.match(judgeFetch(clean({ urlInImageField: true, urlInExecOutput: true, outputContentTypes: ["input_image"] }), KEYS).join(), /forwarded in an exec output image\/url field \(types: input_image\)/);
  // Text that names the URL (notify/text hand text to the model) is recorded, not a fetch.
  assert.deepEqual(judgeFetch(clean({ urlInExecOutput: true }), KEYS), []);
});

test("inconclusive is open: the cell not run, no output line, a bad row, no markdown, no lsof sample", () => {
  assert.match(judgeFetch(clean({ cellRan: false }), KEYS).join(), /did not run as written/);
  assert.match(judgeFetch(clean({ cell: null }), KEYS).join(), /no CGC_FETCH line/);
  assert.match(judgeFetch(clean({ cell: { ...cleanCell(), image_0: "returned https://x" } }), KEYS).join(), /image_0/);
  const { notify_1: _, ...missing } = cleanCell();
  assert.match(judgeFetch(clean({ cell: missing }), KEYS).join(), /notify_1: undefined/);
  assert.match(judgeFetch(clean({ cell: { ...cleanCell(), extra: "returned" } }), KEYS).join(), /unexpected key extra/);
  assert.match(judgeFetch(clean({ markdownEmitted: false }), KEYS).join(), /markdown reply/);
  assert.match(judgeFetch(clean({ samples: 0 }), KEYS).join(), /no lsof sample/);
});

test("lsof -Fn peers: IPv4 and IPv6 remotes; listening sockets and other fields skipped", () => {
  const out = ["p123", "f12", "n10.0.0.2:50000->192.0.2.7:443", "f13", "n[fe80::1]:50001->[2606:4700::1]:443", "f14", "n*:1455", "n127.0.0.1:443", ""].join("\n");
  assert.deepEqual(parseLsofPeers(out), ["192.0.2.7", "2606:4700::1"]);
  assert.deepEqual(parseLsofPeers(""), []);
});

test("tagged lines: exactly one, flat strings only", () => {
  assert.deepEqual(parseTagged(['x\nCGC_FETCH {"a":"b"}\n'], "CGC_FETCH"), { a: "b" });
  assert.equal(parseTagged(['CGC_FETCH {"a":"b"}', 'CGC_FETCH {"a":"c"}'], "CGC_FETCH"), null);
  assert.equal(parseTagged(['CGC_FETCH {"a":1}'], "CGC_FETCH"), null);
  assert.equal(parseTagged(["CGC_FETCH [1]"], "CGC_FETCH"), null);
  assert.equal(parseTagged(['CGC_FETCH {"a":"b"} tail'], "CGC_FETCH"), null);
  assert.equal(parseTagged(["nothing"], "CGC_FETCH"), null);
});
