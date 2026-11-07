import Foundation

public struct ChartSpecError: Error, Equatable, Sendable {
    public let reason: String
    init(_ reason: String) { self.reason = reason }
}

public enum ChartBlockModel: Equatable, Sendable {
    case valid(ChartSpec)
    /// The fence as the parser read it (built once there, shown as code) and why it was refused.
    case invalid(code: CodeModel, reason: String)
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
    /// Arrays and objects inside each other; a valid spec needs 5 (root, series, a series, points, a point).
    public static let maxDepth = 6
    /// Above this many points in all, the spoken summary describes each series instead of listing every value.
    public static let maxSpokenPoints = 12

    public static func parse(_ json: String) -> Result<ChartSpec, ChartSpecError> {
        do { return .success(try validate(json)) } catch let e as ChartSpecError { return .failure(e) } catch {
            return .failure(ChartSpecError("the data is not valid JSON"))
        }
    }

    static func validate(_ json: String) throws -> ChartSpec {
        guard json.utf8.count <= maxBytes else { throw ChartSpecError("the data is larger than 8 KB") }
        // Before the (recursive) decoder sees it.
        guard nestingDepth(json) <= maxDepth else { throw ChartSpecError("the data is nested too deeply") }
        guard let root = try? JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)), case .object(let o) = root
        else { throw ChartSpecError("the data is not valid JSON") }
        try only(o, ["version", "type", "title", "units", "x", "y", "series", "source"])
        guard case .number(1)? = o["version"] else { throw ChartSpecError("version must be 1") }
        guard case .string(let t)? = o["type"], let kind = Kind(rawValue: t) else {
            throw ChartSpecError("type must be bar, line, pie or metric")
        }
        let title = try text(o["title"], 1...80, "title", "title must be 1–80 characters")
        let units: String? = try o["units"].map { try text($0, 0...16, "units", "units must be at most 16 characters") }
        let xLabel = try axis(o["x"], "x"), yLabel = try axis(o["y"], "y")
        guard case .array(let rawSeries)? = o["series"] else { throw ChartSpecError("series must be a list") }
        let seriesRange = (kind == .pie || kind == .metric) ? 1...1 : 1...4
        guard seriesRange.contains(rawSeries.count) else {
            throw ChartSpecError(seriesRange == 1...1 ? "a pie or metric chart needs exactly 1 series" : "a bar or line chart needs 1–4 series")
        }
        let pointRange = kind == .line ? 1...60 : kind == .metric ? 1...4 : kind == .pie ? 1...8 : 1...24
        var series: [Series] = [], names = Set<String>()
        for (si, raw) in rawSeries.enumerated() {
            guard case .object(let so) = raw else { throw ChartSpecError("series \(si + 1) must be an object") }
            try only(so, ["name", "points"])
            let name = try text(so["name"], 1...40, "series \(si + 1) name", "series \(si + 1) needs a name of 1–40 characters")
            guard names.insert(trimmed(name)).inserted else { throw ChartSpecError("series name \"\(name)\" appears twice") }
            guard case .array(let rawPoints)? = so["points"], pointRange.contains(rawPoints.count) else {
                if kind == .pie { throw ChartSpecError("a pie chart needs 1–8 points") }
                throw ChartSpecError("series \(si + 1) needs \(pointRange.lowerBound)–\(pointRange.upperBound) points")
            }
            var points: [Point] = [], seen = Set<String>()
            for (pi, rp) in rawPoints.enumerated() {
                let where_ = rawSeries.count > 1 ? " in series \(si + 1)" : ""
                guard case .object(let po) = rp else { throw ChartSpecError("point \(pi + 1)\(where_) must be an object") }
                try only(po, ["label", "value"])
                let label = try text(po["label"], 1...40, "point \(pi + 1)\(where_) label",
                                     "point \(pi + 1)\(where_) needs a label of 1–40 characters")
                guard seen.insert(trimmed(label)).inserted else { throw ChartSpecError("label \"\(label)\" appears twice in series \(si + 1)") }
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
        let source = try text(o["source"], 1...200, "source", "source must be 1–200 characters")
        return ChartSpec(kind: kind, title: title, units: units, xLabel: xLabel, yLabel: yLabel, series: series, source: source)
    }

    /// The deepest nesting of arrays and objects, counted outside strings in one linear pass.
    static func nestingDepth(_ json: String) -> Int {
        var depth = 0, deepest = 0, inString = false, escaped = false
        for b in json.utf8 {
            if inString {
                if escaped { escaped = false } else if b == 92 { escaped = true } else if b == 34 { inString = false }
                continue
            }
            switch b {
            case 34: inString = true
            case 91, 123: depth += 1; deepest = max(deepest, depth)
            case 93, 125: depth = max(0, depth - 1)
            default: break
            }
        }
        return deepest
    }

    private static func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func only(_ o: [String: JSONValue], _ allowed: Set<String>) throws {
        if let k = o.keys.sorted().first(where: { !allowed.contains($0) }) {
            throw ChartSpecError("unknown field \"\(k.prefix(40))\"")
        }
    }

    /// C0/C1 controls, format characters (the direction marks LRM, RLM and ALM, the bidi embedding, override and
    /// isolate controls, zero-width characters) and the line and paragraph separators: they would hide, split or
    /// reorder what is shown, so a label could read differently from its data row.
    static func hasControl(_ s: String) -> Bool {
        s.unicodeScalars.contains { u in
            switch u.properties.generalCategory {
            case .control, .format, .lineSeparator, .paragraphSeparator: true
            default: (0x202A...0x202E).contains(u.value) || (0x2066...0x2069).contains(u.value)
            }
        }
    }

    private static func text(_ v: JSONValue?, _ range: ClosedRange<Int>, _ field: String, _ why: String) throws -> String {
        guard case .string(let s)? = v, range.contains(s.count), s.unicodeScalars.count <= 4 * range.upperBound,
              range.lowerBound == 0 || !trimmed(s).isEmpty else { throw ChartSpecError(why) }
        guard !hasControl(s) else { throw ChartSpecError("\(field) has a control or text-direction character") }
        return s
    }

    private static func axis(_ v: JSONValue?, _ name: String) throws -> String? {
        guard let v else { return nil }
        guard case .object(let o) = v else { throw ChartSpecError("\(name) must be an object with a label") }
        try only(o, ["label"])
        return try text(o["label"], 1...40, "\(name) label", "\(name) needs a label of 1–40 characters")
    }

    /// Locale-independent: whole numbers without decimals; others to 2 decimals, or 2 significant digits below 1, so a
    /// small value never shows as 0. Never "-0".
    public static func format(_ v: Double) -> String {
        if v == 0 { return "0" }
        if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
        let a = abs(v)
        var s: String
        if a < 1e-6 {
            s = String(format: "%.2g", v)
        } else {
            let decimals = a < 1 ? max(2, Int((-log10(a)).rounded(.up)) + 1) : 2
            s = String(format: "%.\(decimals)f", v)
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s == "-0" ? "0" : s
    }

    /// The units after a value: " s", "%" (no space before a percent sign), or nothing.
    public var unitSuffix: String {
        guard let u = units, !u.isEmpty else { return "" }
        return u == "%" ? u : " " + u
    }

    static let spokenUnits = ["s": "seconds", "ms": "milliseconds", "min": "minutes", "h": "hours", "%": "percent",
                              "KB": "kilobytes", "MB": "megabytes", "GB": "gigabytes"]

    /// For Read Aloud and the VoiceOver summary: every value for small charts; above `maxSpokenPoints` points, each
    /// series as its count, first and last label, lowest, highest and last value (the Data table has them all).
    public var spokenSummary: String {
        let kindName = ["bar": "Bar chart", "line": "Line chart", "pie": "Pie chart", "metric": "Summary"][kind.rawValue]!
        let unit = units.map { " " + (Self.spokenUnits[$0] ?? $0) } ?? ""
        func value(_ v: Double) -> String { Self.format(v) + unit }
        let total = series.reduce(0) { $0 + $1.points.count }
        guard total > Self.maxSpokenPoints else {
            let parts = series.map { s in
                (series.count > 1 ? "\(s.name): " : "") + s.points.map { "\($0.label) \(value($0.value))" }.joined(separator: ", ")
            }
            return "\(kindName), \(title): \(parts.joined(separator: "; "))."
        }
        let parts = series.map { s -> String in
            let lo = s.points.min { $0.value < $1.value }!, hi = s.points.max { $0.value < $1.value }!
            let n = s.points.count
            return (series.count > 1 ? "\(s.name): " : "")
                + "\(n) point\(n == 1 ? "" : "s") from \(s.points.first!.label) to \(s.points.last!.label); "
                + "lowest \(value(lo.value)) on \(lo.label), highest \(value(hi.value)) on \(hi.label), last \(value(s.points.last!.value))"
        }
        return "\(kindName), \(title): \(parts.joined(separator: ". "))."
    }

    /// Every label across the series, in first-seen order (the category axis).
    public var categories: [String] {
        var seen = Set<String>(), out: [String] = []
        for s in series { for p in s.points where seen.insert(p.label).inserted { out.append(p.label) } }
        return out
    }

    public var plainText: String {
        ([title] + series.flatMap { s in s.points.map { (series.count > 1 ? s.name + "\t" : "") + "\($0.label)\t\(Self.format($0.value))" } })
            .joined(separator: "\n")
    }
}
