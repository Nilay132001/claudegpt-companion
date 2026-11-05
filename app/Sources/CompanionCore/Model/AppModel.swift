import Foundation
import Observation

public enum ConnectionState: Equatable, Sendable { case connecting, connected(daemonVersion: String), stopped(String) }

public enum Gate: Equatable, Sendable {
    case ready, connecting, daemonStopped(String), hostStarting, hostFailed(String), securityStop(String)
    case signedOut, authUnsupported(String), authError(String), noSession
}

public struct PendingPreview: Identifiable, Equatable, Sendable {
    public let question: String
    public let prepared: Prepared
    public var removed: Set<String>
    public var notice: String?
    public var id: String { prepared.prepareId }
}

public enum SentView: Identifiable, Equatable, Sendable {
    case found(SentRecord), notKept(turnId: String)
    public var id: String {
        switch self {
        case .found(let r): r.turnId
        case .notKept(let t): t
        }
    }
}

/// App state and every action that reaches companiond. Sends only a prepareId from chat.prepare in the same flow.
@MainActor @Observable
public final class AppModel {
    public static let explainQuestion = "Explain Claude's last message simply."
    static let threadReplacedNotice = "GPT lost the earlier part of this conversation (Codex could not reopen it). It continues in a new thread."

    public private(set) var connection: ConnectionState = .connecting
    public private(set) var host: HostState = .starting
    public private(set) var auth: AuthState?
    public private(set) var authError: String?
    public private(set) var threadNotices: [String: String] = [:]
    /// Set after a revoke whose threads are still finishing (pendingClose > 0).
    public private(set) var revokeNotice: String?
    public private(set) var snapshot: SessionsSnapshot?
    public private(set) var privacy: PrivacyState?
    public private(set) var worktrees: [String: WorktreeResolution] = [:]
    public private(set) var syncs: [String: SyncStatus] = [:]
    public private(set) var repoBanners: [String: String] = [:]
    public private(set) var alerts: [SecurityAlert] = []
    public private(set) var syncError: String?
    public private(set) var conversations: [String: Conversation] = [:]
    public private(set) var settings = UISettings()
    public var draft = ""
    public var preview: PendingPreview?
    public var sentView: SentView?
    public var errorMessage: String?

    @ObservationIgnored public var onSettingsChanged: ((UISettings) -> Void)?
    @ObservationIgnored public var onReplyCompleted: ((UUID, String) -> Void)?
    @ObservationIgnored public private(set) var detailLoad: Task<Void, Never>?
    @ObservationIgnored public private(set) var settingsWrite: Task<Void, Never>?
    @ObservationIgnored private let connector: Connector
    @ObservationIgnored private var current: Connection?
    @ObservationIgnored private var eventTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var autoPlayed: Set<UUID> = []
    /// Events with no session id for a turn no conversation owns yet (chat.send has not answered). Replayed on attach.
    @ObservationIgnored private var unrouted: [String: [TurnEvent]] = [:]

    public init(connector: @escaping Connector) {
        self.connector = connector
    }

    private var api: (any DaemonAPI)? { current?.api }

    // MARK: Lifecycle

    public func start() async {
        connection = .connecting
        generation += 1
        let gen = generation
        let c: Connection
        do {
            c = try await connector()
            current = c
            eventTask = Task { [weak self] in
                for await e in c.events {
                    guard let self, self.generation == gen else { return }
                    self.handle(e)
                }
            }
            let hello = try await c.api.hello()
            connection = .connected(daemonVersion: hello.daemonVersion)
        } catch {
            // No live daemon: only a connector failure or a failed hello means "stopped".
            connection = .stopped(Self.describe(error))
            return
        }
        // The daemon is alive from here on. A failure now must not read as "stopped": that would let a restart
        // skip a security stop's acknowledgement (ruling 18).
        do {
            host = try await c.api.hostStatus()
            privacy = try await c.api.privacyGet()
            settings = await UISettings.load { try await c.api.settingsGet($0) }
            onSettingsChanged?(settings)
            apply(snapshot: try await c.api.sessionsSnapshot())
            if host.isReady { await loadAuth() }
        } catch {
            errorMessage = Self.describe(error)
        }
    }

