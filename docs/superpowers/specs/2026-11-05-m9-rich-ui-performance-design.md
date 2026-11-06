# M9 — Rich answers and scrolling performance: design

Status: phase 1 (investigation + design). No product behaviour changed in this phase. The only code added is the
DEBUG-only profiling harness (`app/Sources/CompanionApp/Demo/PerfHarness.swift`, `PerfContent.swift`, and `#if DEBUG`
probe lines in the chat views).

**Audience.** The owner, who decides the open rulings in §9, and the M9 implementers, who build §5–§8 in the order of
§10. Read §2–§3 first. They say what is actually slow and why, with the measurements.

## 1. How it was measured

- **Build.** Release-optimised with the DEBUG demo compiled in, in a scratch build path that is never shipped:
  `cd app && swift build -c release -Xswiftc -DDEBUG --build-path <scratch>/perf/build`. The shipped release build has
  no synthetic-data path: it contains no `COMPANION_DEMO` or `COMPANION_PERF` strings.
- **Content.** `COMPANION_DEMO=perf-short|perf-medium|perf-long` restores 10, 50 or 200 stored turns per session. Each
  answer is 2–7 KB of realistic GPT Markdown: H2/H3 headings, nested lists, pipe tables, 0–3 fenced code blocks
  (some with 160-character lines), long paragraphs with bold, italic and inline code, and `path:line` refs inside the
  demo root. Each turn also has a 4-item "Context sent" record. `perf-stream` is 200 turns plus a ~28 KB answer
  streamed 3 words every 60 ms (about 50 words/s). The content is seeded, synthetic, and never leaves the process.
- **Driver.** This session cannot screen-capture or use Accessibility, so the app drives itself.
  `COMPANION_PERF=scroll|stream|switch|resize|idle` starts once the content is laid out:
  - `scroll` moves the chat's `NSScrollView` (SwiftUI's `HostingScrollView`) 20 pt per display frame from the bottom
    towards the top.
  - `stream` holds still while the answer streams.
  - `switch` alternates the two demo sessions through `model.pin`.
  - `resize` steps the panel 10 pt per frame between 600 and 300 pt.

  The driver emits `os_signpost` intervals in the Points of Interest table (subsystem `companion.perf`: `phase`,
  `switch`, `resize-step`, `parse.segments`, `parse.plainText`, `parse.highlight`). It also counts view-body
  evaluations per type, records the interval between delivered display-link frames and `phys_footprint`, then writes a
  JSON summary and quits. A display-link frame is delivered on the main run loop, so a late frame means the main thread
  was busy and could not handle a scroll, click or keystroke either.
- **Instruments.** `xctrace` 27.2 on a 120 Hz MacBook Pro, panel width 449 pt. Time Profiler samples are taken from
  the main thread inside the `phase` signpost and summarised by symbol and by category. The SwiftUI template supplies
  the `hitches` table. Each scenario ran twice in each of three modes: untraced, SwiftUI template and Time Profiler.
  The tables give the median, with both values in parentheses. Traces are kept in `<scratch>/perf/traces/` as
  `<scenario>-tp-<n>.trace` and `<scenario>-hitches-<n>.trace`.
- **What could not be measured, and why:**
  - The SwiftUI template's view-update tables (`swiftui-updates`, `swiftui-causes`, …) recorded 0 rows headless, both
    for the bare binary and for an ad-hoc-signed bundle. Body-evaluation counts come from the harness's own counters
    instead.
  - The standalone Animation Hitches template hung while saving after the target exited. The `hitches` numbers below
    come from the same instrument inside the SwiftUI template.
  - On this macOS 26 panel the hitches instrument **under-reports badly**. It recorded 0 hitches while the main thread
    was 99.6% busy and frames came every 72 ms, probably because each late commit still presents "on time". Treat the
    frame intervals and main-thread busy time as the primary metrics. The hitch columns are reported because they were
    asked for, not because they describe the problem.
  - Read Aloud and transcript-sync updates were not driven. Their effect is argued from code (§4).

## 2. Baseline (before any fix)

Frame interval: the time between delivered display-link frames, where 8.3 ms means 120 fps. A frame is "late" when the
interval is more than 1.5 display periods. Busy: the share of the phase in which the main thread was running (Time
Profiler).

