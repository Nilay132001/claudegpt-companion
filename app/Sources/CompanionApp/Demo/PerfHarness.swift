#if DEBUG
import AppKit
import CompanionCore
import Foundation
import QuartzCore
import os

/// DEBUG-only (M9 phase 1) profiling harness. Scenes perf-short / perf-medium / perf-long (10 / 50 / 200 stored turns)
/// and perf-stream (200 turns + a long answer streaming at a realistic rate). COMPANION_PERF=<driver> then drives the
/// real panel by itself, emits os_signpost intervals (subsystem companion.perf, Points of Interest), writes a JSON
/// summary to COMPANION_PERF_OUT and quits:
///   scroll  — scrolls the chat's NSScrollView between top and bottom in fixed steps at display rate
///   stream  — holds still at the bottom while perf-stream's answer streams
///   switch  — switches between the two demo sessions repeatedly
///   resize  — steps the panel width between 300 and 600 pt at display rate
///   idle    — does nothing (memory baseline)
/// COMPANION_PERF_SECONDS (default 10), COMPANION_PERF_STEP (pt per frame, default 20), COMPANION_PERF_SETTLE (s, 2).
enum PerfFlags {
    static let env = ProcessInfo.processInfo.environment
    static let mode: String? = env["COMPANION_PERF"]
    static let seconds = Double(env["COMPANION_PERF_SECONDS"] ?? "") ?? 10
    static let step = CGFloat(Double(env["COMPANION_PERF_STEP"] ?? "") ?? 20)
    static let settle = Double(env["COMPANION_PERF_SETTLE"] ?? "") ?? 2
    static let out: String? = env["COMPANION_PERF_OUT"]

    static var turns: Int? {
        switch DemoFlags.scene {
        case "perf-short": 10
        case "perf-medium": 50
        case "perf-long", "perf-stream": 200
        default: nil
        }
    }
    static var isPerfScene: Bool { turns != nil }
}

/// Counters and signposts the views call (DEBUG only, and only while a perf driver runs).
@MainActor enum PerfProbe {
    static let signposter = OSSignposter(subsystem: "companion.perf", category: .pointsOfInterest)
    static let enabled = PerfFlags.mode != nil
    static var counts: [String: Int] = [:]
    static var nanos: [String: UInt64] = [:]

    /// Counts one evaluation of `name` (a view body, a parse).
    static func count(_ name: String) {
        guard enabled else { return }
        counts[name, default: 0] += 1
    }

    /// Times `body` as a signpost interval and adds it to the counters.
    static func measure<T>(_ name: StaticString, _ body: () -> T) -> T {
        guard enabled else { return body() }
        let key = "\(name)"
        counts[key, default: 0] += 1
        let id = signposter.makeSignpostID()
        let state = signposter.beginInterval(name, id: id)
        let t0 = DispatchTime.now().uptimeNanoseconds
        let result = body()
        nanos[key, default: 0] += DispatchTime.now().uptimeNanoseconds - t0
        signposter.endInterval(name, state)
        return result
    }

    static func snapshot() -> (counts: [String: Int], nanos: [String: UInt64]) { (counts, nanos) }

    static func diff(since s: (counts: [String: Int], nanos: [String: UInt64])) -> [String: Any] {
        var c: [String: Int] = [:]
        for (k, v) in counts where v != (s.counts[k] ?? 0) { c[k] = v - (s.counts[k] ?? 0) }
        var ms: [String: Double] = [:]
        for (k, v) in nanos where v != (s.nanos[k] ?? 0) { ms[k] = Double(v - (s.nanos[k] ?? 0)) / 1e6 }
        return ["counts": c, "ms": ms]
    }

    /// Physical footprint in MB (what Activity Monitor's Memory column shows).
    static func footprintMB() -> Double {
        var info = task_vm_info_data_t()
        var n = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(n)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &n) }
        }
        return kr == KERN_SUCCESS ? (Double(info.phys_footprint) / 1_048_576 * 10).rounded() / 10 : -1
    }
}

@MainActor final class PerfDriver: NSObject {
    static let shared = PerfDriver()
    /// perf-stream's answer waits for this, so it streams inside the measured window.
    private(set) var measuring = false
    private var launched = DispatchTime.now()
    private var summary: [String: Any] = [:]
    private var link: CADisplayLink?
    private var onTick: ((CADisplayLink) -> Void)?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var last: CFTimeInterval = 0
    private var frameMs: [Double] = []
    private var expectedMs = 0.0

