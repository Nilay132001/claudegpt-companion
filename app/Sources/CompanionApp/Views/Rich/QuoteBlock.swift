import CompanionCore
import SwiftUI

/// A block quote: a 2 pt (3 pt and full strength under Increase Contrast) leading rule and its blocks in secondary text. No box (D1).
struct QuoteBlock: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let blocks: [AnswerBlock]
    let root: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Rectangle()
                .fill(contrast == .increased ? AnyShapeStyle(.secondary) : AnyShapeStyle(.secondary.opacity(0.5)))
                .frame(width: contrast == .increased ? 3 : 2)
                .accessibilityHidden(true)
            NestedBlocks(blocks: blocks, root: root, listDepth: 0)
                .foregroundStyle(.secondary)
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}
