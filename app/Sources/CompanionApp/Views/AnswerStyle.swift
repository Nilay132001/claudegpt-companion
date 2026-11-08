import CompanionCore
import SwiftUI

/// Colours of an answer's prose, applied once per chunk when the chunk is rendered (and cached). Sizes come from
/// the block views (`Design.Typography`), so nothing here sets a font except the paragraph gap.
enum AnswerStyle {
    static let styler: ReplyMarkdown.Styler = { role, s in
        switch role {
        case .quote: s.foregroundColor = .secondary
        // The empty line between merged paragraphs: with the 4 pt line spacing on both sides it makes the 10 pt
        // paragraph gap (M9 §6).
        case .gap: s.font = .system(size: 2)
        case .paragraph, .heading, .listItem, .tableCell: break
        }
        let code = s.runs.filter { $0.inlinePresentationIntent?.contains(.code) == true }.map(\.range)
        for r in code { s[r].backgroundColor = Color.primary.opacity(0.06) }
    }
}
