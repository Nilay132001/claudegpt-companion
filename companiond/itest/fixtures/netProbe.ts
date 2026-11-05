// SYNTHETIC FIXTURE — runs inside the companion-jira profile and reports what it may do. One JSON line on stdout.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";

const probe = (host: string, port: number) =>
  new Promise<string>((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(4000, () => (s.destroy(), resolve("timeout")));
    s.on("connect", () => (s.destroy(), resolve("ok")));
    s.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "error"));
  });
const tryDo = (f: () => unknown) => {
  try {
    f();
    return "ok";
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? "error";
  }
};
const out: Record<string, string> = {};
try {
  const r = await fetch("https://example.com/", { redirect: "error", signal: AbortSignal.timeout(10_000) });
  out.https = `status ${r.status}`;
} catch (e) {
  out.https = `failed ${(e as Error).name}`;
}
out.port80 = await probe("example.com", 80);
out.loopback443 = await probe("127.0.0.1", 443);
out.readHome = tryDo(() => fs.readdirSync(os.homedir()));
out.writeTmp = tryDo(() => fs.writeFileSync(`${os.tmpdir()}/cgc-jira-probe-${process.pid}`, "x"));
process.stdout.write(`${JSON.stringify(out)}\n`);
