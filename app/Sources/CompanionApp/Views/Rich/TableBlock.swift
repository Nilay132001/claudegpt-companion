import CompanionCore
import AppKit
import SwiftUI

/// A Markdown table that adapts to the answer column (M9 §6, P8): a plain grid when it fits, the same grid in a
/// sideways scroller when it does not, and one small block per row when the column is too narrow for even that
/// (under 300 pt, more than two columns). `TableLayout.choose` decides from the estimated column widths; the
/// decision is kept in `@State` and only recomputed when the column width moves by more than a point, so a live
/// resize does not re-measure the table per frame.
///
/// Selection: one `chatTextSelection()` on the whole table, not one per cell (per-block overlays cost memory and
/// resize time, Task 6). A drag can still select across cells; each Text keeps its own overlay, which is the
/// price of a grid that wraps cells and aligns columns (one Text per row cannot do either).
struct TableBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    let table: TableModel
    static let cellCap = CGFloat(TableLayout.cellCap)

    /// Starts as `.scroll`: before the first measurement it lays out at the cells' natural widths (capped at 220 pt),
    /// so the first frame is never a wide table squeezed into a narrow column and wrapped to a huge height.
    @State private var choice: TableLayoutChoice = .scroll
    @State private var ideal: [Double]?
    @State private var measuredWidth: CGFloat = 0
    @State private var fadeEdge = false

    var body: some View {
        let size = Design.Typography.tableCell * Design.Typography.scale(typeSize)
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        VStack(alignment: .trailing, spacing: 2) {
            copyMenu
            Group {
                switch choice {
                case .grid: grid(size: size).overlay(border(shape))
                case .scroll: scroller(size: size, shape: shape)
                case .stacked: stacked(size: size).overlay(border(shape))
                }
            }
            .clipShape(shape)
            .frame(maxWidth: .infinity, alignment: .leading)
            .chatTextSelection()
            .modifier(RowReading(table: table))
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { w in
            guard abs(w - measuredWidth) > 1 else { return }
            measuredWidth = w
            let widths = ideal ?? table.estimatedColumnWidths()
            if ideal == nil { ideal = widths }
            let next = TableLayout.choose(idealWidths: widths, available: Double(w))
            if next != choice { choice = next }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table, \(table.rows.count) rows")
    }

    private func border(_ shape: RoundedRectangle) -> some View {
        shape.strokeBorder(Design.Fill.hairline(contrast), lineWidth: Design.Fill.hairlineWidth(contrast))
    }

    /// One line per body row: every column as "Header: value".
    fileprivate static func spoken(_ t: TableModel) -> [String] {
        let p = t.plainRows()
        return p.dropFirst().map { r in (0..<r.count).map { "\(p[0][$0]): \(r[$0])" }.joined(separator: ", ") }
    }

    // MARK: Copy

    private var copyMenu: some View {
        Menu {
            Button("Copy as Markdown") { Design.copy(table.markdown) }
            Button("Copy as tab-separated") { Design.copy(table.tabSeparated) }
        } label: {
            Image(systemName: "doc.on.doc")
        } primaryAction: {
            Design.copy(table.markdown)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.visible)
        .controlSize(.small)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help("Copy table (click), or choose Markdown or tab-separated")
        .accessibilityLabel("Copy table")
    }

    // MARK: Layouts

    private func grid(size: CGFloat) -> some View {
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
    }

    /// The grid sideways, header first, with the code blocks' 12 pt trailing fade while there is more.
    private func scroller(size: CGFloat, shape: RoundedRectangle) -> some View {
        // At least the column wide, so a table that fits looks the same as in the plain grid.
        ScrollView(.horizontal) { grid(size: size).frame(minWidth: measuredWidth, alignment: .leading).overlay(border(shape)) }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
            .onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.width > g.containerSize.width + 1 && g.visibleRect.maxX < g.contentSize.width - 1
            } action: { _, more in
                fadeEdge = more
            }
            .overlay(alignment: .trailing) {
                if fadeEdge {
                    LinearGradient(colors: [Color(nsColor: .windowBackgroundColor), Color(nsColor: .windowBackgroundColor).opacity(0)],
                                   startPoint: .trailing, endPoint: .leading)
                        .frame(width: 12)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
    }

    /// One block per body row: the first cell as a semibold title, then "Header: value" for the others.
    private func stacked(size: CGFloat) -> some View {
        let p = table.rows
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(p.indices, id: \.self) { r in
                if r > 0 {
                    Rectangle().fill(Design.Fill.hairline(contrast)).frame(height: Design.Fill.hairlineWidth(contrast))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(p[r].first ?? AttributedString())
                        .font(.system(size: size, weight: .semibold))
                    Text(Self.detail(table, row: p[r]))
                        .font(.system(size: size))
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(r % 2 == 1 ? Color.primary.opacity(0.03) : .clear)
            }
        }
    }

    /// "Header: value" lines for every column after the first, one Text so a drag selects the whole row.
    private static func detail(_ t: TableModel, row: [AttributedString]) -> AttributedString {
        var out = AttributedString()
        for c in 1..<max(t.columnCount, 1) where c < row.count {
            if c > 1 { out += AttributedString("\n") }
            var h = t.header[c]
            h.foregroundColor = .secondary
            out += h + AttributedString(": ") + row[c]
        }
        return out
    }

    @ViewBuilder private func cells(_ row: [AttributedString], size: CGFloat, header: Bool, zebra: Bool) -> some View {
        ForEach(0..<table.columnCount, id: \.self) { c in
            let a = Self.alignment(table.alignments[c])
            CappedWidth(cap: Self.cellCap) {
                Text(c < row.count ? row[c] : AttributedString())
                    .font(.system(size: size, weight: header ? .semibold : .regular))
                    .multilineTextAlignment(a.text)
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

/// VoiceOver reads a table by rows, with the header names ("Package: parser, Seconds: 4.2"), not cell by cell.
/// The row elements are only built while VoiceOver is running: they cost memory and layout time on every table
/// of a long chat, and nobody else reads them.
private struct RowReading: ViewModifier {
    let table: TableModel
    func body(content: Content) -> some View {
        if NSWorkspace.shared.isVoiceOverEnabled {
            content.accessibilityChildren {
                VStack {
                    ForEach(Array(TableBlock.spoken(table).enumerated()), id: \.offset) { _, line in Text(line) }
                }
            }
        } else {
            content
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
