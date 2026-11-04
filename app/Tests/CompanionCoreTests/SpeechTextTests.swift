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
    @Test func flattensTables() {
        #expect(SpeechText.plainText(fromMarkdown: "| a | b |\n|---|---|\n| 1 | 2 |") == "a, b\n1, 2")
    }
}
