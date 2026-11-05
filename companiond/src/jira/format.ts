// Jira JSON → plain text for the model (spec §7.4, §7.6). Everything that came from Jira is escaped like the context
// block (escapeData), redacted (best effort) and capped, then wrapped once as untrusted data.
import { escapeData } from "../context/contextBuilder.ts";
import { redactText } from "../jail/redactor.ts";

export const JIRA_TEXT_CAP = 24_000;
const DESCRIPTION_CAP = 8_000;
const COMMENT_CAP = 2_000;
const MAX_NODES = 5_000;
const MAX_DEPTH = 40;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const name = (v: unknown, fallback = ""): string => s(obj(v)?.name) || s(obj(v)?.displayName) || fallback;
const BLOCKS = new Set(["paragraph", "heading", "blockquote", "codeBlock", "listItem", "rule", "panel", "table", "tableRow", "mediaSingle", "mediaGroup"]);

export function adfToText(node: unknown, maxChars: number): string {
  let out = "";
  let nodes = 0;
  const walk = (n: unknown, depth: number, prefix: string): void => {
    if (out.length >= maxChars || depth > MAX_DEPTH || ++nodes > MAX_NODES) return;
    const o = obj(n);
    if (!o) return;
    const type = s(o.type);
    const attrs = obj(o.attrs) ?? {};
    if (type === "text") out += s(o.text);
    else if (type === "hardBreak") out += "\n";
    else if (type === "mention") out += s(attrs.text) || "@someone";
    else if (type === "emoji") out += s(attrs.shortName) || s(attrs.text);
    else if (type === "inlineCard" || type === "blockCard") out += s(attrs.url);
    else if (type === "media" || type === "mediaInline") out += "[attachment]";
    else if (type === "rule") out += "---";
    if (type === "listItem") out += `${prefix}- `;
    if (type === "codeBlock") out += "```\n";
    const kids = Array.isArray(o.content) ? o.content : [];
    for (const k of kids) walk(k, depth + 1, type === "bulletList" || type === "orderedList" ? `${prefix}  ` : prefix);
    if (type === "codeBlock") out += "\n```";
    if (BLOCKS.has(type) && !out.endsWith("\n")) out += "\n";
  };
  walk(node, 0, "");
  return out.slice(0, maxChars).replace(/\n{3,}/g, "\n\n").trim();
}

/** The one wrapper: escaped (so a payload cannot close it), redacted, capped. */
export function wrapJira(body: string): string {
  const text = escapeData(redactText(body));
  const capped = text.length > JIRA_TEXT_CAP ? `${text.slice(0, JIRA_TEXT_CAP)}\n[cut: the rest was too long]` : text;
  return `<untrusted_data source="jira">\n${capped}\n</untrusted_data>`;
}

export function formatIssue(j: unknown): string {
  const o = obj(j) ?? {};
  const f = obj(o.fields) ?? {};
  const labels = Array.isArray(f.labels) ? f.labels.filter((x) => typeof x === "string").join(", ") : "";
  const lines = [
    `${s(o.key)} · ${s(f.summary)}`,
    `Status: ${name(f.status, "?")} · Type: ${name(f.issuetype, "?")} · Priority: ${name(f.priority, "none")}`,
    `Assignee: ${name(f.assignee, "Unassigned")} · Reporter: ${name(f.reporter, "?")}`,
    `Created: ${s(f.created)} · Updated: ${s(f.updated)}`,
    ...(s(obj(f.parent)?.key) ? [`Parent: ${s(obj(f.parent)?.key)}`] : []),
    ...(labels ? [`Labels: ${labels}`] : []),
    "Description:",
    adfToText(f.description, DESCRIPTION_CAP) || "(none)",
  ];
  return wrapJira(lines.join("\n"));
}

export function formatSearch(jql: string, j: unknown): string {
  const issues = Array.isArray(obj(j)?.issues) ? (obj(j)?.issues as unknown[]) : [];
  const rows = issues.map((i) => {
    const o = obj(i) ?? {};
    const f = obj(o.fields) ?? {};
    return `${s(o.key)} · ${s(f.summary)} · ${name(f.status, "?")} · ${name(f.issuetype, "?")} · ${name(f.assignee, "Unassigned")} · updated ${s(f.updated)}`;
  });
  return wrapJira([`JQL: ${jql}`, ...(rows.length > 0 ? rows : ["No issues matched."])].join("\n"));
}

export function formatComments(key: string, j: unknown): string {
  const list = Array.isArray(obj(j)?.comments) ? (obj(j)?.comments as unknown[]) : [];
  const rows = list.map((c) => {
    const o = obj(c) ?? {};
    return `— ${name(o.author, "someone")}, ${s(o.created)}:\n${adfToText(o.body, COMMENT_CAP)}`;
  });
  return wrapJira([`Comments on ${key} (newest first):`, ...(rows.length > 0 ? rows : ["No comments."])].join("\n\n"));
}
