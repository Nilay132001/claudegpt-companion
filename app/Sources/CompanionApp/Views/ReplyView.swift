import CompanionCore
import SwiftUI

/// Renders a GPT reply from its cached `RenderedAnswer` (parsed only by ReplyMarkdown). Each prose run is ONE
/// selectable Text (R7), so a selection can cross paragraphs and list items. Blocks are keyed by `BlockID`, so closed
/// blocks keep their identity while an answer streams. The single link kind is companion-open (path:line in the root).
struct ReplyView: View {
    @Environment(AppModel.self) private var model
    let answer: RenderedAnswer
    let root: String?

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.ReplyView")
        #endif
        VStack(alignment: .leading, spacing: Design.Space.m - 2) {
            ForEach(answer.blocks) { b in
                switch b.block {
                case .paragraphs(let text):
                    Text(text)
                        .font(.body)
                        .lineSpacing(Design.bodyLineSpacing)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .code(let language, let code, _):
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
}
