import Foundation
import Testing
@testable import CompanionCore

@Suite struct RowJumpTests {
    let turn = UUID()
    let t0 = ContinuousClock.now

    @Test func endsOnlyOnUnfollowOrANewTurn() {
        let j = RowJump(turn: turn, at: t0)
        #expect(j.update(lastTurn: turn, following: true))
        #expect(!j.update(lastTurn: turn, following: false))   // the reader moved up
        #expect(!j.update(lastTurn: UUID(), following: true))  // a new turn arrived
    }

    @Test func whileItsAnswerStreamsTheRowIsFollowedByItsBottom() {
        // The row growing does not end the jump (re-review N1), and a row that has grown past the reading area's
        // bottom is sought again, not left to the marker.
        let j = RowJump(turn: turn, at: t0)
        #expect(j.update(lastTurn: turn, following: true))
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: -40, slack: 18, now: t0))  // grew 40 pt below
        #expect(!j.seeksRow(following: true, jumping: false, gapBelow: 0, slack: 18, now: t0))   // at the bottom
        #expect(!j.seeksRow(following: true, jumping: false, gapBelow: -0.4, slack: 18, now: t0)) // noise
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: -0.6, slack: 18, now: t0))
    }

    @Test func seeksTheRowWhenNudgedPastItButNeverForAReaderOrDuringAnAnimatedJump() {
        let j = RowJump(turn: turn, at: t0)
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: 40, slack: 18, now: t0))   // past the row
        #expect(!j.seeksRow(following: false, jumping: false, gapBelow: 40, slack: 18, now: t0)) // a reader above
        #expect(!j.seeksRow(following: true, jumping: true, gapBelow: 40, slack: 18, now: t0))   // the jump runs
        // An unreported row: held for 1 s, then sought.
        #expect(!j.seeksRow(following: true, jumping: false, gapBelow: nil, slack: 18, now: t0 + .milliseconds(500)))
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: nil, slack: 18, now: t0 + .seconds(1)))
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
