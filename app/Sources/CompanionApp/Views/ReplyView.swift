import CompanionCore
import SwiftUI

/// Renders a GPT reply through ReplyMarkdown only. The single link kind is companion-open (path:line inside the root).
struct ReplyView: View {
    @Environment(AppModel.self) private var model
    let markdown: String
    let root: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(ReplyMarkdown.blocks(markdown).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .environment(\.openURL, OpenURLAction { url in
            // Checked again here: the root may have changed since the reply was rendered.
            guard let ref = EditorLink.parseCompanionURL(url), let root,
                  let path = FileReferences.contained(ref.path, root: root) else { return .discarded }
            FileOpener.open(FileReference(path: path, line: ref.line), root: root, editor: model.settings.editor)
            return .handled
        })
    }

    @ViewBuilder private func view(for block: ReplyBlock) -> some View {
        switch block {
        case .paragraph(let t):
            Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled)
        case .heading(let level, let t):
            Text(ReplyMarkdown.inline(t, root: root)).font(level <= 2 ? .headline : .subheadline.bold())
        case .bullet(let t):
            HStack(alignment: .firstTextBaseline, spacing: 6) { Text("•"); Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled) }
        case .numbered(let marker, let t):
            HStack(alignment: .firstTextBaseline, spacing: 6) { Text(marker); Text(ReplyMarkdown.inline(t, root: root)).textSelection(.enabled) }
        case .quote(let t):
            Text(ReplyMarkdown.inline(t, root: root)).foregroundStyle(.secondary).padding(.leading, 8)
                .overlay(alignment: .leading) { Rectangle().frame(width: 2).foregroundStyle(.tertiary) }
        case .code(_, let code):
            ScrollView(.horizontal) {
                Text(code).font(.system(.callout, design: .monospaced)).textSelection(.enabled).padding(8)
            }
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 6))
        }
    }
}
