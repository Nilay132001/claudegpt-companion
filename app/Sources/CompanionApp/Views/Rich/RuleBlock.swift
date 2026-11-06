import SwiftUI

/// A thematic break: a hairline with 4 pt above and below (the separator colour at 1 pt under Increase Contrast).
struct RuleBlock: View {
    @Environment(\.colorSchemeContrast) private var contrast

    var body: some View {
        Rectangle()
            .fill(Design.Fill.hairline(contrast))
            .frame(height: Design.Fill.hairlineWidth(contrast))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .accessibilityHidden(true)
    }
}
