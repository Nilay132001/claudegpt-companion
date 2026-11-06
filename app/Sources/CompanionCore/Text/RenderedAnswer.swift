import Foundation

/// Where a block sits: its chunk and its index inside the chunk. Closed chunks never change, so their blocks keep
/// their ids while the answer grows (M9 §5.2). Never an enumerated() offset of the whole answer.
public struct BlockID: Hashable, Sendable {
    public let chunk: Int
    public let index: Int
    public init(chunk: Int, index: Int) { self.chunk = chunk; self.index = index }
}

public enum AnswerBlock: Equatable, Sendable {
    /// Consecutive top-level paragraphs: one selectable Text.
    case paragraphs(AttributedString)
    case heading(level: Int, text: AttributedString)
    case list(ListModel)
    case quote([AnswerBlock])
    case code(CodeModel)
    case table(TableModel)
    case rule
    case math(String)
}

public struct ListModel: Equatable, Sendable {
    public var ordered: Bool
    public var items: [ListItem]
    public init(ordered: Bool, items: [ListItem]) { self.ordered = ordered; self.items = items }
}

public struct ListItem: Equatable, Sendable {
    public enum Check: Equatable, Sendable { case open, done }
    /// "•" "◦" "▪" by depth, or "3."
    public var marker: String
    public var check: Check?
    public var content: [AnswerBlock]
    public init(marker: String, check: Check?, content: [AnswerBlock]) {
        self.marker = marker; self.check = check; self.content = content
    }
}

/// What a code block's highlight task is keyed on: a stream closing the fence changes `isOpen` without changing
/// the text, and must still re-run it.
public struct HighlightKey: Hashable, Sendable {
    public var text: String
    public var isOpen: Bool
    public init(text: String, isOpen: Bool) { self.text = text; self.isOpen = isOpen }
}

/// A small LRU for computed values (highlighted code), capped by entry count and by total cost.
public struct BoundedCache<Key: Hashable, Value> {
    private var values: [Key: (value: Value, cost: Int)] = [:]
    private var order: [Key] = []
    public private(set) var totalCost = 0
    public let capacity: Int
    public let maxCost: Int
    public init(capacity: Int, maxCost: Int = .max) { self.capacity = max(1, capacity); self.maxCost = maxCost }
    public var count: Int { values.count }

    public mutating func value(for key: Key) -> Value? {
        guard let v = values[key] else { return nil }
        if let i = order.lastIndex(of: key) { order.remove(at: i); order.append(key) }
        return v.value
    }

    /// A single entry above `maxCost` is not stored.
    public mutating func insert(_ value: Value, for key: Key, cost: Int = 1) {
        if let old = values.removeValue(forKey: key) {
            totalCost -= old.cost
            if let i = order.lastIndex(of: key) { order.remove(at: i) }
        }
        guard cost <= maxCost else { return }
        values[key] = (value, cost)
        totalCost += cost
        order.append(key)
        while order.count > capacity || totalCost > maxCost {
            let k = order.removeFirst()
            if let gone = values.removeValue(forKey: k) { totalCost -= gone.cost }
        }
    }
}

public struct CodeModel: Equatable, Sendable {
    public var language: String?
    public var text: String { didSet { hasVeryLongLine = Self.scanVeryLong(text) } }
    public var isOpen: Bool
    public var lineCount: Int
    public var reference: FileReference?
    /// Computed once per text, not per render.
    public private(set) var hasVeryLongLine: Bool
    public init(language: String?, text: String, isOpen: Bool, lineCount: Int, reference: FileReference?) {
        self.hasVeryLongLine = Self.scanVeryLong(text)
        self.language = language; self.text = text; self.isOpen = isOpen; self.lineCount = lineCount; self.reference = reference
    }

    /// The first `shownLines` lines and how many are hidden, or nil when the block has at most `maxLines` lines.
    /// Scans only as far as the 24th line break, so it is cheap to call on every render.
    public func preview(maxLines: Int = 40, shownLines: Int = 24) -> (text: String, hiddenLines: Int)? {
        guard lineCount > maxLines, shownLines > 0 else { return nil }
        var seen = 0
        var cut: String.Index?
        let bytes = text.utf8
        for i in bytes.indices where bytes[i] == 10 {
            seen += 1
            if seen == shownLines { cut = i; break }
        }
        guard let cut else { return nil }
        return (String(text[..<cut]), lineCount - shownLines)
    }

    /// A line longer than this (UTF-16 units) is never laid out in one unwrapped row: giant single-line text
    /// renders blank or clipped, so such a block wraps whatever the Wrap setting says.
    public static let veryLongLine = 2000

    private static func scanVeryLong(_ text: String) -> Bool {
        var run = 0
        for u in text.utf16 {
            if u == 10 { run = 0 } else { run += 1; if run > veryLongLine { return true } }
        }
        return false
    }
}