| Scenario (trace prefix) | Frame interval p50 / p95 ms | Late frames | Main thread busy | Instruments hitches: count, total ms | Footprint after load | Time to first stable layout |
|---|---|---|---|---|---|---|
| 10 turns, scroll (`short-scroll`) | 8.3 / 8.3 | 0.5 of 1199 | 30% (27 / 32) | 0, 0 | 278 MB | 0.57 s |
| 50 turns, scroll (`medium-scroll`) | 8.3 / 8.3 | 0 of 1199 | 43% (41 / 44) | 1, 12.5 | 1,100 MB | 1.94 s |
| 200 turns, scroll (`long-scroll`) | **12.9 / 21.0** | 391 of 761 | **98%** (97.8 / 98.4) | 1, 33 | **4,221 MB** | **7.3 s** |
| 200 turns + streaming, still (`stream`) | **72.5 / 105.7** | 137 of 138 | **99.6%** | 0, 0 (under-reported) | 4,223 → 4,246 MB | 7.6 s |
| 200 turns + streaming, scrolling (`stream-scroll`) | **84.2 / 125.9** | 121 of 127 | **99.6%** | 0, 0 (under-reported) | 4,223 MB | 7.1 s |
| Switch sessions, 10 turns each (`switch-short`) | 8.3 / 41 | 31 of 461 | 63% | 1, 188 | 278 MB | — |
| Switch sessions, 200 turns each (`switch-long`) | 8.3 / 815 | — | 97% | 3, 20,933 (9.0 s max) | 4,222 → 4,285 MB | — |
| Resize 600↔300 pt, 10 turns (`resize-short`) | **94 / 127** | 103 of 103 | 92% | 1, 142 | 278 → **701 MB** | — |
| Resize 600↔300 pt, 200 turns (`resize-long`) | **1,729 / 1,793** | 5 of 5 | 98% | 6, 6,023 | 4,221 → **8,964 MB** | — |

Other measurements:

- One session switch takes **8.1 s** at 200 turns (median of 3 and 3; values 8.1 and 9.7 s max) and **446 ms** at
  10 turns (median of 14).
- One resize step costs 64 ms synchronously in `setFrame` at 200 turns, then about 1.7 s more before the next frame.
- Streaming moved the reader back to the bottom on **54 of 127** scroll steps (`yanksByOthers`).
- Idle footprint is 31 MB with no chat (`footprint`, `empty` scene). It grows with history at about 21 MB per turn:
  278 MB, 1,099 MB and 4,221 MB for 10, 50 and 200 turns.
- `footprint` on perf-long shows **3,862 MB dirty in 2,521 CoreAnimation regions**. 500,918 pt × 449 pt × 2² × 4 B
  is about 3.6 GB: every answer's text is rasterised for the whole 500k-pt document.

**Fix experiments (scratch copies only; not committed).** Each was run twice, untraced, with the same harness.

| Scenario | Baseline | `LazyVStack` only | `sizingOptions = []` only | Both |
|---|---|---|---|---|
| Long scroll p50 / p95, late | 12.9 / 21.0, 391 | 8.3 / 8.3, 22 | 12.8 / 21.6, 390 | 8.3 / 8.3, 21 |
| Stream (still) p50 / p95 | 72.5 / 105.7 | 8.3 / 20.9 | 8.6 / 67 | 8.3 / 20.7 |
| Stream + scroll p50 / p95 | 84.2 / 125.9 | 8.3 / 21.3 | 17.3 / 69 | 8.3 / 20.4 |
| Switch, 200 turns | 8.1 s | 97 ms | 7.1 s | **67 ms** |
| Resize, 200 turns p50 | 1,729 ms | 21.8 ms | 1,653 ms | **16.7 ms** |
| Footprint after load, 200 turns | 4,221 MB | 121 MB | 4,215 MB | 120 MB |
| Time to first stable layout, 200 turns | 7.3 s | 0.40 s | 5.7 s | 0.36 s |

- **Main thread with both fixes.** Busy time drops from 99.6% to 23% while streaming (`exp-both-stream-tp.trace`).
  What is left is mostly re-parsing the growing answer on every delta: `ReplyMarkdown` is 25% of main-thread time and
  `plainText` for the accessibility label is 12%. While scrolling, busy time drops from 98% to 20%
  (`exp-both-scroll-tp`).
- **Without text selection.** A non-lazy build without `.textSelection(.enabled)` scrolls at 8.3 / 8.3 ms. Its memory
  stays at 4,188 MB and load takes 5.4 s. So the per-frame scroll cost comes from the selectable-text platform views,
  while the memory comes from rendering every view eagerly.

## 3. Root causes, ranked by measured cost

1. **The chat is an eager `VStack` inside `ScrollView`, so every turn is built, laid out and rasterised**
   (`ChatView.swift`). This one choice explains the 4.2 GB footprint (3.9 GB of CoreAnimation backing stores), the
   7.3 s load and the 8.1 s session switch. In `switch-long-tp`, typesetting is 33%, `NSStringDrawing`/`NSLayoutManager`
   for every `Text` is 25%, and the whole tree is built from scratch because every `Turn` id changes. It also explains
   the 1.7 s resize frames: every `Text` is re-laid out and every layer redrawn, with text layout 55% and glyph drawing
   32% in `resize-long-tp`. Finally it explains the per-frame scroll cost at 200 turns: about 1,000 selectable-text and
   button platform views get tracking-area and visible-rect updates on every scroll step
   (`-[NSScrollView _updateTrackingAreas…]` 15%, `NSViewBackingLayer display` 38% in `long-scroll-tp`). The cost grows
   with history length, which is why short chats feel fine. **Evidence:** the `LazyVStack` experiment alone gives
   4,221 → 121 MB, 7.3 → 0.4 s, 8.1 s → 97 ms per switch, and scrolling at 120 fps.
