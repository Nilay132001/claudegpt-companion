import Foundation

public enum ReplyBlock: Equatable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case bullet(String)
    case numbered(marker: String, text: String)
    case quote(String)
    case code(language: String?, text: String)
}

/// What a piece of a prose run is, so the view can style it (fonts live in the app, not here).
public enum ProseRole: Equatable, Sendable { case paragraph, heading(level: Int), bullet, numbered, quote, gap }

/// A reply split for display: consecutive non-code blocks become ONE attributed string (one selectable Text),
/// so a selection can cross paragraphs, headings and list items.
public enum ReplySegment: Equatable, Sendable {
    case prose(AttributedString)
    case code(language: String?, text: String)
}

/// The only place GPT reply text is parsed as Markdown (SourceRulesTests enforces it).
public enum ReplyMarkdown {
    /// Splits a reply into prose runs and code blocks. `style` is called once per piece (and per gap between
    /// blocks) so the caller can set fonts and colours; list items in a row are joined by one newline, other blocks
    /// by a `.gap` piece ("\n\n") the caller can make shorter than a full line.
    public static func segments(_ markdown: String, root: String?,
                                style: (ProseRole, inout AttributedString) -> Void = { _, _ in }) -> [ReplySegment] {
        var out: [ReplySegment] = []
        var run: AttributedString?
        var lastWasList = false
        func flush() {
            if let r = run { out.append(.prose(r)) }
            run = nil
            lastWasList = false
        }
        for block in blocks(markdown) {
            let role: ProseRole
            var piece: AttributedString
            switch block {
            case .code(let lang, let text):
                flush()
                out.append(.code(language: lang, text: text))
                continue
            case .paragraph(let t): role = .paragraph; piece = inline(t, root: root)
            case .heading(let level, let t): role = .heading(level: level); piece = inline(t, root: root)
            case .bullet(let t): role = .bullet; piece = AttributedString("•  ") + inline(t, root: root)
            case .numbered(let marker, let t): role = .numbered; piece = AttributedString(marker + "  ") + inline(t, root: root)
            case .quote(let t): role = .quote; piece = inline(t, root: root)
            }
            style(role, &piece)
            let isList = role == .bullet || role == .numbered
            if var r = run {
                if isList && lastWasList {
                    r.append(AttributedString("\n"))
                } else {
                    var gap = AttributedString("\n\n")
                    style(.gap, &gap)
                    r.append(gap)
                }
                r.append(piece)
                run = r
            } else {
                run = piece
            }
            lastWasList = isList
        }
        flush()
        return out
    }

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

    /// The reply as plain text: headings, bullets and quotes flattened, inline marks removed, code verbatim.
    public static func plainText(_ markdown: String) -> String {
        func flat(_ s: String) -> String { String(inline(s, root: nil).characters) }
        return blocks(markdown).map { block -> String in
            switch block {
            case .paragraph(let t), .quote(let t): flat(t)
            case .heading(_, let t): flat(t)
            case .bullet(let t): "• " + flat(t)
            case .numbered(let marker, let t): marker + " " + flat(t)
            case .code(_, let t): t
            }
        }.joined(separator: "\n\n")
    }
}

public struct MarkdownChunk: Hashable, Sendable {
    public let text: String
    /// Ends inside a fence that is not closed yet (only the last chunk can).
    public let isOpen: Bool
    public init(text: String, isOpen: Bool) { self.text = text; self.isOpen = isOpen }
}

extension ReplyMarkdown {
    public typealias Styler = @Sendable (ProseRole, inout AttributedString) -> Void
    public static let noStyle: Styler = { _, _ in }

    /// Splits an answer into chunks at blank lines followed by an unindented line, never inside a fence and never
    /// between items of one list. Earlier chunks do not change as the text grows, so they are parsed once.
    public static func chunks(_ markdown: String) -> [MarkdownChunk] {
        var out: [MarkdownChunk] = []
        var lines: [Substring] = []
        var fence: Substring?        // the opening marker, "```" or "~~~" (or longer)
        var sawBlank = false
        var inList = false
        func flush() {
            let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { out.append(MarkdownChunk(text: text, isOpen: false)) }
            lines = []
        }
        for line in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.drop { $0 == " " || $0 == "\t" }
            if let f = fence {
                lines.append(line)
                if trimmed.hasPrefix(f), trimmed.drop(while: { $0 == f.first }).allSatisfy(\.isWhitespace) { fence = nil }
                continue
            }
            if trimmed.isEmpty { sawBlank = true; lines.append(line); continue }
            let indented = trimmed.count != line.count
            let listItem = !indented && line.firstMatch(of: /^([-*+]|\d{1,9}[.)])(\s|$)/) != nil
            if sawBlank && !indented && !(inList && listItem) { flush() }
            sawBlank = false
            if !indented { inList = listItem }
            if let m = trimmed.firstMatch(of: /^(`{3,}|~{3,})/) { fence = m.1 }
            lines.append(line)
        }
        let open = fence != nil
        flush()
        if open, let last = out.popLast() { out.append(MarkdownChunk(text: last.text, isOpen: true)) }
        return out
    }

    /// Task 3: M8's block parser per chunk. Task 5 replaces the body with the full-syntax parser.
    public static func renderChunk(_ chunk: MarkdownChunk, root: String?, style: Styler) -> RenderedChunk {
        let segments = segments(chunk.text, root: root, style: style)
        let blocks: [AnswerBlock] = segments.enumerated().map { i, s in
            switch s {
            case .prose(let a): .paragraphs(a)
            case .code(let lang, let text): .code(language: lang, text: text, isOpen: chunk.isOpen && i == segments.count - 1)
            }
        }
        return RenderedChunk(blocks: blocks, plainText: plainText(chunk.text), cost: chunk.text.utf8.count * 4 + 256)
    }

    /// Joins rendered chunks; adjacent `.paragraphs` blocks become one run, so a selection crosses them (P1).
    public static func assemble(_ chunks: [RenderedChunk], style: Styler) -> RenderedAnswer {
        var blocks: [RenderedBlock] = []
        for (c, chunk) in chunks.enumerated() {
            for (i, block) in chunk.blocks.enumerated() {
                if case .paragraphs(let next) = block, let last = blocks.last, case .paragraphs(var run) = last.block {
                    var gap = AttributedString("\n\n")
                    style(.gap, &gap)
                    run.append(gap)
                    run.append(next)
                    blocks[blocks.count - 1] = RenderedBlock(id: last.id, block: .paragraphs(run))
                } else {
                    blocks.append(RenderedBlock(id: BlockID(chunk: c, index: i), block: block))
                }
            }
        }
        return RenderedAnswer(blocks: blocks, plainText: chunks.map(\.plainText).filter { !$0.isEmpty }.joined(separator: "\n\n"))
    }

    /// Uncached render of a whole answer (tests, Copy, speech).
    public static func render(_ markdown: String, root: String?, style: Styler = noStyle) -> RenderedAnswer {
        assemble(chunks(markdown).map { renderChunk($0, root: root, style: style) }, style: style)
    }
}
