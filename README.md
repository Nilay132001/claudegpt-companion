# ClaudeGPT Companion

A native macOS sidebar that sits to the left of **Claude Code Desktop** and gives you a ChatGPT-style
explainer for what Claude is doing, using your **existing ChatGPT subscription** through OpenAI's
official Codex app-server. No API keys.

- Claude Code stays unchanged and stays the coding agent.
- The companion reads the focused Claude session's transcript and the same repository, **read-only**.
- It explains code, Claude's last message, test failures and Jira tickets in plain language.
- Microphone dictation and Read Aloud use on-device macOS speech.

> Status: **Phase 1 done (proof of concept), design under review.** Not usable yet.

## Docs

- [Phase 1 findings](docs/findings/2026-11-03-phase1-poc.md) — what was verified on a real Mac.
- [Design](docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md) — architecture, security
  model, UI, milestones.

## Try the proof of concept

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

## Not affiliated

Independent personal project. Not affiliated with Anthropic or OpenAI.

## License

MIT
