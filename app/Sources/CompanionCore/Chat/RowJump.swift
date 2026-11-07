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

    /// Retries of the safety net, at most.
    public static let maxRetries = 2
    /// How long a row that has not reported a frame still counts as at the bottom.
    public static let unreportedHold: Duration = .seconds(1)

    public init(turn: UUID, at now: ContinuousClock.Instant) {
        self.turn = turn
        self.started = now
    }

    /// One geometry update. False when the jump has ended: `lastTurn` is another turn (a new one arrived) or the
    /// reader is no longer following. Neither the row growing (its answer streaming) nor a re-measure ends it.
    public func update(lastTurn: UUID?, following: Bool) -> Bool {
        lastTurn == turn && following
    }

    /// Whether the stick scrolls to the row now: following, no animated jump running, and the row not at the bottom
    /// (`atBottom`). Whatever the distance to the content's (estimated) end says: a re-measure (a 1 pt resize at
    /// 300 pt) left the chat at that end, blank, at a distance of 0; and while the answer streams the row grows past
    /// the reading area's bottom and is followed by its bottom.
    public func seeksRow(following: Bool, jumping: Bool, gapBelow: Double?, slack: Double,
                         now: ContinuousClock.Instant) -> Bool {
        following && !jumping && !atBottom(gapBelow: gapBelow, slack: slack, now: now)
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
    public mutating func takeRetry(following: Bool, readerScrolling: Bool, restoring: Bool, noTurnVisible: Bool) -> Bool {
        guard retries < Self.maxRetries, following, !readerScrolling, !restoring, noTurnVisible else { return false }
        retries += 1
        return true
    }
}
