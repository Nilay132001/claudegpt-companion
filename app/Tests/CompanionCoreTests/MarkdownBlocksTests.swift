import Foundation
import Testing
@testable import CompanionCore

/// A compact description of blocks, so the expectations read like the Markdown.
func describe(_ b: AnswerBlock) -> String {
    switch b {
    case .paragraphs(let s): "p:" + String(s.characters)
    case .heading(let l, let s): "h\(l):" + String(s.characters)
    case .list(let l):
        (l.ordered ? "ol[" : "ul[") + l.items.map { item in
            let check = item.check.map { $0 == .done ? "x " : "o " } ?? ""
            return check + item.marker + " " + item.content.map(describe).joined(separator: " ")
        }.joined(separator: ", ") + "]"
    case .quote(let bs): "q[" + bs.map(describe).joined(separator: " ") + "]"
    case .code(let c): "code(\(c.language ?? "-")\(c.isOpen ? ",open" : "")):" + c.text
    case .table(let t): "table \(t.columnCount)x\(t.rows.count)"
    case .rule: "hr"
    case .math(let m): "math:" + m
    }
}

@Suite struct MarkdownBlocksTests {
    func d(_ md: String, root: String? = nil) -> [String] { ReplyMarkdown.blocks(md, root: root).map(describe) }

    @Test func headingsAndParagraphRuns() {
        #expect(d("## Head *it*\n\nOne.\n\nTwo.") == ["h2:Head it", "p:One.\n\nTwo."])
    }

    @Test func inlineStylesSurviveIncludingStrikethrough() {
        guard case .paragraphs(let s) = ReplyMarkdown.blocks("A **b** `c` ~~d~~", root: nil).first else { Issue.record(); return }
        let intents = s.runs.map { (String(s[$0.range].characters), $0.inlinePresentationIntent) }
        #expect(intents.contains { $0.0 == "b" && $0.1 == .stronglyEmphasized })
        #expect(intents.contains { $0.0 == "c" && $0.1 == .code })
        #expect(intents.contains { $0.0 == "d" && $0.1 == .strikethrough })
    }

    @Test func nestedListsAndTaskItems() {
        #expect(d("- one\n  - nested\n- [ ] todo\n- [x] done") == ["ul[• p:one ul[◦ p:nested], o • p:todo, x • p:done]"])
    }

    @Test func orderedListsKeepTheirStart() {
        #expect(d("3. three\n4. four") == ["ol[3. p:three, 4. p:four]"])
    }

