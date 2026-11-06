#if DEBUG
import CompanionCore
import Foundation

/// DEBUG-only (M9 phase 1): deterministic synthetic conversations for the perf scenes. Answers look like real GPT
/// replies in this app: headings, nested lists, pipe tables, several fenced code blocks (some long lines), long
/// paragraphs with emphasis, inline code and `path:line` references inside the demo root. Nothing leaves the process.
@MainActor enum PerfContent {
    /// A small LCG so every run builds the same text.
    struct Rng {
        var state: UInt64
        mutating func next() -> UInt64 {
            state = state &* 6364136223846793005 &+ 1442695040888963407
            return state >> 33
        }
        mutating func pick<T>(_ a: [T]) -> T { a[Int(next() % UInt64(a.count))] }
        mutating func int(_ r: ClosedRange<Int>) -> Int { r.lowerBound + Int(next() % UInt64(r.count)) }
    }

    static let files = ["src/parser/tokenize.ts", "src/parser/flush.ts", "packages/csv/src/writer.ts", "src/cli/main.ts",
                        "test/parser.test.ts", "Sources/Widgets/Parser.swift", "scripts/release.sh", "src/api/routes.py"]
    static let words = ["buffer", "token", "parser", "newline", "flush", "reader", "stream", "cell", "row", "quote",
                        "escape", "boundary", "state", "loop", "test", "fixture", "writer", "column", "header", "field",
                        "error", "retry", "cache", "index", "range", "offset", "width", "limit", "branch", "commit"]

    static func sentence(_ r: inout Rng, ref: Bool = false) -> String {
        let n = r.int(9...22)
        var w: [String] = (0..<n).map { _ in r.pick(words) }
        w[0] = w[0].prefix(1).uppercased() + w[0].dropFirst()
        if n > 6 { w[r.int(1...n - 2)] = "`" + r.pick(words) + "()`" }
        if n > 10 { let i = r.int(2...n - 3); w[i] = "**" + w[i] + "**" }
        if n > 14 { let i = r.int(3...n - 2); w[i] = "*" + w[i] + "*" }
        if ref { w.append("(see \(r.pick(files)):\(r.int(3...480)))") }
        return w.joined(separator: " ") + "."
    }

    static func paragraph(_ r: inout Rng, sentences: ClosedRange<Int>) -> String {
        (0..<r.int(sentences)).map { i in sentence(&r, ref: i == 1) }.joined(separator: " ")
    }

    static func list(_ r: inout Rng, numbered: Bool) -> String {
        var lines: [String] = []
        for i in 0..<r.int(3...6) {
            lines.append((numbered ? "\(i + 1). " : "- ") + sentence(&r, ref: i == 0))
            if !numbered, r.next() % 3 == 0 {
                for _ in 0..<r.int(1...3) { lines.append("  - " + sentence(&r)) }
            }
        }
        return lines.joined(separator: "\n")
    }

    static func table(_ r: inout Rng) -> String {
        var rows = ["| File | What changes | Risk |", "| --- | --- | :---: |"]
        for _ in 0..<r.int(3...6) {
            rows.append("| `\(r.pick(files)):\(r.int(3...400))` | \(sentence(&r)) | \(r.pick(["low", "medium", "high"])) |")
        }
        return rows.joined(separator: "\n")
    }

    static let swiftCode = """
    func tokenize(_ input: String) -> [Token] {
        var out: [Token] = []
        var buffer = ""
        for ch in input {
            if ch == "\\n" {
                flush(&buffer, into: &out) // a newline ends the current token
            } else {
                buffer.append(ch)
            }
        }
        flush(&buffer, into: &out)
        return out
    }

    private func flush(_ buffer: inout String, into out: inout [Token]) {
        guard !buffer.isEmpty else { return }
        out.append(Token(kind: .word, text: buffer, range: out.last.map { $0.range.upperBound..<($0.range.upperBound + buffer.count) } ?? 0..<buffer.count))
        buffer.removeAll(keepingCapacity: true)
    }
    """

    static let tsCode = """
    export async function writeRows(rows: Row[], out: Writable, opts: WriterOptions = {}): Promise<number> {
      const sep = opts.separator ?? ",";
      let written = 0;
      for (const row of rows) {
        const cells = row.cells.map((c) => (needsQuote(c, sep) ? `"${c.replaceAll('"', '""')}"` : c));
        if (!out.write(cells.join(sep) + "\\n")) {
          await once(out, "drain"); // back-pressure: wait before the next row so memory stays flat on big exports
        }
        written += 1;
      }
      return written;
    }

    function needsQuote(cell: string, sep: string): boolean {
      return cell.includes(sep) || cell.includes('"') || cell.includes("\\n") || cell.startsWith(" ") || cell.endsWith(" ");
    }
    """

    static let pyCode = """
    def load_fixture(path: str, *, strict: bool = True) -> list[dict]:
        rows = []
        with open(path, encoding="utf-8") as f:
            for n, line in enumerate(f, start=1):
                line = line.rstrip("\\n")
                if not line or line.startswith("#"):
                    continue
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError as e:
                    if strict:
                        raise ValueError(f"{path}:{n}: {e.msg}") from e
        return rows
    """

    static let shCode = """
    set -euo pipefail
    npm test -- parser --reporter=dot
    git diff --stat origin/main...HEAD -- src/parser test/parser.test.ts packages/csv/src/writer.ts packages/csv/test/writer.test.ts
    rg -n "flush\\(" src packages --glob '!**/dist/**'
    """

    static func code(_ r: inout Rng) -> String {
        let (lang, body) = r.pick([("swift", swiftCode), ("ts", tsCode), ("python", pyCode), ("bash", shCode)])
        return "```\(lang)\n\(body)\n```"
    }

