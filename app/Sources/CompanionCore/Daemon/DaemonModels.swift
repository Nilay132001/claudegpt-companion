import Foundation

// Codable mirrors of the M4b daemon API ("Daemon API" section of the M5 plan). Extra fields are ignored.

public let daemonProtocolVersion = 1

public enum DaemonErrorCode {
    public static let parseError = -32700
    public static let invalidRequest = -32600
    public static let methodNotFound = -32601
    public static let invalidParams = -32602
    public static let internalError = -32603
    public static let securityCheckFailed = 1001
    public static let hostNotReady = 1002
    public static let repoRefused = 1003
    public static let prepareExpired = 1004
    public static let turnBusy = 1005
    public static let approvalRefused = 1006
    public static let unknownSession = 1007
    public static let emptyQuestion = 1008
    public static let hostBusy = 1009
    public static let prepareStale = 1010
    public static let confirmRequired = 1011
    /// After these the same prepareId may be sent again (M4b retry rule).
    public static let retryable: Set<Int> = [hostNotReady, turnBusy, hostBusy]
    /// After these the app prepares again and re-previews.
    public static let prepareAgain: Set<Int> = [prepareExpired, prepareStale, confirmRequired]
    public static let securityStopPrefix = "Security check failed"
    /// App side: the daemon process or its pipe is gone.
    public static let stopped = -1
}

public struct JiraStatus: Decodable, Sendable, Equatable {
    public let configured: Bool
    public let site: String?
    public let email: String?
    public init(configured: Bool, site: String?, email: String?) {
        self.configured = configured
        self.site = site
        self.email = email
    }
}

public struct JiraCheckResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let detail: String
    public init(ok: Bool, detail: String) {
        self.ok = ok
        self.detail = detail
    }
}

public struct DaemonError: Error, Sendable, Equatable {
    public let code: Int
    public let message: String
    public let data: JSONValue?
    public init(code: Int, message: String, data: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.data = data
    }
    public var reason: String? { data?["reason"]?.stringValue }
    public static let stopped = DaemonError(code: DaemonErrorCode.stopped, message: "companiond stopped.")
}

public struct HelloResult: Decodable, Sendable, Equatable {
    public let protocolVersion: Int
    public let daemonVersion: String
}

public enum HostState: Decodable, Sendable, Equatable {
    case stopped, starting, ready(warnings: [String]), failed(detail: String)
    private enum K: String, CodingKey { case state, warnings, detail }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .state) {
        case "stopped": self = .stopped
        case "starting": self = .starting
        case "ready": self = .ready(warnings: try c.decodeIfPresent([String].self, forKey: .warnings) ?? [])
        case "failed": self = .failed(detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "Codex failed.")
        case let other: self = .failed(detail: "Unknown Codex state: \(other)")
        }
    }
    public var isReady: Bool { if case .ready = self { true } else { false } }
}

public enum AuthState: Decodable, Sendable, Equatable {
    case signedIn(planType: String?), signedOut, unsupported(mode: String)
    private enum K: String, CodingKey { case state, planType, mode }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        switch try c.decode(String.self, forKey: .state) {
        case "signed_in": self = .signedIn(planType: try c.decodeIfPresent(String.self, forKey: .planType))
        case "signed_out": self = .signedOut
        default: self = .unsupported(mode: try c.decodeIfPresent(String.self, forKey: .mode) ?? "unknown")
        }
    }
}

public enum SharingMode: String, Codable, Sendable, CaseIterable {
    case off, ask, automatic
    public var title: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask each time"
        case .automatic: "Automatic"
        }
    }
}

public enum SessionStatus: String, Decodable, Sendable {
    case busy, idle, recent, inactive
    public init(from decoder: any Decoder) throws {
        self = SessionStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .inactive
    }
}

public struct SessionSummary: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String
    public let cliSessionId: String?
    public let title: String
    public let status: SessionStatus
    public let isArchived: Bool
    public let lastFocusedAt: Double?
    public let lastActivityAt: Double?
    public let recordCwd: String?
    public let recordBranch: String?
    public let resolvedRoot: String?
    public let source: String
    public let transcriptMissing: String?
    public var id: String { sessionId }
}

