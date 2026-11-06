import AppKit
import CompanionCore
import SwiftUI

/// A Markdown table that adapts to the answer column (M9 §6, P8). Grid and sideways scroll are one view tree: a
/// custom `Layout` (`TableGridLayout`) inside a horizontal scroller reads the column width and picks "fits, so a
/// grid" or "wider, so it scrolls" while it lays out, with 8 pt of hysteresis, so there is no state flip, no second
/// build and no height change after the first layout. Only the stacked layout (under 300 pt, more than two
/// columns) is a different tree; it is switched by `@State` from the measured width, which only changes when the
/// panel is that narrow.
///
/// Selection: one `chatTextSelection()` on the whole table. Each Text still has its own overlay (a wrapping,
/// aligned grid cannot be one Text), the same count as before Task 8.
struct TableBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let table: TableModel
    static let cellCap = CGFloat(TableLayout.cellCap)

    @State private var info = TableInfo()
    @State private var stacked = false

    var body: some View {
        let scale = Design.Typography.scale(typeSize)
        let size = Design.Typography.tableCell * scale
        Group {
            if stacked {
                StackedRows(table: table, size: size).framed()
            } else {
                TableScroller(table: table, size: size, ideal: info.ideal(table, scale: scale))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .chatTextSelection()
        .modifier(CopyPill(table: table))
        .modifier(RowReading(table: table))
        // A container, so the label names the table and does not land on the cells.
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table, \(table.rows.count) rows")
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { w in
            info.width = w
            decideStacked(scale: scale)
        }
        .onChange(of: table) { decideStacked(scale: scale) }
    }

    /// Only the stacked decision lives here; grid and scroll are decided in the layout pass.
    private func decideStacked(scale: CGFloat) {
        guard info.width > 0 else { return }
        let st = TableLayout.decide(idealWidths: info.ideal(table, scale: scale), available: Double(info.width), previous: info.state)
        info.state = st
        let now = st.choice == .stacked
        if now != stacked { stacked = now }
    }
}

/// Per-table values that are stateful but not part of what the view shows: the estimated column widths (cached per
/// content and type size, not computed in `body`), the last layout decision (hysteresis) and the last width.
final class TableInfo {
    private let estimate = TableWidthEstimate()
    var state: TableLayoutState?
    var width: CGFloat = 0
    func ideal(_ t: TableModel, scale s: CGFloat) -> [Double] { estimate.widths(for: t, scale: Double(s)) }
}

// MARK: Grid and scroll

private struct TableScroller: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let table: TableModel
    let size: CGFloat
    let ideal: [Double]
    @State private var fadeEdge = false

    var body: some View {
        let n = table.columnCount
        ScrollView(.horizontal) {
            TableGridLayout(columns: n, ideal: ideal) {
                // Reports the scroller's width to the layout (a zero-height view as wide as the visible area).
                Color.clear.frame(height: 0).containerRelativeFrame(.horizontal)
                ForEach(0..<n, id: \.self) { c in cell(table.header, r: 0, c: c) }
                ForEach(table.rows.indices, id: \.self) { r in
                    ForEach(0..<n, id: \.self) { c in cell(table.rows[r], r: r + 1, c: c) }
                }
            }
            // The border moves with the table, so a scroll bar track sits outside it.
            .framed()
        }
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

    private func cell(_ row: [AttributedString], r: Int, c: Int) -> some View {
        let header = r == 0
        let a = TableBlock.alignment(table.alignments[c])
        return CappedWidth(cap: TableBlock.cellCap) {
            Text(c < row.count ? row[c] : AttributedString())
                .font(.system(size: size, weight: header ? .semibold : .regular))
                .multilineTextAlignment(a.text)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        // Fills the cell the layout gives it, so the zebra fill spans the whole row height.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: a.frame)
        .background(!header && (r - 1) % 2 == 1 ? Color.primary.opacity(0.03) : .clear)
        .overlay(alignment: .bottom) {
            if header { Rectangle().fill(Design.Fill.hairline(contrast)).frame(height: Design.Fill.hairlineWidth(contrast)) }
        }
    }
}

/// Lays the table's cells out as a grid with the column width decided here: the first subview is a zero-height probe
/// as wide as the scroller, then the header cells, then the body cells, `columns` per row.
///   grid: columns share the width (natural widths, shrunk or stretched to it);
///   scroll: natural widths (cells capped at 220 pt), at least as wide as the scroller.
struct TableGridLayout: Layout {
    var columns: Int
    var ideal: [Double]

    struct Cache {
        var state: TableLayoutState?
        var natural: [CGFloat]?
        var widths: [CGFloat] = []
        var heights: [CGFloat] = []
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }

    private func natural(_ subviews: Subviews, _ cache: inout Cache) -> [CGFloat] {
        if let n = cache.natural { return n }
        var w = [CGFloat](repeating: 0, count: columns)
        for (i, v) in subviews.dropFirst().enumerated() { w[i % columns] = max(w[i % columns], v.sizeThatFits(.unspecified).width) }
        cache.natural = w
        return w
    }

    private func columnWidths(_ subviews: Subviews, _ cache: inout Cache) -> [CGFloat] {
        let nat = natural(subviews, &cache)
        let avail = subviews[0].sizeThatFits(.unspecified).width
        guard avail.isFinite, avail > 1 else { return nat }
        let st = TableLayout.decide(idealWidths: ideal, available: Double(avail), previous: cache.state)
        cache.state = st
        var w = nat
        let sum = w.reduce(0, +)
        if sum < avail {
            let extra = (avail - sum) / CGFloat(columns)
            w = w.map { $0 + extra }
        } else if sum > avail, st.choice == .grid {
            // The estimate said it fits and it does not quite: shrink the widest columns (cells wrap), not below 56.
            var over = sum - avail
            while over > 0.5 {
                let widest = w.max() ?? 0
                let tier = w.filter { $0 > widest - 0.01 }.count
                let next = max(w.filter { $0 < widest - 0.01 }.max() ?? 56, 56)
                let step = min(widest - next, over / CGFloat(tier))
                if step <= 0.01 { break }
                w = w.map { $0 > widest - 0.01 ? $0 - step : $0 }
                over -= step * CGFloat(tier)
            }
        }
        return w
    }

    private func rowHeights(_ subviews: Subviews, _ widths: [CGFloat], _ cache: inout Cache) -> [CGFloat] {
        if cache.widths == widths, !cache.heights.isEmpty { return cache.heights }
        let cells = Array(subviews.dropFirst())
        let rows = cells.count / max(columns, 1)
        let h = (0..<rows).map { r in
            (0..<columns).map { c in cells[r * columns + c].sizeThatFits(ProposedViewSize(width: widths[c], height: nil)).height }.max() ?? 0
        }
        cache.widths = widths; cache.heights = h
        return h
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        guard columns > 0, subviews.count > 1 else { return .zero }
        let w = columnWidths(subviews, &cache)
        return CGSize(width: w.reduce(0, +), height: rowHeights(subviews, w, &cache).reduce(0, +))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        guard columns > 0, subviews.count > 1 else { return }
        subviews[0].place(at: bounds.origin, proposal: ProposedViewSize(width: 0, height: 0))
        let w = columnWidths(subviews, &cache), h = rowHeights(subviews, w, &cache)
        var y = bounds.minY
        for (r, rh) in h.enumerated() {
            var x = bounds.minX
            for c in 0..<columns {
                subviews[1 + r * columns + c].place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(width: w[c], height: rh))
                x += w[c]
            }
            y += rh
        }
    }
}

// MARK: Stacked

/// One block per body row: a semibold title (the first cell, or "Row N" when it is empty or a number), then
/// "Header: value" lines for the non-empty cells.
private struct StackedRows: View {
    @Environment(\.colorSchemeContrast) private var contrast
    let table: TableModel
    let size: CGFloat

    var body: some View {
        let plans = table.stackedRows
        VStack(alignment: .leading, spacing: 0) {
            ForEach(table.rows.indices, id: \.self) { r in
                let plan = plans[r]
                if r > 0 {
                    Rectangle().fill(Design.Fill.hairline(contrast)).frame(height: Design.Fill.hairlineWidth(contrast))
                }
                VStack(alignment: .leading, spacing: 2) {
                    if let t = plan.titleColumn {
                        Text(table.rows[r][t]).font(.system(size: size, weight: .semibold))
                    } else {
                        Text("Row \(plan.number)").font(.system(size: size, weight: .semibold))
                    }
                    if !plan.detailColumns.isEmpty {
                        Text(detail(plan, row: table.rows[r])).font(.system(size: size))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(r % 2 == 1 ? Color.primary.opacity(0.03) : .clear)
            }
        }
    }

    /// One Text so a drag selects the whole row.
    private func detail(_ plan: TableModel.StackedRow, row: [AttributedString]) -> AttributedString {
        var out = AttributedString()
        for (i, c) in plan.detailColumns.enumerated() {
            if i > 0 { out += AttributedString("\n") }
            var h = table.header[c]
            h.foregroundColor = .secondary
            out += h + AttributedString(": ") + row[c]
        }
        return out
    }
}

/// VoiceOver reads a table by rows with their header names. The row elements exist only while VoiceOver runs (the
/// environment value follows it at runtime): an always-present accessibilityChildren, even empty, measurably costs
/// memory and layout time on every table of a long chat.
private struct RowReading: ViewModifier {
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    let table: TableModel
    func body(content: Content) -> some View {
        if voiceOver {
            content.accessibilityChildren {
                VStack {
                    ForEach(Array(table.accessibilityRows.enumerated()), id: \.offset) { _, line in Text(line) }
                }
            }
        } else {
            content
        }
    }
}

// MARK: Copy

/// A small Copy pill on the table's top trailing edge, fixed (outside the scroller). It shows on hover or keyboard
/// focus; hidden with opacity, not removed, so it stays in the focus and accessibility trees. Also a context menu
/// and two accessibility actions with the same two items.
private struct CopyPill: ViewModifier {
    let table: TableModel
    @State private var hover = false
    @State private var pillHover = false
    @State private var menuOpen = false
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        let show = hover || pillHover || menuOpen || focused
        content
            .onHover { hover = $0 }
            .overlay(alignment: .topTrailing) {
                // The pill sticks out above the table, outside the table's hover region, so it has its own: one
                // hover on a container around a catcher and the pill, so moving between them never drops it.
                ZStack {
                    Color.clear.frame(width: 28, height: 18).contentShape(Rectangle())
                    pill(show: show)
                }
                .onHover { pillHover = $0 }
                // Straddles the top edge, so it never covers the header's last cell (no space reserved in it).
                .padding(.trailing, 3)
                .offset(y: -9)
            }
            .contextMenu { items }
            .accessibilityAction(named: "Copy as Markdown") { Design.copy(table.markdown) }
            .accessibilityAction(named: "Copy as tab-separated") { Design.copy(table.tabSeparated) }
    }

    /// Until the table is hovered a plain Button of the same fixed size (a Menu per table measurably costs scroll
    /// time); then the real Menu. Never swapped while the pill has keyboard focus (the focus would be lost), and
    /// kept while its popup is open. Hidden with opacity and no mouse hits, still in the focus and accessibility trees.
    @ViewBuilder private func pill(show: Bool) -> some View {
        Group {
            if (hover || pillHover || menuOpen) && !focused {
                Menu {
                    items
                } label: {
                    Image(systemName: "doc.on.doc")
                } primaryAction: {
                    Design.copy(table.markdown)
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                // Only while the Menu exists: the popup opening and closing keeps it in place.
                .background {
                    Color.clear.frame(width: 0, height: 0)
                        .onReceive(NotificationCenter.default.publisher(for: NSMenu.didBeginTrackingNotification)) { _ in
                            if hover || pillHover { menuOpen = true }
                        }
                        .onReceive(NotificationCenter.default.publisher(for: NSMenu.didEndTrackingNotification)) { _ in
                            menuOpen = false
                        }
                }
            } else {
                Button { Design.copy(table.markdown) } label: { Image(systemName: "doc.on.doc") }
                    .focused($focused)
            }
        }
        .buttonStyle(.borderless)
        .controlSize(.small)
        .frame(width: 22, height: 18)
        .background(.regularMaterial, in: Capsule())
        .opacity(show ? 1 : 0)
        .allowsHitTesting(show)
        .help("Copy table (click), or choose Markdown or tab-separated")
        .accessibilityLabel("Copy table")
    }

    @ViewBuilder private var items: some View {
        Button("Copy as Markdown") { Design.copy(table.markdown) }
        Button("Copy as tab-separated") { Design.copy(table.tabSeparated) }
    }
}

private struct TableFrame: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: 6, style: .continuous)
        content.clipShape(shape)
            .overlay(shape.strokeBorder(Design.Fill.hairline(contrast), lineWidth: Design.Fill.hairlineWidth(contrast)))
    }
}

private extension View {
    func framed() -> some View { modifier(TableFrame()) }
}

extension TableBlock {
    fileprivate static func alignment(_ a: TableModel.Alignment) -> (text: TextAlignment, frame: Alignment, horizontal: HorizontalAlignment) {
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
