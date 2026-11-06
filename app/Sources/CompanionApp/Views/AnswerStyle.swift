import CompanionCore
import SwiftUI

/// Fonts and colours of an answer's prose, applied once per chunk when the chunk is rendered (and cached).
enum AnswerStyle {
    static let styler: ReplyMarkdown.Styler = { role, s in
        switch role {
        case .heading(let level): s.font = level <= 2 ? .title3.weight(.semibold) : .headline
        case .quote: s.foregroundColor = .secondary
        // A short line between blocks: a caption2 line, relative to Dynamic Type.
        case .gap: s.font = .caption2
        case .paragraph, .listItem, .tableCell: break
        }
        let code = s.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
        for r in code { s[r].backgroundColor = Color.primary.opacity(0.06) }
    }
}
