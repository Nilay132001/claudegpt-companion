import Foundation

/// A Jump to latest that scrolled to the last turn's row instead of the bottom marker (ChatView). Pure: the view
/// reports what it sees and asks what to do.
///
/// The marker after the lazy stack marks only the content's estimated end. From far above, the rows near the end
/// are unmeasured, and their estimate can run more than a viewport over their real height: a scroll to the marker
/// then stops past the last row with nothing laid out (a blank chat). After an instant jump that estimated end was
/// measured 4–16k pt below the last row. So while a jump is active, every bottom seek goes to the row, anchored at
/// its bottom, including while its answer streams into it. "At the bottom" for the stick is the row's bottom within
/// `slack` of the reading area's bottom.
///
/// The jump ends when the reader stops following (any upward move), a new turn arrives or the chat switches
/// (`update`; the view clears it on a switch). It does not hand back to the marker when the answer finishes, even
/// once the content's estimated end is the row's bottom: handing back then, a 1 pt resize re-estimated the end and
/// left the 300 pt chat blank in 3 of 6 nudge runs. A scroll phase alone does not end it.
public struct RowJump: Equatable, Sendable {
    public let turn: UUID
    public let started: ContinuousClock.Instant
    public private(set) var retries = 0
    private var lastOffset: Double?
    private var lastGap: Double?
    private var ownSeekUntil: ContinuousClock.Instant?
    /// After a seek, moves within this long are the seek's (it can land over several layout passes).
    public static let seekSettle: Duration = .milliseconds(250)

    /// Retries of the safety net, at most.
    public static let maxRetries = 2
    /// How long a row that has not reported a frame still counts as at the bottom.
    public static let unreportedHold: Duration = .seconds(1)

    public init(turn: UUID, at now: ContinuousClock.Instant) {
        self.turn = turn
        self.started = now
    }

    /// One geometry update. False when the jump has ended: `lastTurn` is another turn (a new one arrived), the
    /// reader is no longer following, or the reader moved up (`endedByReader` then true: the view stops following).
    /// Moving up is the chat's offset getting smaller *and* the row's bottom moving down in the reading area
    /// (`gapBelow` smaller). That catches input without a scroll phase too (the keyboard, VoiceOver, scroller arrows),
    /// which nothing else reports. A row growing (its answer streaming) moves its bottom down with the offset
    /// unchanged; a row above being measured changes the offset with the row unmoved on screen; neither ends it.
    /// While a seek settles (`seeked`) its own moves are not the reader's: a seek only brings the row's bottom toward
    /// the reading area's bottom, so a move up that takes the row's bottom below it (`gapBelow` < -0.5) is still the
    /// reader. With the row not reported (`gapBelow` nil), the offset alone decides, outside the settle time.
    public mutating func update(lastTurn: UUID?, following: Bool, offset: Double, gapBelow: Double?,
                                now: ContinuousClock.Instant) -> Bool {
        defer { lastOffset = offset; lastGap = gapBelow }
        guard lastTurn == turn, following else { return false }
        guard let last = lastOffset, offset < last - 0.5 else { return true }
        // The row moved down on screen by about what the offset moved: a scroll. A row above re-measured during a
        // stream moves the offset while the row's own growth moves its bottom, by unrelated amounts; read as the
        // reader, that ended animated jumps on legacy scrollers and stopped the chat following.
        let dOffset = offset - last
        let rowDown: Bool? = gapBelow.flatMap { g in lastGap.map { lg in
            let dGap = g - lg
            return dGap < -0.5 && abs(dGap - dOffset) <= max(2, 0.25 * abs(dOffset))
        } }
        if let ownSeekUntil, now < ownSeekUntil {
            // After an animated seek the chat itself settles upward by 150–1,250 pt just after the animation (legacy
            // scrollers, 4 of 6 runs), moving the row down with the offset exactly as a reader would: within that
            // seek's settle time nothing is taken for the reader. (Keyboard input in those 650 ms is left to the
            // geometry after it.)
            guard !ownSeekAnimated, rowDown == true, let g = gapBelow, g < -0.5 else { return true }
        } else if rowDown == false {
            return true
        }
        endedByReader = true
        return false
    }

    /// The jump ended because the reader moved up (`update`).
    public private(set) var endedByReader = false

    /// The view scrolled to the row (a seek): moves in the next `seekSettle` are not the reader's, after the seek's own
    /// animation (`running`: an animated Jump to latest runs 400 ms; legacy scrollers' corrections during it ended the
    /// jump as if the reader had moved up, and the chat stopped following the stream).
    public mutating func seeked(at now: ContinuousClock.Instant, running: Duration = .zero) {
        ownSeekUntil = now + running + Self.seekSettle
        ownSeekAnimated = running > .zero
    }
    private var ownSeekAnimated = false

    /// A seek of this jump is still settling: the view holds ScrollFollow meanwhile, so the seek's own move up (from
    /// past the row) is not taken for the reader scrolling up.
    public func settling(at now: ContinuousClock.Instant) -> Bool { ownSeekUntil.map { now < $0 } ?? false }

    /// Whether the stick scrolls to the row now: following, no animated jump running, and the row not at the bottom
    /// (`atBottom`). Whatever the distance to the content's (estimated) end says: a re-measure (a 1 pt resize at
    /// 300 pt) left the chat at that end, blank, at a distance of 0; and while the answer streams the row grows past
    /// the reading area's bottom and is followed by its bottom.
    public func seeksRow(following: Bool, jumping: Bool, readerScrolling: Bool = false, gapBelow: Double?, slack: Double,
                         now: ContinuousClock.Instant) -> Bool {
        following && !jumping && !readerScrolling && !atBottom(gapBelow: gapBelow, slack: slack, now: now)
    }

    /// Whether the chat is at its bottom for the stick: the row's bottom from 0.5 pt below to `slack` above the
    /// reading area's bottom (`gapBelow`: reading area bottom minus row bottom). A row that has not reported a
    /// frame counts as at the bottom for `unreportedHold` after the jump, then not (the stick then seeks the row).
    public func atBottom(gapBelow: Double?, slack: Double, now: ContinuousClock.Instant) -> Bool {
        guard let gap = gapBelow else { return now < started + Self.unreportedHold }
        return gap >= -0.5 && gap <= slack
    }

    /// The safety net after the jump has run: whether to scroll to the row again. Only while following, never while
    /// the reader scrolls or a restore is in progress, only when no turn is in the reading area, and at most
    /// `maxRetries` times. It is a safety net: it retried 0 times in 96 measured jumps and nudges (the row scroll
    /// alone placed the row each time). A retry is a scroll to the row's bottom, which is harmless if the chat is
    /// already there.
    /// After a bottom seek to the marker (a new turn, the stick, a switch to a following chat, the first open): whether
    /// to fall back to the last turn's row because no turn is in the reading area (the marker was past the last row).
    /// The same guards as the safety net. When rows are drawn this is false and nothing changes.
    public static func fallsBack(following: Bool, readerScrolling: Bool, restoring: Bool, noTurnVisible: Bool) -> Bool {
        following && !readerScrolling && !restoring && noTurnVisible
    }

    public mutating func takeRetry(following: Bool, readerScrolling: Bool, restoring: Bool, noTurnVisible: Bool) -> Bool {
        guard retries < Self.maxRetries, following, !readerScrolling, !restoring, noTurnVisible else { return false }
        retries += 1
        return true
    }
}
