import SwiftUI

/// A display formula (`$$…$$`, `\[…\]`) shown as monospaced source on a faint fill: the platform has no LaTeX layout.
struct MathBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: Design.Typography.code * Design.Typography.scale(typeSize), design: .monospaced))
            .lineSpacing(Design.Typography.codeLineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "Formula: " + text))
    }
}
