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

    // MARK: RestoreProgress

    private func restore(inset: Double = 400) -> (RestoreProgress, UUID) {
        let id = UUID()
        return (RestoreProgress(anchor: ChatScrollAnchor(turn: id, inset: inset), deadline: .now + .seconds(3)), id)
    }

    @Test func restoreScrollsTheMarkerOnceTheTurnLandsAndStopsWhenThere() {
        var (r, id) = restore()
        let other = UUID()
        // The scroll to the turn, in two geometry steps (lazy layout), before it is first visible.
        do { let asked = r.step(offset: 5000, distanceFromBottom: 9000, firstVisible: ChatScrollAnchor(turn: other, inset: 10), now: .now); #expect(!asked) }
        do { let asked = r.step(offset: 3000, distanceFromBottom: 11000, firstVisible: nil, now: .now); #expect(!asked) }
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        do { let asked = r.step(offset: 2400, distanceFromBottom: 11600, firstVisible: ChatScrollAnchor(turn: id, inset: 400), now: .now); #expect(!asked) }
        #expect(r.finished)
    }

    @Test func restoreAsksAgainWhileItsMarkerScrollHasNotMoved() {
        var (r, id) = restore()
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        // Text arrived below (distance changed, offset did not): the marker scroll has not happened yet.
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12060, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        #expect(!r.finished && r.tries == 2)
    }

    @Test func aReaderScrollingInsideTheSavedTurnIsNeverPulledBack() {
        // The marker landed short; the reader then scrolls inside the same long turn: no further marker scroll.
        var (r, id) = restore(inset: 400)
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        do { let asked = r.step(offset: 2380, distanceFromBottom: 11620, firstVisible: ChatScrollAnchor(turn: id, inset: 380), now: .now); #expect(!asked) }
        #expect(r.finished) // its own scroll moved but missed: it does not keep scrolling
        // And when the reader moves before its scroll is asked for (landed at the turn top, then the reader scrolls):
        var (r2, id2) = restore(inset: 400)
        do { let asked = r2.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id2, inset: 0), now: .now); #expect(asked) }
        do { let asked = r2.step(offset: 2300, distanceFromBottom: 11700, firstVisible: ChatScrollAnchor(turn: id2, inset: 300), now: .now); #expect(!asked) }
        do { let asked = r2.step(offset: 2500, distanceFromBottom: 11500, firstVisible: ChatScrollAnchor(turn: id2, inset: 500), now: .now); #expect(!asked) }
        do { let asked = r2.step(offset: 2300, distanceFromBottom: 11700, firstVisible: ChatScrollAnchor(turn: id2, inset: 300), now: .now); #expect(!asked) }
        #expect(r2.finished && r2.tries == 1)
    }

    @Test func aScrollPhaseEndsTheRestore() {
        var (r, id) = restore()
        r.readerScrolled()
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(!asked) }
        #expect(r.finished)
    }

    @Test func leavingTheSavedTurnEndsTheRestore() {
        var (r, id) = restore()
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        // The marker scroll is still pending; the first visible turn is now another one.
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12010, firstVisible: ChatScrollAnchor(turn: UUID(), inset: 10), now: .now); #expect(!asked) }
        #expect(r.finished)
    }

    @Test func aLayoutCorrectionIsNotTheReader() {
        var (r, id) = restore()
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        // Rows above re-measured: offset and content height move together, the distance stays; the scroll is pending.
        do { let asked = r.step(offset: 1400, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now); #expect(asked) }
        #expect(!r.finished)
        do { let asked = r.step(offset: 1800, distanceFromBottom: 11600, firstVisible: ChatScrollAnchor(turn: id, inset: 400), now: .now); #expect(!asked) }
        #expect(r.finished)
    }

    @Test func theRestoreGivesUpAtItsDeadlineAndAfterThreeTries() {
        var (r, id) = restore()
        do { let asked = r.step(offset: 2000, distanceFromBottom: 12000, firstVisible: ChatScrollAnchor(turn: id, inset: 0), now: .now + .seconds(4)); #expect(!asked) }
        #expect(r.finished)
        // The marker never lays out (nothing moves): asked at most three times.
        var (r2, id2) = restore()
        var issued = 0
        for i in 0..<6 where r2.step(offset: 2000, distanceFromBottom: 12000 + Double(i),
                                     firstVisible: ChatScrollAnchor(turn: id2, inset: 0), now: .now) { issued += 1 }
        #expect(issued == RestoreProgress.maxTries)
        #expect(r2.finished)
    }
}