    /// A block of more than 40 lines (the "Show all" preview case).
    static func longCode(_ r: inout Rng) -> String {
        let (lang, body) = r.pick([("swift", swiftCode), ("ts", tsCode)])
        return "```\(lang)\n" + (0..<3).map { _ in body }.joined(separator: "\n\n") + "\n```"
    }

    /// A block with lines of 180+ characters (the sideways-scroll case).
    static func wideCode(_ r: inout Rng) -> String {
        let line = "const result = await client.request({ method: \"POST\", path: \"/v2/ledger/reconcile\", headers: { \"x-request-id\": requestId, \"content-type\": \"application/json\" }, body: JSON.stringify({ entries, window: 72 }) });"
        return "```ts \(r.pick(files)):\(r.int(3...300))\nasync function run() {\n  \(line)\n  return result.status;\n}\n  \(line)\n```"
    }

    /// Code-heavy answer (scene perf-code): every answer has one to three code blocks, a quarter over 40 lines,
    /// a quarter with long lines.
    static func codeAnswer(_ r: inout Rng) -> String {
        var parts: [String] = [paragraph(&r, sentences: 2...3)]
        for _ in 0..<r.int(1...3) {
            parts.append("## " + sentence(&r).dropLast().split(separator: " ").prefix(5).joined(separator: " "))
            parts.append(paragraph(&r, sentences: 2...4))
            switch r.next() % 4 {
            case 0: parts.append(longCode(&r))
            case 1: parts.append(wideCode(&r))
            default: parts.append(code(&r))
            }
        }
        parts.append("Next: " + sentence(&r, ref: true))
        return parts.joined(separator: "\n\n")
    }

    /// A table of 2 to 6 columns and 3 to 8 rows (scene perf-table), alignments varied.
    static func wideTable(_ r: inout Rng) -> String {
        let heads = ["Name", "Count", "Status", "Owner", "Notes", "Latency"]
        let n = r.int(2...6)
        let aligns = (0..<n).map { _ in r.pick(["---", "---:", ":---:"]) }
        var rows = ["| " + heads.prefix(n).joined(separator: " | ") + " |", "| " + aligns.joined(separator: " | ") + " |"]
        for _ in 0..<r.int(3...8) {
            rows.append("| " + (0..<n).map { c in c == 1 ? "\(r.int(1...9999))" : r.pick(["ok", "late", "src/csv/write.ts", sentence(&r)]) }
                .joined(separator: " | ") + " |")
        }
        return rows.joined(separator: "\n")
    }

    /// Table-heavy answer (scene perf-table): every answer has one to three tables.
    static func tableAnswer(_ r: inout Rng) -> String {
        var parts: [String] = [paragraph(&r, sentences: 2...3)]
        for _ in 0..<r.int(1...3) {
            parts.append("## " + sentence(&r).dropLast().split(separator: " ").prefix(5).joined(separator: " "))
            parts.append(wideTable(&r))
        }
        parts.append("Next: " + sentence(&r, ref: true))
        return parts.joined(separator: "\n\n")
    }

    /// One answer: ~2–7 KB of Markdown, the kinds of blocks GPT uses here.
    static func answer(_ r: inout Rng, size: Int = 1) -> String {
        var parts: [String] = [paragraph(&r, sentences: 2...4)]
        for s in 0..<(r.int(2...4) * size) {
            parts.append((s % 2 == 0 ? "## " : "### ") + sentence(&r).dropLast().split(separator: " ").prefix(6).joined(separator: " "))
            parts.append(paragraph(&r, sentences: 3...7))
            switch r.next() % 5 {
            case 0: parts.append(list(&r, numbered: false))
            case 1: parts.append(list(&r, numbered: true))
            case 2: parts.append(table(&r))
            case 3: parts.append("> " + sentence(&r))
            default: parts.append(list(&r, numbered: false))
            }
            if r.next() % 2 == 0 { parts.append(code(&r)) }
            if r.next() % 3 == 0 { parts.append(paragraph(&r, sentences: 4...8)) }
        }
        parts.append("Next: " + sentence(&r, ref: true))
        return parts.joined(separator: "\n\n")
    }

    static func question(_ r: inout Rng) -> String {
        (0..<r.int(1...3)).map { _ in sentence(&r) }.joined(separator: " ").replacingOccurrences(of: "`", with: "")
            .replacingOccurrences(of: "*", with: "") + "?"
    }

    /// `count` stored turns for a session, oldest first, the newest ending a minute ago.
    static func turns(sessionId: String, count: Int, root: String, title: String) -> [TurnRecord] {
        var r = Rng(state: sessionId == "s1" ? 42 : 7)
        let now = Date().timeIntervalSince1970 * 1000
        let items = DemoDaemon.turnItems(DemoDaemon.items.prefix(4))
        let block = DemoDaemon.block(DemoDaemon.items.prefix(4))
        return (0..<count).map { i in
            let at = now - Double(count - i) * 120_000
            return TurnRecord(turnId: "\(sessionId)-t\(i)", sessionId: sessionId, threadId: "th-\(sessionId)", sessionTitle: title,
                              mode: .ask, question: question(&r), contextBlock: block, items: items, omitted: 0,
                              answer: DemoFlags.is_("perf-code") ? codeAnswer(&r) : DemoFlags.is_("perf-table") ? tableAnswer(&r) : answer(&r), sentAt: at, completedAt: at + 60_000)
        }
    }

    /// The answer perf-stream streams: long enough (~30 s at the demo rate) to outlast a measurement window.
    static let streamAnswer: String = {
        var r = Rng(state: 99)
        return answer(&r, size: 4)
    }()
}
#endif
