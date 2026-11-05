import CompanionCore
import SwiftUI

struct ChatView: View {
    @Environment(AppModel.self) private var model
    let messages: [ChatMessage]
    let readOnly: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(messages) { m in MessageView(message: m).id(m.id) }
                }
                .padding(10)
            }
            .onChange(of: messages.last?.text) {
                if let id = messages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
            }
        }
    }
}

struct MessageView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReadAloudController.self) private var readAloud
    let message: ChatMessage

    var body: some View {
        if message.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(message.text).textSelection(.enabled).padding(8)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !message.text.isEmpty { ReplyView(markdown: message.text, root: model.currentRoot) }
                if let a = message.activity {
                    Label(a, systemImage: "doc.text.magnifyingglass").font(.caption).foregroundStyle(.secondary)
                }
                footer
            }
            .padding(8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        }
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 10) {
            switch message.status {
            case .sending, .streaming:
                ProgressView().controlSize(.small)
                Text("Answering…").font(.caption).foregroundStyle(.secondary)
            case .interrupted:
                Text("Stopped").font(.caption).foregroundStyle(.secondary)
            case .failed(let why):
                Text(why).font(.caption).foregroundStyle(.red)
                if message.retry != nil {
                    Button("Send again") { Task { await model.sendAgain(message) } }.font(.caption)
                }
            case .done:
                EmptyView()
            }
            Spacer(minLength: 0)
            if !message.isRunning && !message.text.isEmpty {
                Button { readAloud.toggle(id: message.id, markdown: message.text) } label: {
                    Image(systemName: readAloud.icon(for: message.id))
                }
                .help(readAloud.isActive(message.id) ? "Pause or resume" : "Read aloud")
                if readAloud.isActive(message.id) {
                    Button { readAloud.stop() } label: { Image(systemName: "stop.fill") }.help("Stop reading")
                }
            }
            if message.turnId != nil {
                Button("View what was sent") { Task { await model.viewSent(message) } }.font(.caption)
            }
        }
        .buttonStyle(.borderless)
    }
}
