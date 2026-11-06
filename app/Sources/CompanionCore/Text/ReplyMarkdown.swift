import Foundation

/// What a piece of an answer is, so the app can style it (fonts live in the app, not here).
public enum ProseRole: Equatable, Sendable { case paragraph, heading(level: Int), listItem, quote, tableCell, gap }

/// The only place GPT reply text is parsed as Markdown (SourceRulesTests enforces it).
public enum ReplyMarkdown {
    /// Inline Markdown (emphasis, code spans) with every link and image removed, then `path:line` links added.
    public static func inline(_ text: String, root: String?) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        return clean(parsed, root: root)
    }

    /// Removes links and images (their URL is shown once, as text), then links `path:line` inside the root.
    static func clean(_ parsed: AttributedString, root: String?) -> AttributedString {
        var out = AttributedString()
        // A link may span several runs (e.g. [**a** b](u)); its URL is shown once, after the last of them.
        var open: (url: URL, text: String)?
        func closeLink() {
            if let o = open, o.url.absoluteString != o.text {
                var url = AttributedString(" (\(o.url.absoluteString))")
                url[AnswerAttributes.SpeechSkip.self] = true
                out.append(url)
            }
            open = nil
        }
        for run in parsed.runs {
            var piece = AttributedString(parsed[run.range])
            let target = run.link
            if open != nil && open?.url != target { closeLink() }
            if run.imageURL != nil { piece[AnswerAttributes.SpeechSkip.self] = true }
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

    public static func blocks(_ markdown: String, root: String?) -> [AnswerBlock] {
        render(markdown, root: root).blocks.map(\.block)
    }

    public static func plainText(_ markdown: String) -> String { render(markdown, root: nil).plainText }

    public static func plainText(_ blocks: [AnswerBlock]) -> String {
        blocks.map(plain).joined(separator: "\n\n")
    }

    static func plain(_ block: AnswerBlock) -> String {
        switch block {
        case .paragraphs(let s): return String(s.characters)
        case .heading(_, let s): return String(s.characters)
        case .list(let l): return listLines(l, indent: "").joined(separator: "\n")
        case .quote(let bs): return plainText(bs)
        case .code(let c): return c.text
        case .table(let t):
            return ([t.header] + t.rows).map { $0.map { String($0.characters) }.joined(separator: "\t") }.joined(separator: "\n")
        case .rule: return "—"
        case .math(let m): return m
        }
    }

    private static func listLines(_ list: ListModel, indent: String) -> [String] {
        var lines: [String] = []
        for item in list.items {
            let check = item.check.map { $0 == .done ? " [x]" : " [ ]" } ?? ""
            var first = true
            for block in item.content {
                if case .list(let nested) = block {
                    lines += listLines(nested, indent: indent + "  ")
                    first = false
                    continue
                }
                for (n, line) in plain(block).split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
                    if first && n == 0 { lines.append(indent + item.marker + check + " " + line) }
                    else { lines.append(indent + "  " + line) }
                }
                first = false
            }
            if first { lines.append(indent + item.marker + check) }
        }
        return lines
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
        var mathClose: Substring?    // a line that is exactly `$$` or `\[` opens a block closed by `$$` or `\]`
        var sawBlank = false
        var inList = false
        func flush() {
            let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { out.append(MarkdownChunk(text: text, isOpen: false)) }
            lines = []
        }
        // "\r\n" is one Character in Swift, so it never matches "\n": normalise CRLF and lone CR first.
        let markdown = markdown.utf8.contains(13)
            ? markdown.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n") : markdown
        for rawLine in markdown.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = fence == nil && mathClose == nil ? Substring(bound(String(rawLine))) : rawLine   // code is verbatim
            let trimmed = skipping(line, quotes: false)
            // A fence inside a quote starts after its `>` markers.
            let body = skipping(line, quotes: true)
            if let f = fence {
                lines.append(line)
                if body.hasPrefix(f), body.drop(while: { $0 == f.first }).allSatisfy(\.isWhitespace) { fence = nil }
                continue
            }
            if let close = mathClose {
                lines.append(line)
                if trimmed == close { mathClose = nil }
                continue
            }
            if trimmed.isEmpty { sawBlank = true; lines.append(line); continue }
            let indented = trimmed.startIndex != line.startIndex
            let listItem = !indented && line.firstMatch(of: /^([-*+]|\d{1,9}[.)])(\s|$)/) != nil
            if sawBlank && !indented && !(inList && listItem) { flush() }
            sawBlank = false
            if !indented { inList = listItem }
            if let m = body.firstMatch(of: /^(`{3,}|~{3,})/) { fence = m.1 }
            if trimmed == "$$" { mathClose = "$$" } else if trimmed == "\\[" { mathClose = "\\]" }
            lines.append(line)
        }
        let open = fence != nil || mathClose != nil
        flush()
        if open, let last = out.popLast() { out.append(MarkdownChunk(text: last.text, isOpen: true)) }
        return out
    }

        static let full = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: false, interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)

    /// One chunk, parsed once with Foundation's full syntax; the plain text comes from the same blocks.
    public static func renderChunk(_ chunk: MarkdownChunk, root: String?, style: @escaping Styler) -> RenderedChunk {
        let text = preprocess(chunk.text)
        var blocks: [AnswerBlock]
        if let doc = try? AttributedString(markdown: text, options: full) {
            let builder = BlockBuilder(root: root, style: style)
            blocks = builder.build(doc)
            if chunk.isOpen { blocks = markOpen(blocks) }
            blocks = mergeParagraphs(blocks, style: style)
        } else {
            blocks = [.paragraphs(AttributedString(chunk.text))]
        }
        return RenderedChunk(blocks: blocks, plainText: plainText(blocks), cost: chunk.text.utf8.count * 4 + 256)
    }

    /// The unclosed fence is the last code block, however deep it sits (list item, quote).
    static func markOpen(_ blocks: [AnswerBlock]) -> [AnswerBlock] {
        var blocks = blocks
        guard let last = blocks.last else { return blocks }
        switch last {
        case .code(var c): c.isOpen = true; blocks[blocks.count - 1] = .code(c)
        case .quote(let inner): blocks[blocks.count - 1] = .quote(markOpen(inner))
        case .list(var l):
            if var item = l.items.popLast() { item.content = markOpen(item.content); l.items.append(item) }
            blocks[blocks.count - 1] = .list(l)
        default: break
        }
        return blocks
    }

    /// Top-level paragraphs in a row become one run, so a selection crosses them.
    static func mergeParagraphs(_ blocks: [AnswerBlock], style: Styler) -> [AnswerBlock] {
        var out: [AnswerBlock] = []
        for block in blocks {
            if case .paragraphs(let next) = block, let last = out.last, case .paragraphs(var run) = last {
                var gap = AttributedString("\n\n")
                style(.gap, &gap)
                run.append(gap)
                run.append(next)
                out[out.count - 1] = .paragraphs(run)
            } else {
                out.append(block)
            }
        }
        return out
    }

    /// `s` without its leading spaces and tabs (and `>` markers); walks UTF-8 bytes, which is far cheaper than Characters.
    static func skipping(_ s: Substring, quotes: Bool) -> Substring {
        var i = s.utf8.startIndex
        while i < s.utf8.endIndex {
            let b = s.utf8[i]
            guard b == 32 || b == 9 || (quotes && b == 62) else { break }
            i = s.utf8.index(after: i)
        }
        return s[i...]
    }

    /// Linear guard before Foundation parses a line: at most `BlockBuilder.maxNesting` leading `>` markers and
    /// list markers, and no more than 64 characters of indentation in one run, so the structure Foundation sees
    /// is bounded (it is superlinear on deep nesting). Content text is preserved.
    static func bound(_ line: String) -> String {
        let u = Array(line.utf8)
        guard let f = u.first, f == 32 || f == 9 || f == 62 || f == 45 || f == 42 || f == 43 || (48...57).contains(f) else { return line }
        func isWS(_ b: UInt8) -> Bool { b == 32 || b == 9 }
        func isDigit(_ b: UInt8) -> Bool { (48...57).contains(b) }
        var out: [UInt8] = []
        out.reserveCapacity(min(u.count, 256))
        var i = 0
        var quotes = 0, marks = 0
        while i < u.count {
            var j = i
            while j < u.count, isWS(u[j]) { j += 1 }
            let ws = u[i..<min(j, i + 64)]
            guard j < u.count else { out += ws; break }
            let c = u[j]
            if c == 62 {
                quotes += 1
                if quotes <= BlockBuilder.maxNesting { out += ws; out.append(c) }
                i = j + 1
                continue
            }
            var end = j
            if c == 45 || c == 42 || c == 43 { end = j + 1 }
            else if isDigit(c) {
                while end < u.count, isDigit(u[end]), end - j < 9 { end += 1 }
                if end < u.count, u[end] == 46 || u[end] == 41 { end += 1 } else { end = j }
            }
            if end > j, end == u.count || isWS(u[end]) {
                marks += 1
                if marks <= BlockBuilder.maxNesting { out += ws; out += u[j..<end] }
                i = end
                continue
            }
            out += ws
            out += u[j...]
            break
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// Math blocks become a `math` fence; fences are copied as they are; inline `$x$` becomes a code span on lines
    /// without a backtick ("$5 and $10" is not math).
    static func preprocess(_ text: String) -> String {
        var out: [String] = []
        var fence: String?
        var mathIndent: String?
        var mathClose = "$$"
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let t = raw.trimmingCharacters(in: .whitespaces)
            let indent = String(raw.prefix { $0 == " " || $0 == "\t" })
            if let f = fence {
                out.append(raw)
                if t.hasPrefix(f), t.drop(while: { $0 == f.first }).allSatisfy(\.isWhitespace) { fence = nil }
                continue
            }
            if let i = mathIndent {
                if t == mathClose { out.append(i + "```"); mathIndent = nil } else { out.append(raw) }
                continue
            }
            if let m = t.firstMatch(of: /^(`{3,}|~{3,})/) { fence = String(m.1); out.append(raw); continue }
            if t == "$$" || t == "\\[" {
                out.append(indent + "```math"); mathIndent = indent; mathClose = t == "$$" ? "$$" : "\\]"; continue
            }
            if let m = t.firstMatch(of: /^\$\$(.+)\$\$$/) {
                out += [indent + "```math", indent + String(m.1).trimmingCharacters(in: .whitespaces), indent + "```"]
                continue
            }
            let raw = bound(raw)
            out.append(raw.contains("$") && !raw.contains("`")
                ? raw.replacingOccurrences(of: #"(?<![\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?![\w$])"#, with: "`$1`",
                                           options: .regularExpression)
                : raw)
        }
        if let i = mathIndent { out.append(i + "```") }
        return out.joined(separator: "\n")
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
    public static func render(_ markdown: String, root: String?, style: @escaping Styler = noStyle) -> RenderedAnswer {
        assemble(chunks(markdown).map { renderChunk($0, root: root, style: style) }, style: style)
    }
}