    func markLaunch() {
        launched = .now()
        summary["footprintLaunchMB"] = PerfProbe.footprintMB()
    }

    func run(model: AppModel) {
        guard let mode = PerfFlags.mode else { return }
        summary["scene"] = DemoFlags.scene ?? ""
        summary["driver"] = mode
        summary["width"] = DemoFlags.width ?? "default"
        Task { @MainActor in
            // A sleeping display delivers no frames: give up with what we have rather than hang.
            try? await Task.sleep(for: .seconds(PerfFlags.settle + PerfFlags.seconds + 60))
            self.summary["error"] = "watchdog: the run did not finish (display asleep?)"
            self.finish()
        }
        Task { @MainActor in
            let ready = await self.waitForContent()
            self.summary["contentReadyMs"] = ready
            self.summary["footprintLoadedMB"] = PerfProbe.footprintMB()
            self.summary["loadCounters"] = PerfProbe.diff(since: ([:], [:]))
            try? await Task.sleep(for: .seconds(PerfFlags.settle))
            self.startLink()
            let before = PerfProbe.snapshot()
            let span = PerfProbe.signposter.beginInterval("phase", id: PerfProbe.signposter.makeSignpostID())
            self.measuring = true
            let t0 = DispatchTime.now()
            switch mode {
            case "scroll": await self.scroll()
            case "switch": await self.switchSessions(model)
            case "resize": await self.resize()
            default: try? await Task.sleep(for: .seconds(PerfFlags.seconds)) // stream, idle
            }
            self.measuring = false
            PerfProbe.signposter.endInterval("phase", span)
            self.summary["phaseMs"] = Self.ms(since: t0)
            self.summary["phaseCounters"] = PerfProbe.diff(since: before)
            self.summary["footprintEndMB"] = PerfProbe.footprintMB()
            self.summary["frames"] = self.frameStats()
            self.finish()
        }
    }

    // MARK: Finding the chat

    private var panel: NSWindow? { NSApp.windows.first { $0 is NSPanel && $0.isVisible } }

