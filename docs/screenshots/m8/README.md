# M8 screenshots

These are rendered by the DEBUG demo connector (`COMPANION_DEMO=<scene>`) with synthetic data only. Nothing here
comes from a real session or repository. The demo connector is compiled out of release builds.

All shots except `before-chat.png` and `icon-512.png` are at the 449 pt panel width (`COMPANION_DEMO_WIDTH=449`)
with the long synthetic names (`COMPANION_DEMO_LONG=1`): session "Investigate flaky integration tests in the
payments reconciliation worker after the Node upgrade", repo "acme-payments-reconciliation-service", branch
"claude/fix-flaky-reconciliation-tests-7f3a2c", file "packages/worker/src/reconcile/ledgerMatcher.ts". Long names
are what overlapped in the first M8 build.

- `before-chat.png`: the v0.7.0 chat view, for comparison.
- `empty-light.png`, `empty-dark.png`: the empty state, with the composer's repo and context controls.
- `chat-light.png`, `chat-dark.png`: a chat on one surface: question bubbles, "context items sent" lines, a
  Markdown answer, a code block with Copy, and the latest answer's actions row.
- `chat-long-300.png`: the same chat at 300 pt: the title truncates, the repo name shortens and the context
  control drops to "Ask" instead of overlapping.
- `context-dark.png`: "context items sent" opened: the items list with file name + parent folder, Copy Context and
  Raw Block.
- `history-light.png`: the History popover with past chats.
- `whatGPTSees-light.png`: the "What GPT can see" popover, opened from the context menu; it names the branch.
- `ask-light.png`: the Ask preview before a question is sent.
- `signedOut-light.png`: the signed-out state.
- `status-light.png`: the borderless status line.
- `icon-512.png`: the app icon.
