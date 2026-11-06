import Foundation

/// Whether the chat follows new text at the bottom (M9 §5.7). Pure: the view reports scroll geometry.
///
/// Following stops as soon as the reader scrolls up, by any amount: the offset moved up AND the distance from the
/// bottom grew. (Requiring 80 pt first let each streamed delta pull a reader who had scrolled up 20 pt back to the
/// bottom, so they could never get away; the measured "pullbacks".) Neither content growing below (the offset stays,
/// the distance grows) nor a layout correction above (offset and content height change together, the distance stays)
/// is the reader scrolling up. Following starts again when the reader scrolls down to within `nearBottom` of the
/// bottom, reaches the bottom, sends a question or jumps to the latest.
public struct ScrollFollow: Equatable, Sendable {
    public static let nearBottom: Double = 80
    public private(set) var following: Bool
    public private(set) var distanceFromBottom: Double = 0
    private var lastOffset: Double?
    private var lastDistance: Double?

    public init(following: Bool = true) { self.following = following }

    /// The "Jump to latest" button shows while the reader is above the bottom and not following.
    public var showsJumpToLatest: Bool { !following && distanceFromBottom > Self.nearBottom }

    /// Following, but no longer at the bottom (content grew below, the viewport changed size): scroll back down.
    public var shouldStickToBottom: Bool { following && distanceFromBottom > 0.5 }

    /// `offset`: content offset from the top. `distanceFromBottom`: content height minus the visible rect's bottom.
    public mutating func geometry(offset: Double, distanceFromBottom: Double) {
        let distance = max(0, distanceFromBottom)
        self.distanceFromBottom = distance
        if let lastOffset, let lastDistance {
            if offset < lastOffset - 0.5 && distance > lastDistance + 0.5 {
                following = false                                   // the reader scrolled up
            } else if distance <= 1 || (offset > lastOffset + 0.5 && distance <= Self.nearBottom) {
                following = true                                    // at the bottom, or scrolled down near it
            }
        } else if distance <= Self.nearBottom {
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