/// Turns Foundation's flat runs (each carrying its block path) into `AnswerBlock`s. Foundation lists a run's
/// `components` innermost first; reversed they read outermost first, and consecutive runs are grouped by the
/// identity of their component at each depth.
struct BlockBuilder {
    let root: String?
    let style: ReplyMarkdown.Styler

    struct Piece {
        let path: [PresentationIntent.IntentType]
        let text: AttributedString
    }

    func build(_ doc: AttributedString) -> [AnswerBlock] {
        let pieces = doc.runs.map { run -> Piece in
            var t = AttributedString(doc[run.range])
            t.presentationIntent = nil
            return Piece(path: Array((run.presentationIntent?.components ?? []).reversed()), text: t)
        }
        return build(pieces[...], depth: 0, listDepth: 0, level: 0, role: .paragraph)
    }

    private func groups(_ pieces: ArraySlice<Piece>, depth: Int) -> [(PresentationIntent.IntentType?, ArraySlice<Piece>)] {
        var out: [(PresentationIntent.IntentType?, ArraySlice<Piece>)] = []
        guard var start = pieces.indices.first else { return out }
        for i in pieces.indices.dropFirst() where pieces[i].path[safe: depth]?.identity != pieces[start].path[safe: depth]?.identity {
            out.append((pieces[start].path[safe: depth], pieces[start..<i]))
            start = i
        }
        out.append((pieces[start].path[safe: depth], pieces[start...]))
        return out
    }

