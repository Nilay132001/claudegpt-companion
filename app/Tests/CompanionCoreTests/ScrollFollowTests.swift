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

    @Test func aReaderJustAboveTheEndIsAboveTheBottomDespiteTheComposerInset() {
        // Final re-review: measured to the visible rect's bottom (which runs 88 pt under the composer) the distance
        // was -88 at rest and still clamped to 0 after 40 pt up: following stayed on and the stick pulled back.
        #expect(ScrollFollow.distance(contentHeight: 10_000, visibleMaxY: 10_088, bottomInset: 88) == 0)
        #expect(ScrollFollow.distance(contentHeight: 10_000, visibleMaxY: 10_048, bottomInset: 88) == 40)
        var f = ScrollFollow()
        f.geometry(offset: 9000, distanceFromBottom: ScrollFollow.distance(contentHeight: 10_000, visibleMaxY: 10_088, bottomInset: 88))
        f.geometry(offset: 8960, distanceFromBottom: ScrollFollow.distance(contentHeight: 10_000, visibleMaxY: 10_048, bottomInset: 88))
        #expect(!f.following && !f.shouldStickToBottom)
        #expect(f.showsJumpToLatest)
        // Text arriving below while they read: they stay where they are.
        f.geometry(offset: 8960, distanceFromBottom: ScrollFollow.distance(contentHeight: 10_200, visibleMaxY: 10_048, bottomInset: 88))
        #expect(!f.following && !f.shouldStickToBottom)
    }

    @Test func aReaderMoveSeenElsewhereStopsFollowing() {
        var f = ScrollFollow()
        f.readerMovedUp()
        #expect(!f.following && !f.shouldStickToBottom)
    }

    @Test func reArmsAtTheLastRowsRealEndWhenTheEstimatedEndIsFarBelow() {
        // After a Jump to latest the content's estimated end was 4–16k pt below the last row (final review I2).
        var f = ScrollFollow()
        f.geometry(offset: 10_000, distanceFromBottom: 5000, lastRowDistance: 0)
        f.geometry(offset: 9700, distanceFromBottom: 5300, lastRowDistance: 300) // the reader scrolls up 300 pt
        #expect(!f.following)
        f.geometry(offset: 9800, distanceFromBottom: 5200, lastRowDistance: 200) // back down, still 200 pt above
        #expect(!f.following && !f.rearmedByRow)
        #expect(f.showsJumpToLatest)
        f.geometry(offset: 9990, distanceFromBottom: 5010, lastRowDistance: 10)  // down, within 80 pt of the row's end
        #expect(f.following && f.rearmedByRow)
        #expect(!f.showsJumpToLatest)
        #expect(f.shouldStickToBottom) // the content distance is kept: the view sticks to the row (RowJump), not the marker
    }

    @Test func aContentShrinkUnderAReaderIsNotTheBottom() {
        // perf-stream, 40 pt up: a re-measure put the viewport 666 pt past the end for a tick, then the offset was
        // clamped back. Neither re-arms; the reader stays where they are.
        var f = ScrollFollow()
        f.geometry(offset: 301_627, distanceFromBottom: 0)
        f.geometry(offset: 301_587, distanceFromBottom: 40)
        #expect(!f.following)
        f.geometry(offset: 301_587, distanceFromBottom: -666)
        #expect(!f.following)
        f.geometry(offset: 300_921, distanceFromBottom: 0)
        #expect(!f.following)
        f.geometry(offset: 300_921, distanceFromBottom: 21)
        #expect(!f.following && f.showsJumpToLatest)
    }

    @Test func aRestoreInProgressNeverReArms() {
        // The position A/B: a restore must never re-arm following, by the content or by the row.
        var f = ScrollFollow(following: false)
        f.geometry(offset: 5000, distanceFromBottom: 6000, lastRowDistance: 900)
        f.geometry(offset: 9000, distanceFromBottom: 0, hold: true, lastRowDistance: 0)   // the restore lands low
        #expect(!f.following && !f.rearmedByRow)
        f.geometry(offset: 9100, distanceFromBottom: 10, hold: true, lastRowDistance: 0)
        #expect(!f.following && !f.rearmedByRow)
    }

    @Test func withoutAnOvershootTheRowsEndDoesNotReArm() {
        // While an answer streams the row's frame can lag a tick: 40 pt up read as 0 pt from its stale end. With the
        // content's end close to the row's (no overshoot), only the content distance counts.
        var f = ScrollFollow()
        f.geometry(offset: 9000, distanceFromBottom: 0, lastRowDistance: 0)
        f.geometry(offset: 8960, distanceFromBottom: 40, lastRowDistance: 0)   // the reader, 40 pt up; stale row end
        #expect(!f.following)
        f.geometry(offset: 8960, distanceFromBottom: 120, lastRowDistance: 0)  // a delta arrives: still up there
        #expect(!f.following && !f.rearmedByRow)
    }

    @Test func neverReArmsAboveTheLastRowsRealEnd() {
        var f = ScrollFollow(following: false)
        f.geometry(offset: 5000, distanceFromBottom: 6000, lastRowDistance: 900)
        #expect(!f.following)
        // Not scrolling down (a still tick), even at the row's end: no re-arm. Scrolling down to it: re-arm.
        f.geometry(offset: 5000, distanceFromBottom: 6000, lastRowDistance: 1)
        #expect(!f.following)
        f.geometry(offset: 5001, distanceFromBottom: 5999, lastRowDistance: 0)
        #expect(f.following && f.rearmedByRow)
        // Scrolling down but 81 pt above it: no.
        var g = ScrollFollow(following: false)
        g.geometry(offset: 5000, distanceFromBottom: 6000, lastRowDistance: 900)
        g.geometry(offset: 5100, distanceFromBottom: 5900, lastRowDistance: 81)
        #expect(!g.following)
    }

    @Test func withoutTheRowOnlyTheContentDistanceCounts() {
        var f = ScrollFollow(following: false)
        f.geometry(offset: 5000, distanceFromBottom: 6000)
        f.geometry(offset: 5100, distanceFromBottom: 5900, lastRowDistance: nil)
        #expect(!f.following && !f.rearmedByRow)
        // The content near its end re-arms by itself: not by the row.
        f.geometry(offset: 10_900, distanceFromBottom: 0, lastRowDistance: 0)
        #expect(f.following && !f.rearmedByRow)
    }

    @Test func aChatOpenedAtItsTopDoesNotChaseTheBottom() {
        // The `rich` demo opened at its top (300 pt): it started following, so its first geometry (offset 0, 1967 pt
        // above the bottom) scrolled it to the bottom, and the top shots showed the end of the chat.
        var top = ScrollFollow.opening(restored: false, atBottom: false)
        top.geometry(offset: 0, distanceFromBottom: 1967)
        #expect(!top.following && !top.shouldStickToBottom)
        #expect(top.showsJumpToLatest)
        // A chat opened at its bottom (every chat in the app) follows it; a restored one waits for its geometry.
        var bottom = ScrollFollow.opening(restored: false, atBottom: true)
        #expect(bottom.following)
        bottom.geometry(offset: 1967, distanceFromBottom: 0)
        #expect(bottom.following && !bottom.showsJumpToLatest)
        #expect(!ScrollFollow.opening(restored: true, atBottom: true).following)
        #expect(!ScrollFollow.opening(restored: true, atBottom: false).following)
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

    @Test func reachingTheBottomFollowsAgainButTheEndComingToTheReaderDoesNot() {
        // The end coming to the reader (the content shrinking, the panel growing) does not re-arm: after Page Up the
        // content shrank 17 pt under the reader, which read as the bottom and pulled them down (final re-review).
        var f = ScrollFollow(following: false)
        f.geometry(offset: 500, distanceFromBottom: 400)
        f.geometry(offset: 500, distanceFromBottom: 0.5)
        #expect(!f.following)
        f.geometry(offset: 520, distanceFromBottom: 0)   // the reader scrolls to the end
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
        let a = ChatScrollAnchor(turn: UUID(), inset: 1844)
        let y = a.unitY(turnHeight: 3397, viewportHeight: 884)
        #expect(abs(y - 1844.0 / (3397 - 884)) < 1e-12)
        #expect(abs(ChatScrollAnchor.landedInset(unitY: y, turnHeight: 3397, viewportHeight: 884) - 1844) < 1e-9)
        // A turn shorter than the reading area: y is negative and still lands on the inset.
        let s = ChatScrollAnchor(turn: UUID(), inset: 100)
        let ys = s.unitY(turnHeight: 300, viewportHeight: 884)
        #expect(ys < 0 && abs(ChatScrollAnchor.landedInset(unitY: ys, turnHeight: 300, viewportHeight: 884) - 100) < 1e-9)
    }

    @Test func unitYIsTheTopWithoutAnInsetOrHeights() {
        let a = ChatScrollAnchor(turn: UUID(), inset: 300)
        #expect(ChatScrollAnchor(turn: UUID(), inset: 0).unitY(turnHeight: 3000, viewportHeight: 884) == 0)
        #expect(a.unitY(turnHeight: 0, viewportHeight: 884) == 0)
        #expect(a.unitY(turnHeight: 884.5, viewportHeight: 884) == 0)
        #expect(a.unitY(turnHeight: 900, viewportHeight: 884) == 0)   // within ambiguousSpan
    }

    @Test func unitYIsClampedWhereItWouldMagnifyErrors() {
        // A turn 40 pt taller than the reading area: inset 600 would need y = 15.
        let a = ChatScrollAnchor(turn: UUID(), inset: 600)
        let y = a.unitY(turnHeight: 924, viewportHeight: 884)
        #expect(ChatScrollAnchor.unitYRange.contains(y) && y == 2)
        // The clamp lands nearer the saved line than the turn's top does.
        #expect(abs(600 - ChatScrollAnchor.landedInset(unitY: y, turnHeight: 924, viewportHeight: 884)) < 600)
    }

    @Test func driftInTheTurnOrViewportHeightMovesTheRestoredLineALittle() {
        // The restore computes y from the reading area's current height and the turn's saved height (its current
        // one is used when it is laid out); the turn may have changed by up to ±20 pt, the saved viewport by ±40 pt
        // (which the restore does not use). The line must land near where exact heights put it.
        let H = 884.0
        let cases: [(h: Double, inset: Double)] = [
            (300, 100), (500, 300), (850, 600), (870, 600), (900, 600), (920, 600), (884, 400), (1200, 200), (1200, 900),
            (3397, 1844), (3397, 3300), (4696, 4162), (6000, 10)]
        for (h, inset) in cases {
            for dh in [-20.0, 0, 20] { for dH in [-40.0, 0, 40] {
                let saved = ChatScrollAnchor(turn: UUID(), inset: inset, turnHeight: h + dh, viewportHeight: H + dH)
                let y = saved.unitY(turnHeight: saved.turnHeight, viewportHeight: H)
                let exactY = saved.unitY(turnHeight: h, viewportHeight: H)
                let landed = ChatScrollAnchor.landedInset(unitY: y, turnHeight: h, viewportHeight: H)
                let ideal = ChatScrollAnchor.landedInset(unitY: exactY, turnHeight: h, viewportHeight: H)
                // Within 25 pt where |y| ≤ 1.25 (the error is 20 pt × |y|), 40 pt up to |y| = 2. A turn within
                // ambiguousSpan + 20 pt of the reading area's height: the ±20 pt error can make it look within
                // ambiguousSpan, the turn is shown at its top, and the line is off by at most 2 × |h − H| < 80 pt.
                let ambiguous = abs(h - H) < ChatScrollAnchor.ambiguousSpan + 20
                let bound = ambiguous ? 2 * (ChatScrollAnchor.ambiguousSpan + 20) : abs(exactY) > 1.25 ? 40.0 : 25.0
                #expect(abs(landed - ideal) <= bound, "h \(h) inset \(inset) dh \(dh) dH \(dH): \(landed) vs \(ideal)")
                // Where the line is reachable with y in range, the ideal is the saved line itself.
                if ChatScrollAnchor.unitYRange.contains(inset / (h - H)) && abs(h - H) >= ChatScrollAnchor.ambiguousSpan {
                    #expect(abs(ideal - inset) < 1e-6)
                }
            } }
        }
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
        r.step(firstVisible: ChatScrollAnchor(turn: UUID(), inset: 10), now: .now)
        #expect(!r.finished)
        r.step(firstVisible: ChatScrollAnchor(turn: id, inset: 400), now: .now)
        #expect(r.finished && r.endReason == "landed")
    }

    @Test func aRestoreIsNotEndedByAnIntermediateLayoutPass() {
        // The scroll lands in two passes; the first shows the turn first visible at another inset. Saving then lost
        // the line in rapid switch-throughs.
        var (r, id) = restore()
        r.step(firstVisible: ChatScrollAnchor(turn: id, inset: 160), now: .now)
        #expect(!r.finished)
        r.step(firstVisible: ChatScrollAnchor(turn: id, inset: 401.5), now: .now)
        #expect(r.finished && r.endReason == "landed")
    }

    @Test func aRestoreLandsWhereItsClampedScrollAims() {
        let id = UUID()
        var r = RestoreProgress(anchor: ChatScrollAnchor(turn: id, inset: 600), expectedInset: 40, deadline: .now + .seconds(3))
        r.step(firstVisible: ChatScrollAnchor(turn: id, inset: 40), now: .now)
        #expect(r.finished && r.endReason == "landed")
    }

    @Test func theReaderJumpingOrTheDeadlineEndsTheRestore() {
        var (r, _) = restore()
        r.end("jump")
        #expect(r.finished && r.endReason == "jump")
        var (r2, id2) = restore()
        r2.step(firstVisible: ChatScrollAnchor(turn: id2, inset: 0), now: .now + .seconds(4))
        #expect(r2.finished && r2.endReason == "deadline")
    }

    @Test func releasedAtTheBottomFollowsAgain() {
        // The reader reached the bottom during the hold with input that has no scroll phase (the keyboard).
        var f = ScrollFollow(following: false)
        f.geometry(offset: 4000, distanceFromBottom: 5000, hold: true)
        f.geometry(offset: 9000, distanceFromBottom: 0, hold: true)
        #expect(!f.following)
        f.released()
        #expect(f.following)
        f.geometry(offset: 9000, distanceFromBottom: 120)   // the stream grows
        #expect(f.following && f.shouldStickToBottom)
        // Released above the bottom: still not following.
        var g = ScrollFollow(following: false)
        g.geometry(offset: 4000, distanceFromBottom: 5000, hold: true)
        g.released()
        #expect(!g.following)
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
