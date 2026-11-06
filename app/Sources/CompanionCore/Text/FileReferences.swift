import Foundation

public struct FileReference: Equatable, Sendable {
    /// Absolute and lexically inside the bound root.
    public let path: String
    public let line: Int
    public init(path: String, line: Int) {
        self.path = path
        self.line = line
    }
}

/// `path:line` references in GPT replies (spec §4.6, §8). Only paths inside the bound root are kept.
public enum FileReferences {
    public struct Match: Equatable, Sendable {
        public let range: Range<String.Index>
        public let reference: FileReference
    }

    // A path with an extension, then :line (and an optional :column). Not preceded by a path or URL character.
    static let regex = try! NSRegularExpression(
        pattern: #"(?<![\w/.~:-])((?:/|\./)?(?:[\w.@+-]+/)*[\w@+-][\w.@+-]*\.[A-Za-z0-9]{1,10}):([1-9][0-9]{0,6})(?::[0-9]+)?"#)

    public static func find(in text: String, root: String?) -> [Match] {
        guard let root else { return [] }
        let all = NSRange(text.startIndex..., in: text)
        return regex.matches(in: text, range: all).compactMap { m in
            guard let whole = Range(m.range, in: text), let p = Range(m.range(at: 1), in: text),
                  let l = Range(m.range(at: 2), in: text), let line = Int(text[l]),
                  let abs = contained(String(text[p]), root: root) else { return nil }
            return Match(range: whole, reference: FileReference(path: abs, line: line))
        }
    }

    /// Lexical containment: never touches the filesystem, never follows "..", refuses NUL.
    public static func contained(_ path: String, root: String) -> String? {
        guard !path.contains("\u{0}"), root.hasPrefix("/"), let base = normalize(root) else { return nil }
        let joined = path.hasPrefix("/") ? path : base + "/" + path
        guard let full = normalize(joined) else { return nil }
        return full == base || full.hasPrefix(base == "/" ? "/" : base + "/") ? full : nil
    }

    static func normalize(_ absolute: String) -> String? {
        var parts: [Substring] = []
        for c in absolute.split(separator: "/", omittingEmptySubsequences: true) {
            if c == "." { continue }
            if c == ".." {
                if parts.isEmpty { return nil }
                parts.removeLast()
                continue
            }
            parts.append(c)
        }
        return "/" + parts.joined(separator: "/")
    }
}

public enum FileDisplay {
    /// `path` relative to `root` when it is inside it (whole path components only), otherwise the file name.
    public static func relative(_ path: String, root: String?) -> String {
        if let root, !root.isEmpty {
            let prefix = root.hasSuffix("/") ? root : root + "/"
            if path.hasPrefix(prefix) { return String(path.dropFirst(prefix.count)) }
        }
        return path.split(separator: "/").last.map(String.init) ?? path
    }
}

public enum EditorLink {
    public static let scheme = "companion-open"

    public static func companionURL(_ ref: FileReference) -> URL {
        var c = URLComponents()
        c.scheme = scheme
        c.host = "open"
        c.queryItems = [URLQueryItem(name: "path", value: ref.path), URLQueryItem(name: "line", value: String(ref.line))]
        return c.url!
    }

    public static func parseCompanionURL(_ url: URL) -> FileReference? {
        guard url.scheme == scheme, let c = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let path = c.queryItems?.first(where: { $0.name == "path" })?.value, path.hasPrefix("/"),
              let line = c.queryItems?.first(where: { $0.name == "line" })?.value.flatMap({ Int($0) }), line > 0 else { return nil }
        return FileReference(path: path, line: line)
    }

    /// The URL to hand to NSWorkspace. Xcode is opened with `xed --line` by the app instead.
    public static func url(for ref: FileReference, editor: EditorChoice) -> URL? {
        switch editor {
        case .vscode, .cursor:
            var c = URLComponents()
            c.scheme = editor == .vscode ? "vscode" : "cursor"
            c.host = "file"
            c.path = "\(ref.path):\(ref.line)"
            return c.url
        case .auto, .xcode, .system:
            return URL(fileURLWithPath: ref.path)
        }
    }
}
