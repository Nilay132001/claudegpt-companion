import Foundation

/// A Jump to latest that scrolled to the last turn's row instead of the bottom marker (ChatView). Pure: the view
/// reports what it sees and asks what to do.
///
/// The marker after the lazy stack marks only the content's estimated end. From far above, the rows near the end
/// are unmeasured, and their estimate can run more than a viewport over their real height: a scroll to the marker
/// then stops past the last row with nothing laid out (a blank chat). So while a jump is active, every bottom
/// seek goes to the row. The row's bottom sits a little above the content's (estimated) end (the stack's bottom
/// padding and the marker, plus any overshoot), so "at the bottom" for the stick is the row's bottom within `slack`
/// of the reading area's bottom.
///
/// The jump ends (the chat goes back to the marker path) when the reader stops following (any upward move), a new
/// turn arrives, the chat switches, or the row grows (an answer streaming into it: it is then laid out and the
/// content's end below it is its real end). A scroll phase alone does not end it: a reader's downward nudge after
/// the jump must still land on the row, never past it.
public struct RowJump: Equatable, Sendable {
    public let turn: UUID
    public let started: ContinuousClock.Instant
    /// The row's height when it was first reported after the jump.
    public private(set) var landedHeight: Double?
    public private(set) var retries = 0

    /// Retries of the safety net, at most.
    public static let maxRetries = 2
    /// How long a row that has not reported a frame still counts as at the bottom.
    public static let unreportedHold: Duration = .seconds(1)
    /// Row growth that ends the jump (layout noise is below it).
    public static let growth = 0.5

    public init(turn: UUID, at now: ContinuousClock.Instant) {
        self.turn = turn
        self.started = now
    }

    /// One geometry update. False when the jump has ended: `lastTurn` is another turn (a new one arrived),
    /// the reader is no longer following, or the row grew since it landed while its answer streams (`streaming`).
    /// Its height, not its position: a row above being measured moves the row without anything growing below it.
    /// And only while streaming: a width change re-measures the row (its text reflows) without anything arriving,
    /// and ending the jump then put a 300 pt chat back on the marker path, past its last row (the nudge driver).
    public mutating func update(lastTurn: UUID?, following: Bool, rowHeight: Double?, streaming: Bool) -> Bool {
        guard lastTurn == turn, following else { return false }
        if let h = rowHeight {
            if let landed = landedHeight {
                if streaming && h > landed + Self.growth { return false }
                if !streaming { landedHeight = h }
            } else {
                landedHeight = h
            }
        }
        return true
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
    /// `maxRetries` times. The tracker can miss rows that an instant scroll left on screen, so this also fires on a
    /// chat that is drawn: the retry is then a scroll to where the chat already is, which moves nothing.
    public mutating func takeRetry(following: Bool, readerScrolling: Bool, restoring: Bool, noTurnVisible: Bool) -> Bool {
        guard retries < Self.maxRetries, following, !readerScrolling, !restoring, noTurnVisible else { return false }
        retries += 1
        return true
    }
}