public struct Selection: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let via: String
    public let focusedSessionId: String?
    public let focusLabel: String
    public let focusMovedTo: String?
    public let pinnedMissing: Bool
}

public struct SessionsSnapshot: Decodable, Sendable, Equatable {
    public let sessions: [SessionSummary]
    public let selection: Selection
    public let desktopRecordsError: String?
    public let refreshedAt: Double
}

public struct PickerGroups: Decodable, Sendable, Equatable {
    public let busy: [SessionSummary]
    public let idle: [SessionSummary]
    public let recent: [SessionSummary]
    public let older: [SessionSummary]
}

public struct SyncStats: Decodable, Sendable, Equatable {
    public let records: Int
    public let malformedLines: Int
    public let unknownRecords: Int
    public let droppedEvents: Int
    private enum K: String, CodingKey { case records, malformedLines, unknownRecords, droppedEvents }
    public init(records: Int, malformedLines: Int, unknownRecords: Int, droppedEvents: Int) {
        self.records = records
        self.malformedLines = malformedLines
        self.unknownRecords = unknownRecords
        self.droppedEvents = droppedEvents
    }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        records = try c.decodeIfPresent(Int.self, forKey: .records) ?? 0
        malformedLines = try c.decodeIfPresent(Int.self, forKey: .malformedLines) ?? 0
        unknownRecords = try c.decodeIfPresent(Int.self, forKey: .unknownRecords) ?? 0
        droppedEvents = try c.decodeIfPresent(Int.self, forKey: .droppedEvents) ?? 0
    }
}

public struct SyncStatus: Decodable, Sendable, Equatable {
    public let state: String
    public let stats: SyncStats?
    public let lastPollAt: Double?
    public init(state: String, stats: SyncStats?, lastPollAt: Double?) {
        self.state = state
        self.stats = stats
        self.lastPollAt = lastPollAt
    }
}

public enum WorktreeResolution: Decodable, Sendable, Equatable {
    case resolved(root: String, branch: String?, isLinkedWorktree: Bool)
    case unavailable(reason: String, detail: String, root: String?, candidate: String?)
    private enum K: String, CodingKey { case kind, root, branch, isLinkedWorktree, reason, detail, candidate }
    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        if try c.decode(String.self, forKey: .kind) == "resolved" {
            self = .resolved(root: try c.decode(String.self, forKey: .root),
                             branch: try c.decodeIfPresent(String.self, forKey: .branch),
                             isLinkedWorktree: try c.decodeIfPresent(Bool.self, forKey: .isLinkedWorktree) ?? false)
        } else {
            self = .unavailable(reason: try c.decodeIfPresent(String.self, forKey: .reason) ?? "unknown",
                                detail: try c.decodeIfPresent(String.self, forKey: .detail) ?? "Repository unavailable.",
                                root: try c.decodeIfPresent(String.self, forKey: .root),
                                candidate: try c.decodeIfPresent(String.self, forKey: .candidate))
        }
    }
}

public struct RepoChange: Decodable, Sendable, Equatable {
    public let from: String?
    public let to: String?
    public let banner: String
    public let contextNote: String
}

public struct ApprovedRoot: Decodable, Sendable, Equatable, Identifiable {
    public let root: String
    public let commonDir: String
    public let includeWorktrees: Bool
    public let approvedAt: Double
    public var id: String { root }
}

/// privacy.revoke's answer. pendingClose = threads on roots no longer approved that are still open, mostly
/// replies being stopped (M4b handlers.ts revokedThreadIds; spec §7.5, §8).
public struct RevokeResult: Decodable, Sendable, Equatable {
    public let revoked: Bool
    public let pendingClose: Int
    public init(revoked: Bool, pendingClose: Int) {
        self.revoked = revoked
        self.pendingClose = pendingClose
    }
}

public struct PrivacyState: Decodable, Sendable, Equatable {
    public let sharingMode: SharingMode
    public let approvals: [ApprovedRoot]
    public let redactionNotice: String
}

public struct RepoLine: Decodable, Sendable, Equatable {
    public let state: String
    public let root: String?
    public let branch: String?
    public let detail: String?
}

