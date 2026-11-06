import Foundation

/// A stored chat opened read-only from History.
public struct PastChat: Equatable, Sendable {
    public let summary: ChatSummary
    public let messages: [ChatMessage]
}

extension AppModel {
    /// Restores this session's stored turns in front of anything already shown. Once per session per connection.
    public func loadCurrentChat(sessionId sid: String) async {
        guard let api, !loadedChats.contains(sid) else { return }
        loadedChats.insert(sid)
        let gen = generation, token = chatTokens[sid, default: 0]
        loadingChats.insert(sid)
        defer { loadingChats.remove(sid) }
        do {
            let turns = try await api.historyTurns(sessionId: sid).turns
            guard generation == gen, chatTokens[sid, default: 0] == token, !Task.isCancelled else { return }
            if sendsInFlight[sid, default: 0] > 0 {
                // A send is between chat.send and its answer: restore after it attaches, so its turn is not added twice.
                loadedChats.remove(sid)
                reloadAfterSend.insert(sid)
                return
            }
            conversations[sid, default: Conversation()].restore(turns)
            for t in turns { records[t.turnId] = t }
        } catch {
            if generation == gen, chatTokens[sid, default: 0] == token { loadedChats.remove(sid) } // try again at the next selection or reconnect
        }
    }

    /// After a reply ends: the daemon now holds its context block and items. Only the newest turn is read and merged.
    func refreshRecords(sessionId sid: String) {
        guard let api else { return }
        let gen = generation, token = chatTokens[sid, default: 0]
        recordLoad = Task {
            guard let turns = try? await api.historyTurns(sessionId: sid, limit: 1).turns,
                  self.generation == gen, self.chatTokens[sid, default: 0] == token else { return }
            for t in turns { self.records[t.turnId] = t }
        }
    }

    /// ⌘K: the next question starts a new thread. Refused while GPT is answering.
    public func newChat() async {
        guard let api, let sid = selectedSessionId, !isAnswering else { return }
        chatTokens[sid, default: 0] += 1
        chatLoad?.cancel()
        do {
            try await api.chatNewChat(sessionId: sid)
            chatTokens[sid, default: 0] += 1
            conversations[sid] = Conversation()
            records = records.filter { $0.value.sessionId != sid }
            pastChat = nil
            threadNotices[sid] = nil
        } catch {
            errorMessage = Self.describe(error)
            // The restore cancelled above did not finish: read the current chat again.
            loadedChats.remove(sid)
            chatLoad = Task { await self.loadCurrentChat(sessionId: sid) }
        }
    }

    public func loadHistory() async {
        guard let api else { return }
        do { history = try await api.historyList() } catch { errorMessage = Self.describe(error) }
    }

    /// True while the selected session's stored chat is being read.
    public var isLoadingCurrentChat: Bool { selectedSessionId.map { loadingChats.contains($0) } ?? false }

    public func openPastChat(_ summary: ChatSummary) async {
        guard let api else { return }
        pastToken += 1
        let gen = generation, token = pastToken
        do {
            let turns = try await api.historyTurns(threadId: summary.threadId).turns
            guard generation == gen, pastToken == token else { return }
            var c = Conversation()
            c.restore(turns)
            for t in turns { records[t.turnId] = t }
            pastChat = PastChat(summary: summary, messages: c.messages)
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    /// A stored chat as Markdown for the clipboard, without opening it.
    public func chatMarkdown(_ summary: ChatSummary) async -> String? {
        guard let api, let turns = try? await api.historyTurns(threadId: summary.threadId).turns else { return nil }
        var c = Conversation()
        c.restore(turns)
        return CopyFormat.conversation(c.messages, contexts: [:], title: summary.sessionTitle ?? summary.firstQuestion, includeContext: false)
    }

    public func closePastChat() {
        pastToken += 1
        if let thread = pastChat?.summary.threadId {
            // Its records were added by openPastChat; keep those the current chats still show.
            let shown = Set(conversations.values.flatMap { $0.messages.compactMap(\.turnId) })
            records = records.filter { $0.value.threadId != thread || shown.contains($0.key) }
        }
        pastChat = nil
    }

    /// nil clears every stored chat.
    public func clearHistory(threadId: String?) async {
        guard let api else { return }
        let current = history?.currentThreads ?? [:]
        for sid in Array(conversations.keys) + Array(loadedChats) { chatTokens[sid, default: 0] += 1 }
        pastToken += 1
        chatLoad?.cancel()
        do {
            try await api.historyClear(threadId: threadId)
        } catch {
            errorMessage = Self.describe(error)
            return
        }
        if let t = threadId {
            for sid in conversations.keys where !(conversations[sid]?.isRunning ?? false) {
                let shown = conversations[sid]?.messages.contains { $0.threadId == t } ?? false
                if shown || current[sid] == t { conversations[sid] = Conversation() }
            }
            records = records.filter { $0.value.threadId != t }
            if pastChat?.summary.threadId == t { pastChat = nil }
        } else {
            for sid in conversations.keys where !(conversations[sid]?.isRunning ?? false) { conversations[sid] = Conversation() }
            records = [:]
            pastChat = nil
        }
        await loadHistory()
    }

    public func setHistoryEnabled(_ enabled: Bool) async {
        guard let api else { return }
        do {
            _ = try await api.historySetEnabled(enabled)
            await loadHistory()
        } catch { errorMessage = Self.describe(error) }
    }

    /// The exact context block sent with a turn, when it is stored.
    public func contextText(for turnId: String) -> String? {
        records[turnId].map(\.contextBlock).flatMap { $0.isEmpty ? nil : $0 }
    }

    public func conversationMarkdown(includeContext: Bool) -> String {
        CopyFormat.conversation(pastChat?.messages ?? currentMessages,
                                contexts: records.mapValues(\.contextBlock),
                                itemCounts: records.mapValues { $0.items.count },
                                title: pastChat.map { $0.summary.sessionTitle ?? $0.summary.firstQuestion } ?? selectedSession?.title,
                                includeContext: includeContext)
    }
}
