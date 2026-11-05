// Tool-output redaction hook (spec §7.4). Tool output goes from this server to Codex (directly or
// through companiond's relay), so redaction has to happen here, inside the jail. M4 plugs in the
// Redactor and keeps it in src/jail/, so the no-writes scan covers it.
import { redactText } from "./redactor.ts";

export type Redact = (text: string) => string;

export const redactToolOutput: Redact = redactText;
