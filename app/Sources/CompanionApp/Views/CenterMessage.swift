import SwiftUI

/// A full-panel state: large symbol (or a spinner), title, one sentence, one prominent action.
struct GateView<Actions: View>: View {
    let symbol: String?
    var tint: Color = .secondary
    let title: String
    var detail: String? = nil
    var spinner = false
    @ViewBuilder var actions: Actions

    var body: some View {
        ScrollView {
            VStack(spacing: Design.Space.m) {
                if spinner {
                    ProgressView().controlSize(.regular).padding(.bottom, Design.Space.xs)
                } else if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 44, weight: .regular))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(tint)
                        .padding(.bottom, Design.Space.xs)
                        .accessibilityHidden(true)
                }
                Text(verbatim: title)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                if let detail {
                    Text(verbatim: detail)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                actions.padding(.top, Design.Space.s)
            }
            .frame(maxWidth: 320)
            .padding(.horizontal, Design.Space.xl)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center) { h, _ in h * 0.8 }
        }
        .scrollBounceBehavior(.basedOnSize)
        .accessibilityElement(children: .contain)
    }
}

extension GateView where Actions == EmptyView {
    init(symbol: String?, tint: Color = .secondary, title: String, detail: String? = nil, spinner: Bool = false) {
        self.init(symbol: symbol, tint: tint, title: title, detail: detail, spinner: spinner) { EmptyView() }
    }
}
