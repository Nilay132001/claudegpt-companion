#if DEBUG
import AppKit
import CompanionCore
import Foundation

/// DEBUG-only (ruling R6): COMPANION_DEMO=<scene> runs the real views on synthetic data. Nothing leaves the process.
/// Scenes: empty, chat, rich, context, raw, history, pastChat, streaming, ask, signedOut, daemonDown, noSession, error, whatGPTSees, status,
/// and the M9 perf scenes perf-short, perf-medium, perf-long, perf-stream (PerfHarness.swift).
/// COMPANION_DEMO_WIDTH=<pt> sets the panel width; COMPANION_DEMO_LONG=1 uses long synthetic titles, repo, branch and
/// paths (the real-world lengths that overlapped in the first M8 build).
enum DemoFlags {
    static let scene: String? = ProcessInfo.processInfo.environment["COMPANION_DEMO"]
    static func is_(_ s: String) -> Bool { scene == s }
    static let long = ProcessInfo.processInfo.environment["COMPANION_DEMO_LONG"] == "1"
    static let width: String? = ProcessInfo.processInfo.environment["COMPANION_DEMO_WIDTH"]
    /// `rich` scene: "bottom" starts at the last answer instead of the first.
    static let anchor: String? = ProcessInfo.processInfo.environment["COMPANION_DEMO_ANCHOR"]
    /// COMPANION_DEMO_WRAP=1 starts with "Wrap long lines in code blocks" on.
    static let wrap = ProcessInfo.processInfo.environment["COMPANION_DEMO_WRAP"] == "1"
}

@MainActor final class DemoDaemon: DaemonAPI {
    static let root = DemoFlags.long ? "/Volumes/Work/acme-payments-reconciliation-service" : "/Volumes/Work/acme-widgets"
    static let title = DemoFlags.long
        ? "Investigate flaky integration tests in the payments reconciliation worker after the Node upgrade"
        : "Refactor widget parser"
    static let branch = DemoFlags.long ? "claude/fix-flaky-reconciliation-tests-7f3a2c" : "fix/parser"
    static let relativeFile = DemoFlags.long ? "packages/worker/src/reconcile/ledgerMatcher.ts" : "src/parser/tokenize.ts"
    static let editedFile = root + "/" + relativeFile
    static let movedTo = DemoFlags.long ? root + "/packages/worker" : root + "/packages/csv"
    let scene: String
    let events: AsyncStream<DaemonEvent>
    let sink: AsyncStream<DaemonEvent>.Continuation
    var turn = 0
    var cleared = false
    /// perf scenes only: the session sessions.pin selected (the switch driver alternates s1 and s2).
    var selectedId = "s1"
    /// perf scenes only: the stored turns of each session, built once.
    var perfTurns: [String: [TurnRecord]] = [:]

    init(scene: String) {
        self.scene = scene
        (events, sink) = AsyncStream.makeStream(of: DaemonEvent.self)
    }
    nonisolated var connection: Connection { Connection(api: self, events: events, close: {}) }

    /// The connector for the scene: daemonDown never connects.
    var connector: Connector {
        if scene == "daemonDown" {
            return { throw DaemonError(code: DaemonErrorCode.internalError, message: "companiond exited before it answered (exit code 1). Its log is in Console under ClaudeGPT Companion.") }
        }
        let c = connection
        return { c }
    }

    /// Questions typed by the demo after start (chat-flow scenes).
    var autoQuestion: String? {
        switch scene {
        case "streaming", "ask", "error": "Why does the widget parser drop the last token, and is Claude's fix right?"
        case "perf-stream": "Walk me through every change Claude made to the parser and the CSV writer, with the risks."
        default: nil
        }
    }

    var mode: String {
        switch scene {
        case "streaming", "error", "perf-stream": "automatic"
        default: "ask"
        }
    }

    static func j<T: Decodable>(_ s: String) -> T { try! JSONDecoder().decode(T.self, from: Data(s.utf8)) }

