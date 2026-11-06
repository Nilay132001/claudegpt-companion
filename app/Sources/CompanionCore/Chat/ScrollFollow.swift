import Foundation

/// Whether the chat follows new text at the bottom (M9 §5.7). Pure: the view reports scroll geometry.
///
/// Following stops as soon as the reader scrolls up, by any amount: the offset moved up AND the distance from the
/// bottom grew. (Requiring 80 pt first let each streamed delta pull a reader who had scrolled up 20 pt back to the
/// bottom, so they could never get away; the measured "pullbacks".) Neither content growing below (the offset stays,
/// the distance grows) nor a layout correction above (offset and content height change together, the distance stays)
/// is the reader scrolling up. Movements are compared per geometry callback with a 0.01 pt tolerance, so even a slow
/// trackpad start (a fraction of a point per frame) counts. Following starts again when the reader scrolls down to within `nearBottom` of the
/// bottom, reaches the bottom, sends a question or jumps to the latest.
public struct ScrollFollow: Equatable, Sendable {
    public static let nearBottom: Double = 80
    /// "Jump to latest" shows once a reader who is not following is more than this above the bottom.
    public static let jumpThreshold: Double = 2
    /// Smallest offset or distance change that counts as movement (layout noise is below it).
    static let epsilon = 0.01
    public private(set) var following: Bool
    public private(set) var distanceFromBottom: Double = 0
    private var lastOffset: Double?
    private var lastDistance: Double?

    public init(following: Bool = true) { self.following = following }

    /// The "Jump to latest" button (and ⌘↓) is there whenever the reader is not following and above the bottom.
    public var showsJumpToLatest: Bool { !following && distanceFromBottom > Self.jumpThreshold }

    /// Following, but no longer at the bottom (content grew below, the viewport changed size): scroll back down.
    public var shouldStickToBottom: Bool { following && distanceFromBottom > 0.5 }

    /// `offset`: content offset from the top. `distanceFromBottom`: content height minus the visible rect's bottom.
    /// `hold`: a restore is moving the chat to a saved position: record the geometry, but do not start (or stop)
    /// following from it (the swap to a restored chat can land briefly at its bottom).
    public mutating func geometry(offset: Double, distanceFromBottom: Double, hold: Bool = false) {
        let distance = max(0, distanceFromBottom)
        self.distanceFromBottom = distance
        if hold {
            // nothing: the restore owns the position
        } else if let lastOffset, let lastDistance {
            if offset < lastOffset - Self.epsilon && distance > lastDistance + Self.epsilon {
                following = false                                   // the reader scrolled up
            } else if distance <= 1 || (offset > lastOffset + Self.epsilon && distance <= Self.nearBottom) {
                following = true                                    // at the bottom, or scrolled down near it
            }
        } else if distance <= Self.nearBottom {
            // The first geometry of a chat (also one restored with following: false): within 80 pt of the bottom
            // the reader is treated as at the bottom and follows.
            following = true
        }
        lastOffset = offset
        lastDistance = distance
    }

    /// A restore ended (landed, the reader took over, or it timed out): the hold is over. A reader who is at the
    /// bottom then (they may have got there with input that has no scroll phase, like the keyboard) follows again.
    public mutating func released() {
        if distanceFromBottom <= 1 { following = true }
    }

    /// The user sent a question, clicked Jump to latest or pressed ⌘↓.
    public mutating func followAgain() {
        following = true
        distanceFromBottom = 0
    }
}

/// Where a reader was in a chat: the first visible turn and how far the reading area's top is below that turn's top.
/// ChatView restores it with one scroll to the turn, anchored so the reading area's top lands `inset` points into it
/// (unitY(turnHeight:viewportHeight:)).
public struct ChatScrollAnchor: Equatable, Sendable {
    public let turn: UUID
    /// Points from the turn's top down to the reading area's top (0: the turn starts at the top edge).
    public let inset: Double
    /// The turn's and the reading area's heights when saved (0: unknown). The restore uses the current heights
    /// when it knows them (see unitY(turnHeight:viewportHeight:)).
    public let turnHeight: Double
    public let viewportHeight: Double

    public init(turn: UUID, inset: Double, turnHeight: Double = 0, viewportHeight: Double = 0) {
        self.turn = turn
        self.inset = inset
        self.turnHeight = turnHeight
        self.viewportHeight = viewportHeight
    }

    /// The anchor range used. The line lands at y·(h − H), so an error of e in the turn's height moves it by y·e:
    /// within this range by at most 2·e. (−1...1 was tried first; it cut a line near the end of a long turn short
    /// by 350 pt in the streaming position runs, where y was 1.09.)
    public static let unitYRange: ClosedRange<Double> = -1...2
    /// A turn within this of the reading area's height is shown at its top: with |y| ≤ 1 the reachable lines are
    /// within |h − H| of the top anyway, and a height estimate that is off by ~20 pt could flip the sign of h − H
    /// and put the line on the wrong side of the turn's top.
    public static let ambiguousSpan: Double = 20

