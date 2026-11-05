import Foundation
import Testing

/// Fitness rules over app/Sources (Global Constraints). Cheap, and they catch the dangerous regressions.
@Suite struct SourceRulesTests {
    static let sourcesDir = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "Sources")

    static func swiftFiles() -> [(name: String, text: String)] {
        let e = FileManager.default.enumerator(at: sourcesDir, includingPropertiesForKeys: nil)
        var out: [(name: String, text: String)] = []
        while let u = e?.nextObject() as? URL {
            if u.pathExtension == "swift", let t = try? String(contentsOf: u, encoding: .utf8) {
                out.append((name: u.lastPathComponent, text: t))
            }
        }
        return out
    }

    @Test func sourcesExist() { #expect(Self.swiftFiles().count >= 2) }

    @Test func neverTouchesClaudeDataOrCredentials() {
        let banned = ["/.claude", ".claude/", "claude-code-sessions", "messagingSocketPath", ".key\"",
                      "Application Support/Claude", "auth.json"]
        for f in Self.swiftFiles() {
            for b in banned { #expect(!f.text.contains(b), "\(f.name) contains \(b)") }
            if f.name != "JiraKeychain.swift" {
                for b in ["SecItem", "kSecClass"] { #expect(!f.text.contains(b), "\(f.name) contains \(b)") }
            }
        }
    }

    @Test func keychainOnlyForTheAppsOwnJiraItem() {
        let files = Self.swiftFiles().filter { $0.text.contains("SecItem") || $0.text.contains("kSecClass") }
        #expect(files.map(\.name) == ["JiraKeychain.swift"])
        if let k = files.first {
            #expect(k.text.contains("\"ClaudeGPT Companion Jira\""))
            #expect(!k.text.contains("kSecClassInternetPassword"))
            #expect(!k.text.contains("Codex"))
            #expect(!k.text.contains("Claude Code"))
        }
    }

    @Test func noConsoleLogging() {
        for f in Self.swiftFiles() {
            for b in ["print(", "NSLog(", "debugPrint(", "dump("] { #expect(!f.text.contains(b), "\(f.name) contains \(b)") }
        }
    }

    @Test func untrustedTextIsNeverParsed() {
        for f in Self.swiftFiles() {
            #expect(!f.text.contains("LocalizedStringKey("), "\(f.name) builds a LocalizedStringKey")
            if f.name != "ReplyMarkdown.swift" {
                #expect(!f.text.contains("AttributedString(markdown"), "\(f.name) parses markdown")
            }
        }
    }
}
