# M9 manual checklist (about 10 minutes)

The M9 harness drives the panel by itself, but it cannot hover, hold a menu open, move keyboard focus, run
VoiceOver, drag a scroll-bar knob or drag the panel's edge. These checks cover what only a person can do.

**Setup (once).** `cd app && swift build`. Most steps use the synthetic demo scenes:

```bash
COMPANION_DEMO=rich .build/debug/CompanionApp           # every block kind, two answers
COMPANION_DEMO=rich-tables .build/debug/CompanionApp    # narrow, wide and very wide tables
COMPANION_DEMO=rich-charts .build/debug/CompanionApp    # bar, line, pie and metric charts
COMPANION_DEMO=perf-long .build/debug/CompanionApp      # 200 long turns in each of two sessions
```

Use your Bluetooth mouse for steps 1–9 (legacy scroll bars), then the trackpad for step 10. Tick a box only when the
expected result happens exactly. Note anything else next to the step.

1. [ ] **Older answer actions appear on hover.** `perf-long`. Scroll up a few answers. Move the pointer over an older
   answer, then just below its last line.
   *Expected:* a row of actions (Copy with its ▾ menu, Read aloud, the time) fades in under that answer only. No text moves when
   it appears or disappears. Moving the pointer away fades it out.
2. [ ] **The actions stay while their menu is open.** Same answer. Open the Copy button's ▾ menu, then move the
   pointer off the answer while the menu is open.
   *Expected:* the actions row stays visible until the menu closes. After you close the menu with the pointer
   elsewhere, the row fades out.
3. [ ] **Table Copy pill.** `rich-tables`. Hover over a table.
   *Expected:* a Copy pill appears just above the table's top-right corner. Clicking it copies the table as Markdown
   (paste into a text editor to check). Holding the pill, or right-clicking the table, opens a menu with "Copy as
   Markdown" and "Copy as tab-separated". Pasting the tab-separated copy into Numbers gives one cell per table cell.
   Hovering text outside the table does not show the pill, and the pill never covers a header cell's text.
4. [ ] **Wide tables and code scroll sideways; the chat still scrolls.** `rich-tables`, then `rich`. With the mouse
   wheel, scroll vertically with the pointer over a wide table and then over a non-wrapping code block. Then
   shift-scroll (horizontal) over each.
   *Expected:* the vertical wheel scrolls the chat even over the table or code. Shift-scroll moves only the table or
   code sideways. The chat does not move.
5. [ ] **Drag the chat's scroll-bar knob.** `perf-long`. Drag the legacy scroll bar's knob from the bottom to the
   top in one slow drag, then back down quickly.
   *Expected:* the knob follows the pointer, with no jumps back toward the bottom. Content keeps up with no blank
   stretches lasting longer than a moment. The knob can grow or shrink slightly while you pass unseen turns (expected:
   lazy rows estimate their height).
6. [ ] **Following stops on any upward scroll.** Ask a real question with a long answer (real bundle, or use
   `perf-stream`). While it streams, scroll up by one wheel notch.
   *Expected:* the chat stops following at once and stays where you put it while the answer keeps growing. "Jump to
   latest" appears. Scrolling back down to the bottom by hand re-arms following, and the chat moves with the stream
   again.
7. [ ] **Jump to latest with the keyboard.** In step 6's state, press ⌘↓.
   *Expected:* the chat scrolls to the newest line, "Jump to latest" disappears, and following resumes. ⌘↓ does
   nothing while the button is hidden.
8. [ ] **Each chat keeps its reading position.** `perf-long`. Scroll to the middle of session 1, note the first
   visible line, switch to session 2, then back. Do this again quickly, several times in a row.
   *Expected:* every time you come back, the same line is at the top, within a line's height, and there is no
   visible animation or second jump. Scrolling immediately after coming back is not pulled back.
9. [ ] **Live resize with the mouse.** `rich`. Drag the panel's edge from wide (about 600 pt) to narrow (about
   300 pt) and back, slowly and then fast. Select some answer text first and keep it selected.
   *Expected:* the content reflows smoothly while you drag. Text cannot be selected during the drag (selection
   handles are off while resizing). Selection works again when you release. The panel stops at its minimum and
   maximum widths (280–640 pt). Tables switch between grid, side-scroll and stacked rows as the width crosses their
   limits, without flicker after you release.
10. [ ] **Trackpad.** Switch to the trackpad (overlay scroll bars). Repeat step 4 with a two-finger swipe, including a
    diagonal swipe over a code block.
    *Expected:* a mostly-vertical swipe scrolls the chat. A mostly-horizontal swipe over code or a wide table scrolls
    only that block. Momentum scrolling ends without a bounce back.
11. [ ] **Keyboard focus.** `rich`. Click in the composer, then press Tab repeatedly (with "Keyboard navigation"
    turned on in System Settings > Keyboard).
    *Expected:* focus moves visibly through the answer's controls: the code block's Wrap toggle and Copy, the
    "Show all N lines" button, table Copy, the chart's Data disclosure, file chips, and the answer's actions. Space or
    Return activates each one. The focus ring is never clipped by the panel edge or by a code or table scroller.
12. [ ] **VoiceOver: answers and tables.** `rich-tables`. Turn on VoiceOver (⌘F5). Move into an answer with VO-→.
    *Expected:* each block is its own element: headings show up in the rotor's Headings list. A table is announced
    as "Table, N rows", and inside it each row is read as one element with its header names ("Name: …, Status: …").
    "Copy table" is reachable. No element reads hidden actions of older answers.
13. [ ] **VoiceOver: charts.** `rich-charts` with VoiceOver on.
    *Expected:* each chart's Data disclosure is open (VoiceOver was on when it first appeared) and its table is
    read row by row. On the chart itself, the VoiceOver rotor offers Audio Graph. Playing it sonifies the series, and
    "Describe chart" reads the title and axis ranges. The pie chart has at most 8 slices. The "Source:" line is read
    after the data.
14. [ ] **Read Aloud while scrolling.** `rich`. Start Read Aloud on the latest answer, then scroll up and down with
    the mouse for a few seconds.
    *Expected:* speech continues with no stutter. The chat never jumps by itself (no snap of several thousand points),
    and the Read Aloud indicator stays on the answer being read. Tables are read row by row, and charts by their
    summary.
15. [ ] **Real bundle smoke test.** Install the release bundle and ask: "Compare three sorting algorithms in a table,
    then show their average runtime as a bar chart with the source." Then scroll the chat while the answer streams.
    *Expected:* the table and chart render at the end of the stream without the chat jumping. The chart has a "Source:"
    line. Scrolling stays smooth while text streams in.
16. [ ] **A chat never opens or jumps past its last row (external display).** Needs a non-Retina external display
    (scale 1). Move the panel onto it. Run `COMPANION_DEMO=rich COMPANION_DEMO_ANCHOR=bottom COMPANION_DEMO_WIDTH=300`,
    then `COMPANION_DEMO=perf-table COMPANION_DEMO_WIDTH=300`, then each again at 360, 449 and 600 pt. In each one,
    scroll to the top and press ⌘↓, then click "Jump to latest".
    *Expected:* the chat opens showing its last answer, never an empty area between the header and the composer.
    After each jump, the last answer is on screen and its actions row sits just above the composer, with the same gap
    as on the built-in display. (On a scale-1 display, before this fix, `rich` at 300 pt opened blank.) The harness
    can check the same thing: `COMPANION_PERF=idle` gives `drawsAtLoad`, and `COMPANION_PERF=jump` gives `draws`.

If anything fails, note the step number, the scene, the panel width and light or dark mode.
