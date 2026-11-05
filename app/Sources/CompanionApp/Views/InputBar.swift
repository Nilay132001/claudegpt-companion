import AppKit
import CompanionCore
import SwiftUI

/// The floating glass composer. Return sends, ⇧Return / ⌥Return insert a newline, ⌘Return sends.
struct InputBar: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation
    @FocusState private var focused: Bool

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
            HStack(spacing: Design.Space.s) {
                contextHint
                Spacer(minLength: Design.Space.xs)
                if model.privacy?.sharingMode != .off && !model.currentMessages.isEmpty { explainButton } // ruling 20
                micButton
                sendButton
            }
        }
        .padding(.horizontal, Design.Space.m + 2)
        .padding(.top, Design.Space.m)
        .padding(.bottom, Design.Space.s + 2)
        .panelGlass(in: RoundedRectangle(cornerRadius: Design.Radius.composer, style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
        .padding(.top, Design.Space.xs)
        .onAppear { focused = true }
    }

    private var contextHint: some View {
        let mode = model.privacy?.sharingMode ?? .ask
        return Label {
            Text(verbatim: mode.hint).lineLimit(1).truncationMode(.tail)
        } icon: {
            Image(systemName: mode == .off ? "eye.slash" : mode == .ask ? "checklist" : "bolt.horizontal")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .help("Context: \(mode.title). \(mode.detail)")
        .accessibilityLabel("Context: \(mode.title). \(mode.detail)")
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
