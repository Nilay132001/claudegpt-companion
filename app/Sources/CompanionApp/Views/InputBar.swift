import AppKit
import CompanionCore
import SwiftUI

/// The composer (M8 desktop-style D7): one rounded field with a hairline border and a soft shadow on the window
/// background; the question on top, the control row below. Return sends, ⇧Return / ⌥Return insert a newline,
/// ⌘Return sends.
struct InputBar: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation
    @FocusState private var focused: Bool
    @State private var showSees = false

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: Design.Space.s) {
            if case .recording(let live) = dictation.state, !live.isEmpty {
                Text(verbatim: live).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            if let status = dictation.statusText {
                Text(verbatim: status).font(.caption).foregroundStyle(dictation.isError ? .red : .secondary)
            }
            TextField("Ask GPT about this session", text: $model.draft, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.body)
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit { send() }
                .onKeyPress(.return, phases: .down) { press in
                    // ⌥Return inserts a newline natively; ⇧Return asks the field editor for the same thing, so the
                    // newline goes in at the cursor.
                    guard press.modifiers.contains(.shift) else { return .ignored }
                    NSApp.sendAction(#selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)), to: nil, from: nil)
                    return .handled
                }
                .accessibilityLabel("Question for GPT")
            // Controls first get what the fixed buttons leave (layoutPriority), so they shrink, never overlap.
            HStack(spacing: Design.Space.xs) {
                ComposerControls(showSees: $showSees)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(1)
                    .foregroundStyle(.secondary)
                HStack(spacing: 2) {
                    if model.privacy?.sharingMode != .off && !model.currentMessages.isEmpty { explainButton } // ruling 20
                    micButton
                    sendButton
                }
                .fixedSize()
            }
            .padding(.leading, -Design.Space.xs) // the borderless menus carry their own inset
        }
        .padding(.horizontal, Design.Space.m)
        .padding(.top, Design.Space.m)
        .padding(.bottom, Design.Space.s)
        .background(Design.Fill.composer, in: RoundedRectangle(cornerRadius: Design.Radius.composer, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Design.Radius.composer, style: .continuous).strokeBorder(Design.Fill.hairline, lineWidth: 0.5))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .padding(.horizontal, Design.Space.m)
        .padding(.bottom, Design.Space.m)
        .padding(.top, Design.Space.xs)
        .onAppear { focused = true }
    }

    /// Kept reachable after the first turn (the empty state's suggestion is gone by then).
    private var explainButton: some View {
        Button { Task { await model.explainLastMessage() } } label: {
            Image(systemName: "text.bubble")
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(!model.canExplain)
        .help("Explain Claude's last message")
        .accessibilityLabel("Explain Claude's last message")
    }

    private var micButton: some View {
        Button {
            Task { await dictation.toggle(appendTo: { model.appendToDraft($0) }) }
        } label: {
            Image(systemName: dictation.isRecording ? "mic.fill" : "mic")
                .symbolEffect(.pulse, isActive: dictation.isRecording)
                .foregroundStyle(dictation.isRecording ? Color.red : Color.secondary)
                .frame(width: 26, height: 26)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .help(dictation.isRecording ? "Stop dictation" : "Dictate")
        .accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Dictate")
    }

    @ViewBuilder private var sendButton: some View {
        if model.isAnswering {
            Button { Task { await model.interrupt() } } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .help("Stop the reply")
            .accessibilityLabel("Stop the reply")
            .transition(.scale.combined(with: .opacity))
        } else {
            Button { send() } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(model.canSend ? Color.white : Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(model.canSend ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.quaternary), in: Circle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!model.canSend)
            .help("Send (Return or ⌘Return)")
            .accessibilityLabel("Send")
            .transition(.scale.combined(with: .opacity))
        }
    }

    private func send() {
        Task { await model.submitDraft() }
    }
}
