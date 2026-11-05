#if DEBUG
import AppKit
import CompanionCore
import Foundation

/// DEBUG-only (ruling R6): COMPANION_DEMO=<scene> runs the real views on synthetic data. Nothing leaves the process.
/// Scenes: empty, chat, context, history, streaming, ask, signedOut, daemonDown, noSession, error, whatGPTSees, status.
enum DemoFlags {
    static let scene: String? = ProcessInfo.processInfo.environment["COMPANION_DEMO"]
    static func is_(_ s: String) -> Bool { scene == s }
}

@MainActor final class DemoDaemon: DaemonAPI {
    static let root = "/Volumes/Work/acme-widgets"
    let scene: String
    let events: AsyncStream<DaemonEvent>
    let sink: AsyncStream<DaemonEvent>.Continuation
    var turn = 0
    var cleared = false

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
        default: nil
        }
    }

    var mode: String {
        switch scene {
        case "streaming", "error": "automatic"
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
        let selected = scene == "noSession" ? "null" : #""s1""#
        let moved = scene == "status" ? #","focusMovedTo":"s2""# : ""
        return """
        {"sessions":[{"sessionId":"s1","cliSessionId":"c1","title":"Refactor widget parser","status":"busy","isArchived":false,
        "lastFocusedAt":1,"lastActivityAt":1,"recordCwd":"\(Self.root)","recordBranch":"fix/parser","resolvedRoot":"\(Self.root)","source":"desktop"},
        {"sessionId":"s2","cliSessionId":"c2","title":"Add CSV export","status":"idle","isArchived":false,
        "lastFocusedAt":1,"lastActivityAt":1,"recordCwd":"\(Self.root)","recordBranch":"main","resolvedRoot":"\(Self.root)","source":"desktop"}],
        "selection":{"sessionId":\(selected),"via":"\(scene == "noSession" ? "none" : "focus")","focusedSessionId":"s1","focusLabel":"Claude focus","pinnedMissing":false\(moved)},
        "refreshedAt":1}
        """
    }
    func sessionsSnapshot() async throws -> SessionsSnapshot { Self.j(snapJSON) }
    func sessionsRefresh() async throws -> SessionsSnapshot { Self.j(snapJSON) }
    func sessionsPin(_ sessionId: String?) async throws -> Selection {
        Self.j(#"{"sessionId":"s1","via":"focus","focusedSessionId":"s1","focusLabel":"Claude focus","pinnedMissing":false}"#)
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
        Self.j(#"{"kind":"resolved","root":"\#(Self.root)","branch":"fix/parser","isLinkedWorktree":false}"#)
    }
    func privacyGet() async throws -> PrivacyState {
        Self.j(#"{"sharingMode":"\#(mode)","approvals":[{"root":"\#(Self.root)","commonDir":"\#(Self.root)/.git","includeWorktrees":true,"approvedAt":1}],"redactionNotice":"Secrets that look like keys or tokens are masked (best effort)."}"#)
    }
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode { mode }
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        Self.j(#"{"root":"\#(root)","commonDir":"\#(root)/.git","includeWorktrees":true,"approvedAt":1}"#)
    }
    func privacyRevoke(root: String) async throws -> RevokeResult { RevokeResult(revoked: true, pendingClose: 0) }

    static let items: [(String, String, String, Int)] = [
        ("user", "Claude user message", "The widget parser drops the last token when the input ends without a newline. Can you fix it?", 0),
        ("assistant", "Claude reply", "Found it: `tokenize()` only flushes the buffer on \\n. I moved the flush after the loop so the last token is kept.", 0),
        ("command", "$ npm test -- parser", "exit 0\n✓ 42 tests passed (parser)\n✓ 3 snapshots", 0),
        ("tool", "Read src/parser/tokenize.ts", "export function tokenize(input: string): Token[] {\n  const out: Token[] = [];\n  const buf: string[] = [];\n  for (const ch of input) {\n    if (ch === \"\\n\") { flush(buf, out); continue; }\n    buf.push(ch);\n  }\n  flush(buf, out);\n  return out;\n}", 0),
        ("assistant", "Claude reply", "I also set NPM_TOKEN=•••••• in the test env so the registry mock works.", 1),
        ("user", "Claude user message", "Great, also check the CSV path.", 0),
    ]

    func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        let list = Self.items.prefix(4).enumerated().map { i, it in
            #"{"id":"item-\#(i + 1)","kind":"\#(it.0)","label":\#(Self.quote(it.1)),"text":\#(Self.quote(it.2)),"redactions":\#(it.3)}"#
        }.joined(separator: ",")
        return Self.j("""
        {"prepareId":"p\(turn)","sessionId":"s1","mode":"\(mode)","needsConfirm":\(mode == "ask"),
        "repo":{"state":"bound","root":"\(Self.root)","branch":"fix/parser"},"sessionTitle":"Refactor widget parser",
        "preview":{"items":[\(list)],"notes":["2 older messages were left out by the 12 KB cap."],"omitted":2,"bytes":1184}}
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

    - It traced the bug to `tokenize()` in src/parser/tokenize.ts:42.
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

    static func block(_ items: ArraySlice<(String, String, String, Int)>) -> String {
        "<untrusted_data source=\"claude-session\" session=\"Refactor widget parser\">\n"
            + items.map { "[\($0.1)]\n\($0.2)" }.joined(separator: "\n\n") + "\n</untrusted_data>"
    }

    static func turnItems(_ items: ArraySlice<(String, String, String, Int)>) -> [TurnItem] {
        items.enumerated().map { TurnItem(kind: $1.0, label: $1.1, text: $1.2, redactions: $1.3, index: $0) }
    }

    var storedTurns: [TurnRecord] {
        guard !cleared, ["chat", "context", "history", "whatGPTSees", "status", "streaming"].contains(scene) else { return [] }
        let now = Date().timeIntervalSince1970 * 1000
        let all = Self.items[...]
        let t1 = TurnRecord(turnId: "h1", sessionId: "s1", threadId: "th1", sessionTitle: "Refactor widget parser", mode: .ask,
                            question: "What is Claude working on right now?", contextBlock: Self.block(all) + Self.padding,
                            items: Self.turnItems(all), answer: Self.answer1, sentAt: now - 26 * 60_000, completedAt: now - 25 * 60_000)
        let t2 = TurnRecord(turnId: "h2", sessionId: "s1", threadId: "th1", sessionTitle: "Refactor widget parser", mode: .ask,
                            question: "Why does the widget parser drop the last token, and is Claude's fix right?",
                            contextBlock: Self.block(Self.items.prefix(3)), items: Self.turnItems(Self.items.prefix(3)),
                            answer: Self.answer2, sentAt: now - 4 * 60_000, completedAt: now - 3 * 60_000)
        return scene == "streaming" ? [t1] : [t1, t2]
    }

    /// Makes the first block about 3 KB, like a real session excerpt.
    static let padding = "\n" + String(repeating: "(earlier Claude output, redacted and trimmed) ", count: 50)

    func historyList() async throws -> HistoryList {
        let now = Date().timeIntervalSince1970 * 1000
        let h = 3_600_000.0
        let chats = cleared ? [] : [
            ChatSummary(sessionId: "s1", threadId: "th1", sessionTitle: "Refactor widget parser",
                        firstQuestion: "What is Claude working on right now?", turns: 2, startedAt: now - 0.5 * h, lastAt: now - 0.07 * h),
            ChatSummary(sessionId: "s1", threadId: "th0", sessionTitle: "Refactor widget parser",
                        firstQuestion: "Is the tokenizer's Unicode handling safe?", turns: 4, startedAt: now - 3 * h, lastAt: now - 2 * h),
            ChatSummary(sessionId: "s2", threadId: "th7", sessionTitle: "Add CSV export",
                        firstQuestion: "Review the CSV writer for quoting bugs", turns: 3, startedAt: now - 28 * h, lastAt: now - 27 * h),
            ChatSummary(sessionId: "s2", threadId: "th6", sessionTitle: "Add CSV export",
                        firstQuestion: "Summarize this session so far", turns: 1, startedAt: now - 75 * h, lastAt: now - 75 * h),
        ]
        return HistoryList(chats: chats, currentThreads: ["s1": "th1"], enabled: true)
    }
    func historyTurns(sessionId: String) async throws -> HistoryTurns {
        HistoryTurns(threadId: "th1", turns: storedTurns.filter { $0.sessionId == sessionId })
    }
    func historyTurns(threadId: String) async throws -> HistoryTurns {
        if threadId == "th1" { return HistoryTurns(threadId: "th1", turns: storedTurns) }
        let now = Date().timeIntervalSince1970 * 1000
        return HistoryTurns(threadId: threadId, turns: [
            TurnRecord(turnId: "o1", sessionId: "s1", threadId: threadId, sessionTitle: "Refactor widget parser", mode: .off,
                       question: "Is the tokenizer's Unicode handling safe?",
                       answer: "Mostly. It iterates `Character`s, so grapheme clusters stay whole. One gap: `\\r\\n` is a single Character in Swift but two code units in TypeScript, so CRLF input splits differently.",
                       sentAt: now - 3 * 3_600_000),
        ])
    }
    func historyClear(threadId: String?) async throws { if threadId == nil { cleared = true } }
    func historySetEnabled(_ enabled: Bool) async throws -> Bool { enabled }
    func chatNewChat(sessionId: String) async throws { cleared = true }

    func settingsGet(_ key: String) async throws -> String? { key == "ui.autoPlay" ? "false" : nil }
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
            if let tree = ProcessInfo.processInfo.environment["COMPANION_DEMO_TREE"] {
                var out = ""
                func walk(_ v: NSView, _ d: Int) {
                    out += String(repeating: "  ", count: d) + "\(type(of: v)) \(v.frame) hidden=\(v.isHidden) alpha=\(v.alphaValue)\n"
                    for c in v.subviews { walk(c, d + 1) }
                }
                for w in NSApp.windows where w.isVisible { if let v = w.contentView { walk(v, 0) } }
                try? out.write(toFile: tree, atomically: true, encoding: .utf8)
            }
            exit(0) // a demo run has nothing to shut down

        }
    }

    private typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    static func windowImage(_ w: NSWindow) -> CGImage? {
        guard let h = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_NOW),
              let sym = dlsym(h, "CGWindowListCreateImage") else { return nil }
        let f = unsafeBitCast(sym, to: CreateImage.self)
        // .optionIncludingWindow = 8, .boundsIgnoreFraming = 1, .bestResolution = 8
        return f(.null, 8, UInt32(w.windowNumber), 1 | 8)?.takeRetainedValue()
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
            guard let v = w.contentView?.superview ?? w.contentView else { continue }
            let origin = CGPoint(x: w.frame.minX - union.minX, y: w.frame.minY - union.minY)
            // The window server's own image of the window (our own windows need no Screen Recording permission).
            // CGWindowListCreateImage is unavailable to Swift in the macOS 15+ SDK, so it is looked up at run time.
            if ProcessInfo.processInfo.environment["COMPANION_DEMO_RENDER"] == "cg", let image = windowImage(w) {
                NSGraphicsContext.current?.cgContext.draw(image, in: CGRect(origin: origin, size: w.frame.size))
                continue
            }
            if ProcessInfo.processInfo.environment["COMPANION_DEMO_RENDER"] == "layer", let layer = v.layer, let ctx = NSGraphicsContext.current?.cgContext {
                ctx.saveGState()
                ctx.translateBy(x: origin.x, y: origin.y + w.frame.height)
                ctx.scaleBy(x: 1, y: -1)
                layer.render(in: ctx)
                ctx.restoreGState()
                continue
            }
            guard let wr = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
            v.cacheDisplay(in: v.bounds, to: wr)
            wr.draw(in: CGRect(origin: origin, size: w.frame.size), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
        }
        NSGraphicsContext.restoreGraphicsState()
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
    }
}
#endif
