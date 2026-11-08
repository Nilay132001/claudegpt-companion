import Foundation

public enum CodeToken: Sendable, Equatable { case keyword, string, comment, number, type, plain }

/// A small single-pass tokenizer for syntax colors. Pure, linear, and a no-op for unknown languages.
public enum CodeHighlighter {
    /// Inputs over this many UTF-8 bytes are not highlighted.
    public static let maxBytes = 100 * 1024

    private enum Lang { case swift, js, python, go, rust, shell, json, yaml, ruby, java, kotlin, c }

    private static func lang(_ name: String?) -> Lang? {
        switch name?.trimmingCharacters(in: .whitespaces).lowercased() {
        case "swift": .swift
        case "ts", "typescript", "tsx", "js", "javascript", "jsx": .js
        case "py", "python": .python
        case "go": .go
        case "rs", "rust": .rust
        case "sh", "bash", "zsh", "shell": .shell
        case "json": .json
        case "yaml", "yml": .yaml
        case "rb", "ruby": .ruby
        case "java": .java
        case "kt", "kotlin": .kotlin
        case "c", "h", "cpp", "c++", "objc": .c
        default: nil
        }
    }

    private static let keywords: [Lang: Set<String>] = [
        .swift: ["func", "let", "var", "if", "else", "guard", "return", "struct", "class", "enum", "protocol", "extension", "import", "for", "in", "while", "switch", "case", "default", "break", "continue", "do", "try", "catch", "throw", "throws", "async", "await", "public", "private", "internal", "fileprivate", "open", "static", "final", "init", "self", "super", "nil", "true", "false", "where", "as", "is", "some", "any", "actor", "typealias", "defer", "inout", "override", "mutating", "lazy", "weak"],
        .js: ["function", "const", "let", "var", "if", "else", "return", "class", "extends", "import", "export", "from", "for", "while", "do", "switch", "case", "default", "break", "continue", "try", "catch", "finally", "throw", "new", "this", "super", "async", "await", "typeof", "instanceof", "in", "of", "null", "undefined", "true", "false", "interface", "type", "enum", "implements", "public", "private", "protected", "readonly", "static", "yield", "void"],
        .python: ["def", "class", "if", "elif", "else", "for", "while", "return", "import", "from", "as", "try", "except", "finally", "raise", "with", "pass", "break", "continue", "lambda", "yield", "None", "True", "False", "and", "or", "not", "in", "is", "global", "nonlocal", "async", "await", "assert", "del"],
        .go: ["func", "var", "const", "type", "struct", "interface", "map", "chan", "if", "else", "for", "range", "switch", "case", "default", "return", "break", "continue", "go", "defer", "select", "package", "import", "nil", "true", "false", "fallthrough", "goto"],
        .rust: ["fn", "let", "mut", "const", "static", "struct", "enum", "impl", "trait", "type", "use", "mod", "pub", "crate", "self", "Self", "super", "if", "else", "match", "for", "while", "loop", "in", "return", "break", "continue", "as", "where", "async", "await", "move", "ref", "unsafe", "dyn", "true", "false"],
        .shell: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "in", "function", "return", "exit", "export", "local", "readonly", "echo", "cd", "set", "unset", "source"],
        .json: ["true", "false", "null"],
        .yaml: ["true", "false", "null", "yes", "no"],
        .ruby: ["def", "end", "class", "module", "if", "elsif", "else", "unless", "while", "until", "for", "in", "do", "return", "yield", "begin", "rescue", "ensure", "raise", "require", "include", "self", "nil", "true", "false", "and", "or", "not", "then", "case", "when", "attr_accessor"],
        .java: ["class", "interface", "enum", "extends", "implements", "public", "private", "protected", "static", "final", "abstract", "void", "if", "else", "for", "while", "do", "switch", "case", "default", "return", "break", "continue", "try", "catch", "finally", "throw", "throws", "new", "this", "super", "import", "package", "null", "true", "false", "instanceof", "int", "long", "double", "float", "boolean", "char", "byte", "short"],
        .kotlin: ["fun", "val", "var", "class", "object", "interface", "data", "sealed", "enum", "if", "else", "when", "for", "while", "do", "return", "break", "continue", "try", "catch", "finally", "throw", "import", "package", "null", "true", "false", "is", "in", "as", "this", "super", "override", "private", "public", "internal", "protected", "open", "abstract", "suspend", "companion"],
        .c: ["if", "else", "for", "while", "do", "switch", "case", "default", "return", "break", "continue", "struct", "union", "enum", "typedef", "static", "const", "extern", "void", "int", "long", "short", "char", "float", "double", "unsigned", "signed", "sizeof", "class", "public", "private", "protected", "namespace", "template", "typename", "new", "delete", "nullptr", "true", "false", "NULL", "using", "include", "define", "@interface", "@implementation", "@end"],
    ]

    public static func tokens(_ code: String, language: String?) -> [(range: Range<String.Index>, kind: CodeToken)] {
        guard let lang = lang(language), !code.isEmpty, code.utf8.count <= maxBytes else { return [] }
        let words = keywords[lang] ?? []
        let hashComments = [.shell, .python, .ruby, .yaml].contains(lang)
        let slashComments = ![.shell, .python, .json, .yaml, .ruby].contains(lang)
        let backticks = lang == .js || lang == .go
        let typeNames = [.swift, .js, .java, .kotlin, .rust, .go].contains(lang)
        let tripleQuotes = lang == .python || lang == .swift || lang == .kotlin

        var out: [(range: Range<String.Index>, kind: CodeToken)] = []
        let chars = code
        var i = chars.startIndex
        func peek(_ at: String.Index, _ off: Int = 1) -> Character? {
            guard let j = chars.index(at, offsetBy: off, limitedBy: chars.endIndex), j < chars.endIndex else { return nil }
            return chars[j]
        }
        func isIdentStart(_ c: Character) -> Bool { c == "_" || c == "@" || c.isLetter }
        func isIdent(_ c: Character) -> Bool { c == "_" || c.isLetter || c.isNumber }

        while i < chars.endIndex {
            let c = chars[i]
            // Off the main actor, in a task the view cancels when it goes away: stop at a line boundary (final review
            // minor 7) instead of running to the end for a view that no longer exists.
            if c == "\n", Task.isCancelled { return [] }
            if slashComments, c == "/", peek(i) == "/" {
                let end = chars[i...].firstIndex(of: "\n") ?? chars.endIndex
                out.append((i..<end, .comment)); i = end; continue
            }
            if slashComments, c == "/", peek(i) == "*" {
                var j = chars.index(i, offsetBy: 2)
                var end = chars.endIndex
                while j < chars.endIndex {
                    if chars[j] == "*", peek(j) == "/" { end = chars.index(j, offsetBy: 2); break }
                    j = chars.index(after: j)
                }
                out.append((i..<end, .comment)); i = end; continue
            }
            if hashComments, c == "#" {
                let end = chars[i...].firstIndex(of: "\n") ?? chars.endIndex
                out.append((i..<end, .comment)); i = end; continue
            }
            if c == "\"" || c == "'" || (c == "`" && backticks) {
                if tripleQuotes, c == "\"" || (c == "'" && lang == .python), peek(i) == c, peek(i, 2) == c {
                    var j = chars.index(i, offsetBy: 3)
                    var end = chars.endIndex
                    while j < chars.endIndex {
                        if chars[j] == c, peek(j) == c, peek(j, 2) == c { end = chars.index(j, offsetBy: 3); break }
                        j = chars.index(after: j)
                    }
                    out.append((i..<end, .string)); i = end; continue
                }
                var j = chars.index(after: i)
                var end = chars.endIndex
                while j < chars.endIndex {
                    let d = chars[j]
                    if d == "\\" { j = chars.index(after: j); if j < chars.endIndex { j = chars.index(after: j) }; continue }
                    if d == c { end = chars.index(after: j); break }
                    if d == "\n", c != "`" { end = j; break }
                    j = chars.index(after: j)
                }
                out.append((i..<end, .string)); i = end; continue
            }
            if c.isASCII, c.isNumber {
                var j = chars.index(after: i)
                if c == "0", let x = peek(i), x == "x" || x == "X" { j = chars.index(i, offsetBy: 2) }
                while j < chars.endIndex, chars[j].isASCII, chars[j].isHexDigit || chars[j] == "_" || chars[j] == "." {
                    if chars[j] == ".", !(peek(j).map { $0.isASCII && $0.isNumber } ?? false) { break }
                    j = chars.index(after: j)
                }
                out.append((i..<j, .number)); i = j; continue
            }
            if isIdentStart(c) {
                var j = chars.index(after: i)
                while j < chars.endIndex, isIdent(chars[j]) { j = chars.index(after: j) }
                let word = String(chars[i..<j])
                if words.contains(word) { out.append((i..<j, .keyword)) }
                else if typeNames, let f = word.first, f.isUppercase { out.append((i..<j, .type)) }
                i = j; continue
            }
            i = chars.index(after: i)
        }
        return out
    }
}
