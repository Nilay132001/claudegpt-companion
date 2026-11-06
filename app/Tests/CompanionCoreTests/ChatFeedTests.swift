import Foundation
import Testing
@testable import CompanionCore

@MainActor @Suite struct ChatFeedTests {
    func msg(_ role: ChatMessage.Role, _ text: String, _ status: ChatMessage.Status = .done) -> ChatMessage {
        ChatMessage(id: UUID(), role: role, text: text, status: status)
    }

    @Test func pairsQuestionsWithAnswers() {
        let q1 = msg(.user, "q1"), a1 = msg(.assistant, "a1"), q2 = msg(.user, "q2"), q3 = msg(.user, "q3")
        #expect(ChatFeed.pair([q1, a1, q2, q3]) == [TurnRef(question: q1.id, answer: a1.id),
                                                     TurnRef(question: q2.id, answer: nil),
                                                     TurnRef(question: q3.id, answer: nil)])
        let lone = msg(.assistant, "a")
        #expect(ChatFeed.pair([lone]).map(\.id) == [lone.id])
    }

    @Test func syncChangesOnlyWhatChanged() {
        let feed = ChatFeed()
        let q = msg(.user, "q"), a = msg(.assistant, "", .streaming)
        var renders = 0
        let render: (ChatMessage, Bool) -> RenderedAnswer? = { _, _ in renders += 1; return .empty }
        feed.sync([q, a], render: render)
        #expect(feed.turns.count == 1 && feed.isRunning)
        let turnsChanged = Flag(), questionChanged = Flag()
        withObservationTracking { _ = feed.turns } onChange: { turnsChanged.set() }
        let qm = feed.model(q.id)!
        withObservationTracking { _ = qm.message } onChange: { questionChanged.set() }
        var a2 = a
        a2.text = "Hello"
        feed.sync([q, a2], render: render)
        #expect(feed.model(a.id)?.message.text == "Hello")
        #expect(!turnsChanged.on && !questionChanged.on)
        #expect(renders == 3)          // q (new), a (new), a (text changed); q unchanged is not re-rendered
    }

    @Test func removedMessagesDropTheirModels() {
        let feed = ChatFeed()
        let q = msg(.user, "q"), a = msg(.assistant, "a")
        feed.sync([q, a], render: { _, _ in nil })
        feed.sync([], render: { _, _ in nil })
        #expect(feed.isEmpty && feed.model(q.id) == nil)
    }

    @Test func lateRendersApplyOnlyToTheSameText() {
        let feed = ChatFeed()
        let a = msg(.assistant, "old")
        feed.sync([a], render: { _, _ in nil })
        let r = RenderedAnswer(blocks: [], plainText: "old")
        feed.setRendered(r, for: a.id, text: "stale")
        #expect(feed.model(a.id)?.rendered == nil)
        feed.setRendered(r, for: a.id, text: "old")
        #expect(feed.model(a.id)?.rendered == r)
    }
}
