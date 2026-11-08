import SwiftUI

/// H1/H2/H3 (deeper levels use the H3 size), semibold, read as a heading by VoiceOver.
struct HeadingBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let level: Int
    let text: AttributedString

    var body: some View {
        Text(text)
            .font(.system(size: Design.Typography.heading(level) * Design.Typography.scale(typeSize), weight: .semibold))
            .lineSpacing(2)
            .chatTextSelection()
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }
}