2. **Every streaming delta re-measures the whole document.** Each delta (every 60 ms) re-evaluates `SidebarView` and
   `ChatView`, because `SidebarView` reads `model.currentMessages` and so the `conversations` dictionary. Earlier
   answers are *not* re-evaluated: 0 settled `AnswerView` bodies in the stream phase, against 121 running ones. But the
   layout pass walks all 200 turns, through three routes:
   - `ScrollViewLayoutComputer.sizeThatFits`, 48% (the eager content);
   - `NSHostingView.updateConstraints` → `minSize`/`updateWindowContentSizeExtrema`, 21%. The hosting view's default
     `sizingOptions` re-measure the entire tree on every update to recompute the window's min and max size.
   - `safeAreaInset`'s `InsetViewLayout`, together with `explicitAlignment`, 27–35%.

   Focus traversal (`FocusNavigator.firstNavigableItem`, 6.8%) and titlebar drag regions (8%) also walk the tree.
   **Evidence:** `stream-tp`, main thread 99.6% busy; frames at 72.5 ms p50. `sizingOptions = []` alone brings the
   stream p50 to 8.6 ms (p95 still 67). Lazy alone brings it to 8.3 / 20.9.
3. **Every answer is parsed in `body`, twice, with no cache.** `ReplyView.segments` runs in `body` (median 3.4 ms per
   answer). `AnswerView.accessibilityText` calls `ReplyMarkdown.plainText`, which is a second full parse (median
   2.6 ms), on every body evaluation, and `AnswerView` is evaluated 2–3 times per appearance (1,600 `plainText` runs
   for 600 answer appearances in `switch-long`). With the eager stack this was 30% of a switch. With both fixes it is
   the largest cost left while streaming: the whole growing answer is re-parsed every 60 ms (`ReplyMarkdown` 25% and `plainText` 12%
   of the remaining main-thread samples). It is also the cause of the remaining late frames while scrolling a lazy list (24 of 1,140), when
   a newly visible turn parses on the main thread.
4. **Streaming forces the reader back to the bottom.** `.onChange(of: messages.last?.text)` calls
   `proxy.scrollTo("bottom")` on every delta while the reply runs, whatever the scroll position. The measurement is 54
   yanks in 127 steps at baseline and about 100 per 1,000 steps after the perf fixes. This breaks the acceptance item
   "no jump to bottom while reading older messages".
5. **Smaller items, each measured below 2% or not measured:**
   - `Turn.pair` runs per body (0.0% measured).
   - `.animation(value: messages.count)` wraps the whole scroll view.
   - Every turn has `EntranceTransition` and `.onHover`.
   - `Conversation.restore` creates new UUIDs on every restore, so a reconnect rebuilds every identity.
   - `CodeHighlighter` takes 0.19 ms median per block (0.5% of a switch). It is fine and only needs caching.

## 4. Answers to the investigation questions

| Question | Finding |
|---|---|
| Main-thread blocking | Yes. 98–99.6% busy for long scroll, streaming, switch and resize. The longest stalls are the 8–9.7 s switch and the 1.7–1.9 s resize frames. No disk or network I/O was seen on main; it is all view work. |
| Invalidation fan-out | Each delta invalidates `SidebarView` and `ChatView` (121 of 121 deltas), because `conversations` is one observed dictionary read through `currentMessages`. Settled answers were not re-evaluated, but the layout pass covers every turn (§3.2). |
| Repeated Markdown parsing | Yes. There are 2 full parses per `AnswerView` body evaluation (`segments` and `plainText`) and 2–3 body evaluations per appearance. While streaming, there are 2 full parses of the running answer per delta. Per frame while scrolling: 0 in the eager stack (already built), and one parse per newly visible turn in a lazy one. |
| Text layout cost | Dominant for switch (33% typesetting) and resize (55% text layout, 32% glyph drawing). It is cached during plain scrolling (0.1%). |
| Excessive state updates | One model mutation per delta; no other storms were seen. Each mutation re-evaluates the root `SidebarView`. |
| Streaming re-renders earlier messages | Bodies: no (0 settled bodies). Layout and rendering: yes, the whole document is re-measured each delta (§3.2). |
| LazyVStack / List / ScrollViewReader / identity | An eager `VStack` with `ScrollViewReader`. Identity is the question's UUID, which is stable within one restore but new on every restore and different per session. With `LazyVStack` only about 9 of 200 turns are built. |
| Auto-scroll | Unconditional on every delta while running (54 yanks in 127 steps). |
| History load / render | One `historyTurns` call per session per connection, which is fine. Rendering all 200 turns eagerly takes 7.3 s before the first stable layout, against 0.4 s lazy. |
| Session switching | 8.1 s (200 turns) and 446 ms (10 turns); the whole subtree is rebuilt. Lazy: 97 ms. Both fixes: 67 ms. |
| Resize | 1.7 s per frame (200 turns) and 94 ms per frame (10 turns). Footprint doubles to 9 GB during resize. Both fixes: 16.7 ms. |
| Speech / sync updates | Not measured. From code: `AnswerView` reads `ReadAloudController.playback`, so every play, pause or stop re-evaluates every `AnswerView`, and therefore re-parses `plainText`: 200 at once in the eager stack, only the visible ones in a lazy stack. Transcript-sync events write `syncs`, which `ChatView` does not read, so no chat invalidation is expected. Verify both after the fix with the harness (§8). |

## 5. Performance design

