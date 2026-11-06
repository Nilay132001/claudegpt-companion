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
    /// Markdown to sentences with pauses: a short one between sentences, a longer one after a paragraph,
    /// list item or heading.
    public static func segments(fromMarkdown markdown: String, readCode: Bool = false) -> [SpeechSegment] {
        var out: [SpeechSegment] = []
        var paragraph: [String] = []
        var inFence = false
        var fenced: [String] = []

        func emit(_ sentences: [String]) {
            let s = sentences.filter { !$0.isEmpty }
            for (i, t) in s.enumerated() { out.append(SpeechSegment(t, pause: i == s.count - 1 ? .paragraph : .sentence)) }
        }
        func flush() {
            if !paragraph.isEmpty { emit(sentences(in: inline(paragraph.joined(separator: " ")))) }
            paragraph = []
        }
        func closeFence() {
            if readCode {
                emit(fenced.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
            } else {
                emit(["Code block omitted."])
            }
            fenced = []
        }

        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if inFence { closeFence() } else { flush() }
                inFence.toggle()
                continue
            }
            if inFence { fenced.append(raw); continue }
            if line.isEmpty { flush(); continue }
            if line.range(of: #"^\|?\s*:?-{3,}"#, options: .regularExpression) != nil { continue }
            if isStructural(line) {
                flush()
                emit(sentences(in: inline(block(line))))
            } else {
                paragraph.append(line)
            }
        }
        if inFence { closeFence() }
        flush()
        return out
    }

    /// The old flat form: sentences joined by spaces, paragraphs by newlines.
    public static func plainText(fromMarkdown markdown: String, readCode: Bool = false) -> String {
        var s = ""
        for seg in segments(fromMarkdown: markdown, readCode: readCode) {
            s += seg.text
            s += seg.pause == .paragraph ? "\n" : " "
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Heading, quote, list item or table row: stands alone instead of joining the paragraph.
    static func isStructural(_ line: String) -> Bool {
        line.range(of: #"^(#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)"#, options: .regularExpression) != nil
    }

    static func block(_ line: String) -> String {
        if line.hasPrefix("|") {
            return line.split(separator: "|")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
        }
        return line.replacingOccurrences(
            of: #"^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
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
