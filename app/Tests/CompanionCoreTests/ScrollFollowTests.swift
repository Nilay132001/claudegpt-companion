import Foundation
import Testing
@testable import CompanionCore

@Suite struct ScrollFollowTests {
    @Test func followsAtFirst() {
        let f = ScrollFollow()
        #expect(f.following && !f.showsJumpToLatest)
    }

    @Test func anyUpwardScrollStopsFollowing() {
        // Task 4b: within 80 pt used to keep following, so each streamed delta pulled a reader who had scrolled up
        // 20 pt back to the bottom (the harness's "pullbacks"); they could never get away.
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 980, distanceFromBottom: 20)
        #expect(!f.following)
        #expect(!f.shouldStickToBottom)
        #expect(f.showsJumpToLatest) // shown (and ⌘↓ enabled) as soon as the reader is more than 2 pt up
        f.geometry(offset: 980, distanceFromBottom: 140) // a delta arrives below: the reader stays where they are
        #expect(!f.following)
        #expect(f.showsJumpToLatest)
    }

    @Test func scrollingUpWhileTextArrivesStillStopsFollowing() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 980, distanceFromBottom: 20 + 60) // up 20 pt, and 60 pt of text arrived in the same frame
        #expect(!f.following)
    }

    @Test func aSlowUpwardDriftStopsFollowing() {
        // A slow trackpad start: 0.3 pt per callback, below the old 0.5 pt test.
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 999.7, distanceFromBottom: 0.3)
        #expect(!f.following)
        #expect(!f.shouldStickToBottom)
    }

    @Test func jumpShowsJustAboveTheBottom() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 998.5, distanceFromBottom: 1.5)
        #expect(!f.following && !f.showsJumpToLatest)     // within 2 pt: no button
        f.geometry(offset: 997, distanceFromBottom: 3)
        #expect(f.showsJumpToLatest)
    }

    @Test func aRestoredChatNearTheBottomFollowsOnItsFirstGeometry() {
        // Intended: a chat restored with following: false whose first geometry is within 80 pt of the bottom is
        // treated as at the bottom and follows; further up it stays put.
        var near = ScrollFollow(following: false)
        near.geometry(offset: 900, distanceFromBottom: 60)
        #expect(near.following)
        var far = ScrollFollow(following: false)
        far.geometry(offset: 500, distanceFromBottom: 400)
        #expect(!far.following && far.showsJumpToLatest)
    }

    @Test func aLayoutCorrectionAboveIsNotAScrollUp() {
        // The lazy list measured rows above the viewport: offset and content height shrink together, the distance
        // from the bottom stays.
        var f = ScrollFollow()
        f.geometry(offset: 50_000, distanceFromBottom: 0)
        f.geometry(offset: 15_000, distanceFromBottom: 0)
        #expect(f.following)
    }

    @Test func followingSticksToTheBottomWhenItMovesAway() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        #expect(!f.shouldStickToBottom)
        f.geometry(offset: 1000, distanceFromBottom: 36) // the answer grew, or the panel was resized
        #expect(f.following && f.shouldStickToBottom)
        f.geometry(offset: 1036, distanceFromBottom: 0)  // scrolled back to the bottom
        #expect(f.following && !f.shouldStickToBottom)
    }

    @Test func scrollingDownNearTheBottomFollowsAgain() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 900, distanceFromBottom: 100)
        #expect(!f.following)
        f.geometry(offset: 900, distanceFromBottom: 140) // text arrives; the reader does not move
        #expect(!f.following)
        f.geometry(offset: 970, distanceFromBottom: 70)  // the reader scrolls down to within 80 pt
        #expect(f.following)
    }

    @Test func reachingTheBottomFollowsAgain() {
        var f = ScrollFollow(following: false)
        f.geometry(offset: 500, distanceFromBottom: 400)
        f.geometry(offset: 500, distanceFromBottom: 0.5)
        #expect(f.following)
    }

    @Test func scrollingUpPastTheThresholdStopsFollowing() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 900, distanceFromBottom: 100)
        #expect(!f.following)
        #expect(f.showsJumpToLatest)
    }

    @Test func contentGrowingBelowDoesNotStopFollowing() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 1000, distanceFromBottom: 240) // a big delta arrived; the offset did not move up
        #expect(f.following)
        #expect(!f.showsJumpToLatest)
    }

    @Test func comingBackNearTheBottomFollowsAgain() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 500, distanceFromBottom: 500)
        f.geometry(offset: 950, distanceFromBottom: 50)
        #expect(f.following)
    }

    @Test func followAgainAfterSendOrJump() {
        var f = ScrollFollow(following: false)
        f.geometry(offset: 10, distanceFromBottom: 900)
        #expect(f.showsJumpToLatest)
        f.followAgain()
        #expect(f.following && !f.showsJumpToLatest)
    }

    private func anchor(_ id: UUID = UUID(), inset: Double = 0) -> ChatScrollAnchor {
        ChatScrollAnchor(turn: id, inset: inset)
    }

    @Test func memoryKeepsOnlyPositionsAwayFromTheBottom() {
        var m = ChatScrollMemory()
        let a = anchor(inset: 42)
        m.save(session: "s1", anchor: a, following: false)
        m.save(session: "s2", anchor: anchor(), following: true)
        #expect(m.position(for: "s1") == a)
        #expect(m.position(for: "s2") == nil)
        m.save(session: "s1", anchor: a, following: true)
        #expect(m.position(for: "s1") == nil)
    }

    @Test func pastChatsAndSessionsKeepSeparatePositions() {
        var m = ChatScrollMemory()
        let live = anchor(), past = anchor()
        m.save(session: "t1", anchor: live, following: false)
        m.save(session: "past:" + "t1", anchor: past, following: false)
        #expect(m.position(for: "t1") == live)
        #expect(m.position(for: "past:t1") == past)
        #expect(m.position(for: "past:t2") == nil)
    }

    @Test func savingWithoutAVisibleTurnShowsTheBottom() {
        var m = ChatScrollMemory()
        m.save(session: "s1", anchor: anchor(), following: false)
        m.save(session: "s1", anchor: nil, following: false)
        #expect(m.position(for: "s1") == nil)
    }

    @Test func firstVisibleIsTheTurnUnderTheTopEdge() {
        var v = VisibleTurns()
        let a = UUID(), b = UUID(), c = UUID()
        v.set(a, minY: 0, maxY: 400)
        v.set(b, minY: 416, maxY: 1200)
        v.set(c, minY: 1216, maxY: 1500)
        let first = v.first(top: 500, viewportHeight: 700)
        #expect(first?.turn == b)
        #expect(first?.inset == 84)
    }

    @Test func firstVisibleInTheGapBetweenTurnsIsTheNextTurnAtInsetZero() {
        var v = VisibleTurns()
        let a = UUID(), b = UUID()
        v.set(a, minY: 0, maxY: 400)
        v.set(b, minY: 416, maxY: 1200)
        let first = v.first(top: 405, viewportHeight: 700)
        #expect(first?.turn == b && first?.inset == 0)
    }

    @Test func noFirstVisibleWithoutLaidOutTurnsInView() {
        var v = VisibleTurns()
        #expect(v.first(top: 0, viewportHeight: 700) == nil)
        let a = UUID()
        v.set(a, minY: 0, maxY: 400)
        #expect(v.first(top: 2000, viewportHeight: 700) == nil)   // only turns far above the viewport
        v.remove(a)
        #expect(v.first(top: 0, viewportHeight: 700) == nil)
    }

    @Test func aRestoredChatStartsNotFollowing() {
        // ChatView starts a chat with a saved position as ScrollFollow(following: false).
        let f = ScrollFollow(following: false)
        #expect(!f.following && !f.showsJumpToLatest) // shown once geometry reports it is above the bottom
    }

    // MARK: RestoreProgress and the restore anchor

    private func restore(inset: Double = 400) -> (RestoreProgress, UUID) {
        let id = UUID()
        return (RestoreProgress(anchor: ChatScrollAnchor(turn: id, inset: inset), deadline: .now + .seconds(3)), id)
    }

    @Test func unitYPutsTheReadingTopInsetPointsIntoTheTurn() {
        // turnTop + y·h = y·H with turnTop = −inset.
        let a = ChatScrollAnchor(turn: UUID(), inset: 1844, turnHeight: 3397, viewportHeight: 884)
        let y = a.unitY
        #expect(abs((-a.inset + y * a.turnHeight) - y * a.viewportHeight) < 1e-9)
        #expect(abs(y - 1844.0 / (3397 - 884)) < 1e-12)
        // A turn shorter than the reading area: y is negative and still satisfies the alignment.
        let s = ChatScrollAnchor(turn: UUID(), inset: 100, turnHeight: 300, viewportHeight: 884)
        #expect(abs((-s.inset + s.unitY * s.turnHeight) - s.unitY * s.viewportHeight) < 1e-9)
    }

    @Test func unitYIsTheTopWithoutAnInsetOrHeights() {
        #expect(ChatScrollAnchor(turn: UUID(), inset: 0, turnHeight: 3000, viewportHeight: 884).unitY == 0)
        #expect(ChatScrollAnchor(turn: UUID(), inset: 300).unitY == 0)
        #expect(ChatScrollAnchor(turn: UUID(), inset: 300, turnHeight: 884.5, viewportHeight: 884).unitY == 0)
    }

    @Test func firstVisibleRecordsTheHeightsForTheRestore() {
        var v = VisibleTurns()
        let a = UUID()
        v.set(a, minY: 1000, maxY: 4397)
        let f = v.first(top: 2844, viewportHeight: 884)
        #expect(f == ChatScrollAnchor(turn: a, inset: 1844, turnHeight: 3397, viewportHeight: 884))
    }

    @Test func aRestoreEndsWhenItsScrollHasLanded() {
        var (r, id) = restore()
        let other = UUID()
        r.step(offset: 5000, firstVisible: ChatScrollAnchor(turn: other, inset: 10), now: .now)
        #expect(!r.finished)
        r.step(offset: 2400, firstVisible: ChatScrollAnchor(turn: id, inset: 400), now: .now)
        #expect(r.finished && r.endReason == "landed")
    }

    @Test func aRestoreIsNotFooledByTheGeometryBeforeItsScroll() {
        // Before the scroll is applied the saved turn may be first visible at another inset: still in progress.
        var (r, id) = restore()
        r.step(offset: 5000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now)
        #expect(!r.finished)
        r.step(offset: 5400, firstVisible: ChatScrollAnchor(turn: id, inset: 400), now: .now)
        #expect(r.finished && r.endReason == "landed")
    }

    @Test func aScrollPhaseOrTheDeadlineEndsTheRestore() {
        var (r, id) = restore()
        r.readerScrolled()
        #expect(r.finished && r.endReason == "reader")
        var (r2, id2) = restore()
        r2.step(offset: 5000, firstVisible: ChatScrollAnchor(turn: id2, inset: 0), now: .now + .seconds(4))
        #expect(r2.finished && r2.endReason == "deadline")
        _ = id
    }

    @Test func holdKeepsARestoredChatFromFollowing() {
        // Swapping to a restored chat can land briefly at its bottom before the restore scrolls.
        var f = ScrollFollow(following: false)
        f.geometry(offset: 9000, distanceFromBottom: 0, hold: true)
        f.geometry(offset: 9000, distanceFromBottom: 0, hold: true)
        #expect(!f.following && !f.shouldStickToBottom)
        f.geometry(offset: 4000, distanceFromBottom: 5000, hold: true)   // the restore's scroll
        f.geometry(offset: 4000, distanceFromBottom: 5060)               // released; text arrives below
        #expect(!f.following)
    }
}