    /// The chat's scroll view: the one with the tallest document (the composer's field has its own).
    private func chatScrollView() -> NSScrollView? {
        guard let root = panel?.contentView else { return nil }
        var found: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView { found.append(s) }
            v.subviews.forEach(walk)
        }
        walk(root)
        if summary["scrollViews"] == nil {
            summary["scrollViews"] = found.map { "\(type(of: $0)) doc=\(Int($0.documentView?.frame.height ?? -1))" }
        }
        return found.max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }

    /// Waits until the chat's document height stops changing; returns ms from launch to the first stable height.
    private func waitForContent() async -> Double {
        var lastHeight: CGFloat = -1, stable = 0
        var firstAt = DispatchTime.now()
        for _ in 0..<600 {
            try? await Task.sleep(for: .milliseconds(50))
            let h = chatScrollView()?.documentView?.frame.height ?? -1
            if h > 100, h == lastHeight { stable += 1 } else { stable = 0; firstAt = .now() }
            lastHeight = h
            if stable >= 6 { break }
        }
        summary["documentHeight"] = Double(lastHeight)
        return Double(firstAt.uptimeNanoseconds - launched.uptimeNanoseconds) / 1e6
    }

    // MARK: Frames

    private func startLink() {
        guard let view = panel?.contentView else { return }
        let l = view.displayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    @objc private func tick(_ l: CADisplayLink) {
        if last > 0 && measuring { frameMs.append((l.timestamp - last) * 1000) }
        last = l.timestamp
        expectedMs = (l.targetTimestamp - l.timestamp) * 1000
        onTick?(l)
        let w = waiters
        waiters = []
        w.forEach { $0.resume() }
    }

    private func nextFrame() async { await withCheckedContinuation { waiters.append($0) } }

    /// Delivered frame intervals: a frame later than 1.5× the display period counts as late; `lateMs` is the time
    /// past one period summed over late frames (a hitch-time estimate from inside the app).
    private func frameStats() -> [String: Any] {
        let period = expectedMs > 0 ? expectedMs : 1000.0 / 120
        let late = frameMs.filter { $0 > period * 1.5 }
        let sorted = frameMs.sorted()
        func pct(_ p: Double) -> Double { sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
        return ["count": frameMs.count, "periodMs": period, "late": late.count, "lateMs": late.reduce(0) { $0 + $1 - period },
                "p50Ms": pct(0.5), "p95Ms": pct(0.95), "p99Ms": pct(0.99), "maxMs": sorted.last ?? 0]
    }

    // MARK: Drivers

    private func scroll() async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        var y = clip.bounds.origin.y, dir: CGFloat = -1, yanks = 0, passes = 0, steps = 0
        summary["scrollStartY"] = Double(y)
        let end = DispatchTime.now().uptimeNanoseconds + UInt64(PerfFlags.seconds * 1e9)
        onTick = { _ in
            if abs(clip.bounds.origin.y - y) > 1 { yanks += 1; y = clip.bounds.origin.y } // someone else scrolled
            let maxY = max(0, (sv.documentView?.frame.height ?? 0) - clip.bounds.height)
            y += dir * PerfFlags.step
            if y <= 0 { y = 0; dir = 1; passes += 1 }
            if y >= maxY { y = maxY; dir = -1; passes += 1 }
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
            sv.reflectScrolledClipView(clip)
            steps += 1
        }
        while DispatchTime.now().uptimeNanoseconds < end { await nextFrame() }
        onTick = nil
        summary["scroll"] = ["steps": steps, "stepPt": Double(PerfFlags.step), "passes": passes, "yanksByOthers": yanks]
    }

    private func switchSessions(_ model: AppModel) async {
        var sync: [Double] = [], toFrame: [Double] = []
        let end = DispatchTime.now().uptimeNanoseconds + UInt64(PerfFlags.seconds * 1e9)
        var next = "s2"
        while DispatchTime.now().uptimeNanoseconds < end {
            let id = PerfProbe.signposter.makeSignpostID()
            let s = PerfProbe.signposter.beginInterval("switch", id: id)
            let t0 = DispatchTime.now()
            await model.pin(next)
            panel?.contentView?.layoutSubtreeIfNeeded()
            panel?.displayIfNeeded()
            sync.append(Self.ms(since: t0))
            await nextFrame()
            toFrame.append(Self.ms(since: t0))
            PerfProbe.signposter.endInterval("switch", s)
            next = next == "s2" ? "s1" : "s2"
            try? await Task.sleep(for: .milliseconds(250))
        }
        summary["switch"] = ["count": sync.count, "syncMs": Self.stats(sync), "toNextFrameMs": Self.stats(toFrame)]
    }

    private func resize() async {
        guard let p = panel else { return }
        var widths: [Double] = []
        var w: CGFloat = 600, dir: CGFloat = -1
        let end = DispatchTime.now().uptimeNanoseconds + UInt64(PerfFlags.seconds * 1e9)
        onTick = { _ in
            w += dir * 10
            if w <= 300 { w = 300; dir = 1 }
            if w >= 600 { w = 600; dir = -1 }
            var f = p.frame
            f.size.width = w
            let s = PerfProbe.signposter.beginInterval("resize-step", id: PerfProbe.signposter.makeSignpostID())
            let t0 = DispatchTime.now()
            p.setFrame(f, display: true)
            widths.append(Self.ms(since: t0))
            PerfProbe.signposter.endInterval("resize-step", s)
        }
        while DispatchTime.now().uptimeNanoseconds < end { await nextFrame() }
        onTick = nil
        summary["resize"] = ["steps": widths.count, "setFrameMs": Self.stats(widths)]
    }

    // MARK: Output

    private static func ms(since t: DispatchTime) -> Double { Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1e6 }

    private static func stats(_ a: [Double]) -> [String: Double] {
        let s = a.sorted()
        guard !s.isEmpty else { return [:] }
        return ["median": s[s.count / 2], "p95": s[min(s.count - 1, Int(Double(s.count) * 0.95))], "max": s.last!,
                "mean": s.reduce(0, +) / Double(s.count)]
    }

    private func finish() {
        link?.invalidate()
        if let out = PerfFlags.out,
           let data = try? JSONSerialization.data(withJSONObject: summary, options: [.prettyPrinted, .sortedKeys]) {
            try? data.write(to: URL(fileURLWithPath: out))
        }
        exit(0) // a demo run has nothing to shut down
    }
}
#endif
