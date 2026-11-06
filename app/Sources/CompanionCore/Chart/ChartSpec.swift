import Foundation

public struct ChartSpecError: Error, Equatable, Sendable {
    public let reason: String
    init(_ reason: String) { self.reason = reason }
}

public enum ChartBlockModel: Equatable, Sendable {
    case valid(ChartSpec)
    case invalid(json: String, reason: String)
}

/// A `companion-chart` block, accepted only when every rule in M9 §6 holds. All strings are shown verbatim.
public struct ChartSpec: Equatable, Sendable {
    public enum Kind: String, Sendable { case bar, line, pie, metric }
    public struct Point: Equatable, Sendable { public let label: String; public let value: Double }
    public struct Series: Equatable, Sendable { public let name: String; public let points: [Point] }
    public let kind: Kind
    public let title: String
    public let units: String?
    public let xLabel: String?
    public let yLabel: String?
    public let series: [Series]
    public let source: String

    public static let maxBytes = 8 * 1024

    public static func parse(_ json: String) -> Result<ChartSpec, ChartSpecError> {
        do { return .success(try validate(json)) } catch let e as ChartSpecError { return .failure(e) } catch {
            return .failure(ChartSpecError("the data is not valid JSON"))
        }
    }

    static func validate(_ json: String) throws -> ChartSpec {
        guard json.utf8.count <= maxBytes else { throw ChartSpecError("the data is larger than 8 KB") }
        guard let root = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), case .object(let o) = root
        else { throw ChartSpecError("the data is not valid JSON") }
        try only(o, ["version", "type", "title", "units", "x", "y", "series", "source"])
        guard case .number(1)? = o["version"] else { throw ChartSpecError("version must be 1") }
        guard case .string(let t)? = o["type"], let kind = Kind(rawValue: t) else {
            throw ChartSpecError("type must be bar, line, pie or metric")
        }
        let title = try text(o["title"], 1...80, "title must be 1–80 characters")
        let units: String? = try o["units"].map { try text($0, 0...16, "units must be at most 16 characters") }
        let xLabel = try axis(o["x"], "x"), yLabel = try axis(o["y"], "y")
        guard case .array(let rawSeries)? = o["series"] else { throw ChartSpecError("series must be a list") }
        let seriesRange = (kind == .pie || kind == .metric) ? 1...1 : 1...4
        guard seriesRange.contains(rawSeries.count) else {
            throw ChartSpecError(seriesRange == 1...1 ? "a pie or metric chart needs exactly 1 series" : "a bar or line chart needs 1–4 series")
        }
        let pointRange = kind == .line ? 1...60 : kind == .metric ? 1...4 : 1...24
        var series: [Series] = []
        for (si, raw) in rawSeries.enumerated() {
            guard case .object(let so) = raw else { throw ChartSpecError("series \(si + 1) must be an object") }
            try only(so, ["name", "points"])
            let name = try text(so["name"], 1...40, "series \(si + 1) needs a name of 1–40 characters")
            guard case .array(let rawPoints)? = so["points"], pointRange.contains(rawPoints.count) else {
                throw ChartSpecError("series \(si + 1) needs \(pointRange.lowerBound)–\(pointRange.upperBound) points")
            }
            var points: [Point] = [], seen = Set<String>()
            for (pi, rp) in rawPoints.enumerated() {
                let where_ = rawSeries.count > 1 ? " in series \(si + 1)" : ""
                guard case .object(let po) = rp else { throw ChartSpecError("point \(pi + 1)\(where_) must be an object") }
                try only(po, ["label", "value"])
                let label = try text(po["label"], 1...40, "point \(pi + 1)\(where_) needs a label of 1–40 characters")
                guard seen.insert(label).inserted else { throw ChartSpecError("label \"\(label)\" appears twice in series \(si + 1)") }
                guard case .number(let v)? = po["value"], v.isFinite else { throw ChartSpecError("value \(pi + 1)\(where_) is not a number") }
                guard abs(v) <= 1e12 else { throw ChartSpecError("value \(pi + 1)\(where_) is too large") }
                points.append(Point(label: label, value: v))
            }
            series.append(Series(name: name, points: points))
        }
        if kind == .pie {
            let values = series[0].points.map(\.value)
            guard values.allSatisfy({ $0 >= 0 }) else { throw ChartSpecError("pie values must be zero or more") }
            guard values.reduce(0, +) > 0 else { throw ChartSpecError("pie values must add up to more than zero") }
        }
        if kind == .line, let first = series.first?.points.map(\.label), series.contains(where: { $0.points.map(\.label) != first }) {
            throw ChartSpecError("line series must share the same labels in the same order")
        }
        let source = try text(o["source"], 1...200, "source must be 1–200 characters")
        return ChartSpec(kind: kind, title: title, units: units, xLabel: xLabel, yLabel: yLabel, series: series, source: source)
    }

    private static func only(_ o: [String: JSONValue], _ allowed: Set<String>) throws {
        if let k = o.keys.sorted().first(where: { !allowed.contains($0) }) {
            throw ChartSpecError("unknown field \"\(k.prefix(40))\"")
        }
    }

    private static func text(_ v: JSONValue?, _ range: ClosedRange<Int>, _ why: String) throws -> String {
        guard case .string(let s)? = v, range.contains(s.count),
              range.lowerBound == 0 || !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw ChartSpecError(why) }
        return s
    }

    private static func axis(_ v: JSONValue?, _ name: String) throws -> String? {
        guard let v else { return nil }
        guard case .object(let o) = v else { throw ChartSpecError("\(name) must be an object with a label") }
        try only(o, ["label"])
        return try text(o["label"], 1...40, "\(name) needs a label of 1–40 characters")
    }

    /// Locale-independent: whole numbers without decimals, others to at most 2 decimals.
    public static func format(_ v: Double) -> String {
        if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
        var s = String(format: "%.2f", v)
        while s.hasSuffix("0") { s.removeLast() }
        if s.hasSuffix(".") { s.removeLast() }
        return s
    }

    static let spokenUnits = ["s": "seconds", "ms": "milliseconds", "min": "minutes", "h": "hours", "%": "percent",
                              "KB": "kilobytes", "MB": "megabytes", "GB": "gigabytes"]

    public var spokenSummary: String {
        let kindName = ["bar": "Bar chart", "line": "Line chart", "pie": "Pie chart", "metric": "Summary"][kind.rawValue]!
        let unit = units.map { " " + (Self.spokenUnits[$0] ?? $0) } ?? ""
        let parts = series.map { s in
            (series.count > 1 ? "\(s.name): " : "") + s.points.map { "\($0.label) \(Self.format($0.value))\(unit)" }.joined(separator: ", ")
        }
        return "\(kindName), \(title): \(parts.joined(separator: "; "))."
    }

    public var plainText: String {
        ([title] + series.flatMap { s in s.points.map { (series.count > 1 ? s.name + "\t" : "") + "\($0.label)\t\(Self.format($0.value))" } })
            .joined(separator: "\n")
    }
}
