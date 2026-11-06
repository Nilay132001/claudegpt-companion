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
        let json = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard case .success(let spec) = ChartSpec.parse(json) else { Issue.record("the instructions example is refused"); return }
        #expect(spec.kind == .bar && spec.series.count == 1 && !spec.source.isEmpty)
    }
}