1. **Lazy container.** `ScrollView { LazyVStack(alignment: .leading, spacing: Design.turnGap) { ForEach(turns) … } }`,
   chosen on the evidence in §2. Keep `ScrollView` rather than `List`: `List` adds row chrome, separators and
   selection, and an NSTableView-backed `List` cannot keep cross-block text selection in rich answers. Keep one turn as
   one row, so the question bubble, "Context sent" and the answer appear and disappear together.
2. **Stable identity.** `ChatMessage.id` becomes deterministic for stored turns (`turnId` + role, hashed into a UUID).
   Live turns keep their UUID until the stored copy replaces them, and then keep it (map `turnId` → existing id in
   `restore`). Never use `enumerated()` offsets as ids for blocks. Use `(messageID, blockIndex)`, so a closed block
   keeps its identity while the answer grows.
3. **Parse once, cache, and parse off the main thread.** Add a `RenderedAnswer` value: the block list, styled
   `AttributedString` runs, highlighted code, plain text for the accessibility label and speech, and table and chart
   models. It is built by `ReplyMarkdown` (still the only parse site) and kept in a bounded `RenderCache` (LRU, ~400
   entries or ~16 MB) keyed by a hash of the text and the root. Restored turns are rendered on a background task as
   soon as `restore` returns: the values are `Sendable`, and the parser is pure. On a miss, a view renders
   synchronously (3 ms). `accessibilityText` reads the cached plain text. `body` never parses.
4. **Streaming touches only the tail.** Split the streaming text into closed blocks and the open last block. Closed
   blocks are rendered once, cached, and keep their identity. Each delta re-parses only the open block, and a code
   fence that is still open is shown as plain monospace until it closes. Deltas are coalesced to at most one view
   update per display frame (a 16 ms throttle in `Conversation.apply` or the view model).
5. **Narrow Observation.**
   - Move each message into an `@Observable` `MessageModel` object; `Conversation` keeps an ordered array of them.
   - `SidebarView` reads only whether the chat is empty or loading, and `ChatView` reads only the message ids.
   - A delta then invalidates one `AnswerView` and nothing above it.
   - Read Aloud state goes into a per-message lookup (`readAloud.state(for:)` backed by a dictionary keyed by message id),
     so a playback change invalidates only the two answers involved.
6. **Host sizing.** Set `NSHostingView.sizingOptions = []` in `WindowCoordinator.install`. `SidePanel` already sets
   `contentMinSize` and `contentMaxSize`; keep `SidebarView`'s frame limits as layout limits only.
7. **Scroll anchoring and auto-scroll.**
   - Track `isNearBottom` with `onScrollGeometryChange` (macOS 15+): it is true when the distance from the bottom is
     ≤ 80 pt.
   - Auto-scroll on a delta only when `isNearBottom`, or when the user has just sent the question. Otherwise show a
     small "Jump to latest ↓" button, reachable with VoiceOver and ⌘↓.
   - Use `.scrollPosition(id:anchor:)` bound to the first visible turn, so heights that become known as rows
     materialise do not move what the reader is looking at.
   - `defaultScrollAnchor(.bottom)` stays for the first appearance. Session switch restores each session's last
     position when it is not at the bottom.
8. **No animation at scale.** Drop `.animation(value: messages.count)` on the scroll view. Animate only the new turn's
   entrance, and only when it is the last turn. Replace per-answer `.onHover` with one hover tracker on the row
   (lazy rows bound the count anyway).

## 6. Rich rendering design

**Parser.** Use Foundation `AttributedString(markdown:options: .init(interpretedSyntax: .full))`. It is cmark-gfm
underneath and its `PresentationIntent` exposes headings, nested ordered and unordered lists, block quotes, code blocks
with a language hint, thematic breaks and **tables with column alignment**, plus strikethrough as an inline intent. It
needs no new dependency, and it keeps the existing rule that only `ReplyMarkdown.swift` parses Markdown. Task-list
items ("[ ]" / "[x]") are detected by prefix inside list items. Links are still stripped, and only `path:line`
references inside the root become links.

- **Fallback:** `swift-markdown` (swiftlang/Apple, cmark-gfm, typed `Table`, `ListItem.checkbox` and `Strikethrough`
  nodes; maintained because DocC uses it), if `PresentationIntent` proves awkward for nested lists. It would be a new
  SwiftPM dependency, so it needs owner approval.
- **Not recommended:** MarkdownUI 2.x is in maintenance mode per its README. Its successor Textual (same author, MIT)
  is a young 0.x project; it adds tables, code and math, but it is too new to take on for a security-sensitive app.
  WKWebView was not prototyped; it is not needed now that the native fix measures 120 MB and 120 fps. It would add a
  WebContent process (tens of MB), HTML sanitisation of untrusted output with JavaScript off, a native/web
  scroll-anchoring seam and separate accessibility trees, which is a worse fit for "no WebView without comparison".
- **Text views:** stay with SwiftUI `Text` per block inside the lazy list. An `NSTextView` with TextKit 2 per answer
  would give viewport layout and selection across the whole answer, but TextKit 2 falls back to TextKit 1 for tables
  (`NSTextTable`). It costs an AppKit bridge per row and a rebuild of what M8 shipped. Revisit only if selection across
  blocks becomes a requirement.

