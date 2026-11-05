import Foundation
@testable import CompanionCore

/// Scriptable DaemonAPI for AppModel tests. @MainActor: every call is serialised on the main actor, so the fake's
/// state is never touched concurrently (main-actor async methods satisfy the nonisolated async requirements).
@MainActor final class FakeDaemon: DaemonAPI {
    static let storeKey = /ui\.[a-z0-9_.]{1,64}/ // companiond/src/store/store.ts
    var calls: [String] = []
    /// prepareIds the daemon would refuse without `confirmed: true` (M4b 1011).
    var needsConfirm: Set<String> = []
    var host: HostState = .ready(warnings: [])
    var auth: AuthState = .signedIn(planType: "plus")
    var snapshot = FakeDaemon.snap(selected: "s1")
    var privacy = PrivacyState(sharingMode: .ask, approvals: [], redactionNotice: RedactionNotice.text)
    var worktree: WorktreeResolution? = .resolved(root: "/r", branch: "main", isLinkedWorktree: true)
    var prepareResults: [Result<Prepared, DaemonError>] = []
    var sendResults: [Result<SendResult, DaemonError>] = []
    var approveError: DaemonError?
    var sent: [SentRecord] = []
    var stored: [String: String] = [:]
    var sendParams: [(prepareId: String, removed: [String], confirmed: Bool)] = []
    /// Runs inside chat.send before it answers (events that arrive "before the response").
    var duringSend: (@MainActor () async -> Void)?
    let events: AsyncStream<DaemonEvent>
    let sink: AsyncStream<DaemonEvent>.Continuation

    init() {
        let (s, c) = AsyncStream.makeStream(of: DaemonEvent.self)
        events = s
        sink = c
    }
    nonisolated var connection: Connection { Connection(api: self, events: events, close: {}) }

    static func session(_ id: String, title: String) -> SessionSummary {
        SessionSummary(sessionId: id, cliSessionId: "c-\(id)", title: title, status: .idle, isArchived: false,
                       lastFocusedAt: 1, lastActivityAt: 1, recordCwd: "/r", recordBranch: "main", resolvedRoot: "/r",
                       source: "desktop", transcriptMissing: nil)
    }
    static func snap(selected: String?, via: String = "focus", focusMovedTo: String? = nil) -> SessionsSnapshot {
        SessionsSnapshot(
            sessions: [session("s1", title: "SYNTHETIC FIXTURE one"), session("s2", title: "SYNTHETIC FIXTURE two")],
            selection: Selection(sessionId: selected, via: selected == nil ? "none" : via, focusedSessionId: "s1",
                                 focusLabel: "Claude focus (from Claude's records)", focusMovedTo: focusMovedTo, pinnedMissing: false),
            desktopRecordsError: nil, refreshedAt: 1)
    }
    nonisolated static func prepared(_ id: String, needsConfirm: Bool, mode: SharingMode = .ask) -> Prepared {
        let items = ["item-1", "item-2"].map { PreviewItem(id: $0, kind: "user", label: "You", text: "SYNTHETIC FIXTURE \($0)", redactions: 0) }
        return Prepared(prepareId: id, sessionId: "s1", mode: mode,
                        preview: mode == .off ? nil : ContextPreview(items: items, notes: [], omitted: 0, bytes: 200),
                        needsConfirm: needsConfirm, repo: RepoLine(state: "bound", root: "/r", branch: "main", detail: nil), repoNote: nil,
                        sessionTitle: mode == .off ? nil : "SYNTHETIC FIXTURE one")
    }

