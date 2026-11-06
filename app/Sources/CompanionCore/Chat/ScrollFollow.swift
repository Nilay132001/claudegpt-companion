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
    public mutating func geometry(offset: Double, distanceFromBottom: Double) {
        let distance = max(0, distanceFromBottom)
        self.distanceFromBottom = distance
        if let lastOffset, let lastDistance {
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

    /// The user sent a question, clicked Jump to latest or pressed ⌘↓.
    public mutating func followAgain() {
        following = true
        distanceFromBottom = 0
    }
}

/// Where a reader was in a chat: the first visible turn and how far the reading area's top is below that turn's top.
/// ChatView restores it by scrolling a marker `inset` points into the turn to the top, so the same line comes back.
public struct ChatScrollAnchor: Equatable, Sendable {
    public let turn: UUID
    /// Points from the turn's top down to the reading area's top (0: the turn starts at the top edge).
    public let inset: Double

    public init(turn: UUID, inset: Double) {
        self.turn = turn
        self.inset = inset
    }
}

/// The second step of a restore (ChatView): the saved turn was scrolled to the top; once it is the first visible turn,
/// the marker `inset` points into it is scrolled to the top. It never fights the reader. It ends:
/// - when the inset is within 2 pt;
/// - when the reader scrolls (a scroll phase, `readerScrolled`), or, once the turn has landed, on any offset move it did
///   not ask for that is not a layout correction (a correction moves offset and content height together, so the
///   distance from the bottom stays);
/// - when its own marker scroll moved but missed (it does not keep scrolling);
/// - when the first visible turn leaves the saved turn after landing, after `maxTries` asks, or at the deadline.
/// A marker scroll that has not moved anything yet (the marker not laid out) may be asked again.
public struct RestoreProgress: Sendable {
    public static let maxTries = 3
    public let anchor: ChatScrollAnchor
    public let deadline: ContinuousClock.Instant
    public private(set) var tries = 0
    public private(set) var finished = false
    /// Why it ended (for diagnostics): landed, reader, missed, left, tries, deadline.
    public private(set) var endReason: String?
    private var landed = false
    /// A marker scroll was asked for and no move has been seen since.
    private var pendingScroll = false
    private var lastOffset: Double?
    private var lastDistance: Double?

    public init(anchor: ChatScrollAnchor, deadline: ContinuousClock.Instant) {
        self.anchor = anchor
        self.deadline = deadline
    }

    /// The reader began scrolling (trackpad, wheel, scroller): stop.
    public mutating func readerScrolled() { _ = finish("reader") }

    /// One scroll geometry. Returns true when the marker should be scrolled to the top now.
    public mutating func step(offset: Double, distanceFromBottom distance: Double, firstVisible: ChatScrollAnchor?,
                              now: ContinuousClock.Instant) -> Bool {
        guard !finished else { return false }
        var moved = false
        if let lastOffset, let lastDistance {
            moved = abs(offset - lastOffset) > 0.5 && abs(distance - lastDistance) > 0.5
        }
        lastOffset = offset
        lastDistance = distance
        guard now < deadline else { return finish("deadline") }
        var ourMove = false
        if landed && moved {
            guard pendingScroll else { return finish("reader") } // a move the restore did not ask for: the reader
            pendingScroll = false
            ourMove = true
        }
        guard let first = firstVisible, first.turn == anchor.turn else {
            return landed ? finish("left") : false              // before landing: the turn scroll is under way
        }
        landed = true
        if abs(first.inset - anchor.inset) <= 2 { return finish("landed") }
        if ourMove { return finish("missed") }
        guard tries < Self.maxTries else { return finish("tries") }
        tries += 1
        pendingScroll = true
        return true
    }

    private mutating func finish(_ reason: String) -> Bool {
        finished = true
        endReason = reason
        return false
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

    /// The turn under the reading area's top edge (`top`, in content coordinates), else the first turn below it
    /// (`viewportHeight`: the reading area's height; a turn below it is not visible).
    public func first(top: Double, viewportHeight: Double) -> ChatScrollAnchor? {
        let candidates = frames.filter { $0.value.maxY > top + 0.5 }
        guard let (id, f) = candidates.min(by: { $0.value.minY < $1.value.minY }),
              f.minY < top + viewportHeight else { return nil }
        return ChatScrollAnchor(turn: id, inset: max(0, top - f.minY))
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