    /// daemon.shutdown, then close stdin. A daemon that does not answer within 3 s is closed anyway.
    public func shutdown() async {
        guard let c = current else { return }
        current = nil
        generation += 1
        eventTask?.cancel()
        let closer = Task {
            guard (try? await Task.sleep(for: .seconds(3))) != nil else { return } // cancelled: the answer came in time
            await c.close()
        }
        try? await c.api.shutdown()
        closer.cancel()
        await c.close()
    }

    /// A security stop must be acknowledged, never skipped by a restart (ruling 18).
    public var isSecurityStop: Bool {
        if case .failed(let d) = host { d.hasPrefix(DaemonErrorCode.securityStopPrefix) } else { false }
    }

    public func restartDaemon() async {
        // A live daemon in a security stop must be acknowledged; a daemon that is already gone may be restarted
        // (its stop latch went with it, and the user would otherwise be locked out).
        if isSecurityStop, case .connected = connection { return }
        await shutdown()
        stopAllRunning("companiond restarted. Ask again.")
        host = .starting
        auth = nil
        authError = nil
        worktrees = [:]
        syncs = [:]
        await start()
    }

    public func restartHost() async {
        guard let api, !isSecurityStop else { return }
        do { host = try await api.hostRestart() } catch { errorMessage = Self.describe(error) }
    }

    /// Only the Acknowledge button calls this (M4b: host.acknowledgeSecurityStop clears the latch, then starts Codex).
    public func acknowledgeSecurityStop() async {
        guard let api, isSecurityStop else { return }
        do { host = try await api.hostAcknowledgeSecurityStop() } catch { errorMessage = Self.describe(error) }
        if host.isReady { await loadAuth() }
    }

    public func loadAuth() async {
        guard let api else { return }
        do {
            auth = try await api.authStatus()
            authError = nil
        } catch {
            authError = Self.describe(error)
        }
    }

    // MARK: Sessions

    public var selectedSessionId: String? { snapshot?.selection.sessionId }
    public var selectedSession: SessionSummary? { snapshot?.sessions.first { $0.sessionId == selectedSessionId } }

    private func apply(snapshot new: SessionsSnapshot) {
        let old = snapshot?.selection.sessionId
        snapshot = new
        guard let id = new.selection.sessionId, id != old || worktrees[id] == nil else { return }
        detailLoad = Task { await self.loadDetail(id) }
    }

    private func loadDetail(_ id: String) async {
        guard let api else { return }
        do { worktrees[id] = try await api.sessionsWorktree(id) } catch {} // null clears a stale resolution
        if let s = try? await api.sessionsSync(id) { syncs[id] = s }
    }

    public func refresh() async {
        guard let api else { return }
        do {
            apply(snapshot: try await api.sessionsRefresh())
            if let id = selectedSessionId { await loadDetail(id) }
        } catch { errorMessage = Self.describe(error) }
    }

    public func pin(_ sessionId: String?) async {
        guard let api else { return }
        do {
            _ = try await api.sessionsPin(sessionId)
            apply(snapshot: try await api.sessionsSnapshot())
            await detailLoad?.value
        } catch { errorMessage = Self.describe(error) }
    }

    public func followFocus() async { await pin(nil) }

    public func picker(query: String) async -> PickerGroups? {
        try? await api?.sessionsPicker(query: query, includeArchived: false)
    }

    // MARK: Asking

    public func appendToDraft(_ text: String) {
        draft = draft.isEmpty ? text : draft + " " + text
    }

    public func submitDraft() async {
        guard canSend else { return }
        let q = draft
        draft = ""
        let prepared = await ask(q)
        if !prepared, draft.isEmpty { draft = q }
    }

