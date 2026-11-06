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
            mutate(sid) { $0.restore(turns) }
            for t in turns { records[t.turnId] = t }
            prewarm(store[sid]?.messages ?? [], rootOf: sid) { [weak self] in self?.feeds[sid] }
        } catch {
            if generation == gen, chatTokens[sid, default: 0] == token { loadedChats.remove(sid) } // try again at the next selection or reconnect
        }
    }

    /// Renders settled answers off the main thread, newest first (they show first), and hands each result to its
    /// message model in batches of 8. The cache key includes the root, and a session's chat and worktree load
    /// concurrently: wait for the worktree read in flight, then read the root, so the prewarmed chunks are the ones
    /// the views ask for.
    func prewarm(_ messages: [ChatMessage], rootOf sid: String?, into feed: @escaping @MainActor @Sendable () -> ChatFeed?) {
        let items = messages.reversed()
            .filter { $0.role == .assistant && !$0.isRunning && !$0.text.isEmpty }.map { ($0.id, $0.text) }
        guard !items.isEmpty else { return }
        let cache = renderCache, detail = detailLoad
        prewarmTask?.cancel()
        prewarmTask = Task { [weak self] in
            await detail?.value
            guard let self, !Task.isCancelled else { return }
            let root = sid.flatMap(self.root(for:))
            let work = Task.detached(priority: .utility) {
                var batch: [(UUID, String, RenderedAnswer)] = []
                // Newest first, within the cache's prewarm budget, so the newest stay resident; older answers
                // render on demand when scrolled to.
                var budget = cache.prewarmBudget
                for (i, (id, text)) in items.enumerated() where !Task.isCancelled {
                    let rendered = cache.prewarmAnswer(text, root: root, budget: &budget)
                    if let rendered { batch.append((id, text, rendered)) }
                    if !batch.isEmpty && (batch.count == 8 || i == items.count - 1 || rendered == nil) {
                        let done = batch
                        batch = []
                        await MainActor.run { for (id, text, r) in done { feed()?.setRendered(r, for: id, text: text) } }
                    }
                    if rendered == nil { break }   // budget spent
                }
            }
            await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        }
    }

    /// A session's root changed (its worktree resolved or moved): its answers render again with the new root.
    func rootMayHaveChanged(_ sid: String, from old: String?) {
        guard root(for: sid) != old else { return }
        flush(sid)
        prewarm(store[sid]?.messages ?? [], rootOf: sid) { [weak self] in self?.feeds[sid] }
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
            mutate(sid) { $0 = Conversation() }
            records = records.filter { $0.value.sessionId != sid }
            pastChat = nil
            pastFeed = nil
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
            // The past chat's answers render with the current root (as AnswerView does), so prewarm with that key.
            let feed = ChatFeed(), root = currentRoot
            feed.sync(c.messages) { self.render($0, isNew: $1, root: root) }
            pastChat = PastChat(summary: summary, messages: c.messages)
            pastFeed = feed
            prewarm(c.messages, rootOf: selectedSessionId) { [weak feed] in feed }
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
        pastFeed = nil
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
            for sid in Array(store.keys) where !(store[sid]?.isRunning ?? false) {
                let shown = store[sid]?.messages.contains { $0.threadId == t } ?? false
                if shown || current[sid] == t { mutate(sid) { $0 = Conversation() } }
            }
            records = records.filter { $0.value.threadId != t }
            if pastChat?.summary.threadId == t { pastChat = nil; pastFeed = nil }
        } else {
            for sid in Array(store.keys) where !(store[sid]?.isRunning ?? false) { mutate(sid) { $0 = Conversation() } }
            records = [:]
            pastChat = nil
            pastFeed = nil
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
