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

public struct CodeModel: Equatable, Sendable {
    public var language: String?
    public var text: String
    public var isOpen: Bool
    public var lineCount: Int
    public var reference: FileReference?
    public init(language: String?, text: String, isOpen: Bool, lineCount: Int, reference: FileReference?) {
        self.language = language; self.text = text; self.isOpen = isOpen; self.lineCount = lineCount; self.reference = reference
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
