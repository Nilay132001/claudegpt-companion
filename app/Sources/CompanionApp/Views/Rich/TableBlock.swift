import CompanionCore
import SwiftUI

/// A Markdown table (first version; Task 8 makes it adaptive): a grid that scrolls sideways when it is wider than
/// the column, semibold header, cells wrapped at 220 pt, zebra rows, and a hairline border around the table only.
struct TableBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    let table: TableModel
    static let cellCap: CGFloat = 220

    var body: some View {
        let size = Design.Typography.tableCell * Design.Typography.scale(typeSize)
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow { cells(table.header, size: size, header: true, zebra: false) }
                Rectangle()
                    .fill(Design.Fill.hairline(contrast))
                    .frame(height: Design.Fill.hairlineWidth(contrast))
                    .gridCellUnsizedAxes(.horizontal)
                ForEach(table.rows.indices, id: \.self) { r in
                    GridRow { cells(table.rows[r], size: size, header: false, zebra: r % 2 == 1) }
                }
            }
            // Measured at its ideal height, so a wrapped cell sets its row's height and the other cells fill it.
            .fixedSize(horizontal: false, vertical: true)
            .clipShape(shape)
            .overlay(shape.strokeBorder(Design.Fill.hairline(contrast), lineWidth: Design.Fill.hairlineWidth(contrast)))
        }
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table")
    }

    @ViewBuilder private func cells(_ row: [AttributedString], size: CGFloat, header: Bool, zebra: Bool) -> some View {
        ForEach(0..<table.columnCount, id: \.self) { c in
            let a = Self.alignment(table.alignments[c])
            CappedWidth(cap: Self.cellCap) {
                Text(c < row.count ? row[c] : AttributedString())
                    .font(.system(size: size, weight: header ? .semibold : .regular))
                    .multilineTextAlignment(a.text)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            // Fills its grid cell, so the zebra fill spans the whole row height.
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: a.frame)
            .background(zebra ? Color.primary.opacity(0.03) : .clear)
            .gridColumnAlignment(a.horizontal)
        }
    }

    private static func alignment(_ a: TableModel.Alignment) -> (text: TextAlignment, frame: Alignment, horizontal: HorizontalAlignment) {
        switch a {
        // Top-aligned: a short cell next to a wrapped one starts on the row's first line.
        case .leading: (.leading, .topLeading, .leading)
        case .center: (.center, .top, .center)
        case .trailing: (.trailing, .topTrailing, .trailing)
        }
    }
}

/// Lays its child out at most `cap` wide, wrapping beyond it, even when offered unlimited width (inside a
/// horizontal scroller a plain `.frame(maxWidth:)` would let the text run on in one line).
struct CappedWidth: Layout {
    var cap: CGFloat

    private func childProposal(_ proposal: ProposedViewSize) -> ProposedViewSize {
        ProposedViewSize(width: min(proposal.width ?? cap, cap), height: nil)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(childProposal(proposal)) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let size = child.sizeThatFits(childProposal(proposal))
        child.place(at: bounds.origin, proposal: ProposedViewSize(size))
    }
}