    @Test func aListItemCanHoldParagraphsAndCode() {
        #expect(d("1. item\n\n   second para\n\n   ```\n   code\n   ```\n2. next")
                == ["ol[1. p:item p:second para code(-):code, 2. p:next]"])   // merging is top-level only
    }

    @Test func quotesRulesAndCode() {
        #expect(d("> quote line\n\n---\n\n```swift\nlet x = 1\n```") == ["q[p:quote line]", "hr", "code(swift):let x = 1"])
    }

    @Test func tablesKeepAlignmentAndEmptyCells() {
        let md = "| Name | Value | Note |\n|:-----|------:|:---:|\n| a | 1 |  |\n| b | 2 | x |"
        guard case .table(let t) = ReplyMarkdown.blocks(md, root: nil).first else { Issue.record(); return }
        #expect(t.alignments == [.leading, .trailing, .center])
        #expect(t.header.map { String($0.characters) } == ["Name", "Value", "Note"])
        #expect(t.rows.map { $0.map { String($0.characters) } } == [["a", "1", ""], ["b", "2", "x"]])
    }

    @Test func numericColumnsWithoutAlignmentAreTrailing() {
        guard case .table(let t) = ReplyMarkdown.blocks("| k | n |\n|---|---|\n| a | 1,200 |\n| b | -3.5 |", root: nil).first
        else { Issue.record(); return }
        #expect(t.alignments == [.leading, .trailing])
    }

    @Test func linksAreRemovedTheirURLShownOnceAndNotSpoken() {
        guard case .paragraphs(let s) = ReplyMarkdown.blocks("Read [the docs](https://evil.example/x) now", root: nil).first
        else { Issue.record(); return }
        #expect(String(s.characters) == "Read the docs (https://evil.example/x) now")
        #expect(s.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
        let skipped = s.runs.filter { $0[AnswerAttributes.SpeechSkip.self] == true }.map { String(s[$0.range].characters) }
        #expect(skipped == [" (https://evil.example/x)"])
    }

    @Test func fileReferencesLinkOnlyInsideTheRoot() {
        let blocks = ReplyMarkdown.blocks("- see `src/a.ts:3`\n- and /etc/passwd.txt:1\n\n| f |\n|---|\n| src/b.ts:4 |", root: "/r")
        var links: [URL] = []
        func collect(_ b: AnswerBlock) {
            switch b {
            case .paragraphs(let s): links += s.runs.compactMap(\.link)
            case .list(let l): l.items.flatMap(\.content).forEach(collect)
            case .table(let t): links += (t.header + t.rows.flatMap { $0 }).flatMap { $0.runs.compactMap(\.link) }
            default: break
            }
        }
        blocks.forEach(collect)
        #expect(links.compactMap(EditorLink.parseCompanionURL) == [FileReference(path: "/r/src/a.ts", line: 3),
                                                                   FileReference(path: "/r/src/b.ts", line: 4)])
    }

    @Test func anOpenFenceWhileStreamingIsOpenCode() {
        let chunk = ReplyMarkdown.chunks("Text\n\n```ts\nlet x").last!
        let r = ReplyMarkdown.renderChunk(chunk, root: nil, style: ReplyMarkdown.noStyle)
        #expect(r.blocks.map(describe) == ["code(ts,open):let x"])
    }

    @Test func mathBlocksAndInlineMath() {
        #expect(d("$$\na+b\n$$") == ["math:a+b"])
        #expect(d("\\[\nx^2\n\\]") == ["math:x^2"])
        #expect(d("$$ e = mc^2 $$") == ["math:e = mc^2"])
        guard case .paragraphs(let s) = ReplyMarkdown.blocks("Area $x^2$ here; costs $5 and $10.", root: nil).first
        else { Issue.record(); return }
        #expect(String(s.characters) == "Area x^2 here; costs $5 and $10.")
        #expect(s.runs.contains { String(s[$0.range].characters) == "x^2" && $0.inlinePresentationIntent == .code })
    }

    @Test func mathBlocksStayInOneChunk() {
        #expect(ReplyMarkdown.chunks("$$\na\n\nb\n$$\n\nAfter").map(\.text) == ["$$\na\n\nb\n$$", "After"])
        #expect(ReplyMarkdown.chunks("\\[\nx\n\n\\]").count == 1)
    }

    @Test func codeInfoStringGivesLanguageAndReference() {
        guard case .code(let c) = ReplyMarkdown.blocks("```ts src/a.ts:12\nx\ny\n```", root: "/r").first else { Issue.record(); return }
        #expect(c.language == "ts")
        #expect(c.reference == FileReference(path: "/r/src/a.ts", line: 12))
        #expect(c.lineCount == 2)
        guard case .code(let outside) = ReplyMarkdown.blocks("```ts /etc/x.ts:1\nx\n```", root: "/r").first else { Issue.record(); return }
        #expect(outside.reference == nil)
    }

    @Test func plainTextFromBlocks() {
        let md = "# T\n\n- a\n  - b\n- [x] c\n\n| h | v |\n|---|---|\n| x | 1 |\n\n---\n\n```\ncode\n```"
        #expect(ReplyMarkdown.plainText(md) == "T\n\n• a\n  ◦ b\n• [x] c\n\nh\tv\nx\t1\n\n—\n\ncode")
    }

    @Test func blockSpacingFollowsTheTokens() {
        let p = AnswerBlock.paragraphs("x"), h1 = AnswerBlock.heading(level: 1, text: "x"), h3 = AnswerBlock.heading(level: 3, text: "x")
        #expect(BlockSpacing.gap(before: p, after: nil) == 0)
        #expect(BlockSpacing.gap(before: p, after: p) == 10)
        #expect(BlockSpacing.gap(before: h1, after: p) == 18)
        #expect(BlockSpacing.gap(before: h3, after: p) == 12)
        #expect(BlockSpacing.gap(before: p, after: h1) == 8)
        #expect(BlockSpacing.gap(before: p, after: AnswerBlock.heading(level: 2, text: "x")) == 6)
        #expect(BlockSpacing.gap(before: p, after: h3) == 4)
    }

    @Test func headingLevelsBeyondThreeUseTheH3Gaps() {
        let p = AnswerBlock.paragraphs("x")
        #expect(BlockSpacing.gap(before: .heading(level: 5, text: "x"), after: p) == 12)
        #expect(BlockSpacing.gap(before: p, after: .heading(level: 6, text: "x")) == 4)
        #expect(BlockSpacing.gap(before: .heading(level: 0, text: "x"), after: p) == 18)
        // A heading right after a heading: the space above the new heading wins.
        #expect(BlockSpacing.gap(before: .heading(level: 2, text: "x"), after: .heading(level: 1, text: "x")) == 16)
    }

    @Test func listMarkerColumnWidths() {
        func item(_ m: String, _ check: ListItem.Check? = nil) -> ListItem { ListItem(marker: m, check: check, content: []) }
        #expect(ListLayout.markerColumn(ListModel(ordered: false, items: [item("•"), item("•")])) == 14)
        #expect(ListLayout.markerColumn(ListModel(ordered: false, items: [item("•", .done), item("•", .open)])) == 14)
        #expect(ListLayout.markerColumn(ListModel(ordered: true, items: [item("1."), item("2.")])) == 18)
        #expect(ListLayout.markerColumn(ListModel(ordered: true, items: (1...12).map { item("\($0).") })) == 26)
        #expect(ListLayout.markerColumn(ListModel(ordered: true, items: [])) == 14)
    }

    @Test func textScaleFollowsTheDynamicTypeSteps() {
        #expect(TextScale.factor(.xSmall) == 0.88)
        #expect(TextScale.factor(.small) == 0.94)
        #expect(TextScale.factor(.medium) == 1.0)
        #expect(TextScale.factor(.large) == 1.0)
        #expect(TextScale.factor(.xLarge) == 1.1)
        #expect(TextScale.factor(.xxLarge) == 1.2)
        #expect(TextScale.factor(.xxxLarge) == 1.3)
        #expect(TextScale.factor(.accessibility) == 1.4)
    }

    @Test func absurdNestingIsCappedAndKeepsItsText() {
        let quote = ReplyMarkdown.blocks(String(repeating: "> ", count: 5000) + "deep text", root: nil)
        #expect(ReplyMarkdown.plainText(quote).contains("deep text"))
        var list = ""
        for i in 0..<5000 { list += String(repeating: "  ", count: i) + "- item\n" }
        let blocks = ReplyMarkdown.blocks(list + String(repeating: "  ", count: 5000) + "- bottom", root: nil)
        #expect(ReplyMarkdown.plainText(blocks).contains("bottom"))
    }

    @Test func anOpenFenceInsideAListOrQuoteMarksTheChunkOpen() {
        for md in ["- item\n  ```ts\n  let x", "> ```\n> code"] {
            let chunk = ReplyMarkdown.chunks(md).last!
            #expect(chunk.isOpen)
            let r = ReplyMarkdown.renderChunk(chunk, root: nil, style: ReplyMarkdown.noStyle)
            func hasOpen(_ b: AnswerBlock) -> Bool {
                switch b {
                case .code(let c): c.isOpen
                case .quote(let bs): bs.contains(where: hasOpen)
                case .list(let l): l.items.flatMap(\.content).contains(where: hasOpen)
                default: false
                }
            }
            #expect(r.blocks.contains(where: hasOpen), "\(md)")
        }
    }

    @Test func mathClosersAgreeBetweenChunksAndPreprocess() {
        // `\[` closes on `\]` only: a `$$` line inside stays math content, and the chunk ends at `\]`.
        #expect(ReplyMarkdown.chunks("\\[\n$$\nx\n\\]\n\nAfter").map(\.text) == ["\\[\n$$\nx\n\\]", "After"])
        #expect(d("\\[\n$$\nx\n\\]\n\nAfter") == ["math:$$\nx", "p:After"])
    }

    @Test func aPathOnlyInfoStringGivesTheReferenceWithoutALanguage() {
        guard case .code(let c) = ReplyMarkdown.blocks("```src/a.ts:12\nx\n```", root: "/r").first else { Issue.record(); return }
        #expect(c.language == nil)
        #expect(c.reference == FileReference(path: "/r/src/a.ts", line: 12))
    }

    @Test func absurdNestingIsBoundedBeforeParsing() {
        var list = ""
        for i in 0..<1000 { list += String(repeating: "  ", count: i) + "- item\n" }
        let inputs = [String(repeating: "> ", count: 5000) + "deep text", list + "- bottom",
                      String(repeating: "- ", count: 5000) + "inline deep"]
        for md in inputs {
            let start = ContinuousClock.now
            let blocks = ReplyMarkdown.blocks(md, root: nil)
            let took = ContinuousClock.now - start
            #expect(took < .milliseconds(400), "\(took) for \(md.prefix(6))")
            let text = ReplyMarkdown.plainText(blocks)
            #expect(text.contains("deep text") || text.contains("bottom") || text.contains("inline deep"))
        }
    }

    @Test func normalNestingIsUnchangedByTheGuard() {
        let md = "> a\n> > b\n\n1. x\n   - y\n     - z\n10) w"
        #expect(ReplyMarkdown.bound("   - y") == "   - y")
        #expect(ReplyMarkdown.bound("> > b") == "> > b")
        #expect(ReplyMarkdown.bound("10) w") == "10) w")
        #expect(d(md) == ["q[p:a q[p:b]]", "ol[1. p:x ul[◦ p:y ul[▪ p:z]]]", "ol[10. p:w]"], "\(d(md))")
    }
}

