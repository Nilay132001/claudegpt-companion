// Root binding through the relay (spec §2, §7.1.9; M4a Tasks 6–9). A bound thread's companion-readonly server is the
// relay with that thread's one-time token; a thread with no root keeps the inert base command. The jail itself is
// launched by companiond (relay/acceptor.ts), never by Codex.
import { SERVER_NAME } from "../jail/mcpServer.ts";
import { BASE_MCP_COMMAND } from "./config.ts";

export const RELAY_TOKEN_ENV = "CGC_RELAY_TOKEN";

export function relayOverride(relayBinary: string, token: string, emptyCwd: string, serverName: string = SERVER_NAME): Record<string, unknown> {
  const k = `mcp_servers.${serverName}`;
  return { [`${k}.command`]: relayBinary, [`${k}.args`]: [], [`${k}.env`]: { [RELAY_TOKEN_ENV]: token }, [`${k}.cwd`]: emptyCwd };
}

export function inertOverride(serverName: string = SERVER_NAME): Record<string, unknown> {
  const k = `mcp_servers.${serverName}`;
  return { [`${k}.command`]: BASE_MCP_COMMAND, [`${k}.args`]: [], [`${k}.env`]: {} };
}
