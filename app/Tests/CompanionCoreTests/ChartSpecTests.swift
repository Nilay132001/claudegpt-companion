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
        #expect(reason(with(#""value":4.2"#, #""value":1e400"#)) != nil)
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
}
