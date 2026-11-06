import SwiftUI

/// A run of paragraphs: one selectable Text, so a selection crosses the paragraphs of the run.
struct ProseBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let text: AttributedString

    var body: some View {
        Text(text)
            .font(.system(size: Design.Typography.answerBody * Design.Typography.scale(typeSize)))
            .lineSpacing(Design.Typography.answerLineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
