import Foundation
import Testing
@testable import CompanionCore

@Suite struct ReplyMarkdownTests {
    @Test func splitsBlocks() {
        let md = "# Title\nFirst line\nsecond line\n\n- one\n2. two\n> quoted\n```swift\nlet x = 1\n```\nafter\n```\nunterminated"
        #expect(ReplyMarkdown.blocks(md) == [
            .heading(level: 1, text: "Title"), .paragraph("First line\nsecond line"), .bullet("one"),
            .numbered(marker: "2.", text: "two"), .quote("quoted"), .code(language: "swift", text: "let x = 1"),
            .paragraph("after"), .code(language: nil, text: "unterminated"),
        ])
    }

    @Test func removesLinksAndImagesAndShowsTheTarget() {
        let s = ReplyMarkdown.inline("Read [the docs](https://evil.example/x) ![pixel](https://evil.example/p.png) now", root: nil)
        #expect(String(s.characters) == "Read the docs (https://evil.example/x) pixel now")
        #expect(s.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    }

    @Test func aStyledLinkShowsItsURLOnce() {
        let s = ReplyMarkdown.inline("[**a** b](https://evil.example/u) end", root: nil)
        #expect(String(s.characters) == "a b (https://evil.example/u) end")
    }

    @Test func autolinksAreTextToo() {
        let s = ReplyMarkdown.inline("<https://evil.example/a>", root: "/r")
        #expect(s.runs.allSatisfy { $0.link == nil })
    }

    @Test func linksOnlyFileReferencesInsideTheRoot() {
        let s = ReplyMarkdown.inline("Look at `src/a.ts:3` and /etc/passwd.txt:1", root: "/r")
        let links = s.runs.compactMap { run -> (String, URL)? in run.link.map { (String(s[run.range].characters), $0) } }
        #expect(links.count == 1)
        #expect(links.first?.0 == "src/a.ts:3")
        #expect(links.first.flatMap { EditorLink.parseCompanionURL($0.1) } == FileReference(path: "/r/src/a.ts", line: 3))
    }

    @Test func keepsEmphasisAndCodeText() {
        #expect(String(ReplyMarkdown.inline("**bold** and `code`", root: nil).characters) == "bold and code")
    }
}
