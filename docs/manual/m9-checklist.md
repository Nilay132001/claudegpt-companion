# M9 manual checklist (rich answers, scrolling performance), real bundle

Run on this Mac, from the packaged app (version 0.9.0). Record each result as PASS / FAIL / NOT RUN with a short
note. Use synthetic data or Context Off where you can: no real repositories, and never paste reply text. Write
repository paths as `<repo>`.

The scene-based checks (the DEBUG demo and perf scenes) are in `docs/superpowers/m9-checklist.md`. This list is
for the installed release app only.

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | Install the 0.9.0 DMG over 0.8.0 (replace the app, keep `~/Library/Application Support`). The app opens and the history from M8 is still there | Owner | Result: |
| 2 | Sign in with ChatGPT still works (or you stay signed in) | Owner | Result: |
| 3 | A long chat (scroll back through 50+ turns) scrolls smoothly with the trackpad, with no stutter. Memory in Activity Monitor stays under about 300 MB | Owner | Result: |
| 4 | While GPT answers, scroll up to read an earlier answer: the view stays put and "Jump to latest" appears. The button and ⌘↓ bring you back | Owner | Result: |
| 5 | Switch sessions back and forth: each opens at once and returns to where you were reading | Owner | Result: |
| 6 | Resize the panel between its narrowest and widest: no lag, and nothing clips at the narrowest width | Owner | Result: |
| 7 | Follow Claude docking still places the panel beside Claude Desktop (R5) | Owner | Result: |
| 8 | Headings, nested lists, checklists, quotes and rules read clearly in light and dark | Owner | Result: |
| 9 | A code block with long lines scrolls sideways. Wrap wraps it, and the choice is kept after relaunch. Copy copies the whole block | Owner | Result: |
| 10 | A table: grid when wide, side-scroll or stacked when narrow. Copy as Markdown and as tab-separated paste correctly | Owner | Result: |
| 11 | Ask "Compare the test runtimes of the packages as a chart, using only numbers from the context" on a session whose context has test output. A chart appears only if GPT gives a valid block, its numbers match the text, and the Data disclosure lists them. An answer without real numbers has no chart | Owner | Result: |
| 12 | Read Aloud on a rich answer: no symbols, pipes or JSON are spoken, and tables and charts are summarised. Pause, resume, stop and voice selection work | Owner | Result: |
| 13 | Microphone dictation still transcribes into the composer | Owner | Result: |
| 14 | Claude Desktop context sync: the Ask mode preview still shows what will be sent, and "Context sent" matches | Owner | Result: |
| 15 | File links (`path:line`) in answers and the code-block chip open in the chosen editor, only for files inside the repository | Owner | Result: |
| 16 | Jira read (if set up) still answers. GPT still cannot write files or run commands (ask it to; it declines) | Owner | Result: |
| 17 | VoiceOver: an answer, a table and a chart are read sensibly, and Jump to latest is reachable | Owner | Result: |
| 18 | A chat never opens or jumps past its last row on an external display. Needs a non-Retina external display (scale 1). Move the panel onto it, open a long chat, and at panel widths of about 300, 360, 449 and 600 pt scroll to the top, then press ⌘↓ and click "Jump to latest". The chat opens showing its last answer, never an empty area between the header and the composer. After each jump the last answer is on screen and its actions row sits just above the composer, with the same gap as on the built-in display | Owner | Result: |

Every row needs the owner at the Mac. Rows 3, 8, 12 and 17 need eyes and ears, not only the app's state.
