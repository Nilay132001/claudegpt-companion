# ClaudeGPT Companion

A native macOS sidebar that sits to the left of **Claude Code Desktop** and gives you a ChatGPT-style
explainer for what Claude is doing, using your **existing ChatGPT subscription** through OpenAI's
official Codex app-server. No API keys.

- Claude Code stays unchanged and stays the coding agent.
- The companion reads the focused Claude session's transcript and the same repository, **read-only**.
- It explains code, Claude's last message, test failures and Jira tickets in plain language.
- Microphone dictation and Read Aloud use on-device macOS speech.

> Status: **Milestones M1–M9 are implemented.** You can build an installable app from source (see Install).
> The owner checklists in `docs/manual/` are still pending.
>
> M8 (0.8.0): redesigned sidebar, copy on every message, kept chat history, better context ranking, app icon
> and a more natural Read Aloud voice. Chat history is stored locally in `companion.db` (secrets redacted). You
> can turn it off or clear it in Settings › Privacy.
>
> M9 (0.9.0): smooth long chats (lazy list, cached parsing), rich answers (tables, task lists, scrolling code,
> charts from validated data), narrow-panel layouts and listenable answers. Measurements: see §11 of
> `docs/superpowers/specs/2026-11-05-m9-rich-ui-performance-design.md`.

## Docs

- [Phase 1 findings](docs/findings/2026-11-03-phase1-poc.md) — what was verified on a real Mac.
- [Design](docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md) — architecture, security
  model, UI, milestones.

## Install

Build the app and install it from a DMG: [install guide](docs/install.md). Signing and notarization notes:
[docs/signing.md](docs/signing.md).

## Try the old Phase 1 proof of concept

Requires macOS, Node 22+, and a ChatGPT plan that includes Codex.

```bash
cd poc/codex && npm install
node poc.mjs login            # opens ChatGPT sign-in in your browser
node poc.mjs chat /path/to/repo
node poc.mjs resume
node poc.mjs attack /path/to/repo   # checks that shell, writes and secret reads are blocked
```

The PoC keeps its own Codex home in `~/Library/Application Support/ClaudeGPTCompanion/` and stores the
login in the macOS Keychain. It does not touch your normal Codex or Claude configuration.

## Development

Requires macOS 26+, full Xcode, Node 24+.

```bash
(cd companiond && npm ci && npm test && npm run typecheck)
(cd app && swift test)
bash scripts/build-app.sh && bash scripts/smoke-bundle.sh
bash scripts/check-repo.sh
```

## Not affiliated

Independent personal project. Not affiliated with Anthropic or OpenAI.

## License

Not decided yet. Until a license is added, no rights to reuse the code are granted beyond viewing it on
GitHub.
