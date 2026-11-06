import Testing
@testable import CompanionCore

@Suite struct SpeechTextTests {
    @Test func stripsHeadingsAndEmphasis() {
        #expect(SpeechText.plainText(fromMarkdown: "# Title\nThis is **bold** and *it*.") == "Title\nThis is bold and it.")
    }
    @Test func omitsFencedCode() {
        #expect(SpeechText.plainText(fromMarkdown: "Before\n```python\nprint(1)\n```\nAfter") == "Before\nCode block omitted.\nAfter")
    }
    @Test func readsCodeWhenAsked() {
        #expect(SpeechText.plainText(fromMarkdown: "Before\n```\nprint(1)\n```\nAfter", readCode: true) == "Before\nprint(1)\nAfter")
    }
    @Test func unterminatedFenceIsOmitted() {
        #expect(SpeechText.plainText(fromMarkdown: "Look\n```\nx = 1") == "Look\nCode block omitted.")
    }
    @Test func keepsLinkTextAndDropsImages() {
        #expect(SpeechText.plainText(fromMarkdown: "See [docs](https://example.com) ![img](a.png)") == "See docs")
    }
    @Test func unwrapsInlineCode() {
        #expect(SpeechText.plainText(fromMarkdown: "Run `npm test` now") == "Run npm test now")
    }
    @Test func stripsListAndQuoteMarkers() {
        #expect(SpeechText.plainText(fromMarkdown: "- one\n2. two\n> quoted") == "one\ntwo\nquoted")
    }
    @Test func keepsSnakeCase() {
        #expect(SpeechText.plainText(fromMarkdown: "use file_name_here") == "use file_name_here")
    }

    private func texts(_ md: String, readCode: Bool = false) -> [String] { SpeechText.segments(fromMarkdown: md, readCode: readCode).map(\.text) }

    @Test func splitsSentencesButNotAbbreviationsVersionsOrFileNames() {
        #expect(texts("It works. Does it? Yes! Fine.") == ["It works.", "Does it?", "Yes!", "Fine."])
        #expect(texts("Use a tool, e.g. grep, here. Next.") == ["Use a tool, e.g. grep, here.", "Next."])
        #expect(texts("Upgrade to 1.2.3 now. Edit parser.ts too.") == ["Upgrade to 1.2.3 now.", "Edit parser.ts too."])
    }
    @Test func pausesAfterSentencesAndParagraphs() {
        let segs = SpeechText.segments(fromMarkdown: "One. Two.\n\nThree.")
        #expect(segs.map(\.pause) == [.sentence, .paragraph, .paragraph])
        #expect(SpeechSegment.Pause.sentence.seconds == 0.12)
        #expect(SpeechSegment.Pause.paragraph.seconds == 0.45)
    }
    @Test func wrappedLinesStayOneParagraph() {
        #expect(texts("A sentence that\nwraps here. Next.") == ["A sentence that wraps here.", "Next."])
    }
    @Test func listItemsAndHeadingsEachEndWithAParagraphPause() {
        let segs = SpeechText.segments(fromMarkdown: "## Plan\n- First step. Then more.\n2. Second")
        #expect(segs.map(\.text) == ["Plan", "First step.", "Then more.", "Second"])
        #expect(segs.map(\.pause) == [.paragraph, .sentence, .paragraph, .paragraph])
    }
    @Test func urlsBecomeLinkAndLinkTextIsRead() {
        #expect(texts("See https://example.com/a-b for details.") == ["See link for details."])
        #expect(texts("Read [the docs](https://example.com/x).") == ["Read the docs."])
        #expect(texts("Go to <https://example.com>.") == ["Go to link."])
    }
    @Test func markdownSymbolsAreNeverRead() {
        #expect(texts("a *star* and ~~gone~~ and `tick` and a_b and _lone") == ["a star and gone and tick and a_b and lone"])
    }
    @Test func codeBlockOmittedOrReadLineByLine() {
        #expect(texts("Before.\n\n```ts\nlet a = 1\nlet b = 2\n```") == ["Before.", "Code block omitted."])
        #expect(texts("```ts\nlet a = 1\nlet b = 2\n```", readCode: true) == ["let a = 1", "let b = 2"])
    }
    @Test func flattensTables() {
        #expect(texts("| a | b |\n|---|---|\n| 1 | 2 |") == ["A table with 1 row.", "1: 2."])
    }
    @Test func longTablesAreSummarised() {
        let rows = (1...7).map { "| r\($0) | \($0) |" }.joined(separator: "\n")
        #expect(texts("| k | v |\n|---|---|\n" + rows) == ["A table with 7 rows is shown on screen."])
    }
    @Test func chartsReadTheirSummary() {
        #expect(texts("```companion-chart\n\(ChartSpecTests.valid)\n```")
                == ["Bar chart, Test runtime by package: parser 4.2 seconds, csv 1.9 seconds."])
        #expect(texts("```companion-chart\n{}\n```") == ["Chart not shown."])
    }
    @Test func taskItemsSayDoneOrToDo() {
        #expect(texts("- [x] Ship it\n- [ ] Test it") == ["Done: Ship it", "To do: Test it"])
    }
    @Test func mathAndRulesAreNotSpelledOut() {
        #expect(texts("Before.\n\n---\n\n$$\na+b\n$$") == ["Before.", "A formula is shown on screen."])
    }
    @Test func noMarkdownPipesOrJSONAreSpoken() {
        let md = "## H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```companion-chart\n\(ChartSpecTests.valid)\n```"
        for t in texts(md) { #expect(!t.contains("|") && !t.contains("{") && !t.contains("#")) }
    }
    @Test func plainTextJoinsSegments() {
        #expect(SpeechText.plainText(fromMarkdown: "One. Two.\n\nThree.") == "One. Two.\nThree.")
    }
}