public struct PreviewItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let kind: String
    public let label: String
    public let text: String
    public let redactions: Int
}

public struct ContextPreview: Decodable, Sendable, Equatable {
    public let items: [PreviewItem]
    public let notes: [String]
    public let omitted: Int
    public let bytes: Int
}

public struct Prepared: Decodable, Sendable, Equatable {
    public let prepareId: String
    public let sessionId: String
    public let mode: SharingMode
    public let preview: ContextPreview?
    public let needsConfirm: Bool
    public let repo: RepoLine
    public let repoNote: String?
    /// Sent with the context in Ask and Automatic; null in Off. The preview sheet shows it.
    public let sessionTitle: String?
}

public struct SendResult: Decodable, Sendable, Equatable {
    public let threadId: String
    public let turnId: String
}

public struct SentRecord: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let threadId: String
    public let turnId: String
    public let contextBlock: String
    public let question: String
    public let sentAt: Double
}

public struct ItemSummary: Decodable, Sendable, Equatable {
    public let id: String
    public let type: String
    public let server: String?
    public let tool: String?
    public let status: String?
}

public struct ChatDelta: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let itemId: String
    public let text: String
}

public struct ChatItemEvent: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let phase: String
    public let item: ItemSummary
}

public struct TurnCompleted: Decodable, Sendable, Equatable {
    public let sessionId: String?
    public let threadId: String
    public let turnId: String
    public let status: String
    public let error: String?
}

public struct SecurityAlert: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String?
    public let threadId: String?
    public let turnId: String?
    public let kind: String
    public let detail: String
    public var id: String { "\(kind)|\(turnId ?? "-")|\(detail)" }
}

public struct TranscriptInfo: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let kind: String
    public let dropped: Int
    public let stats: SyncStats
}

public struct WorktreeEvent: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let resolution: WorktreeResolution
    public let change: RepoChange?
}

public struct ThreadReplaced: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let threadId: String
    public let reason: String
}

public enum DaemonEvent: Sendable, Equatable {
    case hostChanged(HostState)
    case authChanged(AuthState)
    case sessionsChanged(SessionsSnapshot)
    case sessionTranscript(TranscriptInfo)
    case sessionWorktree(WorktreeEvent)
    case syncError(String)
    case chatDelta(ChatDelta)
    case chatItem(ChatItemEvent)
    case turnCompleted(TurnCompleted)
    case threadReplaced(ThreadReplaced)
    case securityAlert(SecurityAlert)
    /// App side: the daemon's stdout closed.
    case disconnected
    case unknown(String)

    private struct Message: Decodable { let message: String }

    public static func decode(method: String, params: JSONValue) -> DaemonEvent {
        func v<T: Decodable>(_ t: T.Type) -> T? { try? RPCCodec.value(params, as: t) }
        let e: DaemonEvent? = switch method {
        case "host.changed": v(HostState.self).map { .hostChanged($0) }
        case "auth.changed": v(AuthState.self).map { .authChanged($0) }
        case "sessions.changed": v(SessionsSnapshot.self).map { .sessionsChanged($0) }
        case "session.transcript": v(TranscriptInfo.self).map { .sessionTranscript($0) }
        case "session.worktree": v(WorktreeEvent.self).map { .sessionWorktree($0) }
        case "session.syncError": v(Message.self).map { .syncError($0.message) }
        case "chat.delta": v(ChatDelta.self).map { .chatDelta($0) }
        case "chat.item": v(ChatItemEvent.self).map { .chatItem($0) }
        case "chat.turnCompleted": v(TurnCompleted.self).map { .turnCompleted($0) }
        case "chat.threadReplaced": v(ThreadReplaced.self).map { .threadReplaced($0) }
        case "security.alert": v(SecurityAlert.self).map { .securityAlert($0) }
        default: nil
        }
        return e ?? .unknown(method)
    }
}

// MARK: History (M8)

