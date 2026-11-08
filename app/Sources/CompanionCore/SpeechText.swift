import Foundation

/// One sentence to speak and the silence that follows it.
public struct SpeechSegment: Equatable, Sendable {
    public enum Pause: Equatable, Sendable {
        case sentence, paragraph
        public var seconds: TimeInterval { self == .sentence ? 0.12 : 0.45 }
    }
    public var text: String
    public var pause: Pause
    public init(_ text: String, pause: Pause = .sentence) {
        self.text = text
        self.pause = pause
    }
}

public enum SpeechText {
    /// The old flat form: sentences joined by spaces, paragraphs by newlines.
    public static func plainText(fromMarkdown markdown: String, readCode: Bool = false) -> String {
        var s = ""
        for seg in segments(fromMarkdown: markdown, readCode: readCode) {
            s += seg.text
            s += seg.pause == .paragraph ? "\n" : " "
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func inline(_ text: String) -> String {
        var t = text
        t = t.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(\*\*|__|~~|\*)(\S(?:.*?\S)?)\1"#, with: "$2", options: .regularExpression)
        // A bare address is never read out; the trailing sentence punctuation stays.
        t = t.replacingOccurrences(of: #"<?https?://[^\s<>)\]]*[^\s<>)\].,;:!?'"]>?"#, with: "link", options: .regularExpression)
        // Markdown symbols left over (unpaired emphasis, strikethrough, stray ticks and pipes) are never read.
        t = t.replacingOccurrences(of: #"[*`|]|~~"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// Text that came from the parser: its Markdown is already gone, so a literal `*`, `|`, backtick or edge `_` (an
    /// escaped `\*`, `a | b`, `__init__`) is the answer's own text and is read. Only a bare address becomes "link".
    static func parsed(_ text: String) -> String {
        var t = text
        t = t.replacingOccurrences(of: #"<?https?://[^\s<>)\]]*[^\s<>)\].,;:!?'"]>?"#, with: "link", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }

    private static let abbreviations: Set<String> = ["e.g.", "i.e.", "etc.", "vs.", "mr.", "mrs.", "ms.", "dr.", "no.", "approx.", "cf.", "fig."]

    /// Splits on . ! ? followed by whitespace, not after an abbreviation. "1.2.3" and "parser.ts" have no space after the dot.
    static func sentences(in text: String) -> [String] {
        let chars = Array(text)
        var result: [String] = []
        var start = 0
        var i = 0
        while i < chars.count {
            if ".!?".contains(chars[i]) {
                var end = i + 1
                while end < chars.count, "\"')]”’".contains(chars[end]) { end += 1 }
                if end >= chars.count || chars[end].isWhitespace {
                    let word = String(chars[start..<end]).split(whereSeparator: \.isWhitespace).last.map { String($0).lowercased() } ?? ""
                    if chars[i] != "." || !abbreviations.contains(word) {
                        result.append(String(chars[start..<end]).trimmingCharacters(in: .whitespaces))
                        start = end
                    }
                }
                i = end
            } else {
                i += 1
            }
        }
        if start < chars.count { result.append(String(chars[start...]).trimmingCharacters(in: .whitespaces)) }
        return result.filter { !$0.isEmpty }
    }
}

extension SpeechText {
    /// Markdown to sentences with pauses: rendered by `ReplyMarkdown` (the only parser), then spoken by block.
    public static func segments(fromMarkdown markdown: String, readCode: Bool = false) -> [SpeechSegment] {
        segments(for: ReplyMarkdown.render(markdown, root: nil), readCode: readCode)
    }

    /// An answer's blocks as sentences: a short pause between sentences, a longer one after a paragraph, heading,
    /// list item, table row or chart. No Markdown marker, table pipe or chart JSON is ever spoken; code only when asked.
    public static func segments(for answer: RenderedAnswer, readCode: Bool) -> [SpeechSegment] {
        var out: [SpeechSegment] = []
        func emit(_ sentences: [String]) {
            let s = sentences.filter { !$0.isEmpty }
            for (i, t) in s.enumerated() { out.append(SpeechSegment(t, pause: i == s.count - 1 ? .paragraph : .sentence)) }
        }
        func spoken(_ s: AttributedString) -> String {
            s.runs.filter { $0[AnswerAttributes.SpeechSkip.self] != true }.map { String(s[$0.range].characters) }.joined()
        }
        func walk(_ blocks: [AnswerBlock], prefix: String = "") {
            var prefix = prefix
            for b in blocks {
                switch b {
                case .paragraphs(let s):
                    for para in spoken(s).components(separatedBy: "\n\n") {
                        emit(sentences(in: prefix + parsed(para.replacingOccurrences(of: "\n", with: " "))))
                        prefix = ""
                    }
                case .heading(_, let s): emit(sentences(in: parsed(spoken(s))))
                case .list(let l):
                    for item in l.items { walk(item.content, prefix: item.check.map { $0 == .done ? "Done: " : "To do: " } ?? "") }
                case .quote(let bs): walk(bs)
                case .code(let c):
                    emit(readCode ? c.text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) } : ["Code block omitted."])
                case .table(let t):
                    let n = t.rows.count
                    emit(n <= 6 ? ["A table with \(n) row\(n == 1 ? "" : "s")."] : ["A table with \(n) rows is shown on screen."])
                    if n <= 6 { for r in t.spokenRows { emit([parsed(r)]) } }
                case .rule: break
                case .math: emit(["A formula is shown on screen."])
                case .chart(.valid(let s)): emit([s.spokenSummary])
                case .chart(.invalid): emit(["Chart not shown."])
                }
            }
        }
        walk(answer.blocks.map(\.block))
        return out
    }
}
