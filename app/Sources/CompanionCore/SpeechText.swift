import Foundation

public enum SpeechText {
    public static func plainText(fromMarkdown markdown: String, readCode: Bool = false) -> String {
        var out: [String] = []
        var inFence = false
        var fenced: [String] = []

        func closeFence() {
            out.append(readCode ? fenced.joined(separator: "\n") : "Code block omitted.")
            fenced = []
        }

        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if inFence { closeFence() }
                inFence.toggle()
                continue
            }
            if inFence { fenced.append(raw); continue }
            if line.range(of: #"^\|?\s*:?-{3,}"#, options: .regularExpression) != nil { continue }
            out.append(inline(block(line)))
        }
        if inFence { closeFence() }
        return out.filter { !$0.isEmpty }.joined(separator: "\n")
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
        return t.trimmingCharacters(in: .whitespaces)
    }
}
