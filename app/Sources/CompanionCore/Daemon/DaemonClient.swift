import Foundation

/// JSON-RPC client for companiond. One instance per daemon process.
public actor DaemonClient {
    private let transport: any LineTransport
    private var nextId = 0
    private var pending: [Int: CheckedContinuation<JSONValue, any Error>] = [:]
    private var stopped = false
    private var reader: Task<Void, Never>?
    public nonisolated let events: AsyncStream<DaemonEvent>
    private let sink: AsyncStream<DaemonEvent>.Continuation

    public init(transport: any LineTransport) {
        self.transport = transport
        let (s, c) = AsyncStream.makeStream(of: DaemonEvent.self)
        events = s
        sink = c
    }

    public func start() {
        guard reader == nil else { return }
        reader = Task { await self.readLoop() }
    }

    public func close() async {
        await transport.close()
    }

    private func readLoop() async {
        do {
            for try await line in transport.lines { receive(line) }
        } catch {}
        finish()
    }

    private func receive(_ line: Data) {
        guard let msg = try? RPCCodec.decode(line: line) else { return } // not protocol: ignore
        switch msg {
        case let .response(id, result):
            guard let c = pending.removeValue(forKey: id) else { return }
            switch result {
            case .success(let v): c.resume(returning: v)
            case .failure(let e): c.resume(throwing: DaemonError(code: e.code, message: e.message, data: e.data))
            }
        case let .notification(method, params):
            sink.yield(DaemonEvent.decode(method: method, params: params))
        case .orphanError:
            break
        }
    }

    private func finish() {
        stopped = true
        let all = pending
        pending = [:]
        for c in all.values { c.resume(throwing: DaemonError.stopped) }
        sink.yield(.disconnected)
        sink.finish()
    }

    private func write(_ line: Data, id: Int) async {
        do { try await transport.send(line) } catch { pending.removeValue(forKey: id)?.resume(throwing: DaemonError.stopped) }
    }

    func call<R: Decodable & Sendable>(_ method: String, _ params: JSONValue = .object([:]), as type: R.Type) async throws -> R {
        if stopped { throw DaemonError.stopped }
        nextId += 1
        let id = nextId
        let line = try RPCCodec.encodeRequest(id: id, method: method, params: params)
        let value = try await withCheckedThrowingContinuation { (c: CheckedContinuation<JSONValue, any Error>) in
            pending[id] = c
            Task { await self.write(line, id: id) }
        }
        return try RPCCodec.value(value, as: R.self)
    }
}

private struct Empty: Decodable, Sendable {}
private struct AuthLink: Decodable, Sendable { let authUrl: String }
private struct ModeResult: Decodable, Sendable { let sharingMode: SharingMode }
private struct SettingValue: Decodable, Sendable { let value: String? }

extension DaemonClient: DaemonAPI {
    public func hello() async throws -> HelloResult {
        try await call("daemon.hello", .object(["protocolVersion": .number(Double(daemonProtocolVersion))]), as: HelloResult.self)
    }
    public func shutdown() async throws { _ = try await call("daemon.shutdown", as: Empty.self) }
    public func hostStatus() async throws -> HostState { try await call("host.status", as: HostState.self) }
    public func hostRestart() async throws -> HostState { try await call("host.restart", as: HostState.self) }
    public func hostAcknowledgeSecurityStop() async throws -> HostState {
        try await call("host.acknowledgeSecurityStop", as: HostState.self)
    }
    public func authStatus() async throws -> AuthState { try await call("auth.status", as: AuthState.self) }
    public func authLogin() async throws -> URL {
        let link = try await call("auth.login", as: AuthLink.self)
        guard let url = URL(string: link.authUrl), url.scheme == "https" else {
            throw DaemonError(code: DaemonErrorCode.internalError, message: "The sign-in link was not an https link.")
        }
        return url
    }
    public func sessionsSnapshot() async throws -> SessionsSnapshot { try await call("sessions.snapshot", as: SessionsSnapshot.self) }
    public func sessionsRefresh() async throws -> SessionsSnapshot { try await call("sessions.refresh", as: SessionsSnapshot.self) }
    public func sessionsPin(_ sessionId: String?) async throws -> Selection {
        try await call("sessions.pin", .object(["sessionId": sessionId.map(JSONValue.string) ?? .null]), as: Selection.self)
    }
    public func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups {
        var p: [String: JSONValue] = ["includeArchived": .bool(includeArchived)]
        if let query, !query.isEmpty { p["query"] = .string(DaemonLimits.clip(query, utf16: DaemonLimits.queryUTF16)) }
        return try await call("sessions.picker", .object(p), as: PickerGroups.self)
    }
    public func sessionsSync(_ sessionId: String) async throws -> SyncStatus {
        try await call("sessions.sync", .object(["sessionId": .string(sessionId)]), as: SyncStatus.self)
    }
    public func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution? {
        try await call("sessions.worktree", .object(["sessionId": .string(sessionId)]), as: WorktreeResolution?.self)
    }
    public func privacyGet() async throws -> PrivacyState { try await call("privacy.get", as: PrivacyState.self) }
    public func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode {
        try await call("privacy.setSharingMode", .object(["mode": .string(mode.rawValue)]), as: ModeResult.self).sharingMode
    }
    public func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot {
        try await call("privacy.approve", .object(["root": .string(root), "includeWorktrees": .bool(includeWorktrees)]), as: ApprovedRoot.self)
    }
    public func privacyRevoke(root: String) async throws -> RevokeResult {
        try await call("privacy.revoke", .object(["root": .string(root)]), as: RevokeResult.self)
    }
    public func chatPrepare(sessionId: String, question: String) async throws -> Prepared {
        try await call("chat.prepare", .object(["sessionId": .string(sessionId), "question": .string(question)]), as: Prepared.self)
    }
    public func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult {
        try await call("chat.send", .object(["prepareId": .string(prepareId), "removeItemIds": .array(removeItemIds.map(JSONValue.string)),
                                             "confirmed": .bool(confirmed)]), as: SendResult.self)
    }
    public func chatInterrupt(sessionId: String) async throws {
        _ = try await call("chat.interrupt", .object(["sessionId": .string(sessionId)]), as: Empty.self)
    }
    public func chatSent(sessionId: String) async throws -> [SentRecord] {
        try await call("chat.sent", .object(["sessionId": .string(sessionId)]), as: [SentRecord].self)
    }
    public func settingsGet(_ key: String) async throws -> String? {
        try await call("settings.get", .object(["key": .string(key)]), as: SettingValue.self).value
    }
    public func settingsSet(_ key: String, _ value: String) async throws {
        _ = try await call("settings.set", .object(["key": .string(key), "value": .string(value)]), as: Empty.self)
    }
    public func jiraStatus() async throws -> JiraStatus { try await call("jira.status", as: JiraStatus.self) }
    public func jiraConfigure(_ c: JiraCredentials) async throws -> JiraStatus {
        try await call("jira.configure", .object(["site": .string(c.site), "email": .string(c.email), "token": .string(c.token)]), as: JiraStatus.self)
    }
    public func jiraClear() async throws -> JiraStatus { try await call("jira.clear", as: JiraStatus.self) }
    public func jiraCheck() async throws -> JiraCheckResult { try await call("jira.check", as: JiraCheckResult.self) }
}
