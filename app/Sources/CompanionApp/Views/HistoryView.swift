import CompanionCore
import SwiftUI

/// History popover (spec "States › History"): search, Today / Earlier, open a past chat read-only, clear.
struct HistoryView: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    @State private var query = ""
    @State private var confirmClear: ChatSummary?
    @State private var confirmClearAll = false

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("History").font(.headline)
                Spacer()
            }
            .padding(.horizontal, Design.Space.l)
            .padding(.top, Design.Space.m)
            .padding(.bottom, Design.Space.s)
            TextField("Search chats", text: $query)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, Design.Space.m)
                .padding(.bottom, Design.Space.s)
            content
            Divider()
            HStack {
                if let h = model.history, !h.enabled {
                    Text("History is off. Settings › Privacy.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Clear All History…", role: .destructive) { confirmClearAll = true }
                    .buttonStyle(.borderless)
                    .font(.callout)
                    .disabled(model.history?.chats.isEmpty ?? true)
            }
            .padding(.horizontal, Design.Space.l)
            .padding(.vertical, Design.Space.s + 2)
        }
        .frame(width: 340, height: 440)
        .task(id: model.gate == .ready) {
            guard model.gate == .ready else { return }
            await model.loadHistory()
        }
        .confirmationDialog("Delete this chat?", isPresented: Binding(get: { confirmClear != nil }, set: { if !$0 { confirmClear = nil } }),
                            presenting: confirmClear) { c in
            Button("Delete Chat", role: .destructive) { Task { await model.clearHistory(threadId: c.threadId) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its questions, answers and the context that was sent are removed from this Mac.")
        }
        .confirmationDialog("Clear all chat history?", isPresented: $confirmClearAll) {
            Button("Clear All History", role: .destructive) { Task { await model.clearHistory(threadId: nil) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Every stored chat, answer and sent context is removed from this Mac. This can't be undone.")
        }
    }

    @ViewBuilder private var content: some View {
        if model.history == nil {
            VStack(spacing: Design.Space.s) {
                ProgressView().controlSize(.small)
                Text("Loading history…").font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            let sections = HistorySections.group(model.history?.chats ?? [], query: query)
            if sections.isEmpty {
                VStack(spacing: Design.Space.s) {
                    Image(systemName: "clock").font(.title2).foregroundStyle(.tertiary)
                    Text(query.isEmpty ? "No past chats yet" : "No chats match “\(query)”")
                        .font(.callout).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(sections) { section in
                        Section(section.title) {
                            ForEach(section.chats) { c in row(c) }
                        }
                    }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }
        }
    }

    private func isCurrent(_ c: ChatSummary) -> Bool { model.history?.currentThreads[c.sessionId] == c.threadId }

    private func row(_ c: ChatSummary) -> some View {
        Button { open(c) } label: {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.s) {
                Circle()
                    .fill(isCurrent(c) ? Color.accentColor : .clear)
                    .frame(width: 6, height: 6)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: c.sessionTitle ?? "Claude session").font(.callout.weight(.medium)).lineLimit(1)
                    Text(verbatim: c.firstQuestion).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                    Text(verbatim: meta(c)).font(.caption).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(c.sessionTitle ?? "Claude session"): \(c.firstQuestion). \(meta(c))")
        .contextMenu {
            Button("Open") { open(c) }
            Button("Copy Chat") {
                Task { if let md = await model.chatMarkdown(c) { Design.copy(md) } }
            }
            Divider()
            Button("Delete…", role: .destructive) { confirmClear = c }
        }
    }

    private func meta(_ c: ChatSummary) -> String {
        let when = Date(timeIntervalSince1970: c.lastAt / 1000).formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        var s = "\(c.turns) turn\(c.turns == 1 ? "" : "s") · \(when)"
        if isCurrent(c) { s += " · current" }
        return s
    }

    private func open(_ c: ChatSummary) {
        Task {
            if isCurrent(c) && c.sessionId == model.selectedSessionId {
                model.closePastChat()
            } else {
                await model.openPastChat(c)
            }
            close()
        }
    }
}
