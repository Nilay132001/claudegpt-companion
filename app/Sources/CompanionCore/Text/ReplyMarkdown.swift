import Foundation

public enum ReplyBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet(String)
    case numbered(marker: String, text: String)
    case quote(String)
    case code(language: String?, text: String)
}

/// The only place GPT reply text is parsed as Markdown (SourceRulesTests enforces it).
public enum ReplyMarkdown {
    public static func blocks(_ markdown: String) -> [ReplyBlock] {
        var out: [ReplyBlock] = []
        var para: [String] = []
        var fence: (lang: String?, lines: [String])?
        func flush() {
            if !para.isEmpty { out.append(.paragraph(para.joined(separator: "\n"))); para = [] }
        }
        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let isFence = line.hasPrefix("```") || line.hasPrefix("~~~")
            if var f = fence {
                if isFence {
                    out.append(.code(language: f.lang, text: f.lines.joined(separator: "\n")))
                    fence = nil
                } else {
                    f.lines.append(raw)
                    fence = f
                }
                continue
            }
            if isFence {
                flush()
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                fence = (lang.isEmpty ? nil : lang, [])
                continue
            }
            if line.isEmpty { flush(); continue }
            if let m = line.firstMatch(of: /^(#{1,6})\s+(.*)$/) { flush(); out.append(.heading(level: m.1.count, text: String(m.2))); continue }
            if let m = line.firstMatch(of: /^[-*+]\s+(.*)$/) { flush(); out.append(.bullet(String(m.1))); continue }
            if let m = line.firstMatch(of: /^(\d{1,3}[.)])\s+(.*)$/) { flush(); out.append(.numbered(marker: String(m.1), text: String(m.2))); continue }
            if let m = line.firstMatch(of: /^>\s?(.*)$/) { flush(); out.append(.quote(String(m.1))); continue }
            para.append(line)
        }
        flush()
        if let f = fence { out.append(.code(language: f.lang, text: f.lines.joined(separator: "\n"))) }
        return out
    }

    /// Inline Markdown (emphasis, code spans) with every link and image removed, then `path:line` links added.
    public static func inline(_ text: String, root: String?) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        var out = AttributedString()
        // A link may span several runs (e.g. [**a** b](u)); its URL is shown once, after the last of them.
        var open: (url: URL, text: String)?
        func closeLink() {
            if let o = open, o.url.absoluteString != o.text { out.append(AttributedString(" (\(o.url.absoluteString))")) }
            open = nil
        }
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            let target = run.link
            if open != nil && open?.url != target { closeLink() }
            piece.link = nil
            piece.imageURL = nil
            out.append(piece)
            if let target { open = (target, (open?.text ?? "") + String(piece.characters)) }
        }
        closeLink()
        let plain = String(out.characters)
        for m in FileReferences.find(in: plain, root: root) {
            let lo = plain.distance(from: plain.startIndex, to: m.range.lowerBound)
            let len = plain.distance(from: m.range.lowerBound, to: m.range.upperBound)
            let start = out.characters.index(out.startIndex, offsetBy: lo)
            let end = out.characters.index(start, offsetBy: len)
            out[start..<end].link = EditorLink.companionURL(m.reference)
        }
        return out
    }
}
