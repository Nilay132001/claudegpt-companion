import Charts
import CompanionCore
import SwiftUI

/// A validated `companion-chart` block (M9 §6): title, the chart at a fixed height (so the turn's height is known
/// from the first frame), a Data disclosure with every value as text, and the source line. Every string from the
/// spec is shown verbatim; VoiceOver gets the spoken summary and an audio graph.
struct ChartBlock: View {
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    @Environment(\.dynamicTypeSize) private var typeSize
    let spec: ChartSpec
    /// nil until the reader opens or closes it: then it starts open only while VoiceOver runs.
    @State private var showData: Bool?

    static let plotHeight: CGFloat = 220

    var body: some View {
        let scale = Design.Typography.scale(typeSize)
        VStack(alignment: .leading, spacing: Design.Space.s) {
            Text(verbatim: spec.title).font(.headline)
            chart
                .frame(maxWidth: .infinity)
                .frame(height: spec.kind == .metric ? nil : Self.plotHeight)
                .accessibilityChartDescriptor(ChartDescriptor(spec: spec))
            DisclosureGroup(isExpanded: Binding(get: { showData ?? voiceOver }, set: { showData = $0 })) {
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
    }

    /// " s", "%" (no space before a percent sign), or nothing.
    private var unitSuffix: String {
        guard let u = spec.units, !u.isEmpty else { return "" }
        return u == "%" ? u : " " + u
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
            .modifier(AxisLabels(spec: spec))
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
            .chartLegend(spec.series.count > 1 ? .visible : .hidden)
            .modifier(AxisLabels(spec: spec))
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
                Text(verbatim: ChartSpec.format(p.value) + unitSuffix)
                    .font(.title2.weight(.semibold))
                    .monospacedDigit()
                Text(verbatim: p.label).font(.caption).foregroundStyle(.secondary)
            }
            .fixedSize()
        }
    }

    private func dataTable(size: CGFloat) -> some View {
        let unit = unitSuffix
        return Grid(alignment: .leading, horizontalSpacing: Design.Space.m, verticalSpacing: 3) {
            ForEach(spec.series, id: \.name) { s in
                if spec.series.count > 1 {
                    GridRow {
                        Text(verbatim: s.name).fontWeight(.semibold).gridCellColumns(2)
                    }
                }
                ForEach(s.points, id: \.label) { p in
                    GridRow {
                        Text(verbatim: p.label)
                        Text(verbatim: ChartSpec.format(p.value) + unit)
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

/// Axis titles from the spec (with the units on the value axis), only when it has them.
private struct AxisLabels: ViewModifier {
    let spec: ChartSpec
    func body(content: Content) -> some View {
        let y = [spec.yLabel, spec.units.map { "(\($0))" }].compactMap { $0 }.joined(separator: " ")
        content
            .chartXAxisLabel(position: .bottom, alignment: .center) {
                if let x = spec.xLabel { Text(verbatim: x) }
            }
            .chartYAxisLabel(position: .leading, alignment: .center) {
                if !y.isEmpty { Text(verbatim: y) }
            }
    }
}

/// The audio graph and VoiceOver summary of a chart, from the validated spec.
struct ChartDescriptor: AXChartDescriptorRepresentable {
    let spec: ChartSpec

    func makeChartDescriptor() -> AXChartDescriptor {
        let values = spec.series.flatMap { $0.points.map(\.value) }
        let lo = min(0, values.min() ?? 0)
        var hi = values.max() ?? 1
        if hi <= lo { hi = lo + 1 }
        let unit = spec.units.map { " " + $0 } ?? ""
        let x = AXCategoricalDataAxisDescriptor(title: spec.xLabel ?? "Label",
                                                categoryOrder: spec.series[0].points.map(\.label))
        let y = AXNumericDataAxisDescriptor(title: spec.yLabel ?? "Value", range: lo...hi, gridlinePositions: []) {
            ChartSpec.format($0) + unit
        }
        let series = spec.series.map { s in
            AXDataSeriesDescriptor(name: s.name, isContinuous: spec.kind == .line,
                                   dataPoints: s.points.map { AXDataPoint(x: $0.label, y: $0.value) })
        }
        return AXChartDescriptor(title: spec.title, summary: spec.spokenSummary, xAxis: x, yAxis: y,
                                 additionalAxes: [], series: series)
    }
}

/// A chart that failed validation: its source as a code block, and why it is not drawn.
struct InvalidChartBlock: View {
    let json: String
    let reason: String

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.xs) {
            CodeBlock(model: CodeModel(language: ReplyMarkdown.chartLanguage, text: json, isOpen: false,
                                       lineCount: json.isEmpty ? 0 : json.split(separator: "\n", omittingEmptySubsequences: false).count,
                                       reference: nil),
                      root: nil)
            Text(verbatim: "Chart not shown: " + reason)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}
