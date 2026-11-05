import CompanionCore
import SwiftUI

struct InputBar: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 6) {
            if model.privacy?.sharingMode != .off { // ruling 20
                Button("Explain Claude's last message") { Task { await model.explainLastMessage() } }
                    .buttonStyle(.link).font(.caption).disabled(!model.canExplain)
            }
            if case .recording(let live) = dictation.state, !live.isEmpty {
                Text(live).font(.callout).foregroundStyle(.secondary).lineLimit(3)
            }
            if let status = dictation.statusText {
                Text(status).font(.caption).foregroundStyle(dictation.isError ? .red : .secondary)
            }
            HStack(alignment: .bottom, spacing: 6) {
                TextField("Ask GPT about this Claude session", text: $model.draft, axis: .vertical)
                    .lineLimit(1...6)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await model.submitDraft() } }
                Button {
                    Task { await dictation.toggle(appendTo: { model.appendToDraft($0) }) }
                } label: {
                    Image(systemName: dictation.isRecording ? "mic.fill" : "mic")
                        .foregroundStyle(dictation.isRecording ? Color.red : Color.primary)
                }
                .help(dictation.isRecording ? "Stop dictation" : "Dictate")
                if model.isAnswering {
                    Button { Task { await model.interrupt() } } label: { Image(systemName: "stop.circle.fill") }.help("Stop the reply")
                } else {
                    Button { Task { await model.submitDraft() } } label: { Image(systemName: "arrow.up.circle.fill") }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!model.canSend)
                        .help("Send (⌘↩)")
                }
            }
            .buttonStyle(.borderless)
        }
        .padding(10)
    }
}
