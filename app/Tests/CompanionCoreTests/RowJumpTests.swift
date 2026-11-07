import Foundation
import Testing
@testable import CompanionCore

@Suite struct RowJumpTests {
    let turn = UUID()
    let t0 = ContinuousClock.now

    @Test func staysWhileFollowingTheSameStillRow() {
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: nil, streaming: false); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
        #expect(j.landedHeight == 5000)
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000.4, streaming: false); #expect(r) } // layout noise
        // A row above measured: the row moves (its frame's position changes), its height does not: it stays.
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
    }

    @Test func endsOnUnfollowNewTurnOrGrowth() {
        var up = RowJump(turn: turn, at: t0)
        do { let r = up.update(lastTurn: turn, following: false, rowHeight: 5000, streaming: false); #expect(!r) } // the reader moved up
        var newTurn = RowJump(turn: turn, at: t0)
        do { let r = newTurn.update(lastTurn: UUID(), following: true, rowHeight: 5000, streaming: false); #expect(!r) }
        var grew = RowJump(turn: turn, at: t0)
        do { let r = grew.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
        do { let r = grew.update(lastTurn: turn, following: true, rowHeight: 5040, streaming: true); #expect(!r) } // an answer streaming into the row
    }

    @Test func aReMeasureWithoutStreamingDoesNotEndIt() {
        // A 1 pt width change reflows the row's text: taller, but nothing arrived below it.
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5032, streaming: false); #expect(r) }
        #expect(j.landedHeight == 5032)
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5040, streaming: true); #expect(!r) } // then the stream grows it
    }

    @Test func aScrollPhaseAloneDoesNotEndIt() {
        // Nothing in update() is about scroll phases: a downward nudge while following keeps the jump, so the next
        // seek still targets the row and never the marker past it.
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, rowHeight: 5000, streaming: false); #expect(r) }
        #expect(!j.atBottom(gapBelow: 40, slack: 18, now: t0)) // nudged past the row: seek the row again
    }

    @Test func atBottomWithinTheSlack() {
        let j = RowJump(turn: turn, at: t0)
        #expect(j.atBottom(gapBelow: 17, slack: 18, now: t0))
        #expect(j.atBottom(gapBelow: 0, slack: 18, now: t0))
        #expect(j.atBottom(gapBelow: -0.5, slack: 18, now: t0))
        #expect(!j.atBottom(gapBelow: -2, slack: 18, now: t0))   // the row ends below the reading area
        #expect(!j.atBottom(gapBelow: 18.5, slack: 18, now: t0)) // past the row
    }

    @Test func anUnreportedRowCountsAsAtTheBottomForOneSecondOnly() {
        let j = RowJump(turn: turn, at: t0)
        #expect(j.atBottom(gapBelow: nil, slack: 18, now: t0 + .milliseconds(999)))
        #expect(!j.atBottom(gapBelow: nil, slack: 18, now: t0 + .seconds(1)))
    }

    @Test func retriesAreCappedAndNeverFightTheReaderOrARestore() {
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.takeRetry(following: true, readerScrolling: true, restoring: false, noTurnVisible: true); #expect(!r) }
        do { let r = j.takeRetry(following: true, readerScrolling: false, restoring: true, noTurnVisible: true); #expect(!r) }
        do { let r = j.takeRetry(following: false, readerScrolling: false, restoring: false, noTurnVisible: true); #expect(!r) }
        do { let r = j.takeRetry(following: true, readerScrolling: false, restoring: false, noTurnVisible: false); #expect(!r) }
        #expect(j.retries == 0)
        do { let r = j.takeRetry(following: true, readerScrolling: false, restoring: false, noTurnVisible: true); #expect(r) }
        do { let r = j.takeRetry(following: true, readerScrolling: false, restoring: false, noTurnVisible: true); #expect(r) }
        do { let r = j.takeRetry(following: true, readerScrolling: false, restoring: false, noTurnVisible: true); #expect(!r) }
        #expect(j.retries == RowJump.maxRetries)
    }
}
