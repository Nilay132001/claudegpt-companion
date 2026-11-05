import SwiftUI

struct CenterMessage<Actions: View>: View {
    let title: String
    var detail: String? = nil
    var spinner = false
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 10) {
            if spinner { ProgressView() }
            Text(title).font(.headline).multilineTextAlignment(.center)
            if let detail {
                Text(detail).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).textSelection(.enabled)
            }
            actions
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

extension CenterMessage where Actions == EmptyView {
    init(title: String, detail: String? = nil, spinner: Bool = false) {
        self.init(title: title, detail: detail, spinner: spinner) { EmptyView() }
    }
}

/// A one-line notice with an optional action and a dismiss button.
struct Banner: View {
    enum Tone { case info, warning, danger }
    let text: String
    var tone: Tone = .info
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tone == .danger ? "exclamationmark.octagon.fill" : tone == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(tone == .danger ? Color.red : tone == .warning ? Color.orange : Color.accentColor)
            Text(text).font(.callout).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            if let actionTitle, let action { Button(actionTitle, action: action).buttonStyle(.link) }
            if let onDismiss { Button { onDismiss() } label: { Image(systemName: "xmark") }.buttonStyle(.borderless).help("Dismiss") }
        }
        .padding(8)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }
}