public struct TableModel: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case leading, center, trailing }
    public var alignments: [Alignment]
    public var header: [AttributedString]
    /// Padded to `alignments.count`.
    public var rows: [[AttributedString]]
    public var columnCount: Int { alignments.count }
    public init(alignments: [Alignment], header: [AttributedString], rows: [[AttributedString]]) {
        self.alignments = alignments; self.header = header; self.rows = rows
    }
}

public enum TableLayoutChoice: Equatable, Sendable { case grid, scroll, stacked }

/// A layout decision and the width tier it was made in, kept by the view's layout so the next decision can be
/// made with hysteresis.
public struct TableLayoutState: Equatable, Sendable {
    public var choice: TableLayoutChoice
    public var tier: Int
    public init(choice: TableLayoutChoice, tier: Int) { self.choice = choice; self.tier = tier }
}

/// Which table layout fits the answer column (M9 §6, P8: thresholds on the column width, panel − 32 pt).
public enum TableLayout {
    public static let cellCap: Double = 220
    /// A decision only flips once the width is this far past a threshold, so a scroll bar appearing (about 15 pt
    /// narrower) cannot flip it back and forth.
    public static let hysteresis: Double = 8
    public static let thresholds: [Double] = [300, 380]

    public static func choose(idealWidths: [Double], available: Double) -> TableLayoutChoice {
        decide(idealWidths: idealWidths, available: available, previous: nil).choice
    }

    public static func decide(idealWidths: [Double], available: Double, previous: TableLayoutState?) -> TableLayoutState {
        // Tier 0: under 300, 1: 300..<380, 2: 380 and up; leaving the previous tier needs `hysteresis` more.
        // Step one tier at a time, so every edge crossed needs its own margin (a jump from 380+ to 295 passes 380).
        var tier = thresholds.filter { available >= $0 }.count
        if let p = previous {
            tier = p.tier
            while tier < thresholds.count, available >= thresholds[tier] + hysteresis { tier += 1 }
            while tier > 0, available < thresholds[tier - 1] - hysteresis { tier -= 1 }
        }
        let slack = previous?.choice == .grid ? hysteresis : (previous == nil ? 0 : -hysteresis)
        let fits = idealWidths.map { min($0, cellCap) }.reduce(0, +) <= available + slack
        let n = idealWidths.count
        let choice: TableLayoutChoice
        switch tier {
        case 0: choice = n <= 2 ? .grid : .stacked
        case 1: choice = n <= 3 && fits ? .grid : .scroll
        default: choice = fits ? .grid : .scroll
        }
        return TableLayoutState(choice: choice, tier: tier)
    }
}

extension TableModel {
    public func plainRows() -> [[String]] {
        ([header] + rows).map { r in (0..<columnCount).map { $0 < r.count ? String(r[$0].characters) : "" } }
    }

    /// Ideal column widths (widest cell; `TableLayout.cellCap` is applied when choosing). Pass `charWidth` scaled by
    /// the type size.
    public func estimatedColumnWidths(charWidth: Double = 7.2, padding: Double = 16) -> [Double] {
        let p = plainRows()
        return (0..<columnCount).map { c in
            Double(p.map { $0[c].count }.max() ?? 0) * charWidth + padding
        }
    }

