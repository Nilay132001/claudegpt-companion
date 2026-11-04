# Implementation plans — roadmap

Spec: `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (v3.1). Milestones from spec §14.

| M | Plan | Status |
|---|------|--------|
| M0 | [Toolchain](2026-11-03-m0-toolchain.md) | written |
| M1 | [Protocol and platform spike](2026-11-03-m1-protocol-spike.md) | done 2026-11-04 (findings doc, "M1 spike results") |
| M2 | SafeGit + `companion-readonly` jail under Seatbelt | written after M1 (needs the Seatbelt profile and git path from M1) |
| M3 | Session bridge, tail, parser, worktree resolver | written after M1 (needs the `cliSessionId`-change finding) |
| M4 | CodexHost, context builder, redactor, store, privacy, signed bundle skeleton | written after M1 (option A chosen; must test `thread/resume` with the override, option B is the fallback) |
| M5 | SwiftUI app + speech → first usable release | written after M4 |
| M6 | Jira (Atlassian MCP, read-only) | written after M5 |
| M7 | Packaging | written after M6 |

Why not all at once: M1 decides facts that later code depends on — one app-server or a pool, the exact
flag keys, the Seatbelt profile, how Claude's CLI session id changes. Writing M2–M4 code before those are
known would be guessing. Each later plan is written from the spec plus the M1 findings.

After M1: M2 builds on the §7.2 Seatbelt profile (exact Node prefixes, narrower metadata reads); M3
on the confirmed `sessionId` check (no id change observed); M4 (CodexHost) on option A plus a
`thread/resume` test, the per-type replies (elicitation accepted only for a tool-call approval of an
allowlisted tool on an allowlisted server; `url` and form elicitations always declined), the candidate
tool-removal keys, the `unified_exec` self-check exception, and the open question of running Codex
itself under Seatbelt (§7.1.9, owner approval needed).

Every milestone: feature branch → PR → review → owner merges. Short progress summary after each.
