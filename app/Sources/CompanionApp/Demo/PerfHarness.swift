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
///   resize  — steps the panel width between 300 and 600 pt at display rate, inside the live-resize notifications
///             AppKit posts while the user drags the panel's edge
///   idle    — does nothing (memory baseline)
///   position — scrolls to the middle, switches to the other session and back (slowly, then rapidly), opens and
///              closes a past chat; the first visible turn must match each time (perf-stream: while s1 streams)
///   wheel   — synthesizes scroll-wheel events (mouse-like and trackpad-like) over a non-wrapping code block and over
///             prose, delivered through the window, and reports how far the chat moved for each
///   readaloud — the scroll driver, toggling Read Aloud on the latest answer every 30 frames (a silent synthesizer),
///               inside a live scroll (COMPANION_PERF_LIVESCROLL)
/// COMPANION_PERF_SECONDS (default 10), COMPANION_PERF_STEP (pt per frame, default 20), COMPANION_PERF_SETTLE (s, 2).
enum PerfFlags {
    static let env = ProcessInfo.processInfo.environment
    static let mode: String? = env["COMPANION_PERF"]
    static let seconds = Double(env["COMPANION_PERF_SECONDS"] ?? "") ?? 10
    static let step = CGFloat(Double(env["COMPANION_PERF_STEP"] ?? "") ?? 20)
    static let settle = Double(env["COMPANION_PERF_SETTLE"] ?? "") ?? 2
    static let out: String? = env["COMPANION_PERF_OUT"]
    /// COMPANION_PERF_SCROLLERS=system: keep the Mac's scroller style (legacy with a mouse connected) instead of
    /// forcing overlay scrollers.
    static let systemScrollers = env["COMPANION_PERF_SCROLLERS"] == "system"
    /// COMPANION_PERF_INPUT=wheel: the scroll driver, the position driver's move to the middle and its reader trip
    /// scroll with synthesized mouse-wheel events (discrete, no phases) over the chat, as a mouse does, instead of
    /// moving the clip view.
    static let wheelInput = env["COMPANION_PERF_INPUT"] == "wheel"
    /// COMPANION_PERF_LIVESCROLL=on|off: the clip-moving scroll driver wraps its run in a live scroll (willStart, one
    /// didLiveScroll per step, didEnd), as AppKit does for a user's scroll. Without one, SwiftUI's scroll view never
    /// adopts the driver's offset and writes its stale one (where the run started) back whenever a row outside the
    /// laid-out range changes: the readaloud run's three +3068 pt "corrections". Default on for readaloud only, so
    /// the other scenarios stay comparable with earlier runs.
    static let liveScroll = env["COMPANION_PERF_LIVESCROLL"].map { $0 == "on" } ?? (mode == "readaloud")

    static var turns: Int? {
        switch DemoFlags.scene {
        case "perf-short": 10
        case "perf-medium": 50
        case "perf-long", "perf-stream", "perf-code", "perf-table", "perf-chart": 200
        default: nil
        }
    }
    static var isPerfScene: Bool { turns != nil }
    /// The drivers that read ChatView's follow state (PerfProbe.following, jumpShown).
    static var tracksFollow: Bool {
        ["jump", "jumpstream", "jumpsend", "restoresend", "jumpupdown", "upstay"].contains(mode ?? "")
    }
}

/// Counters and signposts the views call (DEBUG only, and only while a perf driver runs).
@MainActor enum PerfProbe {
    static let signposter = OSSignposter(subsystem: "companion.perf", category: .pointsOfInterest)
    static let enabled = PerfFlags.mode != nil
    static var counts: [String: Int] = [:]
    static var nanos: [String: UInt64] = [:]
    /// The chat's first visible turn and how far (pt) the viewport top is below that turn's top, as ChatView's
    /// tracker sees it, for the `position` driver.
    static var firstVisibleTurn: UUID?
    static var firstVisibleInset: Double?
    static var contentInsetTop = 0.0
    static var contentInsetBottom = 0.0
    /// ChatView's follow state and whether a row jump is active, for the `jump` driver.
    static var following = "-"
    static var jumpShown = false
    /// The laid-out rows' frames in the content, as the rows last reported them (not cleared on a session switch).
    static var rowFrames: [UUID: ClosedRange<Double>] = [:]
    /// ChatView's Jump to latest (animated or not), for the `jump` driver.
    static var jumpToLatest: ((Bool) -> Void)?
    /// Scrolls the app itself asked for (following the stream, a new turn, a restore). Counted even when a driver
    /// is not running, so the driver can tell its own moves and lazy-layout corrections from the app's.
    static var programmaticScrolls = 0

    /// The app scrolled by itself (`reason`: follow, newTurn, restore, jump).
    static func programmaticScroll(_ reason: String) {
        programmaticScrolls += 1
        count("scroll." + reason)
    }

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