@Suite struct CodePreviewTests {
    @Test func longCodeShowsTheFirst24Lines() {
        let text = (1...41).map { "line \($0)" }.joined(separator: "\n")
        let m = CodeModel(language: nil, text: text, isOpen: false, lineCount: 41, reference: nil)
        let p = m.preview()
        #expect(p?.hiddenLines == 17)
        #expect(p?.text == (1...24).map { "line \($0)" }.joined(separator: "\n"))
        #expect(CodeModel(language: nil, text: "a", isOpen: false, lineCount: 40, reference: nil).preview() == nil)
    }
}

@Suite struct CodeBlockLogicTests {
    @Test func veryLongLineThresholdIsPerLine() {
        func m(_ t: String) -> CodeModel { CodeModel(language: nil, text: t, isOpen: false, lineCount: 1, reference: nil) }
        let limit = CodeModel.veryLongLine
        #expect(!m(String(repeating: "a", count: limit)).hasVeryLongLine)
        #expect(m(String(repeating: "a", count: limit + 1)).hasVeryLongLine)
        // Many short lines adding up past the limit are fine; one long line among them is not.
        #expect(!m(Array(repeating: String(repeating: "a", count: 100), count: 50).joined(separator: "\n")).hasVeryLongLine)
        #expect(m("x\n" + String(repeating: "a", count: limit + 1) + "\ny").hasVeryLongLine)
    }

