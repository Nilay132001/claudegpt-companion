import CompanionCore
import SwiftUI

/// Renders a GPT reply through ReplyMarkdown only. Each run of prose is ONE selectable Text (R7), so a selection can
/// cross paragraphs and list items. The single link kind is companion-open (path:line inside the root).
struct ReplyView: View {
    @Environment(AppModel.self) private var model
    let markdown: String
    let root: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            ForEach(Array(Self.segments(markdown, root: root).enumerated()), id: \.offset) { _, segment in
                switch segment {
                case .prose(let text):
                    Text(text)
                        .font(.body)
                        .lineSpacing(2)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let language, let code):
                    CodeBlockView(language: language, code: code)
                }
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

    static func segments(_ markdown: String, root: String?) -> [ReplySegment] {
        ReplyMarkdown.segments(markdown, root: root) { role, s in
            switch role {
            case .heading(let level): s.font = level <= 2 ? .title3.weight(.semibold) : .headline
            case .quote: s.foregroundColor = .secondary
            // A short line between blocks: about half a line of body text.
            case .gap: s.font = .system(size: 7)
            case .paragraph, .bullet, .numbered: break
            }
        }
    }
}