    /// chat.prepare; Ask → preview sheet; Off/Automatic → send at once. False when nothing was prepared.
    @discardableResult
    public func ask(_ raw: String) async -> Bool {
        let q = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let api, let sid = selectedSessionId, gate == .ready else { return false }
        guard q.utf16.count <= DaemonLimits.questionUTF16 else {
            errorMessage = "The question is too long. Keep it under 20,000 characters."
            return false
        }
        do {
            let p = try await api.chatPrepare(sessionId: sid, question: q)
            // Second guard: an Ask-mode prepare always goes through the sheet, whatever needsConfirm says.
            if p.needsConfirm || p.mode == .ask {
                preview = PendingPreview(question: q, prepared: p, removed: [], notice: nil)
            } else {
                await send(sessionId: p.sessionId, PendingSend(prepareId: p.prepareId, removeItemIds: [], confirmed: false), question: q)
            }
            return true
        } catch {
            errorMessage = Self.describe(error)
            return false
        }
    }

    public var canExplain: Bool { gate == .ready && !isAnswering && privacy?.sharingMode != .off }

    public func explainLastMessage() async {
        guard canExplain else { return }
        await ask(Self.explainQuestion)
    }

    public func toggle(itemId: String) {
        guard var p = preview else { return }
        if p.removed.contains(itemId) { p.removed.remove(itemId) } else { p.removed.insert(itemId) }
        preview = p
    }

    public func cancelPreview() {
        if let p = preview, draft.isEmpty, p.question != Self.explainQuestion { draft = p.question }
        preview = nil
    }

    /// The only place `confirmed: true` is sent: the user pressed Send in the preview sheet.
    public func confirmPreview() async {
        guard let p = preview else { return }
        preview = nil
        await send(sessionId: p.prepared.sessionId,
                   PendingSend(prepareId: p.prepared.prepareId, removeItemIds: p.removed.sorted(), confirmed: true),
                   question: p.question)
    }

    /// "Send again" after hostBusy, turnBusy or hostNotReady: the same prepareId (M4b retry rule).
    public func sendAgain(_ message: ChatMessage) async {
        guard let retry = message.retry,
              let sid = conversations.first(where: { $0.value.messages.contains { $0.id == message.id } })?.key,
              let question = conversations[sid]?.question(before: message.id) else { return }
        conversations[sid]?.discard(message.id)
        await send(sessionId: sid, retry, question: question)
    }

    private func send(sessionId sid: String, _ s: PendingSend, question: String, attempt: Int = 0) async {
        guard let api else { return }
        var conv = conversations[sid] ?? Conversation()
        let mid = conv.begin(question: question)
        conversations[sid] = conv
        do {
            let r = try await api.chatSend(prepareId: s.prepareId, removeItemIds: s.removeItemIds, confirmed: s.confirmed)
            conversations[sid]?.attach(mid, threadId: r.threadId, turnId: r.turnId)
            // Known limit (low likelihood: M4b stores the thread before startTurn, so events carry a sessionId): if one
            // turn's early events arrive split between this buffer and the Conversation's, their order is not merged.
            for e in unrouted.removeValue(forKey: r.turnId) ?? [] { conversations[sid]?.apply(e) }
            maybeAutoPlay(sid, turnId: r.turnId)
        } catch let e as DaemonError where DaemonErrorCode.prepareAgain.contains(e.code) {
            // Expired, stale (mode or approval changed) or a confirmation is now required: prepare again.
            conversations[sid]?.discard(mid)
            do {
                let fresh = try await api.chatPrepare(sessionId: sid, question: question)
                if fresh.needsConfirm || fresh.mode == .ask {
                    preview = PendingPreview(question: question, prepared: fresh, removed: [],
                                             notice: "What will be sent has changed or expired. Check it again.")
                } else if attempt == 0 {
                    // Off / Automatic need no preview: send the fresh prepare once, unconfirmed.
                    await send(sessionId: sid, PendingSend(prepareId: fresh.prepareId, removeItemIds: [], confirmed: false),
                               question: question, attempt: 1)
                } else {
                    errorMessage = "The request expired twice. Ask again."
                    if draft.isEmpty { draft = question }
                }
            } catch {
                errorMessage = Self.describe(error)
                if draft.isEmpty { draft = question }
            }
        } catch let e as DaemonError where DaemonErrorCode.retryable.contains(e.code) {
            conversations[sid]?.fail(mid, message: Self.describe(e), retry: s)
        } catch {
            conversations[sid]?.fail(mid, message: Self.describe(error))
        }
    }

