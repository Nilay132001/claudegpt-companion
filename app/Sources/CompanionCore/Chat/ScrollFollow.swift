import Foundation

/// Whether the chat follows new text at the bottom (M9 §5.7). Pure: the view reports scroll geometry.
/// Following stops only when the reader scrolls UP past the threshold; content growing below never stops it.
public struct ScrollFollow: Equatable, Sendable {
    public static let nearBottom: Double = 80
    public private(set) var following: Bool
    public private(set) var distanceFromBottom: Double = 0
    private var lastOffset: Double?

    public init(following: Bool = true) { self.following = following }

    /// The "Jump to latest" button shows while the reader is above the bottom and not following.
    public var showsJumpToLatest: Bool { !following && distanceFromBottom > Self.nearBottom }

    /// `offset`: content offset from the top. `distanceFromBottom`: content height minus the visible rect's bottom.
    public mutating func geometry(offset: Double, distanceFromBottom: Double) {
        self.distanceFromBottom = max(0, distanceFromBottom)
        if self.distanceFromBottom <= Self.nearBottom {
            following = true
        } else if let last = lastOffset, offset < last - 0.5 {
            following = false
        }
        lastOffset = offset
    }

    /// The user sent a question, clicked Jump to latest or pressed ⌘↓.
    public mutating func followAgain() {
        following = true
        distanceFromBottom = 0
    }
}

/// Each chat's first visible turn while the reader is above the bottom, so a session switch can come back to it.
public struct ChatScrollMemory: Equatable, Sendable {
    private var positions: [String: UUID] = [:]
    public init() {}
    public mutating func save(session: String, firstVisible: UUID?, following: Bool) {
        positions[session] = following ? nil : firstVisible
    }
    public func position(for session: String) -> UUID? { positions[session] }
}
