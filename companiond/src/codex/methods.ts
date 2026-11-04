// The only app-server methods companiond ever calls (requests and notifications).
export const CLIENT_METHODS: readonly string[] = [
  "initialize",
  "initialized",
  "account/read",
  "account/login/start",
  "account/login/cancel",
  "config/read",
  "experimentalFeature/list",
  "mcpServerStatus/list",
  "thread/start",
  "thread/resume",
  "thread/unsubscribe",
  "turn/start",
  "turn/interrupt",
];

export const CLIENT_INFO = { name: "claudegpt_companion", title: "ClaudeGPT Companion", version: "0.4.0" } as const;
