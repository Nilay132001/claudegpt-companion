import Testing
@testable import CompanionCore

@Suite struct FrameThrottleTests {
    @Test func firstUpdateIsImmediateThenAtMostOnePerInterval() {
        var t = FrameThrottle(interval: .milliseconds(16))
        let t0 = ContinuousClock.now
        #expect(t.delay(at: t0) == nil)
        #expect(t.delay(at: t0 + .milliseconds(5)) == .milliseconds(11))
        t.flushed(at: t0 + .milliseconds(16))
        #expect(t.delay(at: t0 + .milliseconds(20)) == .milliseconds(12))
        #expect(t.delay(at: t0 + .milliseconds(40)) == nil)
    }
}