    /// Adds work timed elsewhere (a background task), counted once.
    static func record(_ name: String, nanos n: UInt64) {
        guard enabled else { return }
        counts[name, default: 0] += 1
        nanos[name, default: 0] += n
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

/// The `readaloud` driver's synthesizer: nothing is spoken during measurement, and playback never ends by itself.
@MainActor final class SilentSynth: SpeechSynthesizing {
    var onEnd: ((Int) -> Void)?
    func speak(_ segments: [SpeechSegment], rate: Float, voiceIdentifier: String?, token: Int) {}
    func pause() {}
    func resume() {}
    func stop(atWordBoundary: Bool) {}
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
        // Overlay scrollers for every run, whatever the Mac's "Show scroll bars" setting and pointing device (a
        // connected mouse makes them legacy). With legacy scrollers SwiftUI's scroll view wrote its own offset back
        // over the drivers' clip-view moves on its next update (a jump to the middle came back to the bottom), so
        // results depended on whether a mouse was connected. Process-local (argument domain), nothing persisted.
        // (keepPanelAwayFromPointer handles the other case of the same race.)
        if PerfFlags.mode != nil && !PerfFlags.systemScrollers {
            var args = UserDefaults.standard.volatileDomain(forName: UserDefaults.argumentDomain)
            args["AppleShowScrollBars"] = "WhenScrolling"
            UserDefaults.standard.setVolatileDomain(args, forName: UserDefaults.argumentDomain)
        }
        launched = .now()
        summary["footprintLaunchMB"] = PerfProbe.footprintMB()
    }

    func run(model: AppModel, readAloud: ReadAloudController) {
        guard let mode = PerfFlags.mode else { return }
        summary["scene"] = DemoFlags.scene ?? ""
        summary["driver"] = mode
        summary["width"] = DemoFlags.width ?? "default"
        keepPanelAwayFromPointer()
        Task { @MainActor in
            // A sleeping display delivers no frames: give up with what we have rather than hang.
            try? await Task.sleep(for: .seconds(PerfFlags.settle + PerfFlags.seconds + 60))
            self.summary["error"] = "watchdog: the run did not finish (display asleep?)"
            self.finish()
        }
        Task { @MainActor in
            let ready = await self.waitForContent()
            self.summary["contentReadyMs"] = ready
            if let p = self.panel {
                self.summary["environment"] = [
                    "panel": NSStringFromRect(p.frame), "scale": Double(p.backingScaleFactor),
                    "screens": NSScreen.screens.map { NSStringFromRect($0.frame) },
                    "preferredScrollerStyle": NSScroller.preferredScrollerStyle == .legacy ? "legacy" : "overlay",
                    "chatScrollerStyle": self.chatScrollView().map { $0.scrollerStyle == .legacy ? "legacy" : "overlay" } ?? "-",
                    "pointerOverPanel": p.frame.contains(NSEvent.mouseLocation)]
            }
            // A chat that loaded with turns but none of them in the reading area is blank (the bottom marker outside
            // the lazy stack left the 300 pt `rich` chat past its last row): every run says whether that happened.
            self.summary["turnVisibleAtLoad"] = PerfProbe.firstVisibleTurn != nil
            // The same from AppKit's clip view: the tracker's viewport comes from SwiftUI's scroll geometry, which with
            // legacy scrollers can miss the clip's last move at load (the scroller narrows the content, rows reflow).
            self.summary["turnInClipAtLoad"] = self.turnInClip()
            if Self.pixelChecks { self.summary["drawsAtLoad"] = self.chatDrawsSomething() }
            self.summary["footprintLoadedMB"] = PerfProbe.footprintMB()
            self.summary["loadCounters"] = PerfProbe.diff(since: ([:], [:]))
            try? await Task.sleep(for: .seconds(PerfFlags.settle))
            self.summary["turnVisibleAfterSettle"] = PerfProbe.firstVisibleTurn != nil
            self.summary["turnInClipAfterSettle"] = self.turnInClip()
            if Self.pixelChecks { self.summary["drawsAfterSettle"] = self.chatDrawsSomething() }
            self.startLink()
            let before = PerfProbe.snapshot()
            let cacheBefore = model.renderCache.stats
            let span = PerfProbe.signposter.beginInterval("phase", id: PerfProbe.signposter.makeSignpostID())
            self.measuring = true
            let t0 = DispatchTime.now()
            switch mode {
            case "scroll": await self.scroll()
            case "readaloud": await self.readAloud(model, readAloud)
            case "switch": await self.switchSessions(model)
            case "resize": await self.resize()
            case "position": await self.position(model)
            case "wheel": await self.wheel()
            case "jump": await self.jump(model)
            case "jumpstream": await self.jumpStream(model)
            case "jumpsend": await self.sendAfter(model, restore: false)
            case "restoresend": await self.sendAfter(model, restore: true)
            case "jumpupdown": await self.jumpUpDown(model)
            case "upstay": await self.upStay(model)
            default: try? await Task.sleep(for: .seconds(PerfFlags.seconds)) // stream, idle
            }
            self.measuring = false
            PerfProbe.signposter.endInterval("phase", span)
            self.summary["phaseMs"] = Self.ms(since: t0)
            self.summary["phaseCounters"] = PerfProbe.diff(since: before)
            let cache = model.renderCache.stats
            self.summary["renderCache"] = ["hits": cache.hits - cacheBefore.hits, "misses": cache.misses - cacheBefore.misses,
                                           "tailRenders": cache.tailRenders - cacheBefore.tailRenders]
            self.summary["footprintEndMB"] = PerfProbe.footprintMB()
            self.summary["frames"] = self.frameStats()
            self.finish()
        }
    }

    /// The drivers move the chat's clip view directly; SwiftUI's scroll view learns of that on its next scroll
    /// update. A hover update (the pointer resting over rows that move under it) can run first and write SwiftUI's
    /// previous offset back: a jump to the middle came back to the bottom, and long-scroll was thrown back every
    /// ~230 steps, whenever the pointer happened to be over the panel. So the panel is moved, on its own screen,
    /// to the side away from the pointer (the run records where it was).
    private func keepPanelAwayFromPointer() {
        guard let p = panel, let screen = p.screen else { return }
        let mouse = NSEvent.mouseLocation
        summary["pointerWasOverPanel"] = p.frame.contains(mouse)
        guard p.frame.contains(mouse) else { return }
        var f = p.frame
        let v = screen.visibleFrame
        f.origin.x = mouse.x - v.minX > v.maxX - mouse.x ? v.minX : v.maxX - f.width
        if f.contains(mouse) { f.origin.x = mouse.x > v.midX ? mouse.x - f.width - 40 : mouse.x + 40 }
        p.setFrame(f, display: true)
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

    /// The scroll driver, plus a Read Aloud toggle on the latest answer every 30 frames. Only the answers whose
    /// playback changed should re-render: `answerBodies` (settled AnswerView bodies) ≤ 2 × toggles.
    private func readAloud(_ model: AppModel, _ readAloud: ReadAloudController) async {
        var frames = 0, toggles = 0
        let before = PerfProbe.counts["body.AnswerView.settled"] ?? 0
        await scroll { [weak model] in
            frames += 1
            guard frames % 30 == 0, let feed = model?.currentFeed, let id = feed.turns.last?.answer,
                  let text = feed.model(id)?.message.text else { return }
            readAloud.toggle(id: id, markdown: text)
            toggles += 1
        }
        summary["readaloud"] = ["toggles": toggles,
                                "answerBodies": (PerfProbe.counts["body.AnswerView.settled"] ?? 0) - before]
    }

    /// Scrolls the chat's clip view by `step` pt per frame between bottom and top (starting upward from where it is).
    /// Every clip move it did not make is classified:
    /// - `yanksWhileReading`: the app scrolled by itself (PerfProbe.programmaticScroll within the last 3 frames) while
    ///   the driver's own last position was more than ScrollFollow.nearBottom above the bottom (measured when it moved,
    ///   so content growing below does not make the driver "reading");
    /// - `pullbacks`: the app scrolled by itself down, against the driver scrolling up (any distance): the reader
    ///   cannot get away from the bottom;
    /// - `offsetCorrections`: moves the app did not ask for (lazy-layout height corrections, clamping).
    /// `yanksByOthers` (all of them) and `yanksWhileReadingLegacy` (the window's definition) stay for comparison.
    private func scroll(_ extra: (() -> Void)? = nil) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        var y = clip.bounds.origin.y, dir: CGFloat = -1, yanks = 0, legacy = 0, passes = 0, steps = 0
        var reading = 0, pullbacks = 0, corrections = 0, frame = 0, lastProgFrame = -100
        var lastProg = PerfProbe.programmaticScrolls
        var events: [String] = [] // the first few non-driver moves: kind@step:points (distance the driver had chosen)
        var driverDistance: CGFloat = 0
        var lastDocH = sv.documentView?.frame.height ?? 0
        var travel: CGFloat = 0, lowY = y, lastClipY = y // how far the chat really moved, and its lowest offset
        summary["scrollStartY"] = Double(y)
        let live = PerfFlags.liveScroll && !PerfFlags.wheelInput
        summary["liveScroll"] = live
        if live { NotificationCenter.default.post(name: NSScrollView.willStartLiveScrollNotification, object: sv) }
        let end = DispatchTime.now().uptimeNanoseconds + UInt64(PerfFlags.seconds * 1e9)
        onTick = { _ in
            frame += 1
            travel += abs(clip.bounds.origin.y - lastClipY); lastClipY = clip.bounds.origin.y; lowY = min(lowY, lastClipY)
            if PerfProbe.programmaticScrolls != lastProg { lastProg = PerfProbe.programmaticScrolls; lastProgFrame = frame }
            let docH = sv.documentView?.frame.height ?? 0
            let legacyAbove = max(0, docH - clip.bounds.height) - y > ScrollFollow.nearBottom
            // With wheel input the driver's last event is applied on the next frame: what it asked for is its own.
            let asked = PerfFlags.wheelInput ? self.wheelPending : 0
            self.learnWheel(moved: clip.bounds.origin.y - y)
            let moved = clip.bounds.origin.y - y - asked
            if abs(moved) > max(1, 0.25 * abs(asked) + 2) { // someone else scrolled
                yanks += 1
                if legacyAbove { legacy += 1 }
                var kind = "correction"
                if frame - lastProgFrame <= 3 {
                    kind = "programmatic"
                    if driverDistance > ScrollFollow.nearBottom { reading += 1; kind = "reading" }
                    if dir < 0 && moved > 0 { pullbacks += 1; kind = "pullback" }
                } else {
                    corrections += 1
                }
                // A correction that moves the offset by as much as the document height changed kept the visible
                // content in place (the lazy list replaced estimated heights above the viewport).
                if events.count < 8 { events.append("\(kind)@\(steps):\(Int(moved)) doc\(Int(docH - lastDocH)) d\(Int(driverDistance))") }
                y = clip.bounds.origin.y
            }
            lastDocH = docH
            if PerfFlags.wheelInput { y = clip.bounds.origin.y } // the last event has been applied: start from there
            let maxY = max(0, docH - clip.bounds.height)
            y += dir * PerfFlags.step
            if y <= 0 { y = 0; dir = 1; passes += 1 }
            if y >= maxY { y = maxY; dir = -1; passes += 1 }
            if PerfFlags.wheelInput {
                let want = y - clip.bounds.origin.y
                y = clip.bounds.origin.y           // applied next frame; checked against wheelPending then
                self.chatWheel(sv, by: want)
            } else {
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: y))
                sv.reflectScrolledClipView(clip)
                if live { NotificationCenter.default.post(name: NSScrollView.didLiveScrollNotification, object: sv) }
            }
            driverDistance = maxY - y
            steps += 1
            extra?()
        }
        while DispatchTime.now().uptimeNanoseconds < end { await nextFrame() }
        onTick = nil
        if live { NotificationCenter.default.post(name: NSScrollView.didEndLiveScrollNotification, object: sv) }
        if PerfFlags.wheelInput { summary["wheelInput"] = wheelStats() }
        summary["scroll"] = ["steps": steps, "stepPt": Double(PerfFlags.step), "passes": passes, "yanksByOthers": yanks,
                             "yanksWhileReadingLegacy": legacy, "yanksWhileReading": reading, "pullbacks": pullbacks,
                             "offsetCorrections": corrections, "events": events, "travelPt": Double(travel),
                             "lowestY": Double(lowY)]
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