    func hello() async throws -> HelloResult { Self.j(#"{"protocolVersion":1,"daemonVersion":"0.8.0"}"#) }
    func shutdown() async throws {}
    func hostStatus() async throws -> HostState { Self.j(#"{"state":"ready","warnings":[]}"#) }
    func hostRestart() async throws -> HostState { try await hostStatus() }
    func hostAcknowledgeSecurityStop() async throws -> HostState { try await hostStatus() }
    func authStatus() async throws -> AuthState {
        scene == "signedOut" ? Self.j(#"{"state":"signed_out"}"#) : Self.j(#"{"state":"signed_in","planType":"plus"}"#)
    }
    func authLogin() async throws -> URL { URL(string: "https://example.invalid")! }

    var snapJSON: String {
        let selected = scene == "noSession" ? "null" : "\"\(selectedId)\""
        let moved = scene == "status" ? #","focusMovedTo":"s2""# : ""
        return """
        {"sessions":[{"sessionId":"s1","cliSessionId":"c1","title":\(Self.quote(Self.title)),"status":"busy","isArchived":false,
        "lastFocusedAt":1,"lastActivityAt":1,"recordCwd":"\(Self.root)","recordBranch":"\(Self.branch)","resolvedRoot":"\(Self.root)","source":"desktop"},
        {"sessionId":"s2","cliSessionId":"c2","title":"Add CSV export","status":"idle","isArchived":false,
        "lastFocusedAt":1,"lastActivityAt":1,"recordCwd":"\(Self.root)","recordBranch":"main","resolvedRoot":"\(Self.root)","source":"desktop"}],
        "selection":{"sessionId":\(selected),"via":"\(scene == "noSession" ? "none" : selectedId == "s1" ? "focus" : "pin")","focusedSessionId":"s1","focusLabel":"Claude focus","pinnedMissing":false\(moved)},
        "refreshedAt":1}
        """
    }
    func sessionsSnapshot() async throws -> SessionsSnapshot { Self.j(snapJSON) }
    func sessionsRefresh() async throws -> SessionsSnapshot { Self.j(snapJSON) }
    func sessionsPin(_ sessionId: String?) async throws -> Selection {
        if PerfFlags.isPerfScene {
            selectedId = sessionId ?? "s1"
            return Self.j(#"{"sessionId":"\#(selectedId)","via":"pin","focusedSessionId":"s1","focusLabel":"Claude focus","pinnedMissing":false}"#)
        }
        return Self.j(#"{"sessionId":"s1","via":"focus","focusedSessionId":"s1","focusLabel":"Claude focus","pinnedMissing":false}"#)
    }
    func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups {
        // The two sessions of the snapshot, as busy and idle.
        let parts = snapJSON.components(separatedBy: #"},{"sessionId":"s2""#)
        let first = parts[0].replacingOccurrences(of: #"{"sessions":["#, with: "") + "}"
        let second = #"{"sessionId":"s2""# + parts[1].components(separatedBy: "}],")[0] + "}"
        return Self.j(#"{"busy":[\#(first)],"idle":[\#(second)],"recent":[],"older":[]}"#)
    }
    func sessionsSync(_ sessionId: String) async throws -> SyncStatus { SyncStatus(state: "live", stats: nil, lastPollAt: 1) }
    func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution? {
        Self.j(#"{"kind":"resolved","root":"\#(Self.root)","branch":"\#(Self.branch)","isLinkedWorktree":false}"#)
    }
    func privacyGet() async throws -> PrivacyState {
        Self.j(#"{"sharingMode":"\#(mode)","approvals":[{"root":"\#(Self.root)","commonDir":"\#(Self.root)/.git","includeWorktrees":true,"approvedAt":1}],"redactionNotice":"Secrets that look like keys or tokens are masked (best effort)."}"#)
    }
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode { mode }
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        Self.j(#"{"root":"\#(root)","commonDir":"\#(root)/.git","includeWorktrees":true,"approvedAt":1}"#)
    }
    func privacyRevoke(root: String) async throws -> RevokeResult { RevokeResult(revoked: true, pendingClose: 0) }

    /// Real item kinds and labels from companiond/src/context/contextBuilder.ts (user, assistant, command,
    /// failure, file_edit, subagent, folder).
    static let items: [(String, String, String, Int)] = [
        ("user", "Claude user message", "The widget parser drops the last token when the input ends without a newline. Can you fix it?", 0),
        ("assistant", "Claude reply", "Found it: `tokenize()` only flushes the buffer on a newline. I'll move the flush after the loop so the last token is kept, then run the parser tests.", 0),
        ("failure", "Failure", "Tests failed in `npm test -- parser` (exit 1): 1 failing: tokenize keeps the last token\nexpected [ 'a', 'b' ] to deeply equal [ 'a', 'b', '' ]\n  at test/parser.test.ts:31:18", 0),
        ("file_edit", "Claude edited a file", editedFile, 0),
        ("command", "$ npm test -- parser", "exit 0\n✓ 42 tests passed (parser)\n✓ 3 snapshots", 0),
        ("subagent", "Subagent result", "Checked the CSV exporter: it calls tokenize() on each cell, so the fix also stops it dropping the last cell of a row without a trailing newline. I also saw NPM_TOKEN=•••••• in the test env file.", 1),
        ("folder", "Claude changed folder", root + " → " + movedTo, 0),
    ]

    static let omittedNote = "2 item(s) left out to stay under 12 KB (kept your messages and Claude's replies first; left out: 2 tool)."

    func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        let list = Self.items.prefix(5).enumerated().map { i, it in
            #"{"id":"item-\#(i + 1)","kind":"\#(it.0)","label":\#(Self.quote(it.1)),"text":\#(Self.quote(it.2)),"redactions":\#(it.3)}"#
        }.joined(separator: ",")
        return Self.j("""
        {"prepareId":"p\(turn)","sessionId":"s1","mode":"\(mode)","needsConfirm":\(mode == "ask"),
        "repo":{"state":"bound","root":"\(Self.root)","branch":"\(Self.branch)"},"sessionTitle":\(Self.quote(Self.title)),
        "preview":{"items":[\(list)],"notes":[\(Self.quote(Self.omittedNote))],"omitted":2,"bytes":1184}}
        """)
    }

    func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult {
        if scene == "error" {
            throw DaemonError(code: DaemonErrorCode.hostBusy, message: "busy")
        }
        turn += 1
        let t = "t\(turn)"
        Task { await self.stream(turnId: t) }
        return Self.j(#"{"threadId":"th1","turnId":"\#(t)"}"#)
    }

    static let answer1 = """
    ## What Claude is doing

    Claude is fixing a bug in the widget parser: input that ends without a newline loses its last token.

    - It traced the bug to `tokenize()` in \(relativeFile):42.
    - It moved the buffer flush after the loop.
    - The parser tests pass (42 of 42).

    > Nothing outside the parser has changed yet.
    """

    static let answer2 = """
    The bug is in `tokenize()`: the buffer is only flushed when a newline arrives, so input that ends without one loses its last token.

    Claude's fix moves the flush after the loop, which is right. One edge case is still open:

    - An **empty** trailing buffer now emits an empty token.

    Guard it like this:

    ```ts
    function flush(buf: string[], out: Token[]): void {
      if (buf.length === 0) return; // nothing pending
      out.push({ kind: "word", text: buf.join("") });
      buf.length = 0;
    }
    ```

    Add a test for `"a b"` (no newline) and for `""`.
    """

    func stream(turnId: String) async {
        if scene == "perf-stream" { return await perfStream(turnId: turnId) }
        emit("chat.item", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","phase":"started","item":{"id":"x1","type":"mcpToolCall","server":"companion-readonly","tool":"read_file","status":"inProgress"}}"#)
        try? await Task.sleep(for: .milliseconds(scene == "streaming" ? 1200 : 10))
        let words = Self.answer2.split(separator: " ", omittingEmptySubsequences: false)
        var i = 0
        while i < words.count {
            let chunk = words[i..<min(i + 6, words.count)].joined(separator: " ") + (i + 6 < words.count ? " " : "")
            emit("chat.delta", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","itemId":"i1","text":\#(Self.quote(chunk))}"#)
            i += 6
            try? await Task.sleep(for: .milliseconds(scene == "streaming" ? 350 : 15))
        }
        emit("chat.item", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","phase":"completed","item":{"id":"x1","type":"mcpToolCall","server":"companion-readonly","tool":"read_file","status":"completed"}}"#)
        emit("chat.turnCompleted", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","status":"completed"}"#)
    }

    /// perf-stream: ~3 words every 60 ms (about 50 words/s, a brisk Codex pace), starting once the perf driver
    /// measures (or after 1.5 s without one).
    func perfStream(turnId: String) async {
        let start = Date()
        while !PerfDriver.shared.measuring && (PerfFlags.mode != nil || Date().timeIntervalSince(start) < 1.5) {
            if Date().timeIntervalSince(start) > 60 { break }
            try? await Task.sleep(for: .milliseconds(50))
        }
        let words = PerfContent.streamAnswer.split(separator: " ", omittingEmptySubsequences: false)
        var i = 0
        while i < words.count {
            let chunk = words[i..<min(i + 3, words.count)].joined(separator: " ") + (i + 3 < words.count ? " " : "")
            emit("chat.delta", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","itemId":"i1","text":\#(Self.quote(chunk))}"#)
            i += 3
            try? await Task.sleep(for: .milliseconds(60))
        }
        emit("chat.turnCompleted", #"{"sessionId":"s1","threadId":"th1","turnId":"\#(turnId)","status":"completed"}"#)
    }

    static func quote(_ s: String) -> String { String(data: try! JSONEncoder().encode(s), encoding: .utf8)! }
    func emit(_ method: String, _ json: String) {
        sink.yield(DaemonEvent.decode(method: method, params: Self.j(json) as JSONValue))
    }

    /// Things that arrive as events after start (status scene).
    func afterStart() {
        if scene == "status" {
            emit("security.alert", #"{"sessionId":"s1","kind":"guard","detail":"GPT tried to read .env, which is a secret file. The read was blocked."}"#)
        }
    }

    func chatInterrupt(sessionId: String) async throws {}
    func chatSent(sessionId: String) async throws -> [SentRecord] { [] }

    // MARK: History

    /// The same shape as companiond's composeTurnText block.
    static func block(_ items: ArraySlice<(String, String, String, Int)>, omitted: Int = 0) -> String {
        var lines = [#"<untrusted_data source="claude-session">"#, "Claude session: \(title)",
                     "Repository: \(root) (branch \(branch)). Read it with the read-only repository tools."]
        if omitted > 0 { lines.append("Note: " + omittedNote) }
        for it in items { lines += ["[\(it.1)]", it.2] }
        lines.append("</untrusted_data>")
        return lines.joined(separator: "\n")
    }

    static func turnItems(_ items: ArraySlice<(String, String, String, Int)>) -> [TurnItem] {
        items.enumerated().map { TurnItem(kind: $1.0, label: $1.1, text: $1.2, redactions: $1.3, index: $0) }
    }

    var storedTurns: [TurnRecord] {
        if scene == "rich" { return cleared ? [] : richTurns }
        if scene == "rich-tables" { return cleared ? [] : [richTurn(RichContent.tableTurn, i: 0, of: 1)] }
        guard !cleared, ["chat", "context", "raw", "history", "whatGPTSees", "status", "streaming", "pastChat"].contains(scene) else { return [] }
        let now = Date().timeIntervalSince1970 * 1000
        let all = Self.items[...]
        let t1 = TurnRecord(turnId: "h1", sessionId: "s1", threadId: "th1", sessionTitle: Self.title, mode: .ask,
                            question: "What is Claude working on right now?", contextBlock: Self.block(all, omitted: 2),
                            items: Self.turnItems(all), omitted: 2, answer: Self.answer1, sentAt: now - 26 * 60_000, completedAt: now - 25 * 60_000)
        let t2 = TurnRecord(turnId: "h2", sessionId: "s1", threadId: "th1", sessionTitle: Self.title, mode: .ask,
                            question: "Why does the widget parser drop the last token, and is Claude's fix right?",
                            contextBlock: Self.block(Self.items.prefix(3)), items: Self.turnItems(Self.items.prefix(3)),
                            answer: Self.answer2, sentAt: now - 4 * 60_000, completedAt: now - 3 * 60_000)
        return scene == "streaming" ? [t1] : [t1, t2]
    }


    /// `rich` scene: every block type (RichContent), stored in session s1, no context records.
    var richTurns: [TurnRecord] {
        return RichContent.turns.enumerated().map { richTurn($1, i: $0, of: RichContent.turns.count) }
    }

    private func richTurn(_ t: (question: String, answer: String), i: Int, of count: Int) -> TurnRecord {
        let at = Date().timeIntervalSince1970 * 1000 - (Double(count) - Double(i)) * 5 * 60_000
        return TurnRecord(turnId: "r\(i + 1)", sessionId: "s1", threadId: "th1", sessionTitle: Self.title, mode: .off,
                          question: t.question, answer: t.answer, sentAt: at, completedAt: at + 60_000)
    }

    func historyList() async throws -> HistoryList {
        let now = Date().timeIntervalSince1970 * 1000
        let h = 3_600_000.0
        let chats = cleared ? [] : [
            ChatSummary(sessionId: "s1", threadId: "th1", sessionTitle: Self.title,
                        firstQuestion: "What is Claude working on right now?", turns: 2, startedAt: now - 0.5 * h, lastAt: now - 0.07 * h),
            ChatSummary(sessionId: "s1", threadId: "th0", sessionTitle: Self.title,
                        firstQuestion: "Is the tokenizer's Unicode handling safe?", turns: 4, startedAt: now - 3 * h, lastAt: now - 2 * h),
            ChatSummary(sessionId: "s2", threadId: "th7", sessionTitle: "Add CSV export",
                        firstQuestion: "Review the CSV writer for quoting bugs", turns: 3, startedAt: now - 28 * h, lastAt: now - 27 * h),
            ChatSummary(sessionId: "s2", threadId: "th6", sessionTitle: "Add CSV export",
                        firstQuestion: "Summarize this session so far", turns: 1, startedAt: now - 75 * h, lastAt: now - 75 * h),
        ]
        return HistoryList(chats: chats, currentThreads: ["s1": "th1"], enabled: true)
    }
    func historyTurns(sessionId: String, limit: Int?) async throws -> HistoryTurns {
        if let n = PerfFlags.turns {
            let all = perfTurns[sessionId] ?? PerfContent.turns(sessionId: sessionId, count: n, root: Self.root,
                                                                 title: sessionId == "s1" ? Self.title : "Add CSV export")
            perfTurns[sessionId] = all
            return HistoryTurns(threadId: "th-\(sessionId)", turns: Array(all.suffix(limit ?? 200)))
        }
        return HistoryTurns(threadId: "th1", turns: Array(storedTurns.filter { $0.sessionId == sessionId }.suffix(limit ?? 200)))
    }
    func historyTurns(threadId: String) async throws -> HistoryTurns {
        if threadId == "th1" { return HistoryTurns(threadId: "th1", turns: storedTurns) }
        let now = Date().timeIntervalSince1970 * 1000
        return HistoryTurns(threadId: threadId, turns: [
            TurnRecord(turnId: "o1", sessionId: "s1", threadId: threadId, sessionTitle: Self.title, mode: .off,
                       question: "Is the tokenizer's Unicode handling safe?",
                       answer: "Mostly. It iterates `Character`s, so grapheme clusters stay whole. One gap: `\\r\\n` is a single Character in Swift but two code units in TypeScript, so CRLF input splits differently.",
                       sentAt: now - 3 * 3_600_000),
        ])
    }
    func historyClear(threadId: String?) async throws { if threadId == nil { cleared = true } }
    func historySetEnabled(_ enabled: Bool) async throws -> Bool { enabled }
    func chatNewChat(sessionId: String) async throws { cleared = true }

    func settingsGet(_ key: String) async throws -> String? {
        switch key {
        case "ui.autoPlay": "false"
        case "ui.window.width": DemoFlags.width
        case "ui.code.wrap": DemoFlags.wrap ? "true" : nil
        default: nil
        }
    }
    func settingsSet(_ key: String, _ value: String) async throws {}
    func jiraStatus() async throws -> JiraStatus { JiraStatus(configured: false, site: nil, email: nil) }
    func jiraConfigure(_ c: JiraCredentials) async throws -> JiraStatus { try await jiraStatus() }
    func jiraClear() async throws -> JiraStatus { try await jiraStatus() }
    func jiraCheck() async throws -> JiraCheckResult { JiraCheckResult(ok: true, detail: "") }
}

/// DEBUG-only: COMPANION_DEMO_SHOT=<png> composites every visible window of the app (panel, sheets, popovers) into
/// one PNG after COMPANION_DEMO_DELAY seconds, then quits.
@MainActor enum DemoShot {
    static func scheduleIfAsked() {
        let env = ProcessInfo.processInfo.environment
        guard let path = env["COMPANION_DEMO_SHOT"] else { return }
        let delay = Double(env["COMPANION_DEMO_DELAY"] ?? "3") ?? 3
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            write(to: URL(fileURLWithPath: path))
            exit(0) // a demo run has nothing to shut down
        }
    }

    static func write(to url: URL) {
        // orderedIndex 0 is frontmost; draw back to front. (orderedWindows leaves out panels.)
        let windows = NSApp.windows.filter { $0.isVisible && $0.contentView != nil && $0.frame.width > 1 }
            .sorted { $0.orderedIndex > $1.orderedIndex }
        guard !windows.isEmpty else { return }
        let union = windows.map(\.frame).reduce(CGRect.null) { $0.union($1) }
        let scale = windows.first?.backingScaleFactor ?? 2
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(union.width * scale), pixelsHigh: Int(union.height * scale),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return }
        rep.size = union.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.clear.setFill()
        CGRect(origin: .zero, size: union.size).fill()
        for w in windows {
            let origin = CGPoint(x: w.frame.minX - union.minX, y: w.frame.minY - union.minY)
            if isPopover(w) {
                drawPopover(w, at: origin)
                continue
            }
            guard let v = w.contentView?.superview ?? w.contentView else { continue }
            guard let wr = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
            v.cacheDisplay(in: v.bounds, to: wr)
            wr.draw(in: CGRect(origin: origin, size: w.frame.size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }

    private static func isPopover(_ w: NSWindow) -> Bool {
        NSStringFromClass(type(of: w)).contains("Popover")
    }

    /// The popover's frame is Liquid Glass, rendered out of process: cacheDisplay captures it as black corners and
    /// a rainbow rim. Draw a window-background stand-in card, then only the
    /// SwiftUI content on top of it.
    private static func drawPopover(_ w: NSWindow, at origin: CGPoint) {
        guard let root = w.contentView, let content = hostingView(in: root) ?? Optional(root) else { return }
        let inWindow = content.convert(content.bounds, to: nil)
        let card = CGRect(x: origin.x + inWindow.minX, y: origin.y + inWindow.minY, width: inWindow.width, height: inWindow.height)
        let shape = NSBezierPath(roundedRect: card, xRadius: 18, yRadius: 18)
        w.effectiveAppearance.performAsCurrentDrawingAppearance {
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(0.18)
            shadow.shadowBlurRadius = 14
            shadow.shadowOffset = NSSize(width: 0, height: -3)
            shadow.set()
            NSColor.windowBackgroundColor.setFill()
            shape.fill()
            NSGraphicsContext.restoreGraphicsState()
            NSColor.separatorColor.setStroke()
            shape.lineWidth = 0.5
            shape.stroke()
        }
        guard let wr = content.bitmapImageRepForCachingDisplay(in: content.bounds) else { return }
        content.cacheDisplay(in: content.bounds, to: wr)
        NSGraphicsContext.saveGraphicsState()
        shape.addClip()
        wr.draw(in: card, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        NSGraphicsContext.restoreGraphicsState()
    }

    /// The SwiftUI view the popover shows (the first hosting view under the popover's frame).
    private static func hostingView(in v: NSView) -> NSView? {
        if NSStringFromClass(type(of: v)).contains("HostingView") { return v }
        for sub in v.subviews { if let h = hostingView(in: sub) { return h } }
        return nil
    }
}
#endif
