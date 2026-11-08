import Foundation

/// At most one streaming view update per interval (one display frame at 60 Hz) (M9 §5.4).
public struct FrameThrottle: Sendable {
    public let interval: Duration
    private var last: ContinuousClock.Instant?
    public init(interval: Duration = .milliseconds(16)) { self.interval = interval }

    /// nil: update now (and that counts as the last update). Otherwise wait this long; one pending update covers
    /// every delta until then.
    public mutating func delay(at now: ContinuousClock.Instant) -> Duration? {
        if let last, now - last < interval { return interval - (now - last) }
        last = now
        return nil
    }

    public mutating func flushed(at now: ContinuousClock.Instant) { last = now }
}