    @Test func relativePathsUseWholeComponents() {
        #expect(FileDisplay.relative("/a/b/src/x.ts", root: "/a/b") == "src/x.ts")
        #expect(FileDisplay.relative("/a/b/src/x.ts", root: "/a/b/") == "src/x.ts")
        #expect(FileDisplay.relative("/a/bc/x.ts", root: "/a/b") == "x.ts")
        #expect(FileDisplay.relative("/a/b", root: "/a/b") == "b")
        #expect(FileDisplay.relative("/other/y.ts", root: "/a/b") == "y.ts")
        #expect(FileDisplay.relative("/a/b/x.ts", root: nil) == "x.ts")
    }

    @Test func highlightKeyTracksOpenState() {
        // The same text closing (fence arrives without new text) must still change the key.
        #expect(HighlightKey(text: "a", isOpen: true) != HighlightKey(text: "a", isOpen: false))
    }
}

@Suite struct BoundedCacheTests {
    @Test func evictsLeastRecentlyUsed() {
        var c = BoundedCache<String, Int>(capacity: 2)
        c.insert(1, for: "a"); c.insert(2, for: "b")
        _ = c.value(for: "a")           // a is now the most recent
        c.insert(3, for: "c")           // evicts b
        #expect(c.value(for: "b") == nil)
        #expect(c.value(for: "a") == 1 && c.value(for: "c") == 3)
        c.insert(9, for: "a")
        #expect(c.count == 2 && c.value(for: "a") == 9)
    }

    @Test func previewHandlesCRLF() {
        let text = (1...45).map { "l\($0)" }.joined(separator: "\r\n")
        let m = CodeModel(language: nil, text: text, isOpen: false, lineCount: 45, reference: nil)
        #expect(m.preview()?.hiddenLines == 21)
    }
}
