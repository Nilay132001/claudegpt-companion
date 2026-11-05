import Foundation
import Testing
@testable import CompanionCore

@MainActor @Suite struct HistoryTests {
    func turn(_ id: String, sid: String = "s1", thread: String = "t1", q: String = "SYNTHETIC FIXTURE q", a: String = "SYNTHETIC FIXTURE a",
              status: String = "completed", error: String? = nil, sentAt: Double = 1000) -> TurnRecord {
        TurnRecord(turnId: id, sessionId: sid, threadId: thread, sessionTitle: "SYNTHETIC FIXTURE one", mode: .automatic, question: q,
                   contextBlock: "CTX-\(id)", items: [TurnItem(kind: "user", label: "You", text: "x", redactions: 0, index: 0)],
                   answer: a, status: status, error: error, sentAt: sentAt)
    }

    func started(_ d: FakeDaemon) async -> AppModel {
        let m = AppModel(connector: { d.connection })
        await m.start()
        await m.detailLoad?.value
        return m
    }

    @Test func restoreShowsEarlierTurnsInOrder() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1", q: "first", a: "one"), turn("u2", q: "second", a: "two", status: "interrupted"),
                        turn("u3", q: "third", a: "", status: "failed", error: "boom"), turn("u4", q: "fourth", a: "", status: "running")]
        let m = await started(d)
        #expect(m.currentMessages.map(\.text) == ["first", "one", "second", "two", "third", "", "fourth", ""])
        let assistants = m.currentMessages.filter { $0.role == .assistant }
        #expect(assistants.map(\.status) == [.done, .interrupted, .failed("boom"), .failed("The reply did not finish.")])
        #expect(assistants.first?.turnId == "u1" && assistants.first?.threadId == "t1")
        #expect(m.currentMessages.first?.sentAt == Date(timeIntervalSince1970: 1))
        #expect(m.contextText(for: "u2") == "CTX-u2")
    }

    @Test func restoringTwiceDoesNotDuplicate() {
        var c = Conversation()
        let turns = [turn("u1"), turn("u2")]
        c.restore(turns)
        c.restore(turns)
        #expect(c.messages.count == 4)
        let id = c.begin(question: "live")
        c.attach(id, threadId: "t1", turnId: "u3")
        c.restore(turns + [turn("u3", q: "live", a: "")])
        #expect(c.messages.map(\.text) == ["SYNTHETIC FIXTURE q", "SYNTHETIC FIXTURE a", "SYNTHETIC FIXTURE q", "SYNTHETIC FIXTURE a", "live", ""])
    }

    @Test func loadingTheCurrentChatTwiceDoesNotDuplicate() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1")]
        let m = await started(d)
        await m.loadCurrentChat(sessionId: "s1")
        #expect(m.currentMessages.count == 2)
        #expect(d.calls.filter { $0 == "history.turns:session:s1" }.count == 1)
    }

    @Test func turnCompletedRefreshesRecords() async {
        let d = FakeDaemon()
        let m = await started(d)
        await m.ask("why")
        #expect(m.contextText(for: "u1") == nil)
        d.turnsStore = [turn("u1", q: "why", a: "because")]
        m.handle(.turnCompleted(TurnCompleted(sessionId: "s1", threadId: "t1", turnId: "u1", status: "completed", error: nil)))
        await m.recordLoad?.value
        #expect(m.contextText(for: "u1") == "CTX-u1")
        #expect(m.records["u1"]?.items.count == 1)
    }

    @Test func newChatCallsTheDaemonAndEmptiesTheChat() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1")]
        let m = await started(d)
        #expect(m.currentMessages.count == 2)
        await m.newChat()
        #expect(d.calls.contains("chat.newChat:s1"))
        #expect(m.currentMessages.isEmpty)
        #expect(m.records.isEmpty)
    }

    @Test func newChatIsRefusedWhileAnswering() async {
        let d = FakeDaemon()
        let m = await started(d)
        await m.ask("why")
        #expect(m.isAnswering)
        await m.newChat()
        #expect(!d.calls.contains { $0.hasPrefix("chat.newChat") })
        #expect(m.currentMessages.count == 2)
    }

    @Test func newChatErrorIsShown() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1")]
        d.newChatError = DaemonError(code: DaemonErrorCode.turnBusy, message: "busy")
        let m = await started(d)
        await m.newChat()
        #expect(m.errorMessage == "GPT is still answering. Wait or press Stop.")
        #expect(m.currentMessages.count == 2)
    }

    @Test func pastChatOpensReadOnlyAndCloses() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old", q: "old q", a: "old a"), turn("u1", thread: "t1")]
        let m = await started(d)
        await m.loadHistory()
        let old = try! #require(m.history?.chats.first { $0.threadId == "old" })
        await m.openPastChat(old)
        #expect(m.pastChat?.messages.map(\.text) == ["old q", "old a"])
        #expect(m.currentMessages.map(\.text) == ["SYNTHETIC FIXTURE q", "SYNTHETIC FIXTURE a"])
        #expect(!d.calls.contains { $0.hasPrefix("chat.send") })
        m.closePastChat()
        #expect(m.pastChat == nil)
    }

    @Test func askClosesAPastChat() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old")]
        let m = await started(d)
        await m.loadHistory()
        await m.openPastChat(m.history!.chats[0])
        #expect(m.pastChat != nil)
        await m.ask("new question")
        #expect(m.pastChat == nil)
    }

    @Test func clearHistoryEmptiesTheList() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old"), turn("u1", thread: "t1")]
        let m = await started(d)
        await m.loadHistory()
        #expect(m.history?.chats.count == 2)
        await m.clearHistory(threadId: nil)
        #expect(m.history?.chats.isEmpty == true)
        #expect(m.currentMessages.isEmpty)
        #expect(m.records.isEmpty)
    }

    @Test func clearingTheCurrentThreadClearsItsConversation() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old"), turn("u1", thread: "t1")]
        let m = await started(d)
        await m.loadHistory()
        await m.clearHistory(threadId: "t1")
        #expect(m.currentMessages.isEmpty)
        #expect(m.history?.chats.map(\.threadId) == ["old"])
    }

    @Test func historyToggleReloads() async {
        let d = FakeDaemon()
        let m = await started(d)
        await m.setHistoryEnabled(false)
        #expect(m.history?.enabled == false)
    }

    @Test func conversationMarkdownIncludesContextWhenAsked() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1", q: "why", a: "because")]
        let m = await started(d)
        #expect(m.conversationMarkdown(includeContext: true).contains("CTX-u1"))
        #expect(m.conversationMarkdown(includeContext: true).contains("Context sent (1 items)"))
        #expect(!m.conversationMarkdown(includeContext: false).contains("CTX-u1"))
    }

    @Test func conversationMarkdownUsesThePastChatWhenOpen() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old", q: "old q", a: "old a"), turn("u1", thread: "t1", q: "cur q")]
        let m = await started(d)
        await m.loadHistory()
        await m.openPastChat(m.history!.chats.first { $0.threadId == "old" }!)
        let md = m.conversationMarkdown(includeContext: true)
        #expect(md.contains("old q") && md.contains("CTX-o1") && !md.contains("cur q"))
    }

    @Test func historyModelsDecode() throws {
        func j<T: Decodable>(_ s: String, _ t: T.Type) throws -> T { try RPCCodec.value(JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)), as: t) }
        let list = try j(#"{"chats":[{"sessionId":"s1","threadId":"t1","sessionTitle":null,"firstQuestion":"q","turns":2,"startedAt":1000,"lastAt":2000}],"currentThreads":{"s1":"t1"},"enabled":true}"#, HistoryList.self)
        #expect(list.chats.first?.id == "t1" && list.chats.first?.sessionTitle == nil && list.enabled)
        #expect(list.currentThreads == ["s1": "t1"])
        let turns = try j(#"{"threadId":"t1","turns":[{"turnId":"u1","sessionId":"s1","threadId":"t1","sessionTitle":"T","mode":"ask","question":"q","contextBlock":"b","items":[{"kind":"user","label":"You","text":"x","redactions":1},{"kind":"user","label":"You","text":"y","redactions":0}],"omitted":3,"answer":"a","status":"running","error":null,"sentAt":1000,"completedAt":null}]}"#, HistoryTurns.self)
        let t = try #require(turns.turns.first)
        #expect(t.mode == .ask && t.omitted == 3 && t.completedAt == nil && t.error == nil && t.status == "running")
        #expect(t.items.map(\.id) == ["0", "1"] && t.items[0].redactions == 1)
        let none = try j(#"{"threadId":null,"turns":[]}"#, HistoryTurns.self)
        #expect(none.threadId == nil && none.turns.isEmpty)
    }

    @Test func lateLoadAfterNewChatIsDropped() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1")]
        d.turnsGate = true
        let m = AppModel(connector: { d.connection })
        let start = Task { await m.start() }
        for _ in 0..<200 where d.gateResume == nil { await Task.yield() }
        #expect(d.gateResume != nil)
        await m.newChat() // cancels the suspended load and bumps the token
        d.gateResume?.resume()
        await start.value
        await m.chatLoad?.value
        #expect(m.currentMessages.isEmpty)
        #expect(m.records.isEmpty)
    }

    @Test func restoreWaitsForASendInFlight() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("u1", q: "old", a: "older")]
        let m = AppModel(connector: { d.connection })
        d.turnsGate = true
        let start = Task { await m.start() }
        for _ in 0..<200 where d.gateResume == nil { await Task.yield() }
        // The restore read finishes while chat.send is still unanswered; the store already holds the live turn.
        d.duringSend = {
            d.turnsStore.append(self.turn("u1x", q: "live", a: ""))
            d.gateResume?.resume()
            for _ in 0..<50 { await Task.yield() }
        }
        d.sendResults = [.success(SendResult(threadId: "t1", turnId: "u1x"))]
        let ask = Task { await m.ask("live") }
        await ask.value
        await start.value
        await m.chatLoad?.value
        #expect(d.calls.contains("chat.send:p-auto"), "\(d.calls)")
        #expect(m.currentMessages.map(\.text) == ["old", "older", "live", ""], "\(m.currentMessages.map(\.text))")
    }

    @Test func rejectedQuestionKeepsThePastChatOpen() async {
        let d = FakeDaemon()
        d.turnsStore = [turn("o1", thread: "old")]
        let m = await started(d)
        await m.loadHistory()
        await m.openPastChat(m.history!.chats[0])
        #expect(await m.ask(String(repeating: "x", count: 20_001)) == false)
        #expect(m.pastChat != nil)
    }
}

@MainActor @Suite struct ChatMarkdownTests {
    @Test func copiesAStoredChatWithoutOpeningIt() async {
        let d = FakeDaemon()
        d.turnsStore = [TurnRecord(turnId: "u1", sessionId: "s1", threadId: "t1", sessionTitle: "SYNTHETIC FIXTURE one",
                                   question: "q1", answer: "a1", sentAt: 1)]
        let m = AppModel(connector: { d.connection })
        await m.start()
        let md = await m.chatMarkdown(ChatSummary(sessionId: "s1", threadId: "t1", sessionTitle: "SYNTHETIC FIXTURE one",
                                                  firstQuestion: "q1", turns: 1, startedAt: 1, lastAt: 1))
        #expect(md == "# GPT chat — SYNTHETIC FIXTURE one\n\n## You\nq1\n\n## GPT\na1\n")
        #expect(m.pastChat == nil)
    }
}