    public func interrupt() async {
        guard let api, let sid = selectedSessionId else { return }
        do { try await api.chatInterrupt(sessionId: sid) } catch { errorMessage = Self.describe(error) }
    }

    public func viewSent(_ message: ChatMessage) async {
        guard let api, let turn = message.turnId,
              let sid = conversations.first(where: { $0.value.owns(turnId: turn) })?.key else { return }
        let records = (try? await api.chatSent(sessionId: sid)) ?? []
        sentView = records.first { $0.turnId == turn }.map { SentView.found($0) } ?? .notKept(turnId: turn)
    }

    private func maybeAutoPlay(_ sid: String, turnId: String) {
        guard settings.autoPlay, let m = conversations[sid]?.message(forTurn: turnId), m.status == .done,
              !m.text.isEmpty, !autoPlayed.contains(m.id) else { return }
        autoPlayed.insert(m.id)
        onReplyCompleted?(m.id, m.text)
    }

    private func stopAllRunning(_ reason: String) {
        for k in conversations.keys { conversations[k]?.stopRunning(reason: reason) }
    }

    // MARK: Privacy, account, settings

    public func approve(root: String, includeWorktrees: Bool) async -> String? {
        guard let api else { return "companiond is not running." }
        do {
            _ = try await api.privacyApprove(root: root, includeWorktrees: includeWorktrees)
            privacy = try await api.privacyGet()
            if let id = selectedSessionId { await loadDetail(id) }
            return nil
        } catch let e as DaemonError where e.code == DaemonErrorCode.approvalRefused {
            return Self.approvalText(reason: e.reason, fallback: e.message)
        } catch {
            return Self.describe(error)
        }
    }

    /// Spec v3.4 §8: "Revoke shows pendingClose threads still finishing; after 30 s the daemon may restart Codex."
    public func revoke(root: String) async {
        guard let api else { return }
        do {
            let r = try await api.privacyRevoke(root: root)
            // Only a revoke that removed an approval replaces the notice; a no-op revoke must not hide one still true.
            if r.revoked { revokeNotice = Self.revokeText(r) }
            privacy = try await api.privacyGet()
            if let id = selectedSessionId { await loadDetail(id) }
        } catch { errorMessage = Self.describe(error) }
    }

    static func revokeText(_ r: RevokeResult) -> String? {
        guard r.revoked, r.pendingClose > 0 else { return nil }
        let n = r.pendingClose
        // Follows the code (M4b handlers.ts): a running reply keeps its thread and repo access until it stops.
        return "\(n) conversation\(n == 1 ? " is" : "s are") still being stopped on a repository that is no longer approved. Until \(n == 1 ? "it stops" : "they stop"), GPT may still read that repository; if \(n == 1 ? "it has" : "they have") not stopped within 30 seconds, Codex restarts and every conversation reopens at its next message."
    }

    public func dismissRevokeNotice() { revokeNotice = nil }

    public func setSharingMode(_ mode: SharingMode) async {
        guard let api else { return }
        do {
            _ = try await api.privacySetSharingMode(mode)
            privacy = try await api.privacyGet()
        } catch { errorMessage = Self.describe(error) }
    }

    public func signIn() async -> URL? {
        do { return try await api?.authLogin() } catch { errorMessage = Self.describe(error); return nil }
    }

    public func setSetting<V>(_ keyPath: WritableKeyPath<UISettings, V>, _ value: V) {
        let old = settings
        settings[keyPath: keyPath] = value
        let changes = settings.changes(from: old)
        guard !changes.isEmpty else { return }
        onSettingsChanged?(settings)
        guard let api else { return }
        settingsWrite = Task { for c in changes { try? await api.settingsSet(c.key, c.value) } }
    }

