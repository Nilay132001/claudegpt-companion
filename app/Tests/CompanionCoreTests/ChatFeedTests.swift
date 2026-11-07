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

    @Test func aFeedNotShownDropsItsSettledRendersButNotAStreamingOne() {
        // Final review minor 6: memory must not grow with every session viewed.
        let feed = ChatFeed()
        let q = msg(.user, "q"), done = msg(.assistant, "done"), q2 = msg(.user, "q2"), live = msg(.assistant, "li", .streaming)
        feed.sync([q, done, q2, live], render: { _, _ in .empty })
        #expect(feed.model(done.id)?.rendered != nil && feed.model(live.id)?.rendered != nil)
        feed.dropRenders()
        #expect(feed.model(done.id)?.rendered == nil)
        #expect(feed.model(live.id)?.rendered != nil)
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
        feed.setRendered(r, for: a.id, text: "stale", root: nil)
        #expect(feed.model(a.id)?.rendered == nil)
        feed.setRendered(r, for: a.id, text: "old", root: nil)
        #expect(feed.model(a.id)?.rendered == r)
    }

    @Test func aRootChangeDropsRendersMadeWithTheOldRoot() {
        let feed = ChatFeed()
        let a = msg(.assistant, "a"), q = msg(.user, "q")
        let old = RenderedAnswer(blocks: [], plainText: "old root")
        feed.sync([q, a], root: "/r") { m, _ in m.role == .assistant ? old : nil }
        #expect(feed.model(a.id)?.rendered == old && feed.model(a.id)?.root == "/r")
        var asked: [Bool] = []
        feed.sync([q, a], root: "/r2") { m, isNew in asked.append(isNew); return nil }   // nothing cached for /r2
        #expect(asked == [true])                       // only the rendered answer is asked again, as new
        #expect(feed.model(a.id)?.rendered == nil && feed.model(a.id)?.root == "/r2" && feed.root == "/r2")
        feed.setRendered(old, for: a.id, text: "a", root: "/r")     // a late batch from before the change
        #expect(feed.model(a.id)?.rendered == nil)
        let fresh = RenderedAnswer(blocks: [], plainText: "new root")
        feed.setRendered(fresh, for: a.id, text: "a", root: "/r2")
        #expect(feed.model(a.id)?.rendered == fresh)
        var again = 0
        feed.sync([q, a], root: "/r2") { _, _ in again += 1; return nil }   // same root, same messages: nothing
        #expect(again == 0 && feed.model(a.id)?.rendered == fresh)
    }
}