    static let maxNesting = 32

    private func build(_ pieces: ArraySlice<Piece>, depth: Int, listDepth: Int, level: Int, role: ProseRole) -> [AnswerBlock] {
        // Deeper than any real answer: flatten to text rather than recurse (stack safety off the main thread).
        if level >= Self.maxNesting { return [.paragraphs(inline(pieces, role: role))] }
        var out: [AnswerBlock] = []
        for (intent, group) in groups(pieces, depth: depth) {
            switch intent?.kind {
            case .header(let level)?:
                out.append(.heading(level: level, text: inline(group, role: .heading(level: level))))
            case .orderedList?:
                out.append(.list(list(group, depth: depth, ordered: true, listDepth: listDepth, level: level)))
            case .unorderedList?:
                out.append(.list(list(group, depth: depth, ordered: false, listDepth: listDepth, level: level)))
            case .blockQuote?:
                out.append(.quote(build(group, depth: depth + 1, listDepth: listDepth, level: level + 1, role: .quote)))
            case .codeBlock(let hint)?:
                out.append(code(group, hint: hint))
            case .thematicBreak?:
                out.append(.rule)
            case .table(let columns)?:
                out.append(.table(table(group, depth: depth, columns: columns)))
            default:
                out.append(.paragraphs(inline(group, role: role)))
            }
        }
        return out
    }

