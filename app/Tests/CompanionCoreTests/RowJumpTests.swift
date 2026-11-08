import Foundation
import Testing
@testable import CompanionCore

@Suite struct RowJumpTests {
    let turn = UUID()
    let t0 = ContinuousClock.now

    @Test func endsOnUnfollowANewTurnOrTheReaderMovingUp() {
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000.3, gapBelow: 0, now: t0); #expect(r) } // noise
        var unfollow = j
        do { let r = unfollow.update(lastTurn: turn, following: false, offset: 1000, gapBelow: 0, now: t0); #expect(!r) }
        var newTurn = j
        do { let r = newTurn.update(lastTurn: UUID(), following: true, offset: 1000, gapBelow: 0, now: t0); #expect(!r) }
        // Up 40 pt (a wheel notch): the offset 40 smaller and the row's bottom 40 lower in the reading area, while
        // ScrollFollow still says following (its distance is 0 for the first ~88 pt above the end).
        var up = j
        do { let r = up.update(lastTurn: turn, following: true, offset: 960, gapBelow: -40, now: t0); #expect(!r) }
        #expect(up.endedByReader)
        #expect(!unfollow.endedByReader && !newTurn.endedByReader)
        // The row not reported: the offset alone decides.
        var unreported = j
        do { let r = unreported.update(lastTurn: turn, following: true, offset: 960, gapBelow: nil, now: t0); #expect(!r) }
    }

    @Test func growthAndReMeasuresAreNotTheReader() {
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0); #expect(r) }
        // The answer streams: the row's bottom moves down, the offset stays.
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: -60, now: t0); #expect(r) }
        // A row above is measured smaller: the offset drops, the row stays where it is on screen.
        do { let r = j.update(lastTurn: turn, following: true, offset: 700, gapBelow: -60, now: t0); #expect(r) }
        // Both in one tick (a re-measure above while a delta arrives): the offset drops 300, the row's bottom 20.
        do { let r = j.update(lastTurn: turn, following: true, offset: 400, gapBelow: -80, now: t0); #expect(r) }
        #expect(!j.endedByReader)
    }

    @Test func itsOwnSeekIsNotTheReaderWhileItSettles() {
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, offset: 1200, gapBelow: 200, now: t0); #expect(r) } // past the row
        j.seeked(at: t0)                                                                                      // seek the row
        do { let r = j.update(lastTurn: turn, following: true, offset: 1100, gapBelow: 100, now: t0 + .milliseconds(16)); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0 + .milliseconds(100)); #expect(r) }
        #expect(j.settling(at: t0 + .milliseconds(100)) && !j.settling(at: t0 + .milliseconds(300)))
        var animated = RowJump(turn: turn, at: t0)
        animated.seeked(at: t0, running: .milliseconds(400))
        #expect(animated.settling(at: t0 + .milliseconds(600)) && !animated.settling(at: t0 + .milliseconds(700)))
        // Just after the animation the chat settles up by itself, row and offset together: not the reader.
        do { let r = animated.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0 + .milliseconds(400)); #expect(r) }
        do { let r = animated.update(lastTurn: turn, following: true, offset: 846, gapBelow: -154, now: t0 + .milliseconds(434)); #expect(r) }
        #expect(!animated.endedByReader)
        // After the settle time, the same kind of move is the reader.
        do { let r = j.update(lastTurn: turn, following: true, offset: 960, gapBelow: -40, now: t0 + .milliseconds(300)); #expect(!r) }
    }

    @Test func aMoveUpWithoutAScrollPhaseEndsItEvenWhileASeekSettles() {
        // Final re-review N1: Page Up, arrows, VoiceOver report no scroll phase, and a seek's settle time used to
        // swallow their move, so the next seek pulled them back.
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0); #expect(r) }
        j.seeked(at: t0)
        // Within the settle time: up 300 pt (Page Up), the row's bottom 300 pt below the reading area's bottom.
        do { let r = j.update(lastTurn: turn, following: true, offset: 700, gapBelow: -300, now: t0 + .milliseconds(50)); #expect(!r) }
        #expect(j.endedByReader)
        // While a seek settles, its own move toward the band (from past the row) is not the reader.
        var k = RowJump(turn: turn, at: t0)
        do { let r = k.update(lastTurn: turn, following: true, offset: 1300, gapBelow: 300, now: t0); #expect(r) }
        k.seeked(at: t0)
        do { let r = k.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0 + .milliseconds(50)); #expect(r) }
        #expect(!k.endedByReader)
    }

    @Test func whileItsAnswerStreamsTheRowIsFollowedByItsBottom() {
        // The row growing does not end the jump (re-review N1), and a row that has grown past the reading area's
        // bottom is sought again, not left to the marker.
        var j = RowJump(turn: turn, at: t0)
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: 0, now: t0); #expect(r) }
        do { let r = j.update(lastTurn: turn, following: true, offset: 1000, gapBelow: -40, now: t0); #expect(r) } // grew
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: -40, slack: 18, now: t0))  // grew 40 pt below
        #expect(!j.seeksRow(following: true, jumping: false, gapBelow: 0, slack: 18, now: t0))   // at the bottom
        #expect(!j.seeksRow(following: true, jumping: false, gapBelow: -0.4, slack: 18, now: t0)) // noise
        #expect(j.seeksRow(following: true, jumping: false, gapBelow: -0.6, slack: 18, now: t0))
        #expect(!j.seeksRow(following: true, jumping: false, readerScrolling: true, gapBelow: -40, slack: 18, now: t0))
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

    @Test func aMarkerSeekFallsBackToTheRowOnlyWhenNothingIsDrawn() {
        #expect(RowJump.fallsBack(following: true, readerScrolling: false, restoring: false, noTurnVisible: true))
        #expect(!RowJump.fallsBack(following: true, readerScrolling: false, restoring: false, noTurnVisible: false))
        #expect(!RowJump.fallsBack(following: true, readerScrolling: true, restoring: false, noTurnVisible: true))
        #expect(!RowJump.fallsBack(following: true, readerScrolling: false, restoring: true, noTurnVisible: true))
        #expect(!RowJump.fallsBack(following: false, readerScrolling: false, restoring: false, noTurnVisible: true))
    }
}
