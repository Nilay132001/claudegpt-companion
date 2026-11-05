import Foundation

/// The M4b daemon methods the app uses ("Daemon API" section of the M5 plan). DaemonClient is the real one; tests fake it.
public protocol DaemonAPI: Sendable {
    func hello() async throws -> HelloResult
    func shutdown() async throws
    func hostStatus() async throws -> HostState
    func hostRestart() async throws -> HostState
    func hostAcknowledgeSecurityStop() async throws -> HostState
    func authStatus() async throws -> AuthState
    func authLogin() async throws -> URL
    func sessionsSnapshot() async throws -> SessionsSnapshot
    func sessionsRefresh() async throws -> SessionsSnapshot
    func sessionsPin(_ sessionId: String?) async throws -> Selection
    func sessionsPicker(query: String?, includeArchived: Bool) async throws -> PickerGroups
    func sessionsSync(_ sessionId: String) async throws -> SyncStatus
    func sessionsWorktree(_ sessionId: String) async throws -> WorktreeResolution?
    func privacyGet() async throws -> PrivacyState
    func privacySetSharingMode(_ mode: SharingMode) async throws -> SharingMode
    func privacyApprove(root: String, includeWorktrees: Bool) async throws -> ApprovedRoot
    func privacyRevoke(root: String) async throws -> RevokeResult
    func chatPrepare(sessionId: String, question: String) async throws -> Prepared
    /// `confirmed` is true only when the user pressed Send in the preview sheet (M4b: Ask mode refuses otherwise, 1011).
    func chatSend(prepareId: String, removeItemIds: [String], confirmed: Bool) async throws -> SendResult
    func chatInterrupt(sessionId: String) async throws
    func chatSent(sessionId: String) async throws -> [SentRecord]
    func settingsGet(_ key: String) async throws -> String?
    func settingsSet(_ key: String, _ value: String) async throws
    func jiraStatus() async throws -> JiraStatus
    /// Sends the credential once; companiond keeps it in memory only (owner ruling B).
    func jiraConfigure(_ c: JiraCredentials) async throws -> JiraStatus
    func jiraClear() async throws -> JiraStatus
    func jiraCheck() async throws -> JiraCheckResult
}

/// Daemon input limits (M4b handlers): strings are capped in UTF-16 units.
public enum DaemonLimits {
    public static let questionUTF16 = 20_000
    public static let queryUTF16 = 200
    public static func clip(_ s: String, utf16 max: Int) -> String {
        guard s.utf16.count > max else { return s }
        var out = ""
        for ch in s {
            if out.utf16.count + String(ch).utf16.count > max { break }
            out.append(ch)
        }
        return out
    }
}

public struct Connection: Sendable {
    public let api: any DaemonAPI
    public let events: AsyncStream<DaemonEvent>
    public let close: @Sendable () async -> Void
    public init(api: any DaemonAPI, events: AsyncStream<DaemonEvent>, close: @escaping @Sendable () async -> Void) {
        self.api = api
        self.events = events
        self.close = close
    }
}

public typealias Connector = @Sendable () async throws -> Connection
