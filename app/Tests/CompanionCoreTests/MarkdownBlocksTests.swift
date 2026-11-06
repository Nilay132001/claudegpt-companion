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
}