**Components** (all in `Views/Rich/`, one file each):

- `BlockStack`: the answer's block list.
- `ProseBlock`: one selectable `Text` per run of paragraphs, quotes and list items, as today.
- `HeadingBlock`.
- `ListBlock`: nested, with bullet and number columns and task checkboxes as SF Symbols (`checkmark.square` /
  `square`, read as "done" / "to do").
- `QuoteBlock`: a 2 pt leading rule in secondary text.
- `RuleBlock`.
- `CodeBlock`.
- `TableBlock`.
- `ChartBlock`.
- `MathBlock`: monospace display of `$$…$$`, `\[…\]` and inline `$…$` as code. Native LaTeX layout is not
  in the platform; SwiftMath, an iosMath port under MIT, is the option if the owner wants real math later.

**Typography tokens** (`Design.Type`):

- `answerBody` 14 pt, line height 21 (lineSpacing 4);
- `h1` 20 semibold, 18 pt above and 8 pt below;
- `h2` 17 semibold, 16 above and 6 below;
- `h3` 15 semibold, 12 above and 4 below;
- `code` 12.5 mono, line height 18;
- `tableCell` 13, header 13 semibold;
- `caption` 11;
- paragraph gap 10, list item gap 4, nesting indent 18 per level, bullet column 14.

Each token scales with the user's text size setting (`.dynamicTypeSize` mapping). Colours are system label colours
only, so light and dark mode follow automatically. Links use the accent colour, inline code a 6% primary fill with a
4 pt radius, and quotes `.secondary`.

**Code blocks: resolving wrap vs horizontal scroll.** M8 chose soft-wrap so nothing would clip at 280 pt; the owner now
asks for horizontal scrolling. Proposal:

- Default to **no wrap, with horizontal scroll** inside the block: `ScrollView(.horizontal)` around a non-wrapping
  `Text`, a visible scroller on hover, and a 12 pt trailing fade when content overflows. Vertical wheel events pass
  through to the chat.
- The header keeps the language and Copy, and adds a **Wrap** toggle (`text.word.wrap`). Its state is saved as a
  setting (`ui.code.wrap`, default off), so a user who prefers M8's behaviour keeps it.
- Very long blocks (> 40 lines) show 24 lines with "Show all N lines" and a file:line chip when GPT referenced one.
- Copy always copies the original text.

**Tables: adaptive strategy.** Measure each column's ideal width, with cells capped at 220 pt and wrapping beyond that.

- **600 and 449 pt:** use a grid when the sum fits; otherwise scroll horizontally, keeping the cell wrap cap and the
  header.
- **360 pt:** use a grid only for ≤ 3 columns that fit; otherwise scroll horizontally.
- **300 pt:** use a grid for ≤ 2 columns. For more columns, use a **stacked** layout: each row becomes a small block of
  "Header: value" lines, separated by hairlines, with the first column as the row title.

In every layout:

- header in semibold;
- column alignment from the Markdown (`:---:`);
- numeric columns trailing-aligned;
- zebra fill of 3% primary;
- a hairline border only around the table;
- Copy ▾ offers Markdown and tab-separated;
- VoiceOver reads it as a table (`accessibilityElement(children: .contain)` per row, with the header as each cell's
  label).

**Charts (Swift Charts, macOS 13+; `SectorMark` for pie needs macOS 14+, which is fine on 26).** Only an explicit
block is rendered:

````
```companion-chart
{"version":1,"type":"bar","title":"Test runtime by package","units":"s",
 "x":{"label":"Package"},"y":{"label":"Seconds"},
 "series":[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}],
 "source":"Read from the npm test output in the session context"}
```
````

**Validation** (`ChartSpec.parse` in CompanionCore, pure, unit-tested). The JSON is accepted only when every rule
holds:

- the JSON is ≤ 8 KB and parses with `JSONDecoder`, and unknown keys are rejected;
- `version == 1`;
- `type` is one of `bar`, `line`, `pie` or `metric`;
- `title` is 1–80 characters, `units` ≤ 16 and `source` 1–200 (required);
- there are 1–4 series, except `pie` and `metric`, which have exactly 1;
- each series has 1–24 points (`line` up to 60) and each label is 1–40 characters, unique within its series;
- every value is a finite JSON number with |v| ≤ 1e12; NaN, infinity and strings are rejected;
- `pie` values are ≥ 0 with a sum > 0;
- `line` series share the same labels in the same order;
- `metric` has 1–4 points.

All strings are shown verbatim, never as `LocalizedStringKey` or Markdown, and never as links. When valid, the block
renders the chart (max height 220 pt, full width, and a legend only when there is more than one series), then a
**text table equivalent** under a "Data" disclosure, which is open when VoiceOver is running. It also gets
`.accessibilityChartDescriptor`, so the data can be heard as an Audio Graph. Invalid → a normal code block labelled
`companion-chart` plus a caption line saying why ("Chart not shown: value 3 is not a number"). The app never infers
chart data from prose or tables.

**Read Aloud with rich content.** `SpeechText` works from the cached `RenderedAnswer`, not raw Markdown:

