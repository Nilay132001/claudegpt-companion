import Foundation
import Testing
@testable import CompanionCore

@Suite struct ChartSpecTests {
    static let valid = #"""
    {"version":1,"type":"bar","title":"Test runtime by package","units":"s",
     "x":{"label":"Package"},"y":{"label":"Seconds"},
     "series":[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}],
     "source":"Read from the npm test output in the session context"}
    """#

    func reason(_ json: String) -> String? {
        if case .failure(let e) = ChartSpec.parse(json) { return e.reason }
        return nil
    }
    func with(_ replace: String, _ by: String) -> String { Self.valid.replacingOccurrences(of: replace, with: by) }

    @Test func acceptsTheSpecExample() throws {
        let s = try ChartSpec.parse(Self.valid).get()
        #expect(s.kind == .bar && s.title == "Test runtime by package" && s.units == "s")
        #expect(s.xLabel == "Package" && s.yLabel == "Seconds")
        #expect(s.series == [.init(name: "main", points: [.init(label: "parser", value: 4.2), .init(label: "csv", value: 1.9)])])
        #expect(s.spokenSummary == "Bar chart, Test runtime by package: parser 4.2 seconds, csv 1.9 seconds.")
    }

    @Test func rejectsWhatTheSpecRejects() {
        #expect(reason(String(repeating: " ", count: 8 * 1024) + Self.valid) == "the data is larger than 8 KB")
        #expect(reason("{") == "the data is not valid JSON")
        #expect(reason(with(#""units":"s","#, #""units":"s","colour":"red","#)) == "unknown field \"colour\"")
        #expect(reason(with(#""version":1"#, #""version":2"#)) == "version must be 1")
        #expect(reason(with(#""type":"bar""#, #""type":"scatter""#)) == "type must be bar, line, pie or metric")
        #expect(reason(with(#""title":"Test runtime by package""#, #""title":"""#)) == "title must be 1–80 characters")
        #expect(reason(with(#""units":"s""#, #""units":"seconds per package run""#)) == "units must be at most 16 characters")
        // The source sits on its own line in `valid`, after "],\n ".
        #expect(reason(with("],\n \"source\":\"Read from the npm test output in the session context\"", "]")) == "source must be 1–200 characters")
        #expect(reason(with(#""source":"Read from the npm test output in the session context""#, #""source":"""#)) == "source must be 1–200 characters")
        #expect(reason(with(#""value":4.2"#, #""value":"4.2""#)) == "value 1 is not a number")
        #expect(reason(with(#""value":4.2"#, #""value":true"#)) == "value 1 is not a number")
        #expect(reason(with(#""value":4.2"#, #""value":1e13"#)) == "value 1 is too large")
        #expect(reason(with(#""value":4.2"#, #""value":1e400"#)) == "the data is not valid JSON")
        #expect(reason(with(#""value":4.2"#, "NaN")) == "the data is not valid JSON")
        #expect(reason(with(#""label":"csv""#, #""label":"parser""#)) == "label \"parser\" appears twice in series 1")
        #expect(reason(with(#""label":"csv","#, "")) != nil)                       // a point without a label
        #expect(reason(with(#""name":"main""#, #""name":"""#)) == "series 1 needs a name of 1–40 characters")
    }

    @Test func seriesAndPointCounts() {
        let five = (1...5).map { #"{"name":"s\#($0)","points":[{"label":"a","value":1}]}"# }.joined(separator: ",")
        #expect(reason(with(#"[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}]"#, "[\(five)]"))
                == "a bar or line chart needs 1–4 series")
        let pts = (1...25).map { #"{"label":"p\#($0)","value":1}"# }.joined(separator: ",")
        #expect(reason(with(#"[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]"#, "[\(pts)]")) == "series 1 needs 1–24 points")
        #expect(reason(with(#"[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]"#, "[\(pts)]").replacingOccurrences(of: #""bar""#, with: #""line""#)) == nil)
    }

    @Test func pieAndMetricAndLineRules() {
        let pie = with(#""type":"bar""#, #""type":"pie""#)
        #expect(reason(pie) == nil)
        #expect(reason(pie.replacingOccurrences(of: "4.2", with: "-1")) == "pie values must be zero or more")
        #expect(reason(pie.replacingOccurrences(of: "4.2", with: "0").replacingOccurrences(of: "1.9", with: "0"))
                == "pie values must add up to more than zero")
        let metric = with(#""type":"bar""#, #""type":"metric""#)
        #expect(reason(metric) == nil)
        let line2 = with(#""type":"bar""#, #""type":"line""#).replacingOccurrences(
            of: #"{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}"#,
            with: #"{"name":"a","points":[{"label":"x","value":1},{"label":"y","value":2}]},{"name":"b","points":[{"label":"y","value":1},{"label":"x","value":2}]}"#)
        #expect(reason(line2) == "line series must share the same labels in the same order")
    }

    @Test func neverCrashesOnDamagedInput() {
        for i in Self.valid.indices {
            var s = Self.valid
            s.remove(at: i)
            if case .success(let spec) = ChartSpec.parse(s) {
                #expect(!spec.title.isEmpty && spec.series.allSatisfy { !$0.points.isEmpty && $0.points.allSatisfy { $0.value.isFinite } })
            }
        }
    }

    @Test func formatsNumbersWithoutLocale() {
        #expect(ChartSpec.format(4.2) == "4.2")
        #expect(ChartSpec.format(1200) == "1200")
        #expect(ChartSpec.format(1.0 / 3) == "0.33")
        #expect(ChartSpec.format(-0.5) == "-0.5")
    }

    @Test func aChartFenceBecomesAChartBlock() {
        #expect(ReplyMarkdown.blocks("```companion-chart\n\(Self.valid)\n```", root: nil).map(describe) == ["chart:Test runtime by package"])
        #expect(ReplyMarkdown.blocks("```companion-chart\n{\"version\":2}\n```", root: nil).map(describe)
                == ["chart-invalid:version must be 1"])
        let streaming = ReplyMarkdown.chunks("```companion-chart\n{\"ver").last!
        #expect(ReplyMarkdown.renderChunk(streaming, root: nil, style: ReplyMarkdown.noStyle).blocks.map(describe)
                == ["code(companion-chart,open):{\"ver"])
    }

    static let twoSeries = #"[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}]"#
    func series(_ json: String) -> String { with(Self.twoSeries, json) }

    @Test func seriesNamesAreUnique() {
        let dup = #"[{"name":"main","points":[{"label":"a","value":1}]},{"name":"main ","points":[{"label":"a","value":2}]}]"#
        #expect(reason(series(dup)) == "series name \"main \" appears twice")
    }

    @Test func labelsAreTrimmedBeforeTheDuplicateCheck() {
        #expect(reason(with(#""label":"csv""#, #""label":" parser""#)) == "label \" parser\" appears twice in series 1")
    }

    @Test func controlAndDirectionCharactersAreRefused() {
        #expect(reason(with(#""title":"Test runtime by package""#, #""title":"a\u0007b""#)) == "title has a control or text-direction character")
        #expect(reason(with(#""label":"csv""#, #""label":"c‮sv""#)) == "point 2 label has a control or text-direction character")
        #expect(reason(with(#""units":"s""#, #""units":"⁦s""#)) == "units has a control or text-direction character")
        #expect(reason(with(#""name":"main""#, #""name":"ma\nin""#)) == "series 1 name has a control or text-direction character")
        #expect(reason(with(#""label":"Package""#, #""label":"Pack\u0085age""#)) == "x label has a control or text-direction character")
        // Direction marks, zero-width characters and the line and paragraph separators (final review minor 3).
        #expect(reason(with(#""label":"csv""#, #""label":"Q1\u200F-Q2""#)) == "point 2 label has a control or text-direction character")
        #expect(reason(with(#""label":"csv""#, #""label":"Q1\u200E-Q2""#)) == "point 2 label has a control or text-direction character")
        #expect(reason(with(#""label":"csv""#, #""label":"Q1\u061C-Q2""#)) == "point 2 label has a control or text-direction character")
        #expect(reason(with(#""title":"Test runtime by package""#, #""title":"a\u200Bb""#)) == "title has a control or text-direction character")
        #expect(reason(with(#""title":"Test runtime by package""#, #""title":"a\u2028b""#)) == "title has a control or text-direction character")
        #expect(reason(with(#""title":"Test runtime by package""#, #""title":"a\u2029b""#)) == "title has a control or text-direction character")
        // One character, many scalars (combining marks): capped at 4 × the limit.
        let zalgo = "a" + String(repeating: "\u{0301}", count: 400)
        #expect(reason(with(#""title":"Test runtime by package""#, "\"title\":\"\(zalgo)\"")) == "title must be 1–80 characters")
    }

    @Test func pieChartsHaveAtMostEightPoints() {
        let pts = (1...9).map { #"{"label":"p\#($0)","value":1}"# }.joined(separator: ",")
        let pie = with(#""type":"bar""#, #""type":"pie""#)
        #expect(reason(pie.replacingOccurrences(of: #"[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]"#, with: "[\(pts)]"))
                == "a pie chart needs 1–8 points")
        let eight = (1...8).map { #"{"label":"p\#($0)","value":1}"# }.joined(separator: ",")
        #expect(reason(pie.replacingOccurrences(of: #"[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]"#, with: "[\(eight)]")) == nil)
    }

    @Test func smallValuesKeepTwoSignificantDigitsAndThereIsNoMinusZero() {
        #expect(ChartSpec.format(0.004) == "0.004")
        #expect(ChartSpec.format(0.0043) == "0.0043")
        #expect(ChartSpec.format(-0.001) == "-0.001")
        #expect(ChartSpec.format(0.05) == "0.05")
        #expect(ChartSpec.format(1e-9) == "1e-09")
        #expect(ChartSpec.format(-0.0) == "0")
        #expect(ChartSpec.format(-0.0000000001) != "-0")
        #expect(ChartSpec.format(2.999) == "3")
    }

    @Test func longChartsAreSummarisedNotListed() throws {
        let days = ["Mon", "Tue", "Wed", "Thu", "Fri"]
        let pts = (0..<60).map { i in #"{"label":"\#(days[i % 5])\#(i / 5 == 11 && i % 5 == 4 ? "" : "\(i)")","value":\#(i == 59 ? 6.1 : i == 0 ? 7.9 : 7.0)}"# }
        let json = #"{"version":1,"type":"line","title":"Suite time","units":"s","series":[{"name":"suite","points":[\#(pts.joined(separator: ","))]}],"source":"x"}"#
        let s = try ChartSpec.parse(json).get()
        #expect(s.spokenSummary == "Line chart, Suite time: 60 points from Mon0 to Fri; lowest 6.1 seconds on Fri, highest 7.9 seconds on Mon0, last 6.1 seconds.")
        #expect(s.spokenSummary.count < 200)
        #expect(s.plainText.split(separator: "\n").count == 61)
    }

    @Test func categoriesAreTheOrderedUnionOfLabels() throws {
        let s = try ChartSpec.parse(series(#"[{"name":"a","points":[{"label":"x","value":1},{"label":"y","value":2}]},{"name":"b","points":[{"label":"z","value":1},{"label":"x","value":2}]}]"#)).get()
        #expect(s.categories == ["x", "y", "z"])
    }

    @Test func deepNestingIsRefusedBeforeDecoding() async {
        #expect(reason(String(repeating: "[", count: 7) + String(repeating: "]", count: 7)) == "the data is nested too deeply")
        #expect(ChartSpec.nestingDepth(#"{"a":"[[[[[[[[[[","b":"\"[["}"#) == 1)
        let blocks = await Task.detached {
            ReplyMarkdown.blocks("```companion-chart\n" + String(repeating: "[", count: 4000) + "\n```", root: nil).map(describe)
        }.value
        #expect(blocks == ["chart-invalid:the data is nested too deeply"])
    }

    @Test func anInvalidChartKeepsTheParsersCodeModel() {
        guard case .chart(.invalid(let code, _))? = ReplyMarkdown.blocks("```companion-chart\n{\"version\":2}\n```", root: nil).first
        else { Issue.record("not an invalid chart"); return }
        #expect(code.language == "companion-chart" && code.text == "{\"version\":2}" && code.lineCount == 1 && !code.isOpen)
    }

    /// The example in companiond's GPT instructions (companiond/test/fixtures); a Node test pins that the instructions
    /// carry exactly this text, so GPT is shown a spec this validator accepts.
    @Test func theExampleInTheGPTInstructionsIsValid() throws {
        var dir = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { dir.deleteLastPathComponent() }   // CompanionCoreTests, Tests, app, repo root
        let url = dir.appendingPathComponent("companiond/test/fixtures/companion-chart-example.json")
        #expect(FileManager.default.fileExists(atPath: url.path), "fixture missing at \(url.path): the instructions example must be shared with companiond")
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        let json = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard case .success(let spec) = ChartSpec.parse(json) else { Issue.record("the instructions example is refused"); return }
        #expect(spec.kind == .bar && spec.series.count == 1 && !spec.source.isEmpty)
    }

    // MARK: - Drift guard: every number companiond/src/codex/instructions.ts states, valid at the limit and refused past it.

    private func q(_ s: String) -> String { "\"" + s + "\"" }
    private func pts(_ n: Int, labelPrefix: String = "p", value: String = "1") -> String {
        (0..<n).map { #"{"label":"\#(labelPrefix)\#($0)","value":\#(value)}"# }.joined(separator: ",")
    }
    private func ser(_ name: String, _ n: Int, value: String = "1") -> String { #"{"name":\#(q(name)),"points":[\#(pts(n, value: value))]}"# }
    private func chart(type: String = "bar", title: String = "T", extra: String = "", series: String? = nil, source: String = "src") -> String {
        #"{"version":1,"type":\#(q(type)),"title":\#(q(title)),\#(extra)"series":[\#(series ?? ser("s", 2))],"source":\#(q(source))}"#
    }
    private func ok(_ json: String, _ note: String = "", line: UInt = #line) {
        if case .failure(let e) = ChartSpec.parse(json) { Issue.record("\(note) refused: \(e.reason)", sourceLocation: .init(fileID: #fileID, filePath: #filePath, line: Int(line), column: 1)) }
    }
    private func refused(_ json: String, _ note: String = "", line: UInt = #line) {
        if case .success = ChartSpec.parse(json) { Issue.record("\(note) accepted", sourceLocation: .init(fileID: #fileID, filePath: #filePath, line: Int(line), column: 1)) }
    }
    private func a(_ n: Int) -> String { String(repeating: "a", count: n) }

    @Test func textLimitsMatchTheInstructions() {
        ok(chart(title: a(80)), "title 80"); refused(chart(title: a(81)), "title 81")
        ok(chart(extra: #""units":\#(q(a(16))),"#), "units 16"); refused(chart(extra: #""units":\#(q(a(17))),"#), "units 17")
        for axis in ["x", "y"] {
            ok(chart(extra: #""\#(axis)":{"label":\#(q(a(40)))},"#), "\(axis) label 40")
            refused(chart(extra: #""\#(axis)":{"label":\#(q(a(41)))},"#), "\(axis) label 41")
        }
        ok(chart(source: a(200)), "source 200"); refused(chart(source: a(201)), "source 201")
        ok(chart(series: ser(a(40), 2)), "series name 40"); refused(chart(series: ser(a(41), 2)), "series name 41")
        ok(chart(series: #"{"name":"s","points":[{"label":\#(q(a(40))),"value":1}]}"#), "label 40")
        refused(chart(series: #"{"name":"s","points":[{"label":\#(q(a(41))),"value":1}]}"#), "label 41")
    }

    @Test func seriesAndPointCountsMatchTheInstructions() {
        let four = (0..<4).map { ser("s\($0)", 2) }.joined(separator: ","), five = four + "," + ser("s4", 2)
        ok(chart(series: four), "bar 4 series"); refused(chart(series: five), "bar 5 series")
        ok(chart(series: ser("s", 24)), "bar 24 points"); refused(chart(series: ser("s", 25)), "bar 25 points")
        ok(chart(type: "line", series: four), "line 4 series"); refused(chart(type: "line", series: five), "line 5 series")
        ok(chart(type: "line", series: ser("s", 60)), "line 60"); refused(chart(type: "line", series: ser("s", 61)), "line 61")
        ok(chart(type: "pie", series: ser("s", 8)), "pie 8"); refused(chart(type: "pie", series: ser("s", 9)), "pie 9")
        refused(chart(type: "pie", series: ser("s", 2) + "," + ser("t", 2)), "pie 2 series")
        ok(chart(type: "metric", series: ser("s", 4)), "metric 4"); refused(chart(type: "metric", series: ser("s", 5)), "metric 5")
        refused(chart(type: "metric", series: ser("s", 2) + "," + ser("t", 2)), "metric 2 series")
        refused(chart(series: ""), "no series"); refused(chart(series: ser("s", 0)), "no points")
    }

    @Test func lineSeriesShareLabelsInOrder() {
        let one = #"{"name":"a","points":[{"label":"x","value":1},{"label":"y","value":2}]}"#
        ok(chart(type: "line", series: one + "," + one.replacingOccurrences(of: #""a""#, with: #""b""#)), "same labels")
        refused(chart(type: "line", series: one + "," + #"{"name":"b","points":[{"label":"y","value":1},{"label":"x","value":2}]}"#), "reordered")
        refused(chart(type: "line", series: one + "," + #"{"name":"b","points":[{"label":"x","value":1},{"label":"z","value":2}]}"#), "different")
    }

    @Test func valueRulesMatchTheInstructions() {
        ok(chart(series: ser("s", 1, value: "1e12")), "1e12"); ok(chart(series: ser("s", 1, value: "-1e12")), "-1e12")
        refused(chart(series: ser("s", 1, value: "1.0000001e12")), "just over 1e12")
        refused(chart(series: ser("s", 1, value: "-1.0000001e12")), "just under -1e12")
        ok(chart(type: "pie", series: #"{"name":"s","points":[{"label":"a","value":0},{"label":"b","value":3}]}"#), "pie with a zero")
        refused(chart(type: "pie", series: #"{"name":"s","points":[{"label":"a","value":-1},{"label":"b","value":3}]}"#), "pie negative")
        refused(chart(type: "pie", series: ser("s", 3, value: "0")), "pie all zero")
        ok(chart(series: ser("s", 2, value: "-5")), "bar may be negative")
    }

    @Test func namesAndLabelsAreUnique() {
        refused(chart(series: ser("s", 1) + "," + ser("s", 1)), "duplicate series name")
        refused(chart(series: ser("s", 1) + "," + ser(" s ", 1)), "duplicate series name after trimming")
        refused(chart(series: #"{"name":"s","points":[{"label":"a","value":1},{"label":"a","value":2}]}"#), "duplicate label")
        refused(chart(series: #"{"name":"s","points":[{"label":"a","value":1},{"label":" a ","value":2}]}"#), "duplicate label after trimming")
        refused(chart(title: "a\u{202E}b"), "bidi character"); refused(chart(title: "a\u{0007}b"), "control character")
    }

    @Test func unknownKeysAreRefusedAtEveryLevel() {
        refused(chart(extra: #""colour":"red","#), "top")
        refused(chart(series: #"{"name":"s","colour":"red","points":[{"label":"a","value":1}]}"#), "series")
        refused(chart(series: #"{"name":"s","points":[{"label":"a","value":1,"note":"n"}]}"#), "point")
        refused(chart(extra: #""x":{"label":"X","unit":"u"},"#), "x axis")
        refused(chart(extra: #""y":{"label":"Y","unit":"u"},"#), "y axis")
    }

    @Test func eightKilobytesIsTheLimit() {
        let base = chart()
        let pad = 8 * 1024 - base.utf8.count
        ok(base + String(repeating: " ", count: pad), "exactly 8 KB")
        refused(base + String(repeating: " ", count: pad + 1), "8 KB + 1")
    }
}
