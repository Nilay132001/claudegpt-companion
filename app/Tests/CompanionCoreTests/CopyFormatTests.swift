import Foundation
import Testing
@testable import CompanionCore

@Suite struct CopyFormatTests {
    private func msg(_ role: ChatMessage.Role, _ text: String, turn: String? = nil) -> ChatMessage {
        ChatMessage(id: UUID(), role: role, text: text, status: .done, threadId: nil, turnId: turn)
    }

    @Test func markdownIsTheRawText() {
        #expect(CopyFormat.markdown(msg(.assistant, "**hi** `x`")) == "**hi** `x`")
    }

    @Test func plainStripsMarkdownButKeepsCode() {
        let md = "# Title\n\nSome **bold** and `x` text.\n\n- one\n- two\n\n2. step\n\n> quoted\n\n```swift\nlet a = **1**\n```"
        let out = CopyFormat.plain(msg(.assistant, md))
        #expect(out == "Title\n\nSome bold and x text.\n\n• one\n\n• two\n\n2. step\n\nquoted\n\nlet a = **1**")
        #expect(!out.contains("```"))
    }

    @Test func plainKeepsUserTextAndLinkText() {
        #expect(CopyFormat.plain(msg(.user, "**raw** # x")) == "**raw** # x")
        #expect(ReplyMarkdown.plainText("see [docs](https://example.com/a) and Foo.swift:12") == "see docs (https://example.com/a) and Foo.swift:12")
    }

    @Test func conversationWithoutContext() {
        let m = [msg(.user, "Why?"), msg(.assistant, "Because **x**.", turn: "t1")]
        let out = CopyFormat.conversation(m, contexts: ["t1": "ctx"], title: "Demo", includeContext: false)
        #expect(out == "# GPT chat — Demo\n\n## You\nWhy?\n\n## GPT\nBecause **x**.\n")
    }

    @Test func conversationWithContextUsesLongerFenceWhenNeeded() {
        let m = [msg(.user, "Why?"), msg(.assistant, "A", turn: "t1")]
        let out = CopyFormat.conversation(m, contexts: ["t1": "line\n```\ncode\n```"], itemCounts: ["t1": 3], title: nil, includeContext: true)
        #expect(out.hasPrefix("# GPT chat\n\n## You\nWhy?\n\n<details><summary>Context sent (3 items)</summary>\n\n````text\nline\n```\ncode\n```\n````\n</details>\n\n## GPT\nA\n"))
    }

    @Test func conversationContextSummaryWithoutCount() {
        let m = [msg(.user, "Q"), msg(.assistant, "A", turn: "t")]
        let out = CopyFormat.conversation(m, contexts: ["t": "c"], title: "T", includeContext: true)
        #expect(out.contains("<summary>Context sent</summary>\n\n```text\nc\n```\n</details>"))
    }

    @Test func conversationSkipsContextWhenMissing() {
        let m = [msg(.user, "Q"), msg(.assistant, "A", turn: "zz")]
        let out = CopyFormat.conversation(m, contexts: [:], title: "T", includeContext: true)
        #expect(!out.contains("<details>"))
    }
}