- headings are read as sentences with a paragraph pause, and list items as sentences;
- tables are read as "A table with 4 rows. Parser: 4.2 seconds…" for up to 6 rows, and otherwise "A table with N rows
  is shown on screen";
- charts are read as their title plus the text summary ("Bar chart, Test runtime by package: parser 4.2 seconds,
  csv 1.9 seconds");
- code is read as "Code block omitted", or read out when the "Read code" setting is on, as today;
- no Markdown markers, pipes or JSON are ever spoken.

The existing `SpeechTextTests` gain table, chart and task-list cases.

**Presentation tone (Priority 4).** Change `companiond/src/codex/instructions.ts`. Keep every existing line unchanged
and in place, including the untrusted-data rule, and append:

> Write for someone who may listen rather than read: lead with the answer in plain, short sentences, then the reasons.
> Prefer a few sentences to long bullet lists, and use a table only to compare several items on several points.
> State once what you confirmed by reading files (cite path:line) and what you assumed or could not check; do not
> repeat disclaimers or restate context the user already gave. If a tool was unavailable or a result is unverified,
> say so plainly.
> Add a chart only when it helps and only with numbers you read or computed from the provided data: one fenced block
> tagged companion-chart containing JSON {version:1, type: bar|line|pie|metric, title, units, x, y, series:[{name,
> points:[{label, value}]}], source}. Never invent or estimate values; say in source where they came from, and also
> give the key numbers in the text.

The existing "Explain simply. Cite files…" line stays. The wording adds no capability or tool, and the chart block is
data the app validates; a model that ignores it degrades to a code block. A new `test/codex/instructions.test.ts` asserts that the
safety lines are still present and come before the new ones.

## 7. Test plan

- **Unit (CompanionCore, Swift Testing):**
  - `ReplyMarkdown` full-syntax blocks: nested lists, tables with alignment, task items, thematic break, strikethrough,
    open fences while streaming, links stripped, `path:line` inside the root only.
  - `RenderCache` hit, miss and eviction.
  - Block identity is stable as text grows (tail-only).
  - `ChartSpec` validation: every rule in §6, with fuzzed NaN, huge, duplicate and missing values.
  - `SpeechText` for tables and charts.
  - Deterministic ids across a double `restore`.
  - `Conversation` delta coalescing.
- **Source rules:** Markdown is parsed only in `ReplyMarkdown.swift`; chart strings never reach `LocalizedStringKey`
  (existing rule); there is no `print`; `instructions.ts` safety lines are unchanged.
- **Layout snapshots:** use the self-snapshot (`COMPANION_DEMO_SHOT`) at **300, 360, 449 and 600 pt**, light and dark,
  for the new `rich` demo scene (every block type) plus `chat`, `context`, `status` and `history`. The check is that
  nothing clips, overlaps or overflows horizontally, except inside code and table scrollers.
- **Streaming:** the harness `stream` driver asserts that settled-answer body counts are 0, at most one `AnswerView`
  update per frame, and 0 parses of closed blocks during the phase.
- **Scroll-position preservation:** the harness `stream-scroll` driver asserts `yanksByOthers == 0` when it starts
  more than 80 pt from the bottom. Add a new `COMPANION_PERF=position` driver: scroll to a mid turn, switch away and
  back, then assert the same first visible turn id.
- **Accessibility:**
  - VoiceOver labels for tables, charts, task items and the "Jump to latest" button;
  - keyboard: Tab reaches Copy, Wrap and table Copy; ⌘↓ jumps to latest;
  - Reduce Motion: no entrance offsets;
  - Increase Contrast: hairlines become separators.
- **Regression (Priority 5):** the existing app suite (193 tests) and companiond tests, the packaging smoke test, and a manual pass on the real bundle
  covering sign-in, context sync, mic, Read Aloud and voices, session switching, and file links.

## 8. Measurement plan (after)

Rebuild with the same command and run `<scratch>/perf/tools/matrix.sh` unchanged: the 9 scenarios × untraced, SwiftUI
template and Time Profiler × 2 runs, plus idle footprints. Then run `tools/table.py` and `tools/analyze.py`. Add two
scenarios:

- `readaloud`: start playback on the latest answer, then scroll;
- `position` (§7).

Targets (on this Mac, 449 pt, perf-long):

| Metric | Target |
|---|---|
| Scroll frame p50 / p95 | ≤ 8.4 / ≤ 12 ms |
| Late frames while scrolling | ≤ 2% |
| Stream (still or scrolling) p95 | ≤ 17 ms |
| Main thread busy while streaming | ≤ 15% |
| Session switch | ≤ 100 ms |
| Resize frame p50 | ≤ 17 ms |
| Footprint after load | ≤ 200 MB |
| Time to first stable layout | ≤ 0.5 s |
| Yanks when reading above the bottom | 0 |

Report before and after side by side, with trace names. Then test smooth scrolling and readable rich content on the
real released bundle on the owner's Mac. Unit tests alone do not count.

## 9. Risks and owner rulings needed

- **R1 (ruling): code blocks** default to horizontal scroll with a Wrap toggle (§6). The alternative is to keep M8's
  wrap as the default with a scroll toggle.
- **R2 (ruling): parser.** Foundation full syntax (no dependency) is the plan. Approve `swift-markdown` as the fallback
  dependency only if needed.
- **R3:** lazy rows estimate heights, so the scroll bar can resize while scrolling up through unseen turns.
  Mitigation: `scrollPosition(id:)` anchoring and cached row heights per (id, width).
- **R4:** cross-block text selection stays limited to one prose run, as in M8; this is unchanged.
- **R5:** `sizingOptions = []` changes how the panel's min and max size are derived. Verify the 280–640 pt clamp and
  the Follow Claude docking.
- **R6:** the tone instructions change GPT output for everyone. Gate it behind the same release and watch for lost
  precision in file:line citations.
- **R7:** the hitches instrument under-reports here (§1). The success criteria use frame intervals and busy time,
  which the harness measures directly.

## 10. Implementation tasks (perf first)

1. `LazyVStack`, deterministic message ids, `sizingOptions = []`, drop the scroll-view animation. Re-run the matrix,
   expecting the "Both" column in §2.
2. Near-bottom auto-scroll, "Jump to latest", `scrollPosition` anchoring, and per-session restore of the scroll
   position. Add the `position` driver.
3. `RenderedAnswer` and `RenderCache`, background rendering for restored turns, and accessibility and speech from the
   cache.
4. Streaming tail-only blocks and delta coalescing; per-message `@Observable` models; the narrowed `SidebarView` and
   `ChatView` reads; per-message Read Aloud state. Re-run the matrix and record before and after.
5. Full-syntax `ReplyMarkdown` (blocks, tables, task lists, rules, strikethrough) with tests.
6. Rich components and typography tokens; the `rich` demo scene; snapshots at the four widths.
7. Code block horizontal scroll and Wrap toggle (after the R1 ruling); `TableBlock` with the adaptive layouts.
8. `ChartSpec` validation, `ChartBlock` with the text equivalent and audio graph, and chart and table speech.
9. `instructions.ts` tone and chart wording, with tests.
10. Final measurements (§8), screenshots at the four widths, a manual real-bundle pass, and the PR through review.

## 11. Results (after)

**Conditions.**
- Build: release-optimised with the DEBUG harness (`swift build -c release -Xswiftc -DDEBUG`). Base is 7212a86, the
  §2 starting point. Final is af5d7bf, which is e0ef888 plus a harness-only probe.
- Machine and panel: the same Mac at 120 Hz (8.33 ms display period), panel 449 pt. This time the panel opened on the
  external display at scale 1.
- Plain drivers: overlay scrollers are forced and the driver moves the clip view, as in §2. Display awake and screen
  unlocked for every run (checked before and after each run), with `caffeinate -dimsu`.
- Runs: base and final runs were interleaved, 3 each per scenario. Values are medians, with the three runs in
  parentheses. `stream` was noisy (p95 8.3, 16.7, 14.4), so it ran twice more: five runs, median given.
- Base here is re-measured, so its footprint (about 1,068 MB) is lower than §2's 4,221 MB. Base rasterisation at load
  is not deterministic. §2 stays as the original baseline.

| Scenario (trace prefix) | Base: frame p50 / p95 ms, late frames | After: frame p50 / p95 ms, late frames | Main thread busy, base → after |
|---|---|---|---|
| 200 turns, scroll (`long-scroll`) | 16.7 / 22.7, 494 of 622 | **8.3 / 8.3**, 13 of 1137 (15, 13, 13) | — |
| 200 turns + streaming, still (`stream`) | 81.8 / 117.2, 125 of 125 | **8.3 / 8.3** (p95 8.3, 16.7, 14.4, 8.3, 8.3), 31 of 1164 | 99.5 / 99.6% → **15.3 / 15.1%** (`final-stream-tp-1/2`) |
| 200 turns + streaming, scrolling (`stream-scroll`) | 90.1 / 134.9, 111 of 117 | **8.3 / 8.3**, 14 of 1140 | 99.5 / 99.6% → **32.6 / 32.0%** (`final-stream-scroll-tp-1/2`) |
| Switch sessions, 200 turns (`switch-long`) | sync 7,945 ms, to next frame 8,031 ms | sync **76.8 ms** (76.8, 75.4, 77.3), to next frame 87.8 ms | — |
| Resize 600↔300 pt, 200 turns (`resize-long`) | 1,426 / 1,493, `setFrame` 62.4 ms | **17.2 / 25.9** (p50 16.7, 17.2, 17.5), `setFrame` 0.8 ms | — |
| Footprint after load, 200 turns (idle) | 1,067.9 MB | **64.4 MB** (64.4, 64.6, 64.1) | — |
| Time to first stable layout, 200 turns (`long-scroll`) | 6,788 ms | **566 ms** (594, 541, 566) | — |
| Read Aloud toggling while scrolling (`readaloud`) | no driver at base | 8.3 / 24.5, 114 of 1007; 33 toggles, 23 settled answer bodies, 0 jumps | — |

Time Profiler traces are kept in `<scratch>/perf/traces-final/` and are not committed. Base busy comes from
`stream-tp-1/2` (§2) and `base-stream-scroll-tp-1/2` (the Task 4b window).

**Targets (§8).**

| Metric | Target | After | |
|---|---|---|---|
| Scroll frame p50 / p95 | ≤ 8.4 / ≤ 12 ms | 8.3 / 8.3 | met |
| Late frames while scrolling | ≤ 2% | 1.1% (13 of 1137) | met |
| Stream p95, still / scrolling | ≤ 17 ms | 8.3 / 8.3 (worst single run 16.7) | met |
| Main thread busy while streaming | ≤ 15% | 15.3 / 15.1% | **missed by 0.1–0.3 points** |
| Session switch | ≤ 100 ms | 76.8 ms sync, 87.8 ms to the next frame | met |
| Resize frame p50 | ≤ 17 ms | 17.2 ms (16.7, 17.2, 17.5) | **missed by 0.2 ms** |
| Footprint after load | ≤ 200 MB | 64.4 MB | met |
| Time to first stable layout | ≤ 0.5 s | 566 ms (594, 541, 566; idle runs 573, 578, 538) | **missed by 66 ms** |
| Yanks when reading above the bottom | 0 | 0 in every scroll, stream-scroll and readaloud run (`yanksWhileReading`, `pullbacks`) | met |

**Other counters (after).**
- `stream`: 10 render-cache misses per run (the streamed answer's closed chunks).
- `stream-scroll`: 3 non-driver moves per run, all lazy-layout height corrections that kept the content in place.
  Base had 46, 57 and 62.
- `switch-long`: 283 cache misses per run, from rendering the other session's restored answers off the main thread.
- Read Aloud A/B: Task 9's binary and the final binary, 3 interleaved runs each, gave the same result: p95 24.6
  against 24.7 ms, 21 settled answer bodies for 31–32 toggles. The final code did not regress it.
- Read Aloud is not comparable with runs before Task 9: from Task 9 on, the driver scrolls inside a live scroll, so
  SwiftUI's stale-offset write-backs (+3,068 pt) are gone.
- Table-heavy scroll (`perf-table`, 2 runs): 372893a gave 26 and 31 late frames, 925 and 954 lateMs. Final gave 29 and
  27 late frames, 971 and 934 lateMs, with an end footprint of 116 MB both times. Equal.
- Chart-heavy scroll (`perf-chart`, Task 9): 34 late frames of about 1,120, footprint 152 MB after load.

**Legacy scroll bars and the mouse wheel.** The owner uses a Bluetooth mouse, so their Mac shows legacy scroll bars.
These runs used `COMPANION_PERF_SCROLLERS=system` and `COMPANION_PERF_INPUT=wheel`: discrete wheel notches delivered
through the window.
- `position`, perf-long, 3 runs: the same first visible line after a switch, after rapid switches and after a past
  chat in 2 of 3 runs. In the third run the turn was right after the rapid switches and the past chat, but the
  viewport sat 34 pt higher in it.
- `position`, perf-stream (still streaming), 2 runs: the same line every time.
- Reader trip (wheel down right after coming back): 0 pulls in 4 of 5 runs, and 1 move of 34 pt in the run above. 0
  moves after the reader stopped.
- `stream-scroll`, 2 runs: p50 / p95 8.3 / 8.3 ms, 22 and 25 late frames, 0 `yanksWhileReading`, 0 pullbacks.

**What was not measured.**
- The SwiftUI hitches template, which under-reports here (§1).
- Time Profiler for the non-streaming scenarios.
- Any run with a real person's input. The manual checks are in `docs/superpowers/m9-checklist.md`.

**Screenshots.** `docs/screenshots/m9/` has the following, all synthetic demo content, from a debug build:
- after: `rich-top-*`, `rich-bottom-*` and `long-*` at 300, 360, 449 and 600 pt, light and dark;
- before (db5c26b): `before-long-*`.

Every after shot of the rich, rich-tables, rich-charts, chat, context, status and history scenes was reviewed. No
clipping, overlap or horizontal overflow was found outside the code and table scrollers. Two demo defects remain:
- `rich-top` does not show the top. At 360–600 pt it shows the same bottom view as `rich-bottom`.
- At 300 pt, `rich` with the top anchor shows an empty chat. Light, dark and long names all do this, in 3 of 3
  attempts, at 3 s and 6 s. `rich-bottom` at 300 pt renders. The real app always opens at the bottom (or at a
  restored anchor with following off), so this combination of top anchor and following is demo-only. Its cause is not
  established.

### Rulings during implementation

- **Following the stream.** Any upward scroll stops following at once, whatever the distance. Following re-arms only
  when the reader is back at the bottom, by scrolling there or with Jump to latest (⌘↓).
- **Live resize.** Text selection is off while the panel is being live-resized, and comes back when the drag ends.
  Selection overlays were the per-frame cost of a resize.
- **Restoring a reading position.** The restore is a single anchored scroll to the saved turn and its offset. It is not
  repeated corrections, and it ends on Jump, on a new turn or on a timer, so it never pulls back a reader who has
  started scrolling.
- **Pie charts** have at most 8 slices. A spec with more is invalid: it is shown as its code block, with the reason.
- **Tables** use one of three layouts: a grid when the columns fit, side scroll when they do not, and stacked rows at
  narrow widths. The layout is chosen inside a custom `Layout`, with one tier of hysteresis.