public struct TurnItem: Sendable, Equatable, Identifiable {
    public let kind: String
    public let label: String
    public let text: String
    public let redactions: Int
    /// Position in the turn's item list (assigned when the turn is decoded).
    public let index: Int
    public var id: String { "\(index)" }
    public init(kind: String, label: String, text: String, redactions: Int, index: Int = 0) {
        self.kind = kind
        self.label = label
        self.text = text
        self.redactions = redactions
        self.index = index
    }
}

private struct RawTurnItem: Decodable {
    let kind: String
    let label: String
    let text: String
    let redactions: Int
}

public struct TurnRecord: Decodable, Sendable, Equatable, Identifiable {
    public let turnId: String
    public let sessionId: String
    public let threadId: String
    public let sessionTitle: String?
    public let mode: SharingMode
    public let question: String
    public let contextBlock: String
    public let items: [TurnItem]
    public let omitted: Int
    public let answer: String
    public let status: String
    public let error: String?
    public let sentAt: Double
    public let completedAt: Double?
    public var id: String { turnId }

    private enum Keys: String, CodingKey {
        case turnId, sessionId, threadId, sessionTitle, mode, question, contextBlock, items, omitted, answer, status, error, sentAt, completedAt
    }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        turnId = try c.decode(String.self, forKey: .turnId)
        sessionId = try c.decode(String.self, forKey: .sessionId)
        threadId = try c.decode(String.self, forKey: .threadId)
        sessionTitle = try c.decodeIfPresent(String.self, forKey: .sessionTitle)
        mode = try c.decode(SharingMode.self, forKey: .mode)
        question = try c.decode(String.self, forKey: .question)
        contextBlock = try c.decode(String.self, forKey: .contextBlock)
        items = try c.decode([RawTurnItem].self, forKey: .items).enumerated().map {
            TurnItem(kind: $1.kind, label: $1.label, text: $1.text, redactions: $1.redactions, index: $0)
        }
        omitted = try c.decode(Int.self, forKey: .omitted)
        answer = try c.decode(String.self, forKey: .answer)
        status = try c.decode(String.self, forKey: .status)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        sentAt = try c.decode(Double.self, forKey: .sentAt)
        completedAt = try c.decodeIfPresent(Double.self, forKey: .completedAt)
    }
}

extension TurnRecord {
    public init(turnId: String, sessionId: String, threadId: String, sessionTitle: String? = nil, mode: SharingMode = .automatic,
                question: String, contextBlock: String = "", items: [TurnItem] = [], omitted: Int = 0, answer: String,
                status: String = "completed", error: String? = nil, sentAt: Double = 0, completedAt: Double? = nil) {
        self.turnId = turnId
        self.sessionId = sessionId
        self.threadId = threadId
        self.sessionTitle = sessionTitle
        self.mode = mode
        self.question = question
        self.contextBlock = contextBlock
        self.items = items
        self.omitted = omitted
        self.answer = answer
        self.status = status
        self.error = error
        self.sentAt = sentAt
        self.completedAt = completedAt
    }
}

public struct ChatSummary: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String
    public let threadId: String
    public let sessionTitle: String?
    public let firstQuestion: String
    public let turns: Int
    public let startedAt: Double
    public let lastAt: Double
    public var id: String { threadId }
    public init(sessionId: String, threadId: String, sessionTitle: String?, firstQuestion: String, turns: Int, startedAt: Double, lastAt: Double) {
        self.sessionId = sessionId
        self.threadId = threadId
        self.sessionTitle = sessionTitle
        self.firstQuestion = firstQuestion
        self.turns = turns
        self.startedAt = startedAt
        self.lastAt = lastAt
    }
}

public struct HistoryList: Decodable, Sendable, Equatable {
    public let chats: [ChatSummary]
    public let currentThreads: [String: String]
    public let enabled: Bool
    public init(chats: [ChatSummary], currentThreads: [String: String], enabled: Bool) {
        self.chats = chats
        self.currentThreads = currentThreads
        self.enabled = enabled
    }
}

public struct HistoryTurns: Decodable, Sendable, Equatable {
    public let threadId: String?
    public let turns: [TurnRecord]
    public init(threadId: String?, turns: [TurnRecord]) {
        self.threadId = threadId
        self.turns = turns
    }
}
