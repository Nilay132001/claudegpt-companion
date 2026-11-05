import AppKit
import CompanionCore
import UniformTypeIdentifiers

/// Hands a path:line to the user's editor. The app writes nothing. The link came from an untrusted reply, so only a
/// regular, non-package file of a safe type is opened (ruling 19); anything else is revealed in Finder or refused.
@MainActor enum FileOpener {
    static let refused: [UTType] = [.executable, .application, .applicationBundle, .bundle, .package, .shellScript,
                                    .script, .html, .xml, .svg, .webArchive, .internetLocation, .aliasFile, .symbolicLink]

    static func open(_ ref: FileReference, root: String, editor: EditorChoice) {
        let file = URL(fileURLWithPath: ref.path)
        // Lexical containment is not enough: a symlinked folder inside the root could point outside it.
        let realRoot = URL(fileURLWithPath: root).resolvingSymlinksInPath().path
        guard FileReferences.contained(file.resolvingSymlinksInPath().path, root: realRoot) != nil else { return }
        guard let v = try? file.resourceValues(forKeys: [.isRegularFileKey, .isPackageKey, .isSymbolicLinkKey, .contentTypeKey]),
              v.isSymbolicLink != true, v.isRegularFile == true, v.isPackage != true else { return }
        let type = v.contentType ?? .data
        if refused.contains(where: { type.conforms(to: $0) }) || FileManager.default.isExecutableFile(atPath: ref.path) {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            return
        }
        var chosen = editor
        if chosen == .auto {
            chosen = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "vscode://file/")!) != nil ? .vscode : .system
        }
        if chosen == .system && !(type.conforms(to: .plainText) || type.conforms(to: .sourceCode)) {
            NSWorkspace.shared.activateFileViewerSelecting([file])
            return
        }
        if chosen == .xcode {
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/xed")
            p.arguments = ["--line", String(ref.line), ref.path]
            try? p.run()
            return
        }
        if let url = EditorLink.url(for: ref, editor: chosen) { NSWorkspace.shared.open(url) }
    }
}
