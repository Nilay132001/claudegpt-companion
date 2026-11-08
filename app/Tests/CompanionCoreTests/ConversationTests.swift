import Foundation
import Testing
@testable import CompanionCore

@Suite struct ConversationTests {
    @Test func streamsDeltasIntoTheReply() {
        var c = Conversation()
        let id = c.begin(question: "What broke?")
        #expect(c.messages.map(\.role) == [.user, .assistant])
        #expect(c.messages[1].status == .sending)
        c.attach(id, threadId: "t", turnId: "u1")
        c.apply(.delta(turnId: "u1", itemId: "i1", text: "Hel"))
        c.apply(.delta(turnId: "u1", itemId: "i1", text: "lo"))
        c.apply(.delta(turnId: "u1", itemId: "i2", text: "Second part"))
        #expect(c.messages[1].text == "Hello\n\nSecond part")
        #expect(c.messages[1].status == .streaming)
        #expect(c.isRunning)
        c.apply(.completed(turnId: "u1", status: "completed", error: nil))
        #expect(c.messages[1].status == .done)
        #expect(!c.isRunning)
    }

    @Test func eventsBeforeAttachAreReplayed() {
        var c = Conversation()
        let id = c.begin(question: "q")
        c.apply(.delta(turnId: "u9", itemId: "i", text: "early"))
        c.apply(.completed(turnId: "u9", status: "completed", error: nil))
        #expect(c.messages[1].text == "")
        c.attach(id, threadId: "t", turnId: "u9")
        #expect(c.messages[1].text == "early")
        #expect(c.messages[1].status == .done)
    }

    @Test func toolActivityAndFinalStatuses() {
        var c = Conversation()
        let a = c.begin(question: "q")
        c.attach(a, threadId: "t", turnId: "u1")
        let tool = ItemSummary(id: "x", type: "mcpToolCall", server: "companion-readonly", tool: "read_file", status: nil)
        c.apply(.item(turnId: "u1", phase: "started", item: tool))
        #expect(c.messages[1].activity == "Reading the repository…")
        c.apply(.item(turnId: "u1", phase: "completed", item: tool))
        #expect(c.messages[1].activity == nil)
        c.apply(.completed(turnId: "u1", status: "interrupted", error: nil))
        #expect(c.messages[1].status == .interrupted)

        let b = c.begin(question: "q2")
        c.attach(b, threadId: "t", turnId: "u2")
        c.apply(.completed(turnId: "u2", status: "failed", error: "usage limit"))
        #expect(c.messages[3].status == .failed("usage limit"))
        let d = c.begin(question: "q3")
        c.attach(d, threadId: "t", turnId: "u3")
        c.apply(.completed(turnId: "u3", status: "abandoned", error: "Codex restarted before this reply finished. Ask again."))
        #expect(c.messages[5].status == .failed("Codex restarted before this reply finished. Ask again."))
        c.apply(.delta(turnId: "u2", itemId: "late", text: "ignored"))
        #expect(c.messages[3].text == "")
    }

    @Test func sameItemIdInTwoTurnsDoesNotMix() {
        var c = Conversation()
        let a = c.begin(question: "q1")
        c.attach(a, threadId: "t", turnId: "u1")
        c.apply(.delta(turnId: "u1", itemId: "msg", text: "first"))
        let b = c.begin(question: "q2")
        c.attach(b, threadId: "t", turnId: "u2")
        c.apply(.delta(turnId: "u2", itemId: "msg", text: "second"))
        #expect(c.messages[1].text == "first")
        #expect(c.messages[3].text == "second")
    }

    @Test func failDiscardAndStop() {
        var c = Conversation()
        let a = c.begin(question: "one")
        let retry = PendingSend(prepareId: "p1", removeItemIds: [], confirmed: true)
        c.fail(a, message: "GPT is still answering.", retry: retry)
        #expect(c.messages[1].status == .failed("GPT is still answering."))
        #expect(c.messages[1].retry == retry)
        #expect(c.question(before: a) == "one")
        let b = c.begin(question: "two")
        c.discard(b)
        #expect(c.messages.count == 2)
        let d = c.begin(question: "three")
        c.attach(d, threadId: "t", turnId: "u3")
        c.stopRunning(reason: "Codex restarted. Ask again.")
        #expect(c.messages[3].status == .failed("Codex restarted. Ask again."))
        #expect(c.owns(turnId: "u3"))
        #expect(c.message(forTurn: "u3")?.id == d)
    }

    @Test func earlyBufferIsBounded() {
        var c = Conversation()
        for t in 0..<50 { c.apply(.delta(turnId: "t\(t)", itemId: "i", text: "x")) }
        for _ in 0..<5_000 { c.apply(.delta(turnId: "t49", itemId: "i", text: "x")) }
        let id = c.begin(question: "q")
        c.attach(id, threadId: "t", turnId: "t49")
        #expect(c.messages[1].text.count == Conversation.earlyEventCap)
    }

    @Test func storedTurnsGetTheSameIdsOnEveryRestore() {
        let turns = [TurnRecord(turnId: "h1", sessionId: "s1", threadId: "t1", question: "q1", answer: "a1"),
                     TurnRecord(turnId: "h2", sessionId: "s1", threadId: "t1", question: "q2", answer: "a2")]
        var a = Conversation()
        a.restore(turns)
        let first = a.messages.map(\.id)
        a.restore(turns)
        #expect(a.messages.map(\.id) == first)
        var b = Conversation()
        b.restore(turns)
        #expect(b.messages.map(\.id) == first)
        #expect(Set(first).count == 4)
        #expect(first[0] == ChatMessage.storedID(turnId: "h1", role: .user))
        #expect(first[1] == ChatMessage.storedID(turnId: "h1", role: .assistant))
    }

    @Test func storedIdsDependOnTurnAndRoleOnly() {
        #expect(ChatMessage.storedID(turnId: "x", role: .user) == ChatMessage.storedID(turnId: "x", role: .user))
        #expect(ChatMessage.storedID(turnId: "x", role: .user) != ChatMessage.storedID(turnId: "x", role: .assistant))
        #expect(ChatMessage.storedID(turnId: "x", role: .user) != ChatMessage.storedID(turnId: "y", role: .user))
        // RFC 4122 variant and the name-based version nibble.
        let s = ChatMessage.storedID(turnId: "x", role: .user).uuidString
        #expect(Array(s)[14] == "5")
        #expect("89AB".contains(Array(s)[19]))
    }

    @Test func liveTurnsKeepTheirIdsAcrossARestore() {
        var c = Conversation()
        let a = c.begin(question: "live")
        c.attach(a, threadId: "t1", turnId: "u9")
        c.restore([TurnRecord(turnId: "u9", sessionId: "s1", threadId: "t1", question: "live", answer: "stored")])
        #expect(c.messages.map(\.id).contains(a))
        #expect(c.messages.count == 2)
    }
}