    private func inline(_ group: ArraySlice<Piece>, role: ProseRole) -> AttributedString {
        var joined = AttributedString()
        for p in group { joined.append(p.text) }
        var s = ReplyMarkdown.clean(joined, root: root)
        style(role, &s)
        return s
    }

    private func list(_ group: ArraySlice<Piece>, depth: Int, ordered: Bool, listDepth: Int, level: Int) -> ListModel {
        var items: [ListItem] = []
        for (intent, itemGroup) in groups(group, depth: depth + 1) {
            var ordinal = items.count + 1
            if case .listItem(let o)? = intent?.kind { ordinal = o }
            var content = build(itemGroup, depth: depth + 2, listDepth: listDepth + 1, level: level + 1, role: .listItem)
            var check: ListItem.Check?
            if case .paragraphs(var s)? = content.first {
                let text = String(s.characters)
                for (prefix, value) in [("[ ] ", ListItem.Check.open), ("[x] ", .done), ("[X] ", .done)] where text.hasPrefix(prefix) {
                    s.removeSubrange(s.startIndex..<s.characters.index(s.startIndex, offsetBy: 4))
                    content[0] = .paragraphs(s)
                    check = value
                    break
                }
            }
            let marker = ordered ? "\(ordinal)." : ["•", "◦", "▪"][min(listDepth, 2)]
            items.append(ListItem(marker: marker, check: check, content: content))
        }
        return ListModel(ordered: ordered, items: items)
    }

    private func code(_ group: ArraySlice<Piece>, hint: String?) -> AnswerBlock {
        var text = group.map { String($0.text.characters) }.joined()
        if text.hasSuffix("\n") { text.removeLast() }
        let words = (hint ?? "").split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        // An info string that is only `path:line` has no language.
        let firstIsReference = words.first.map { !FileReferences.find(in: String($0), root: root).isEmpty } ?? false
        let language = firstIsReference ? nil : words.first.map(String.init)
        if language == "math" { return .math(text) }
        let rest = firstIsReference ? (hint ?? "") : (words.count > 1 ? String(words[1]) : "")
        let reference = FileReferences.find(in: rest, root: root).first?.reference
        let lines = text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
        return .code(CodeModel(language: language, text: text, isOpen: false, lineCount: lines, reference: reference))
    }

    private func table(_ group: ArraySlice<Piece>, depth: Int, columns: [PresentationIntent.TableColumn]) -> TableModel {
        let count = columns.count
        var alignments: [TableModel.Alignment] = columns.map {
            switch $0.alignment { case .center: .center; case .right: .trailing; default: .leading }
        }
        var header = Array(repeating: AttributedString(), count: count)
        var rows: [[AttributedString]] = []
        for (rowIntent, rowGroup) in groups(group, depth: depth + 1) {
            var cells = Array(repeating: AttributedString(), count: count)   // Foundation emits no run for an empty cell
            for (cellIntent, cellGroup) in groups(rowGroup, depth: depth + 2) {
                guard case .tableCell(let column)? = cellIntent?.kind, column >= 0, column < count else { continue }
                cells[column] = inline(cellGroup, role: .tableCell)
            }
            if case .tableHeaderRow? = rowIntent?.kind { header = cells } else { rows.append(cells) }
        }
        // Foundation reports an unaligned column as .left; a column of numbers reads better trailing.
        let numeric = /^[-+]?[$€£]?\d[\d,]*(\.\d+)?%?$/
        for c in 0..<count where alignments[c] == .leading {
            let texts = rows.map { String($0[c].characters) }.filter { !$0.isEmpty }
            if !texts.isEmpty, texts.allSatisfy({ $0.wholeMatch(of: numeric) != nil }) { alignments[c] = .trailing }
        }
        return TableModel(alignments: alignments, header: header, rows: rows)
    }
}

extension Array {
    subscript(safe i: Int) -> Element? { indices.contains(i) ? self[i] : nil }
}
