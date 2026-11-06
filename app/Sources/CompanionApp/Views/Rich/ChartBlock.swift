import Charts
import CompanionCore
import SwiftUI

/// A validated `companion-chart` block (M9 §6): title, the chart at a fixed per-kind height (so the turn's height is
/// known from the first frame), a Data disclosure with every value as text, and the source line. Every string from
/// the spec is shown verbatim; VoiceOver gets the spoken summary and an audio graph.
struct ChartBlock: View {
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The answer's disclosure state (outside the lazy row); nil outside an answer, then `localOpen` is used.
    @Environment(ChartDisclosures.self) private var disclosures: ChartDisclosures?
    let spec: ChartSpec
    /// Where the block sits in the answer: its disclosure key.
    let path: String
    @State private var localOpen: Bool?

    /// Constant per kind; metric tiles take their own height.
    static func plotHeight(_ kind: ChartSpec.Kind) -> CGFloat? {
        switch kind {
        case .bar, .line: 200
        case .pie: 150
        case .metric: nil
        }
    }

    /// Open by default only if VoiceOver ran when the block first appeared; a later VoiceOver toggle opens nothing.
    private var isOpen: Bool { disclosures?.isOpen(path) ?? localOpen ?? voiceOver }

    var body: some View {
        let scale = Design.Typography.scale(typeSize)
        VStack(alignment: .leading, spacing: Design.Space.s) {
            Text(verbatim: spec.title).font(.headline)
            chart
                .frame(maxWidth: .infinity, alignment: .leading)
                .frame(height: Self.plotHeight(spec.kind))
                .accessibilityChartDescriptor(ChartDescriptor(spec: spec))
            DisclosureGroup(isExpanded: Binding(get: { isOpen }, set: { setOpen($0) })) {
                dataTable(size: Design.Typography.tableCell * scale)
                    .padding(.top, Design.Space.xs)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Text("Data").font(.caption)
            }
            Text(verbatim: "Source: " + spec.source)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Records the first-appearance default (the value already shown, so nothing moves).
        .onAppear { if disclosures?.isOpen(path) == nil && localOpen == nil { setOpen(isOpen) } }
    }

    private func setOpen(_ open: Bool) {
        if let disclosures { disclosures.set(path, open: open) } else { localOpen = open }
    }

    private var xName: String { spec.xLabel ?? "Label" }
    private var yName: String { spec.yLabel ?? "Value" }

    @ViewBuilder private var chart: some View {
        switch spec.kind {
        case .bar:
            Chart {
                ForEach(spec.series, id: \.name) { s in
                    ForEach(s.points, id: \.label) { p in
                        BarMark(x: .value(xName, p.label), y: .value(yName, p.value))
                            .foregroundStyle(by: .value("Series", s.name))
                            .position(by: .value("Series", s.name))
                    }
                }
            }
            .chartLegend(spec.series.count > 1 ? .visible : .hidden)
            .modifier(Axes(spec: spec))
        case .line:
            Chart {
                ForEach(spec.series, id: \.name) { s in
                    ForEach(s.points, id: \.label) { p in
                        LineMark(x: .value(xName, p.label), y: .value(yName, p.value))
                            .foregroundStyle(by: .value("Series", s.name))
                        PointMark(x: .value(xName, p.label), y: .value(yName, p.value))
                            .foregroundStyle(by: .value("Series", s.name))
                    }
                }
            }
            // A line shows change: its scale fits the values (bars keep zero).
            .chartYScale(domain: .automatic(includesZero: false))
            .chartLegend(spec.series.count > 1 ? .visible : .hidden)
            .modifier(Axes(spec: spec))
        case .pie:
            Chart(spec.series[0].points, id: \.label) { p in
                SectorMark(angle: .value("Value", p.value), innerRadius: .ratio(0.5), angularInset: 1)
                    .foregroundStyle(by: .value("Label", p.label))
            }
            .chartLegend(position: .trailing, alignment: .center)
        case .metric:
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: Design.Space.l) { metricTiles }
                VStack(alignment: .leading, spacing: Design.Space.s) { metricTiles }
            }
        }
    }

    @ViewBuilder private var metricTiles: some View {
        ForEach(spec.series[0].points, id: \.label) { p in
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: ChartSpec.format(p.value) + spec.unitSuffix)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
                Text(verbatim: p.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func dataTable(size: CGFloat) -> some View {
        Grid(alignment: .leading, horizontalSpacing: Design.Space.m, verticalSpacing: 3) {
            ForEach(spec.series, id: \.name) { s in
                if spec.series.count > 1 {
                    GridRow {
                        Text(verbatim: s.name).fontWeight(.semibold).gridCellColumns(2)
                    }
                }
                ForEach(s.points, id: \.label) { p in
                    GridRow {
                        Text(verbatim: p.label)
                        Text(verbatim: ChartSpec.format(p.value) + spec.unitSuffix)
                            .monospacedDigit()
                            .gridColumnAlignment(.trailing)
                    }
                }
            }
        }
        .font(.system(size: size))
        .chatTextSelection()
    }
}

/// Value ticks carry the units; axis titles only from the spec's own labels (never the units alone). The y title sits
/// above the plot, unrotated.
private struct Axes: ViewModifier {
    let spec: ChartSpec
    func body(content: Content) -> some View {
        content
            .chartYAxis {
                AxisMarks { v in
                    AxisGridLine()
                    AxisTick()
                    AxisValueLabel {
                        if let d = v.as(Double.self) { Text(verbatim: ChartSpec.format(d) + spec.unitSuffix) }
                    }
                }
            }
            .chartXAxisLabel(position: .bottom, alignment: .center) {
                if let x = spec.xLabel { Text(verbatim: x) }
            }
            .chartYAxisLabel(position: .top, alignment: .leading) {
                if let y = spec.yLabel { Text(verbatim: y) }
            }
    }
}

/// The audio graph and VoiceOver summary of a chart, from the validated spec (all values, not the short summary).
struct ChartDescriptor: AXChartDescriptorRepresentable {
    let spec: ChartSpec

    func makeChartDescriptor() -> AXChartDescriptor {
        let values = spec.series.flatMap { $0.points.map(\.value) }
        // The line's scale fits its values; the others include zero, as drawn.
        let lo = spec.kind == .line ? (values.min() ?? 0) : min(0, values.min() ?? 0)
        var hi = values.max() ?? 1
        if hi <= lo { hi = lo + 1 }
        let x = AXCategoricalDataAxisDescriptor(title: spec.xLabel ?? "Label", categoryOrder: spec.categories)
        let y = AXNumericDataAxisDescriptor(title: spec.yLabel ?? "Value", range: lo...hi, gridlinePositions: []) {
            ChartSpec.format($0) + spec.unitSuffix
        }
        let series = spec.series.map { s in
            AXDataSeriesDescriptor(name: s.name, isContinuous: spec.kind == .line,
                                   dataPoints: s.points.map { AXDataPoint(x: $0.label, y: $0.value) })
        }
        return AXChartDescriptor(title: spec.title, summary: spec.spokenSummary, xAxis: x, yAxis: y,
                                 additionalAxes: [], series: series)
    }
}

/// A chart that failed validation: its source as a code block (the parser's model), and why it is not drawn.
struct InvalidChartBlock: View {
    let code: CodeModel
    let reason: String

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.xs) {
            CodeBlock(model: code, root: nil)
            Text(verbatim: "Chart not shown: " + reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
