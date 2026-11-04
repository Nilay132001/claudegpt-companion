// Tool-output redaction hook (spec §7.4). Tool output goes from this server straight to Codex, so
// redaction has to happen here, inside the jail. M2: identity. M4 replaces the body with the Redactor
// and keeps it in src/jail/, so the no-writes scan covers it.
export type Redact = (text: string) => string;

export const redactToolOutput: Redact = (text) => text;
