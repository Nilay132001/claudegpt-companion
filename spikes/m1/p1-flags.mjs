import { connect, writeConfig, HARDENED_FEATURES, tmpDir } from "./lib.mjs";

writeConfig(HARDENED_FEATURES);
const c = await connect();
const want = ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "image_generation", "multi_agent", "hooks", "memories", "view_image"];
const all = [];
let cursor = null;
do { const r = await c.request("experimentalFeature/list", { cursor, limit: 200 }); all.push(...r.data); cursor = r.nextCursor; } while (cursor);
const flags = Object.fromEntries(want.map((n) => [n, all.find((f) => f.name === n)?.enabled ?? "MISSING"]));
const empty = tmpDir("empty");
const cfg = await c.request("config/read", { includeLayers: true, cwd: empty });
console.log(JSON.stringify({
  flags,
  allOff: Object.values(flags).every((v) => v === false),
  listEntries: Object.fromEntries(want.map((n) => { const f = all.find((x) => x.name === n); return [n, f ? { stage: f.stage, enabled: f.enabled, defaultEnabled: f.defaultEnabled } : "MISSING"]; })),
  configReadFeatures: Object.fromEntries(want.map((n) => [n, cfg.config.features?.[n] ?? "MISSING"])),
  configAllOff: want.every((n) => cfg.config.features?.[n] === false),
  web_search: cfg.config.web_search,
  layers: (cfg.layers || []).map((l) => l.name ?? l.source ?? Object.keys(l)),
}, null, 2));
c.close();