    public func dismiss(alert: SecurityAlert) { alerts.removeAll { $0 == alert } }
    public func dismissRepoBanner() { if let id = selectedSessionId { repoBanners[id] = nil } }
    public func dismissSyncError() { syncError = nil }
    public func dismissThreadNotice() { if let id = selectedSessionId { threadNotices[id] = nil } }

    // MARK: Events

    public func handle(_ e: DaemonEvent) {
        switch e {
        case .hostChanged(let h):
            // Replies are ended by the daemon ("abandoned"), not guessed from host state (ruling 15).
            let wasReady = host.isReady
            host = h
            if h.isReady && !wasReady { Task { await self.loadAuth() } }
        case .authChanged(let a):
            auth = a
            authError = nil
        case .threadReplaced(let t):
            threadNotices[t.sessionId] = Self.threadReplacedNotice
        case .sessionsChanged(let s):
            apply(snapshot: s)
        case .sessionTranscript(let t):
            syncs[t.sessionId] = SyncStatus(state: t.kind == "missing" ? "missing" : "live", stats: t.stats,
                                            lastPollAt: syncs[t.sessionId]?.lastPollAt)
        case .sessionWorktree(let w):
            worktrees[w.sessionId] = w.resolution
            if let c = w.change { repoBanners[w.sessionId] = c.banner }
        case .syncError(let m):
            syncError = m
        case .chatDelta(let d):
            route(d.sessionId, .delta(turnId: d.turnId, itemId: d.itemId, text: d.text))
        case .chatItem(let i):
            route(i.sessionId, .item(turnId: i.turnId, phase: i.phase, item: i.item))
        case .turnCompleted(let t):
            if let sid = route(t.sessionId, .completed(turnId: t.turnId, status: t.status, error: t.error)) {
                maybeAutoPlay(sid, turnId: t.turnId)
            }
            if let id = selectedSessionId { detailLoad = Task { await self.loadDetail(id) } } // live branch after a turn
        case .securityAlert(let a):
            guard !alerts.contains(a) else { return }
            alerts.append(a)
            if alerts.count > 20 { alerts.removeFirst() }
        case .disconnected:
            connection = .stopped("companiond stopped.")
            stopAllRunning("companiond stopped.")
        case .unknown:
            break
        }
    }

    @discardableResult
    private func route(_ sessionId: String?, _ e: TurnEvent) -> String? {
        guard let sid = sessionId ?? conversations.first(where: { $0.value.owns(turnId: e.turnId) })?.key else {
            // No session id and no owner yet: keep it for the chat.send answer (bounded like Conversation's buffer).
            if unrouted[e.turnId] == nil && unrouted.count >= Conversation.earlyTurnCap { unrouted.removeAll() }
            if (unrouted[e.turnId]?.count ?? 0) < Conversation.earlyEventCap { unrouted[e.turnId, default: []].append(e) }
            return nil
        }
        conversations[sid, default: Conversation()].apply(e)
        return sid
    }

    // MARK: Text

    static func approvalText(reason: String?, fallback: String) -> String {
        switch reason {
        case "not_absolute": "That is not a full folder path."
        case "missing": "That folder does not exist."
        case "home_or_root": "Your home folder, a folder that contains it, or the disk root cannot be approved."
        case "not_toplevel": "Approve the repository's top folder, not a folder inside it."
        default: fallback // repo_refused: the daemon's message carries the visible reason
        }
    }

    static func describe(_ error: any Error) -> String {
        if let e = error as? DaemonError {
            switch e.code {
            case DaemonErrorCode.turnBusy: return "GPT is still answering. Wait or press Stop."
            case DaemonErrorCode.hostBusy: return "Too many repositories are busy right now. Try again in a moment."
            case DaemonErrorCode.stopped: return "companiond stopped."
            default: return e.message
            }
        }
        if let e = error as? any LocalizedError, let d = e.errorDescription { return d }
        return "Something went wrong talking to companiond."
    }
}
