import Foundation
import Testing
@testable import CompanionCore

@Suite struct FileReferencesTests {
    @Test func findsRelativeAndAbsoluteReferencesInsideTheRoot() {
        let text = "See src/app.ts:12 and /r/lib/x.swift:3:5, also ./README.md:1."
        let refs = FileReferences.find(in: text, root: "/r").map(\.reference)
        #expect(refs == [FileReference(path: "/r/src/app.ts", line: 12), FileReference(path: "/r/lib/x.swift", line: 3),
                         FileReference(path: "/r/README.md", line: 1)])
        let first = FileReferences.find(in: text, root: "/r")[0]
        #expect(text[first.range] == "src/app.ts:12")
    }

    @Test func refusesEverythingOutsideTheRoot() {
        #expect(FileReferences.find(in: "/etc/hosts.txt:1 ../up.ts:2 /r2/a.ts:3 a/../../b.ts:4", root: "/r").isEmpty)
        #expect(FileReferences.find(in: "src/app.ts:12", root: nil).isEmpty)
        #expect(FileReferences.find(in: "src/app.ts:0", root: "/r").isEmpty)
        #expect(FileReferences.find(in: "https://example.com:8080/x", root: "/r").isEmpty)
        #expect(FileReferences.contained("a/./b/../c.ts", root: "/r/") == "/r/a/c.ts")
        #expect(FileReferences.contained("x\u{0}.ts", root: "/r") == nil)
        #expect(FileReferences.contained("a.ts", root: "relative") == nil)
    }

    @Test func editorURLs() {
        let ref = FileReference(path: "/r/my dir/a.ts", line: 7)
        #expect(EditorLink.url(for: ref, editor: .vscode)?.absoluteString == "vscode://file/r/my%20dir/a.ts:7")
        #expect(EditorLink.url(for: ref, editor: .cursor)?.absoluteString == "cursor://file/r/my%20dir/a.ts:7")
        #expect(EditorLink.url(for: ref, editor: .system) == URL(fileURLWithPath: "/r/my dir/a.ts"))
        #expect(EditorLink.parseCompanionURL(EditorLink.companionURL(ref)) == ref)
        #expect(EditorLink.parseCompanionURL(URL(string: "https://example.com/?path=/r/a.ts&line=1")!) == nil)
        #expect(EditorLink.parseCompanionURL(URL(string: "companion-open://open?path=/r/a.ts&line=abc")!) == nil)
    }
}