    static func isNumeric(_ s: String) -> Bool {
        s.range(of: #"^[-+−]?[\d.,]+%?$"#, options: .regularExpression) != nil
    }

    /// Tab-separated, one line per row: tabs and line breaks inside a cell become a space, and a cell a spreadsheet
    /// would run as a formula (starts with = + - @, a tab or a return, and is not a plain number) gets a leading '.
    public var tabSeparated: String {
        func cell(_ c: String) -> String {
            var t = c
            if let f = t.first, "=+-@\t\r".contains(f), !Self.isNumeric(t) { t = "'" + t }
            return t.replacingOccurrences(of: "\r\n", with: " ").replacingOccurrences(of: "\t", with: " ")
                .replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
        }
        return plainRows().map { $0.map(cell).joined(separator: "\t") }.joined(separator: "\n")
    }

    /// GitHub-style Markdown: backslashes and Markdown specials in cells are escaped, line breaks become `<br>`.
    public var markdown: String {
        func esc(_ c: String) -> String {
            var out = ""
            for ch in c {
                switch ch {
                case "\\", "`", "*", "_", "[", "]", "<", ">", "|", "~": out.append("\\"); out.append(ch)
                case "\r": break
                case "\n": out += "<br>"
                default: out.append(ch)
                }
            }
            return out
        }
        func row(_ cells: [String]) -> String { "| " + cells.map(esc).joined(separator: " | ") + " |" }
        let rule = alignments.map { a -> String in
            switch a { case .leading: "---"; case .center: ":---:"; case .trailing: "---:" }
        }
        let p = plainRows()
        return ([row(p[0]), "| " + rule.joined(separator: " | ") + " |"] + p.dropFirst().map(row)).joined(separator: "\n")
    }

    /// "first: second." for two columns; "first: header2 cell2, header3 cell3." for more (Task 9 speech).
    public var spokenRows: [String] {
        let p = plainRows(), head = p[0]
        return p.dropFirst().map { r in
            guard r.count > 1 else { return (r.first ?? "") + "." }
            let rest = r.count == 2 ? r[1] : (1..<r.count).map { "\(head[$0]) \(r[$0])" }.joined(separator: ", ")
            return "\(r[0]): \(rest)."
        }
    }

    /// What VoiceOver reads for each body row: every column as "Header: value" (same cells as `spokenRows`).
    public var accessibilityRows: [String] {
        let p = plainRows(), head = p[0]
        return p.dropFirst().map { r in (0..<r.count).map { "\(head[$0]): \(r[$0])" }.joined(separator: ", ") }
    }

    /// How a body row is shown in the stacked layout: titled by its first cell, unless that is empty or a number,
    /// then "Row N" and column 0 is an ordinary "Header: value" line. Empty values are skipped.
    public struct StackedRow: Equatable, Sendable {
        public var titleColumn: Int?   // nil: the title is "Row \(number)"
        public var number: Int         // 1-based
        public var detailColumns: [Int]
    }

    public func stackedRow(_ index: Int) -> StackedRow { stackedRows[index] }

    /// The plan for every body row; the plain text is built once.
    public var stackedRows: [StackedRow] {
        plainRows().dropFirst().enumerated().map { index, p in
            let first = p.first ?? ""
            let titled = !first.trimmingCharacters(in: .whitespaces).isEmpty && !Self.isNumeric(first)
            let detail = (titled ? 1 : 0)..<columnCount
            return StackedRow(titleColumn: titled ? 0 : nil, number: index + 1,
                              detailColumns: detail.filter { !p[$0].trimmingCharacters(in: .whitespaces).isEmpty })
        }
    }
}

/// The estimated column widths of one table, recomputed when the table's content or the type-size scale changes
/// (a streaming answer keeps the same view while its table grows).
public final class TableWidthEstimate {
    private var table: TableModel?
    private var scale: Double = -1
    private var widths: [Double] = []
    public init() {}
    public func widths(for t: TableModel, scale s: Double) -> [Double] {
        if s != scale || table != t {
            scale = s; table = t
            widths = t.estimatedColumnWidths(charWidth: 7.2 * s)
        }
        return widths
    }
}

public enum AnswerAttributes {
    /// Text shown on screen but never spoken: a removed link's " (url)" and an image's alt text.
    public enum SpeechSkip: AttributedStringKey {
        public typealias Value = Bool
        public static let name = "companion.speechSkip"
    }
}

public struct RenderedBlock: Identifiable, Equatable, Sendable {
    public let id: BlockID
    public let block: AnswerBlock
    public init(id: BlockID, block: AnswerBlock) { self.id = id; self.block = block }
}

/// One chunk's render: what the cache stores. `cost` is an estimate in bytes.
public struct RenderedChunk: Equatable, Sendable {
    public let blocks: [AnswerBlock]
    public let plainText: String
    public let cost: Int
    public init(blocks: [AnswerBlock], plainText: String, cost: Int) {
        self.blocks = blocks; self.plainText = plainText; self.cost = cost
    }
}

public struct RenderedAnswer: Equatable, Sendable {
    public let blocks: [RenderedBlock]
    /// For the accessibility label, Copy as plain text and (Task 9) speech.
    public let plainText: String
    public init(blocks: [RenderedBlock], plainText: String) { self.blocks = blocks; self.plainText = plainText }
    public static let empty = RenderedAnswer(blocks: [], plainText: "")
}

/// Vertical space between answer blocks (M9 §6 typography): above a heading 18/16/12, below one 8/6/4, else 10.
public enum BlockSpacing {
    public static func gap(before block: AnswerBlock, after previous: AnswerBlock?) -> Double {
        guard let previous else { return 0 }
        if case .heading(let level, _) = block { return [18, 16, 12][min(max(level, 1), 3) - 1] }
        if case .heading(let level, _) = previous { return [8, 6, 4][min(max(level, 1), 3) - 1] }
        return 10
    }
}

/// The marker column of a list (M9 §6): 14 pt for bullets and checkboxes; for numbers, 8 pt per character of the
/// longest marker plus 2, so "9." and "10." share one trailing-aligned column.
public enum ListLayout {
    public static let bulletColumn: Double = 14

    public static func markerColumn(_ list: ListModel) -> Double {
        guard list.ordered, let chars = list.items.map(\.marker.count).max() else { return bulletColumn }
        return Double(chars * 8 + 2)
    }
}

/// How much the answer's type tokens grow with the user's text size (the app maps `DynamicTypeSize` onto these).
public enum TextScale {
    public enum Step: Sendable { case xSmall, small, medium, large, xLarge, xxLarge, xxxLarge, accessibility }

    public static func factor(_ step: Step) -> Double {
        switch step {
        case .xSmall: 0.88
        case .small: 0.94
        case .medium, .large: 1.0
        case .xLarge: 1.1
        case .xxLarge: 1.2
        case .xxxLarge: 1.3
        case .accessibility: 1.4
        }
    }
}
