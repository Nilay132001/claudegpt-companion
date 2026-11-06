import CompanionCore
import SwiftUI

/// The empty chat: what this is, what GPT sees, and four ways to start.
struct EmptyStateView: View {
    @Environment(AppModel.self) private var model
    @State private var showSees = false

    private struct Suggestion: Identifiable {
        let symbol: String
        let title: String
        let question: String?
        let needsContext: Bool
        var id: String { title }
    }

    private let suggestions = [
        Suggestion(symbol: "text.bubble", title: "Explain Claude's last message", question: nil, needsContext: true),
        Suggestion(symbol: "ladybug", title: "Review Claude's latest change for bugs",
                   question: "Review Claude's latest change for bugs. Point to file and line.", needsContext: false),
        Suggestion(symbol: "questionmark.circle", title: "What is Claude stuck on?",
                   question: "What is Claude stuck on right now, and what would you try next?", needsContext: true),
        Suggestion(symbol: "list.bullet", title: "Summarize this session so far",
                   question: "Summarize this Claude session so far: the goal, what changed, and what is still open.", needsContext: true),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: Design.Space.l) {
                VStack(spacing: Design.Space.s) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.system(size: 40))
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.tint)
                        .padding(.bottom, Design.Space.xs)
                        .accessibilityHidden(true)
                    Text("Ask GPT about this session")
                        .font(.title3.weight(.semibold))
                        .multilineTextAlignment(.center)
                    Text("GPT sees what you allow and can read this repository, read-only.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    Button("What GPT can see") { showSees.toggle() }
                        .buttonStyle(.link)
                        .font(.callout)
                        .popover(isPresented: $showSees, arrowEdge: .bottom) { WhatGPTSeesView() }
                }
                VStack(spacing: 2) {
                    ForEach(shown) { s in
                        Button { run(s) } label: {
                            Label {
                                Text(s.title)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            } icon: {
                                Image(systemName: s.symbol).foregroundStyle(.tint)
                            }
                        }
                        .buttonStyle(SuggestionButtonStyle())
                        .disabled(s.question == nil ? !model.canExplain : !model.canAskSuggestion)
                    }
                }
            }
            .frame(maxWidth: 340)
            .padding(.horizontal, Design.Space.l + 4)
            .padding(.vertical, Design.Space.xl)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center) { h, _ in h * 0.92 }
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    /// Suggestions that need session context are hidden in Off (ruling 20).
    private var shown: [Suggestion] {
        model.privacy?.sharingMode == .off ? suggestions.filter { !$0.needsContext } : suggestions
    }

    private func run(_ s: Suggestion) {
        Task {
            if let q = s.question { await model.ask(q) } else { await model.explainLastMessage() }
        }
    }
}

/// A suggestion on the canvas (D1): no box at rest, a soft fill on hover and press.
private struct SuggestionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        SuggestionRow(configuration: configuration)
    }

    private struct SuggestionRow: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var enabled
        @State private var hovering = false
        var body: some View {
            configuration.label
                .font(.callout)
                .padding(.horizontal, Design.Space.m)
                .padding(.vertical, Design.Space.s + 1)
                .background(Color.primary.opacity(configuration.isPressed ? 0.09 : hovering ? 0.05 : 0),
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(Rectangle())
                .opacity(enabled ? 1 : 0.45)
                .onHover { hovering = $0 }
                .animation(Design.Motion.quick, value: hovering)
        }
    }
}

extension AppModel {
    var canAskSuggestion: Bool { gate == .ready && !isAnswering }
}