    func hello() async throws -> HelloResult { calls.append("daemon.hello"); return HelloResult(protocolVersion: 1, daemonVersion: "0.4.0") }
    func shutdown() async throws { calls.append("daemon.shutdown") }
    func hostStatus() async throws -> HostState { calls.append("host.status"); return host }
    func hostRestart() async throws -> HostState { calls.append("host.restart"); return host }
    func hostAcknowledgeSecurityStop() async throws -> HostState {
        calls.append("host.acknowledgeSecurityStop")
        host = .ready(warnings: [])
        return host
    }
    var authError: DaemonError?
    func authStatus() async throws -> AuthState {
        calls.append("auth.status")
        if let e = authError { throw e }
        return auth
    }
    func authLogin() async throws -> URL { calls.append("auth.login"); return URL(string: "https://auth.example.invalid/start")! }
    func sessionsSnapshot() async throws -> SessionsSnapshot { calls.append("sessions.snapshot"); return snapshot }
    func sessionsRefresh() async throws -> SessionsSnapshot { calls.append("sessions.refresh"); return snapshot }
    func sessionsPin(_ sessionId: String?) async throws -> Selection {
        calls.append("sessions.pin:\(sessionId ?? "null")")
        snapshot = Self.snap(selected: sessionId ?? "s1", via: sessionId == nil ? "focus" : "pin")
        return snapshot.selection
    }
    func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups {
        PickerGroups(busy: [], idle: snapshot.sessions, recent: [], older: [])
    }
    func sessionsSync(_ sessionId: String) async throws -> SyncStatus {
        SyncStatus(state: "live", stats: SyncStats(records: 3, malformedLines: 1, unknownRecords: 0, droppedEvents: 0), lastPollAt: 1)
    }
    func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution? { calls.append("sessions.worktree"); return worktree }
    var privacyError: DaemonError?
    func privacyGet() async throws -> PrivacyState {
        calls.append("privacy.get")
        if let e = privacyError { throw e }
        return privacy
    }
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode {
        calls.append("privacy.setSharingMode:\(mode.rawValue)")
        privacy = PrivacyState(sharingMode: mode, approvals: privacy.approvals, redactionNotice: privacy.redactionNotice)
        return mode
    }
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        calls.append("privacy.approve:\(root):\(includeWorktrees)")
        if let e = approveError { throw e }
        return ApprovedRoot(root: root, commonDir: root + "/.git", includeWorktrees: includeWorktrees, approvedAt: 1)
    }
    var revokePending = 0
    func privacyRevoke(root: String) async throws -> RevokeResult {
        calls.append("privacy.revoke:\(root)")
        return RevokeResult(revoked: true, pendingClose: revokePending)
    }
    func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        calls.append("chat.prepare:\(question)")
        let p = prepareResults.isEmpty ? Self.prepared("p-auto", needsConfirm: false, mode: .automatic) : try prepareResults.removeFirst().get()
        if p.needsConfirm { needsConfirm.insert(p.prepareId) }
        return p
    }
    func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult {
        calls.append("chat.send:\(prepareId)")
        sendParams.append((prepareId, removeItemIds, confirmed))
        if needsConfirm.contains(prepareId) && !confirmed {
            throw DaemonError(code: DaemonErrorCode.confirmRequired, message: "Confirm what will be shared before sending.")
        }
        await duringSend?()
        if sendResults.isEmpty { return SendResult(threadId: "t1", turnId: "u\(sendParams.count)") }
        return try sendResults.removeFirst().get()
    }
    func chatInterrupt(sessionId: String) async throws { calls.append("chat.interrupt:\(sessionId)") }
    func chatSent(sessionId: String) async throws -> [SentRecord] { sent }
    func settingsGet(_ key: String) async throws -> String? {
        guard key.wholeMatch(of: Self.storeKey) != nil else { throw DaemonError(code: DaemonErrorCode.invalidParams, message: "UI setting keys look like ui.<name>.") }
        return stored[key]
    }
    func settingsSet(_ key: String, _ value: String) async throws {
        guard key.wholeMatch(of: Self.storeKey) != nil else { throw DaemonError(code: DaemonErrorCode.invalidParams, message: "UI setting keys look like ui.<name>.") }
        calls.append("settings.set:\(key)")
        stored[key] = value
    }
}
