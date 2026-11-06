import Foundation

/// Text forms of chat messages for the clipboard.
public enum CopyFormat {
    /// The raw text as written.
    public static func markdown(_ message: ChatMessage) -> String { message.text }

    /// User text unchanged; GPT replies flattened to plain text.
    public static func plain(_ message: ChatMessage) -> String {
        message.role == .user ? message.text : ReplyMarkdown.plainText(message.text)
    }

    /// The whole chat as Markdown. `contexts` maps a turnId to the exact context block sent with that turn;
    /// a question's context is the one of the assistant message right after it. `itemCounts` (turnId to item count)
    /// fills the "(N items)" in the summary; without it the summary has no count.
    public static func conversation(_ messages: [ChatMessage], contexts: [String: String], itemCounts: [String: Int] = [:], title: String?, includeContext: Bool) -> String {
        var out = "# GPT chat"
        if let title, !title.isEmpty { out += " — \(title)" }
        out += "\n"
        for (i, m) in messages.enumerated() {
            switch m.role {
            case .user:
                out += "\n## You\n\(m.text)\n"
                if includeContext, i + 1 < messages.count, messages[i + 1].role == .assistant,
                   let turn = messages[i + 1].turnId, let block = contexts[turn] {
                    let fence = fenceFor(block)
                    let label = itemCounts[turn].map { "Context sent (\($0) items)" } ?? "Context sent"
                    out += "\n<details><summary>\(label)</summary>\n\n\(fence)text\n\(block)\n\(fence)\n</details>\n"
                }
            case .assistant:
                out += "\n## GPT\n\(m.text)\n"
            }
        }
        return out
    }

    /// A backtick fence longer than any run of backticks inside the block (at least three).
    private static func fenceFor(_ block: String) -> String {
        var longest = 0, run = 0
        for c in block {
            if c == "`" { run += 1; longest = max(longest, run) } else { run = 0 }
        }
        return String(repeating: "`", count: max(3, longest + 1))
    }
}
