import Foundation
import Testing
@testable import CompanionCore

@Suite struct CodeHighlighterTests {
    private func kinds(_ code: String, _ lang: String?) -> [(String, CodeToken)] {
        CodeHighlighter.tokens(code, language: lang).map { (String(code[$0.range]), $0.kind) }
    }

    @Test func swiftTokens() {
        let code = "func f() { let s = \"hi\" // note\n  return 0x1F + 42 } struct Foo {}"
        let k = kinds(code, "swift")
        #expect(k.contains { $0 == ("func", .keyword) })
        #expect(k.contains { $0 == ("\"hi\"", .string) })
        #expect(k.contains { $0 == ("// note", .comment) })
        #expect(k.contains { $0 == ("0x1F", .number) })
        #expect(k.contains { $0 == ("42", .number) })
        #expect(k.contains { $0 == ("Foo", .type) })
    }

    @Test func unknownOrNilLanguageIsNoOp() {
        #expect(CodeHighlighter.tokens("func x", language: "brainfuck").isEmpty)
        #expect(CodeHighlighter.tokens("func x", language: nil).isEmpty)
    }

    @Test func aliasesAndHashComments() {
        #expect(kinds("def a(): # c", "py").contains { $0 == ("# c", .comment) })
        #expect(kinds("const a = `t`", "TS").contains { $0 == ("`t`", .string) })
        #expect(kinds("\"\"\"doc\nx\"\"\"", "python").contains { $0.1 == .string && $0.0.hasPrefix("\"\"\"") })
    }

    @Test func unterminatedInputNeverCrashesAndNeverOverlaps() {
        for code in ["\"abc", "/* open", "'x", "`y", "\"\"\"z", "0x", "é\"ü", ""] {
            let t = CodeHighlighter.tokens(code, language: "swift")
            var last = code.startIndex
            for tok in t {
                #expect(tok.range.lowerBound >= last)
                #expect(tok.range.upperBound <= code.endIndex)
                last = tok.range.upperBound
            }
        }
    }

    @Test func hugeInputReturnsNothing() {
        #expect(CodeHighlighter.tokens(String(repeating: "func ", count: 30_000), language: "swift").isEmpty)
    }
}
