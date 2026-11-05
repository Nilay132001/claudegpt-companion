import { test } from "node:test";
import assert from "node:assert/strict";
import { inertOverride, relayOverride } from "../../src/codex/binding.ts";

test("a bound thread's server is the relay with its one-time token, run from the empty folder", () => {
  const token = "a".repeat(64);
  assert.deepEqual(relayOverride("/s/bin/cgc-relay", token, "/s/empty-cwd"), {
    "mcp_servers.companion-readonly.command": "/s/bin/cgc-relay",
    "mcp_servers.companion-readonly.args": [],
    "mcp_servers.companion-readonly.env": { CGC_RELAY_TOKEN: token },
    "mcp_servers.companion-readonly.cwd": "/s/empty-cwd",
  });
});

test("a thread with no root keeps the inert base command", () => {
  assert.deepEqual(inertOverride(), {
    "mcp_servers.companion-readonly.command": "/usr/bin/false",
    "mcp_servers.companion-readonly.args": [],
    "mcp_servers.companion-readonly.env": {},
  });
});