    /// Whether the chat's reading area (the scroll view minus its insets) draws anything: false when every pixel in it
    /// is the background's colour (a blank chat). From pixels, so it does not depend on the rows reporting frames
    /// (an instant scroll across the lazy stack can leave rows on screen that never re-reported).
    /// The pixel check (cacheDisplay of the chat) only for the drivers that look at visibility: run before a timed
    /// driver it seemed to cost the following frames (stream A/B, not conclusive at the noise of that window).
    private static var pixelChecks: Bool { PerfFlags.mode == "idle" || PerfFlags.mode == "jump" }

    private func chatDrawsSomething() -> Bool {
        guard let sv = chatScrollView() else { return false }
        let b = sv.bounds
        let r = NSRect(x: b.minX, y: b.minY + PerfProbe.contentInsetTop, width: b.width,
                       height: max(1, b.height - PerfProbe.contentInsetTop - PerfProbe.contentInsetBottom))
        guard let rep = sv.bitmapImageRepForCachingDisplay(in: r) else { return false }
        sv.cacheDisplay(in: r, to: rep)
        guard let first = rep.colorAt(x: 0, y: 0) else { return false }
        for y in stride(from: 0, to: rep.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: rep.pixelsWide, by: 2) {
                guard let c = rep.colorAt(x: x, y: y) else { continue }
                if abs(c.redComponent - first.redComponent) + abs(c.greenComponent - first.greenComponent)
                    + abs(c.blueComponent - first.blueComponent) > 0.06 { return true }
            }
        }
        return false
    }

    /// Whether a laid-out row overlaps the chat clip view's reading area (its bounds minus the scroll insets).
    private func turnInClip(_ only: UUID? = nil) -> Bool {
        guard let c = chatScrollView()?.contentView.bounds else { return false }
        let top = Double(c.minY) + PerfProbe.contentInsetTop, bottom = Double(c.maxY) - PerfProbe.contentInsetBottom
        return PerfProbe.rowFrames.contains { id, f in
            (only == nil || id == only) && f.upperBound > top + 0.5 && f.lowerBound < bottom - 0.5
        }
    }

    /// Scroll to the top, then Jump to latest, animated and then instant: the last turn must be in the reading area
    /// afterwards (a jump that stopped past the last row showed a blank chat).
    private func jump(_ model: AppModel) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        var results: [[String: Any]] = []
        for animated in [true, false] {
            let clip = sv.contentView
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            sv.reflectScrolledClipView(clip)
            for _ in 0..<60 { await nextFrame() }
            let atTop: [String: Any] = ["clipY": Double(clip.bounds.origin.y), "turnVisible": PerfProbe.firstVisibleTurn != nil,
                                        "lastTurnVisible": turnInClip(model.currentFeed?.turns.last?.id)]
            let retries = PerfProbe.counts["scroll.jumpRetry"] ?? 0
            // Whether the reading area was blank (pixels) just before the safety net's first check.
            let drawsBeforeNet: Bool
            if animated {
                PerfProbe.jumpToLatest?(animated)
                try? await Task.sleep(for: .milliseconds(420))
                drawsBeforeNet = chatDrawsSomething()
            } else {
                PerfProbe.jumpToLatest?(animated)
                try? await Task.sleep(for: .milliseconds(25))
                drawsBeforeNet = chatDrawsSomething()
            }
            for _ in 0..<120 { await nextFrame() }
            var r = jumpSample(sv, model)
            r["animated"] = animated
            r["atTop"] = atTop
            r["drawsBeforeNet"] = drawsBeforeNet
            r["jumpRetries"] = (PerfProbe.counts["scroll.jumpRetry"] ?? 0) - retries
            // A reader's nudge right after the jump: one wheel tick down (no scroll phase), a still tick, then a lazy
            // re-measure (the panel 1 pt wider and back). It must land on the last row, never past it.
            let retries2 = PerfProbe.counts["scroll.jumpRetry"] ?? 0
            let y0 = sv.contentView.bounds.origin.y
            _ = chatWheel(sv, by: 40)
            await nextFrame()
            let wheelMoved = Double(sv.contentView.bounds.origin.y - y0)
            for _ in 0..<10 { await nextFrame() }
            var still = jumpSample(sv, model)
            still["following"] = PerfProbe.following
            if let p = panel {
                var f = p.frame; f.size.width += 1; p.setFrame(f, display: true)
                await nextFrame()
                f.size.width -= 1; p.setFrame(f, display: true)
            }
            for _ in 0..<60 { await nextFrame() }
            var n = jumpSample(sv, model)
            n["jumpRetries"] = (PerfProbe.counts["scroll.jumpRetry"] ?? 0) - retries2
            n["wheelMoved"] = wheelMoved
            n["afterStill"] = still
            n["following"] = PerfProbe.following
            r["afterNudge"] = n
            results.append(r)
        }
        summary["jump"] = results
    }

    /// perf-stream (with COMPANION_DEMO_TABLES=1, table-heavy history): 2 s into the stream, scroll to the top, Jump
    /// to latest (instant; COMPANION_PERF_JUMPANIM=1: animated), then sample twice a second until the answer has
    /// finished, and once more a second after. Each sample: drawn (pixels), the last turn in the reading area, past the
    /// last row. Also the re-sticks (scroll.follow) and the streaming answer's body updates while it streamed.
    private func jumpStream(_ model: AppModel) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let animated = PerfFlags.env["COMPANION_PERF_JUMPANIM"] == "1"
        for _ in 0..<240 { await nextFrame() }
        let clip = sv.contentView
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
        sv.reflectScrolledClipView(clip)
        for _ in 0..<60 { await nextFrame() }
        let streamingAtJump = model.currentFeed?.isRunning ?? false
        let follows0 = PerfProbe.counts["scroll.follow"] ?? 0, bodies0 = PerfProbe.counts["body.AnswerView.running"] ?? 0
        let retries0 = PerfProbe.counts["scroll.jumpRetry"] ?? 0
        let t0 = DispatchTime.now()
        PerfProbe.jumpToLatest?(animated)
        var samples: [[String: Any]] = []
        while model.currentFeed?.isRunning == true && Self.ms(since: t0) < 90_000 {
            for _ in 0..<60 { await nextFrame() }
            var s = jumpSample(sv, model)
            s["t"] = Self.ms(since: t0) / 1000
            samples.append(s)
        }
        let streamSecs = Self.ms(since: t0) / 1000
        let follows = (PerfProbe.counts["scroll.follow"] ?? 0) - follows0
        let bodies = (PerfProbe.counts["body.AnswerView.running"] ?? 0) - bodies0
        for _ in 0..<120 { await nextFrame() }
        var end = jumpSample(sv, model)
        end["following"] = PerfProbe.following
        summary["jumpStream"] = [
            "animated": animated, "streamingAtJump": streamingAtJump, "streamSecondsAfterJump": streamSecs,
            "restickPer10s": streamSecs > 0 ? Double(follows) / streamSecs * 10 : -1, "follows": follows,
            "streamBodyUpdates": bodies, "jumpRetries": (PerfProbe.counts["scroll.jumpRetry"] ?? 0) - retries0,
            "drawnAll": samples.allSatisfy { ($0["draws"] as? Bool) == true },
            "pastLastRowDuring": samples.filter { ($0["pastLastRow"] as? Bool) == true }.count,
            "lastVisibleDuring": samples.filter { ($0["lastTurnVisible"] as? Bool) == true }.count,
            "samples": samples.count, "end": end]
    }

    /// restore→send / jump→send (final review I1), perf-table with COMPANION_DEMO_MODE=automatic. restore: scroll s1 to
    /// the middle, switch to s2 and back (s1 restores to its line). jump: scroll to the top and Jump to latest
    /// (instant). Then ask a question, and sample twice a second until its answer has finished, and once after.
    private func sendAfter(_ model: AppModel, restore: Bool) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        if restore {
            // With the wheel, as a reader would (a clip move was not adopted here: the chat stayed at its bottom,
            // following, and nothing was saved to restore).
            let mid = max(0, ((sv.documentView?.frame.height ?? 0) - clip.bounds.height) / 2)
            var tries = 0
            while abs(clip.bounds.origin.y - mid) > 150 && tries < 400 {
                let y0 = clip.bounds.origin.y
                chatWheel(sv, by: mid - y0)
                await nextFrame()
                learnWheel(moved: clip.bounds.origin.y - y0)
                tries += 1
            }
            for _ in 0..<30 { await nextFrame() }
            summary["restoreFrom"] = ["clipY": Double(clip.bounds.origin.y), "following": PerfProbe.following]
            await model.pin("s2")
            for _ in 0..<30 { await nextFrame() }
            await model.pin("s1")
            for _ in 0..<90 { await nextFrame() }
        } else {
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            sv.reflectScrolledClipView(clip)
            for _ in 0..<60 { await nextFrame() }
            PerfProbe.jumpToLatest?(false)
            for _ in 0..<60 { await nextFrame() }
        }
        guard let rsv = chatScrollView() else { summary["error"] = "no scroll view after the switch"; return }
        let before = jumpSample(rsv, model)
        summary["restores"] = PerfProbe.counts["scroll.restore"] ?? 0
        let fallbacks0 = PerfProbe.counts["scroll.markerFallback"] ?? 0
        let asked = await model.ask("A follow-up question from the send driver.")
        var samples: [[String: Any]] = []
        let t0 = DispatchTime.now()
        repeat {
            for _ in 0..<60 { await nextFrame() }
            samples.append(jumpSample(rsv, model))
        } while model.currentFeed?.isRunning == true && Self.ms(since: t0) < 30_000
        for _ in 0..<60 { await nextFrame() }
        var end = jumpSample(rsv, model)
        end["following"] = PerfProbe.following
        end["jumpShown"] = PerfProbe.jumpShown
        summary["send"] = ["restore": restore, "asked": asked, "before": before, "samples": samples.count,
                           "drawnAll": samples.allSatisfy { ($0["draws"] as? Bool) == true },
                           "lastVisibleAll": samples.allSatisfy { ($0["lastTurnVisible"] as? Bool) == true },
                           "pastLastRow": samples.filter { ($0["pastLastRow"] as? Bool) == true }.count,
                           "markerFallbacks": (PerfProbe.counts["scroll.markerFallback"] ?? 0) - fallbacks0, "end": end]
    }

    /// perf-stream: 2 s into the stream, a reader moves up a little and must stay put while the answer keeps growing
    /// (final re-review). COMPANION_PERF_UPKIND=wheel (default): one 40 pt wheel notch, no scroll phase. =page: the
    /// scroll view's Page Up, as the keyboard does. COMPANION_PERF_UPAFTER=jump: first scroll to the top and Jump to
    /// latest, so the chat follows the stream on the row path (RowJump) when the reader moves.
    private func upStay(_ model: AppModel) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        for _ in 0..<240 { await nextFrame() }
        if PerfFlags.env["COMPANION_PERF_UPAFTER"] == "jump" {
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            sv.reflectScrolledClipView(clip)
            for _ in 0..<60 { await nextFrame() }
            PerfProbe.jumpToLatest?(false)
            for _ in 0..<120 { await nextFrame() }
        }
        let before: [String: Any] = ["following": PerfProbe.following, "streaming": model.currentFeed?.isRunning ?? false]
        let y0 = clip.bounds.origin.y
        if PerfFlags.env["COMPANION_PERF_UPKIND"] == "page" { sv.pageUp(nil) } else { _ = chatWheel(sv, by: -40) }
        await nextFrame(); await nextFrame()
        let y1 = clip.bounds.origin.y
        let prog0 = PerfProbe.programmaticScrolls
        var pulls = 0, last = y1, maxDrift: CGFloat = 0
        for _ in 0..<600 {
            await nextFrame()
            let y = clip.bounds.origin.y
            if y > last + 1 { pulls += 1 }          // moved down under the reader: pulled toward the bottom
            maxDrift = max(maxDrift, abs(y - y1))
            last = y
        }
        // COMPANION_PERF_SHOT=<png>: the window at the end, to look at what the pixel check saw.
        if let p = PerfFlags.env["COMPANION_PERF_SHOT"] { DemoShot.write(to: URL(fileURLWithPath: p)) }
        summary["upStay"] = ["kind": PerfFlags.env["COMPANION_PERF_UPKIND"] ?? "wheel",
                             "afterJump": PerfFlags.env["COMPANION_PERF_UPAFTER"] == "jump", "before": before,
                             "movedUp": Double(y0 - y1), "pulls": pulls, "maxDrift": Double(maxDrift),
                             "appScrolls": PerfProbe.programmaticScrolls - prog0,
                             "following": PerfProbe.following, "jumpShown": PerfProbe.jumpShown,
                             "streamingAtEnd": model.currentFeed?.isRunning ?? false, "draws": chatDrawsSomething()]
    }

    /// Jump (instant) from the top, scroll up about one screen, then back down to the end with wheel notches (final
    /// review I2): following must re-arm and Jump to latest hide, with the chat drawn throughout.
    private func jumpUpDown(_ model: AppModel) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        // COMPANION_PERF_PREJUMP=1: an animated jump and back to the top first, as the jump driver does before its
        // instant jump (that instant jump left the estimated end ~11,500 pt below the last row at 300 pt).
        if PerfFlags.env["COMPANION_PERF_PREJUMP"] == "1" {
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
            sv.reflectScrolledClipView(clip)
            for _ in 0..<60 { await nextFrame() }
            PerfProbe.jumpToLatest?(true)
            for _ in 0..<120 { await nextFrame() }
        }
        clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: 0))
        sv.reflectScrolledClipView(clip)
        for _ in 0..<60 { await nextFrame() }
        PerfProbe.jumpToLatest?(false)
        for _ in 0..<60 { await nextFrame() }
        var atJump = jumpSample(sv, model)
        atJump["following"] = PerfProbe.following
        let screen = clip.bounds.height
        var moved: CGFloat = 0, tries = 0
        while moved < screen * 0.9 && tries < 60 {
            let y0 = clip.bounds.origin.y
            _ = chatWheel(sv, by: -40)
            await nextFrame()
            moved += y0 - clip.bounds.origin.y
            tries += 1
        }
        for _ in 0..<30 { await nextFrame() }
        var up = jumpSample(sv, model)
        up["following"] = PerfProbe.following
        up["jumpShown"] = PerfProbe.jumpShown
        up["movedUp"] = Double(moved)
        var drawnAll = true
        tries = 0
        // Back down, 40 pt a notch, until following re-arms or 2 screens' worth of notches (past the real end).
        while tries < Int(screen * 2 / 40) {
            _ = chatWheel(sv, by: 40)
            await nextFrame(); await nextFrame()
            if !chatDrawsSomething() { drawnAll = false }
            tries += 1
            if PerfProbe.following.hasPrefix("true") { break }
        }
        for _ in 0..<60 { await nextFrame() }
        var end = jumpSample(sv, model)
        end["following"] = PerfProbe.following
        end["jumpShown"] = PerfProbe.jumpShown
        end["notches"] = tries
        summary["jumpUpDown"] = ["atJump": atJump, "up": up, "end": end, "drawnAll": drawnAll && (end["draws"] as? Bool) == true]
    }

    /// The jump driver's sample: drawn (pixels), the last turn in the reading area, and the reading area's bottom
    /// against the last turn's bottom (`pastLastRow`: more than the padding and marker below it, 18 pt).
    private func jumpSample(_ sv: NSScrollView, _ model: AppModel) -> [String: Any] {
        let clip = sv.contentView
        let docH = sv.documentView?.frame.height ?? 0
        var out: [String: Any] = ["turnVisible": PerfProbe.firstVisibleTurn != nil, "turnInClip": turnInClip(),
                                  "draws": chatDrawsSomething(),
                                  "lastTurnVisible": turnInClip(model.currentFeed?.turns.last?.id),
                                  "distanceFromBottom": Double(docH - clip.bounds.height - clip.bounds.origin.y)]
        if let last = model.currentFeed?.turns.last?.id, let f = PerfProbe.rowFrames[last] {
            let gap = Double(clip.bounds.maxY) - PerfProbe.contentInsetBottom - f.upperBound
            out["gapBelowLastRow"] = gap
            out["pastLastRow"] = gap > 18.5
        }
        return out
    }

    /// Scroll to the middle, switch to the other session and back, then open a past chat and close it: the first
    /// visible turn (and how far into it the viewport top is) should be the same after each round trip.
    private func position(_ model: AppModel) async {
        guard let sv = chatScrollView() else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        let mid = max(0, ((sv.documentView?.frame.height ?? 0) - clip.bounds.height) / 2)
        if PerfFlags.wheelInput {
            // As a mouse user would: wheel there (large discrete steps, several per frame).
            var tries = 0
            while abs(clip.bounds.origin.y - mid) > 150 && tries < 400 {
                let y0 = clip.bounds.origin.y
                chatWheel(sv, by: mid - y0)
                await nextFrame()
                learnWheel(moved: clip.bounds.origin.y - y0)
                tries += 1
            }
            summary["wheelToMiddle"] = ["frames": tries, "missPt": Double(clip.bounds.origin.y - mid)]
        } else {
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: mid))
            sv.reflectScrolledClipView(clip)
        }
        for _ in 0..<30 { await nextFrame() }
        func sample() -> [String: Any] {
            ["turn": PerfProbe.firstVisibleTurn?.uuidString ?? "nil", "inset": PerfProbe.firstVisibleInset ?? -1,
             "clipY": Double(chatScrollView()?.contentView.bounds.origin.y ?? -1), "p": PerfProbe.programmaticScrolls,
             "insetTop": PerfProbe.contentInsetTop]
        }
        let before = sample()
        let (turn0, inset0) = (PerfProbe.firstVisibleTurn, PerfProbe.firstVisibleInset)
        func same() -> Bool {
            guard let turn0, let inset0, let t = PerfProbe.firstVisibleTurn, let i = PerfProbe.firstVisibleInset else { return false }
            return t == turn0 && abs(i - inset0) <= 2
        }
        await model.pin("s2")
        for _ in 0..<30 { await nextFrame() }
        await model.pin("s1")
        for _ in 0..<60 { await nextFrame() }
        let afterSwitch = sample(), sameSwitch = same()
        // Rapid switches: s2, s1, s2, s1 with no frame between, then the same with one frame between.
        for _ in 0..<2 { await model.pin("s2"); await model.pin("s1") }
        for _ in 0..<60 { await nextFrame() }
        let afterRapid0 = sample(), sameRapid0 = same()
        for _ in 0..<2 {
            await model.pin("s2"); await nextFrame()
            await model.pin("s1"); await nextFrame()
        }
        for _ in 0..<60 { await nextFrame() }
        let afterRapid1 = sample(), sameRapid1 = same()
        await model.loadHistory()
        if let past = model.history?.chats.first(where: { $0.threadId != model.history?.currentThreads["s1"] }) {
            await model.openPastChat(past)
            for _ in 0..<30 { await nextFrame() }
            model.closePastChat()
            for _ in 0..<60 { await nextFrame() }
        } else {
            summary["error"] = "no past chat"
        }
        let afterPast = sample()
        let samePast = same()
        // A reader who scrolls right after coming back: switch away and back, and as soon as the saved turn is the
        // first visible one, scroll down 300 pt (20 pt per frame). The restore must not pull them back.
        await model.pin("s2")
        for _ in 0..<30 { await nextFrame() }
        let restoresBefore = PerfProbe.counts["scroll.restore"] ?? 0
        await model.pin("s1")
        // Wait for the restore's scroll to the saved turn, then for that turn to be the first visible one.
        var waited = 0
        while (PerfProbe.counts["scroll.restore"] ?? 0) == restoresBefore && waited < 120 { await nextFrame(); waited += 1 }
        await nextFrame()
        while PerfProbe.firstVisibleTurn != turn0 && waited < 120 { await nextFrame(); waited += 1 }
        let progBefore = PerfProbe.programmaticScrolls
        // Opening and closing the past chat replaced the chat's view: use the scroll view shown now.
        guard let rsv = chatScrollView() else { summary["error"] = "no scroll view after the past chat"; return }
        let rclip = rsv.contentView
        var y = rclip.bounds.origin.y, pulls = 0
        var readerMoves: [Double] = []
        for _ in 0..<15 {
            if PerfFlags.wheelInput {
                let y0 = rclip.bounds.origin.y
                chatWheel(rsv, by: 20)
                await nextFrame()
                let moved = rclip.bounds.origin.y - y0
                readerMoves.append(Double(moved))
                learnWheel(moved: moved)
                if abs(moved - 20 * (wheelScale > 0 ? 1 : 1)) > 12 { pulls += 1 } // not (about) the reader's 20 pt
                y = rclip.bounds.origin.y
            } else {
                y += 20
                rclip.scroll(to: NSPoint(x: rclip.bounds.origin.x, y: y))
                rsv.reflectScrolledClipView(rclip)
                await nextFrame()
                if abs(rclip.bounds.origin.y - y) > 1 { pulls += 1; y = rclip.bounds.origin.y } // moved under the reader
            }
        }
        let yAfterReader = rclip.bounds.origin.y
        for _ in 0..<60 { await nextFrame() }
        let readerScroll: [String: Any] = [
            "framesToLand": waited, "restoreEnds": PerfProbe.counts.filter { $0.key.hasPrefix("restore.end") }, "appScrollsDuringAndAfter": PerfProbe.programmaticScrolls - progBefore,
            "movedAfterReaderStopped": Double(rclip.bounds.origin.y - yAfterReader),
            "pullsWhileScrolling": pulls, "readerMoves": readerMoves]
        // perf-stream: s1 is still streaming throughout; coming back must not land at the bottom.
        let docH = rsv.documentView?.frame.height ?? 0
        if PerfFlags.wheelInput { summary["wheelInput"] = wheelStats() }
        summary["position"] = ["before": before, "afterSwitch": afterSwitch, "afterRapid0": afterRapid0,
                               "afterRapid1": afterRapid1, "afterPast": afterPast,
                               "same": sameSwitch, "sameRapid0": sameRapid0, "sameRapid1": sameRapid1,
                               "samePast": samePast, "turnKnown": turn0 != nil, "readerScroll": readerScroll,
                               "distanceFromBottomAtEnd": Double(docH - rclip.bounds.height - rclip.bounds.origin.y),
                               "streaming": model.currentFeed?.isRunning ?? false]
    }

    /// The view under a window point, as NSWindow.sendEvent finds it: hitTest takes the point in the superview's
    /// coordinates (the contentView is flipped, so converting into its own space would mirror y).
    private static func hit(_ win: NSWindow, _ p: NSPoint) -> NSView? {
        guard let frameView = win.contentView?.superview else { return nil }
        return frameView.hitTest(frameView.convert(p, from: nil))
    }

    /// Every horizontally overflowing NSScrollView inside the chat (the non-wrapping code blocks, wide tables).
    private func overflowScrollers(in chat: NSScrollView) -> [NSScrollView] {
        var out: [NSScrollView] = []
        func walk(_ v: NSView) {
            if let s = v as? NSScrollView, s !== chat, let d = s.documentView, d.frame.width > s.contentView.bounds.width + 1 { out.append(s) }
            v.subviews.forEach(walk)
        }
        if let d = chat.documentView { walk(d) }
        return out
    }

    /// One synthesized wheel event at `p` (window coordinates), delivered through the window like the system would.
    /// `phase`: nil = mouse wheel (no phases, line-like), else the CGScrollPhase of a trackpad gesture.
    private func sendWheel(_ win: NSWindow, at p: NSPoint, dy: Int32, dx: Int32 = 0, phase: Int64? = nil,
                           lines: Bool = false) -> [String: Any] {
        guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: lines ? .line : .pixel, wheelCount: 2, wheel1: dy,
                               wheel2: dx, wheel3: 0) else { return ["error": "no cgevent"] }
        let screen = win.convertPoint(toScreen: p)
        let primaryH = NSScreen.screens.first?.frame.height ?? 0
        cg.location = CGPoint(x: screen.x, y: primaryH - screen.y)
        cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: phase == nil ? 0 : 1)
        if let phase { cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase) }
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(win.windowNumber))
        cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(win.windowNumber))
        guard let ev = NSEvent(cgEvent: cg) else { return ["error": "no nsevent"] }
        // NSEvent(cgEvent:) cannot carry a window or a window location, so do what NSWindow.sendEvent does for a
        // scroll event: hit-test at the pointer, then hand the event to that view (it forwards up its responder chain).
        guard let hit = Self.hit(win, p) else { return ["error": "no hit view"] }
        hit.scrollWheel(with: ev)
        return ["win": ev.windowNumber, "loc": "\(Int(ev.locationInWindow.x)),\(Int(ev.locationInWindow.y))",
                "dy": Double(ev.scrollingDeltaY), "phase": Int(ev.phase.rawValue)]
    }

    // MARK: Mouse-wheel input for the scroll and position drivers

    private var wheelScale: CGFloat = 10    // chat points moved per wheel line (notch), learned from the events
    private var wheelEvents = 0, wheelNoMove = 0
    private var wheelPoint: NSPoint?

    /// A point over the chat's text (not a code or table scroller), in window coordinates.
    private func chatPoint(_ sv: NSScrollView, _ win: NSWindow) -> NSPoint? {
        if let p = wheelPoint, let h = Self.hit(win, p), h.isDescendant(of: sv) { return p }
        let r = sv.convert(sv.bounds, to: nil)
        let scrollers = overflowScrollers(in: sv).map { $0.convert($0.bounds, to: nil) }
        for k in stride(from: 0, to: Int(r.height) / 2 - 40, by: 12) {
            for sign in [CGFloat(1), -1] {
                let c = NSPoint(x: r.midX, y: r.midY + sign * CGFloat(k))
                if scrollers.contains(where: { $0.insetBy(dx: -4, dy: -4).contains(c) }) { continue }
                if let h = Self.hit(win, c), h.isDescendant(of: sv) { wheelPoint = c; return c }
            }
        }
        return nil
    }

    /// Scrolls the chat by about `dy` points (positive: toward the bottom) with one discrete mouse-wheel event of
    /// whole lines (notches), as a mouse wheel sends; returns how far it moved right away.
    @discardableResult
    private func chatWheel(_ sv: NSScrollView, by dy: CGFloat) -> CGFloat {
        guard let win = panel, abs(dy) >= 0.5, let p = chatPoint(sv, win) else { return 0 }
        let y0 = sv.contentView.bounds.origin.y
        // Negative wheel1 scrolls the content up (the chat offset grows).
        var px = Int32(max(-3000, min(3000, (-dy / wheelScale).rounded())))
        if px == 0 { px = dy > 0 ? -1 : 1 }
        _ = sendWheel(win, at: p, dy: px, lines: true)
        wheelEvents += 1
        let moved = sv.contentView.bounds.origin.y - y0
        if abs(moved) > 0.5 {
            wheelScale = max(0.05, min(200, abs(moved / CGFloat(px))))
            wheelPending = 0
        } else {
            wheelNoMove += 1                       // applied on the next frame
            wheelPending = -CGFloat(px) * wheelScale
            wheelPendingPx = px
        }
        return moved
    }

    /// What the last wheel event should move the chat by once applied (points; 0 when it moved at once).
    private var wheelPending: CGFloat = 0
    private var wheelPendingPx: Int32 = 0

    /// Called once the pending event has been applied: refines points per wheel pixel from what really moved.
    private func learnWheel(moved: CGFloat) {
        guard PerfFlags.wheelInput, wheelPendingPx != 0 else { return }
        let r = abs(moved / CGFloat(wheelPendingPx))
        // Only a move in the asked direction and of a plausible size (not a correction or a yank) teaches the scale.
        if (moved > 0) == (wheelPendingPx < 0), r > 0.05, r < 200, abs(abs(moved) - abs(wheelPending)) < 0.5 * abs(wheelPending) + 40 {
            wheelScale = r
        }
        wheelPendingPx = 0
    }

    /// `noImmediateMove` counts events the chat applied on the next frame rather than inside `scrollWheel` (the usual
    /// case): it does not mean the chat did not move. The scroll driver's `travelPt` / `lowestY` say how far it did.
    private func wheelStats() -> [String: Any] {
        ["events": wheelEvents, "noImmediateMove": wheelNoMove, "ptPerLine": Double(wheelScale)]
    }

    /// Whether vertical wheel and trackpad scrolling over a non-wrapping code block still scrolls the chat.
    private func wheel() async {
        guard let sv = chatScrollView(), let win = panel else { summary["error"] = "no scroll view"; return }
        let clip = sv.contentView
        // Find a viewport position where a code scroller is fully visible.
        var y = max(0, (sv.documentView?.frame.height ?? 0) / 2 - clip.bounds.height / 2)
        var target: NSScrollView?
        for _ in 0..<60 {
            clip.scroll(to: NSPoint(x: 0, y: y)); sv.reflectScrolledClipView(clip)
            for _ in 0..<4 { await nextFrame() }
            let vis = clip.documentVisibleRect
            target = overflowScrollers(in: sv).first { s in
                let f = s.convert(s.bounds, to: sv.documentView)
                return f.minY > vis.minY + 40 && f.maxY < vis.maxY - 40 && f.height > 40
            }
            if target != nil { break }
            y += clip.bounds.height * 0.6
        }
        guard let code = target, let doc = sv.documentView else { summary["error"] = "no code scroller found"; return }
        let startY = clip.bounds.origin.y
        summary["wheelStartY"] = Double(startY)
        let cf = code.convert(code.bounds, to: nil)
        // A point inside the code scroller whose hit view really is inside it (selection overlays can sit above).
        var codePoint = NSPoint(x: cf.midX, y: cf.midY)
        var insideHits = 0, samples = 0
        do {
            var found: NSPoint?
            for fy in stride(from: 0.2, through: 0.8, by: 0.15) { for fx in stride(from: 0.15, through: 0.85, by: 0.15) {
                let c = NSPoint(x: cf.minX + cf.width * fx, y: cf.minY + cf.height * fy)
                samples += 1
                if let h = Self.hit(win, c), h.isDescendant(of: code) { insideHits += 1; if found == nil { found = c } }
            } }
            if let found { codePoint = found }
        }
        summary["wheelCodeSamples"] = "\(insideHits)/\(samples) inside the code scroller"
        // A prose point: in the viewport, at the code's x, not inside any overflowing scroller.
        let scrollers = overflowScrollers(in: sv).map { $0.convert($0.bounds, to: nil) }
        let vis = clip.convert(clip.bounds, to: nil)
        // A prose point: inside the chat's viewport (a hit view that is a descendant of the chat's document), at the
        // code's x, not inside any overflowing scroller; searched outward from the middle of the viewport.
        var prosePoint: NSPoint?
        do {
            for k in stride(from: 0, to: Int(vis.height) / 2 - 30, by: 8) {
                for sign in [CGFloat(1), -1] {
                    let c = NSPoint(x: cf.midX, y: vis.midY + sign * CGFloat(k))
                    if scrollers.contains(where: { $0.insetBy(dx: -4, dy: -4).contains(c) }) { continue }
                    if let h = Self.hit(win, c), h.isDescendant(of: doc), prosePoint == nil { prosePoint = c }
                }
                if prosePoint != nil { break }
            }
        }
        guard let prosePoint else { summary["error"] = "no prose point"; return }
        func hitName(_ p: NSPoint) -> String {
            var names: [String] = []
            var v = Self.hit(win, p)
            while let x = v, names.count < 4 { names.append(String(describing: type(of: x)).prefix(40).description); v = x.superview }
            return names.joined(separator: " < ")
        }
        summary["wheelCodeHit"] = hitName(codePoint)
        if let h = Self.hit(win, codePoint) {
            summary["wheelHitInsideCodeScroller"] = h.isDescendant(of: code)
            summary["wheelCodeFrame"] = "\(code.convert(code.bounds, to: nil))"
            summary["wheelHitFrame"] = "\(h.convert(h.bounds, to: nil))"
            var chain: [String] = []
            var v: NSView? = h
            while let x = v, chain.count < 12 { chain.append(String(describing: type(of: x)).prefix(30).description + (x === code ? "*" : "")); v = x.superview }
            summary["wheelHitChain"] = chain
        }
        summary["wheelProseHit"] = hitName(prosePoint)
        summary["wheelCodeDoc"] = "\(Int(code.documentView?.frame.width ?? 0)) in \(Int(code.contentView.bounds.width))"
        var results: [String: Any] = [:]
        func reset() async {
            clip.scroll(to: NSPoint(x: 0, y: startY)); sv.reflectScrolledClipView(clip)
            code.contentView.scroll(to: .zero); code.reflectScrolledClipView(code.contentView)
            for _ in 0..<5 { await nextFrame() }
        }
        func moved() -> Double { Double(clip.bounds.origin.y - startY) }
        func runGesture(_ name: String, at p: NSPoint, dy: Int32, dx: Int32, trackpad: Bool, count: Int) async {
            await reset()
            var info: [String: Any] = [:]
            if trackpad {
                info["first"] = sendWheel(win, at: p, dy: dy, dx: dx, phase: 1)
                await nextFrame()
                for _ in 0..<count { _ = sendWheel(win, at: p, dy: dy, dx: dx, phase: 2); await nextFrame() }
                _ = sendWheel(win, at: p, dy: 0, dx: 0, phase: 4)
            } else {
                for i in 0..<count {
                    let r = sendWheel(win, at: p, dy: dy, dx: dx)
                    if i == 0 { info["first"] = r }
                    await nextFrame()
                }
            }
            for _ in 0..<4 { await nextFrame() }
            info["chatMovedPt"] = moved()
            info["codeScrollX"] = Double(code.contentView.bounds.origin.x)
            results[name] = info
        }
        // Negative wheel1 scrolls the content up (the chat offset grows).
        await runGesture("mouse-prose", at: prosePoint, dy: -40, dx: 0, trackpad: false, count: 10)
        await runGesture("mouse-code", at: codePoint, dy: -40, dx: 0, trackpad: false, count: 10)
        await runGesture("trackpad-prose", at: prosePoint, dy: -20, dx: 0, trackpad: true, count: 20)
        await runGesture("trackpad-code", at: codePoint, dy: -20, dx: 0, trackpad: true, count: 20)
        await runGesture("trackpad-prose-diag", at: prosePoint, dy: -20, dx: 3, trackpad: true, count: 20)
        await runGesture("trackpad-code-diag", at: codePoint, dy: -20, dx: 3, trackpad: true, count: 20)
        await runGesture("mouse-code-horizontal", at: codePoint, dy: 0, dx: -40, trackpad: false, count: 10)
        await runGesture("trackpad-code-horizontal", at: codePoint, dy: 0, dx: -20, trackpad: true, count: 20)
        summary["wheel"] = results
        _ = doc
    }

    private func resize() async {
        guard let p = panel else { return }
        var widths: [Double] = []
        var w: CGFloat = 600, dir: CGFloat = -1
        let end = DispatchTime.now().uptimeNanoseconds + UInt64(PerfFlags.seconds * 1e9)
        // As when the user drags the panel's edge: AppKit posts these around a live resize.
        // The first frames after each notification carry ChatTextSelection's switch (every selectable Text rebuilt):
        // timed separately, before the steps start and after they end.
        func transition() async -> [Double] {
            var out: [Double] = []
            var t = DispatchTime.now()
            for _ in 0..<3 { await nextFrame(); out.append(Self.ms(since: t)); t = .now() }
            return out
        }
        NotificationCenter.default.post(name: NSWindow.willStartLiveResizeNotification, object: p)
        let startFrames = await transition()
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
        NotificationCenter.default.post(name: NSWindow.didEndLiveResizeNotification, object: p)
        let endFrames = await transition()
        summary["resize"] = ["steps": widths.count, "setFrameMs": Self.stats(widths),
                             "startFramesMs": startFrames, "endFramesMs": endFrames]
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
