# M8 manual checklist (UI redesign, history, icon, Read Aloud)

Run on this Mac, from the packaged app (version 0.8.0). Record each result as PASS / FAIL / NOT RUN with a short
note. Use synthetic data or Context Off where you can: no real repositories, and never paste reply text. Write
repository paths as `<repo>`.

| # | Check | Who | Result |
|---|-------|-----|--------|
| 1 | The Dock icon shows the new app icon (not a generic one). It also looks right in the Dark and Tinted icon styles (System Settings › Appearance) | Owner | Result: |
| 2 | The header and the composer look like Liquid Glass. Messages sit on the plain window background, with no glass behind them | Owner | Result: |
| 3 | Select text inside an answer by dragging, then press ⌘C. Paste it elsewhere. The panel does not move while you drag over text | Owner | Result: |
| 4 | The Copy menu on an answer offers Markdown and plain text, and each pastes the right form | Owner | Result: |
| 5 | A code block has its own Copy button. It copies only that block | Owner | Result: |
| 6 | ⌘⇧C copies the whole conversation | Owner | Result: |
| 7 | ⌘K starts a new chat. The next question gets fresh context from Claude's newest messages | Owner | Result: |
| 8 | In the composer, Return sends, ⇧Return adds a new line, and ⌥Return adds a new line | Owner | Result: |
| 9 | With Context on Ask, the "Context sent" disclosure on the answer matches what the Ask preview showed | Owner | Result: |
| 10 | Quit the app and relaunch it. The earlier chat is still there | Owner | Result: |
| 11 | The History popover opens a past chat read-only. You can view and copy it, but not ask in it | Owner | Result: |
| 12 | Settings › Privacy › Clear history… removes the history after you confirm | Owner | Result: |
| 13 | Turn "Keep chat history" off, ask a question, quit and relaunch. The new question was not kept. Turn it back on afterwards | Owner | Result: |
| 14 | The "What GPT can see" popover (eye button in the header, and from the empty state) opens and its text matches what the app really sends | Owner | Result: |
| 15 | The status line shows a notice when there is one, and you can dismiss it | Owner | Result: |
| 16 | Signed-out state: the panel explains why sign-in is needed and "Sign in with ChatGPT" works | Owner | Result: |
| 17 | Daemon-down state: stop companiond (or use a build where it cannot start). The panel says so in plain words and recovers when it is back | Owner | Result: |
| 18 | Settings › Speech: the voice picker lists voices grouped by quality, and the default is the best installed voice | Owner | Result: |
| 19 | Preview plays a sample in the chosen voice | Owner | Result: |
| 20 | With no Premium or Enhanced voice installed, the Spoken Content hint shows, and its button opens System Settings › Accessibility › Spoken Content | Owner | Result: |
| 21 | Read Aloud on an answer: it sounds unhurried, with short pauses between sentences and longer ones between paragraphs. Pause, resume and stop work | Owner | Result: |
| 22 | While reading, the message shows a speaking indicator, and it clears when reading stops | Owner | Result: |
| 23 | Context ranking on a long real session (Context on Ask): the preview includes your own messages and Claude's replies, not only subagent or tool output, and stays within 12 KB | Owner | Result: |

Every row needs the owner at the Mac. Rows 1, 2 and 21 need eyes and ears, not only the app's state.