    /// The unit-point y for `scrollTo(turn, anchor:)` that puts the reading area's top `inset` points into the turn,
    /// computed with the heights at restore time (`turnHeight`: the turn's current height if it is laid out, else
    /// the saved one; `viewportHeight`: the reading area's current height). scrollTo aligns the turn's point at y
    /// with the reading area's point at y: turnTop + y·h = y·H with turnTop = −inset, so y = inset / (h − H).
    /// Outside unitYRange (a turn about as tall as the reading area, or a line near its end) that is ill-conditioned:
    /// y is clamped, which shows the same turn with its top or bottom edge as near the saved line as that range
    /// reaches (always at least as near as the turn's top). 0 when the inset is 0, a height is unknown, or the turn is
    /// within `ambiguousSpan` of the reading area's height.
    public func unitY(turnHeight h: Double, viewportHeight H: Double) -> Double {
        guard inset > 0.5, h > 0, H > 0 else { return 0 }
        let span = h - H
        guard abs(span) >= Self.ambiguousSpan else { return 0 }
        return min(Self.unitYRange.upperBound, max(Self.unitYRange.lowerBound, inset / span))
    }

    /// Where the reading area's top lands inside the turn (points below its top) for anchor `y`, given the turn's
    /// and the reading area's actual heights.
    public static func landedInset(unitY y: Double, turnHeight h: Double, viewportHeight H: Double) -> Double {
        y * (h - H)
    }
}

/// A restore in progress (ChatView): the chat was scrolled to a saved position in one scroll
/// (`scrollTo(turn, anchor: unitY)`). While it is in progress the follow state holds (the swap to a restored chat can
/// show its bottom for a moment) and the chat's position is not saved. It never scrolls by itself, so it cannot fight
/// the reader. It ends:
/// - when the saved turn is the first visible one at the inset the scroll aims for (`expectedInset`, within 2 pt).
///   Not on "moved and the turn is first visible": a scroll can land in more than one layout pass, and a position
///   saved from an intermediate one lost the line (the rapid switch-through trips);
/// - when the reader scrolls (`end("reader")` on a scroll phase), jumps to the latest or sends a question
///   (`end("jump")`, `end("newTurn")`), or at the deadline (ChatView also ends it from a timer).
public struct RestoreProgress: Sendable {
    public let anchor: ChatScrollAnchor
    /// Where the scroll puts the reading area's top inside the turn (ChatScrollAnchor.landedInset for the y used).
    public let expectedInset: Double
    public let deadline: ContinuousClock.Instant
    public private(set) var finished = false
    /// Why it ended: landed, reader, jump, newTurn, deadline.
    public private(set) var endReason: String?

    public init(anchor: ChatScrollAnchor, expectedInset: Double? = nil, deadline: ContinuousClock.Instant) {
        self.anchor = anchor
        self.expectedInset = expectedInset ?? anchor.inset
        self.deadline = deadline
    }

    /// The reader took over (a scroll phase, Jump to latest, ⌘↓, a new question), or the deadline passed.
    public mutating func end(_ reason: String) {
        guard !finished else { return }
        finished = true
        endReason = reason
    }

    /// One scroll geometry.
    public mutating func step(firstVisible: ChatScrollAnchor?, now: ContinuousClock.Instant) {
        guard !finished else { return }
        guard now < deadline else { return end("deadline") }
        guard let first = firstVisible, first.turn == anchor.turn else { return }
        if abs(first.inset - expectedInset) <= 2 { end("landed") }
    }
}

/// The frames (in the scroll content's coordinates) of the turns the lazy list has laid out, so the first visible
/// turn can be found when the chat goes away. Rows report their frames; nothing here is observed by a view.
public struct VisibleTurns: Sendable {
    private var frames: [UUID: (minY: Double, maxY: Double)] = [:]
    public init() {}

    public mutating func set(_ id: UUID, minY: Double, maxY: Double) { frames[id] = (minY, maxY) }
    public mutating func remove(_ id: UUID) { frames[id] = nil }
    public var count: Int { frames.count }
    public func frame(_ id: UUID) -> (minY: Double, maxY: Double)? { frames[id] }

    /// The turn under the reading area's top edge (`top`, in content coordinates), else the first turn below it
    /// (`viewportHeight`: the reading area's height; a turn below it is not visible).
    public func first(top: Double, viewportHeight: Double) -> ChatScrollAnchor? {
        let candidates = frames.filter { $0.value.maxY > top + 0.5 }
        guard let (id, f) = candidates.min(by: { $0.value.minY < $1.value.minY }),
              f.minY < top + viewportHeight else { return nil }
        return ChatScrollAnchor(turn: id, inset: max(0, top - f.minY), turnHeight: f.maxY - f.minY,
                                viewportHeight: viewportHeight)
    }
}

/// Each chat's reading position while the reader is above the bottom, so a session switch can come back to it.
public struct ChatScrollMemory: Equatable, Sendable {
    private var positions: [String: ChatScrollAnchor] = [:]
    public init() {}
    public mutating func save(session: String, anchor: ChatScrollAnchor?, following: Bool) {
        positions[session] = following ? nil : anchor
    }
    public func position(for session: String) -> ChatScrollAnchor? { positions[session] }
}
