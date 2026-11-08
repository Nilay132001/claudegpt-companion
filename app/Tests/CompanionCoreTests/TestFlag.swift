import Synchronization

/// Set from an Observation onChange closure (which is @Sendable).
final class Flag: Sendable {
    private let m = Mutex(false)
    var on: Bool { m.withLock { $0 } }
    func set() { m.withLock { $0 = true } }
}
