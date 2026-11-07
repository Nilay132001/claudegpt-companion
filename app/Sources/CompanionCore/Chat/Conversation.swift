import CryptoKit
import Foundation

/// What chat.send needs to send a prepared message (again).
public struct PendingSend: Equatable, Sendable {
    public let prepareId: String
    public let removeItemIds: [String]
    public let confirmed: Bool
    public init(prepareId: String, removeItemIds: [String], confirmed: Bool) {
        self.prepareId = prepareId
        self.removeItemIds = removeItemIds
        self.confirmed = confirmed
    }
}

public struct ChatMessage: Identifiable, Equatable, Sendable {
    public enum Role: Sendable, Equatable { case user, assistant }
    public enum Status: Sendable, Equatable { case sending, streaming, done, interrupted, failed(String) }
    public let id: UUID
    public let role: Role
    public var text: String
    public var status: Status
    public var threadId: String?
    public var turnId: String?
    /// "Reading the repository…" while a companion-readonly tool call runs.
    public var activity: String?
    /// Set after hostBusy / turnBusy / hostNotReady: the same prepareId may be sent again ("Send again").
    public var retry: PendingSend?
    /// When the question was sent (restored or live turns); nil for messages that predate this field.
    public var sentAt: Date? = nil
    public var isRunning: Bool { role == .assistant && (status == .sending || status == .streaming) }
}

extension ChatMessage {
    /// A stored turn's message id: the same for the same turn and role in every restore and every run, so SwiftUI
    /// keeps row identity when a chat is restored again (M9 §5.2). Name-based, SHA-256, UUID version 5 layout.
    public static func storedID(turnId: String, role: Role) -> UUID {
        let name = "companion.message\u{0}\(turnId)\u{0}\(role == .user ? "user" : "assistant")"
        var b = Array(SHA256.hash(data: Data(name.utf8)).prefix(16))
        b[6] = (b[6] & 0x0F) | 0x50
        b[8] = (b[8] & 0x3F) | 0x80
        return UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
    }
}

public enum TurnEvent: Sendable, Equatable {
    case delta(turnId: String, itemId: String, text: String)
    case item(turnId: String, phase: String, item: ItemSummary)
    case completed(turnId: String, status: String, error: String?)
    var turnId: String {
        switch self {
        case .delta(let t, _, _), .item(let t, _, _), .completed(let t, _, _): t
        }
    }
}

/// One Claude session's chat for this app run (ruling 4).
public struct Conversation: Equatable, Sendable {
    public static let earlyTurnCap = 8
    public static let earlyEventCap = 2_000

    public private(set) var messages: [ChatMessage] = []
    private var turnToMessage: [String: UUID] = [:]
    private var itemOrder: [String: [String]] = [:]
    private var itemText: [String: String] = [:]
    private var early: [String: [TurnEvent]] = [:]
    private var earlyOrder: [String] = []
    /// How many messages at the front came from `restore` (they are replaced by the next restore).
    private var restoredCount = 0

    public init() {}

    public var isRunning: Bool { messages.contains { $0.isRunning } }

    @discardableResult
    public mutating func begin(question: String) -> UUID {
        let now = Date()
        messages.append(ChatMessage(id: UUID(), role: .user, text: question, status: .done, sentAt: now))
        let id = UUID()
        messages.append(ChatMessage(id: id, role: .assistant, text: "", status: .sending, sentAt: now))
        return id
    }

    /// Puts the stored turns (oldest first) in front of the live messages. Replaces what an earlier restore added,
    /// and skips turns this run already owns, so restoring twice never duplicates.
    public mutating func restore(_ turns: [TurnRecord]) {
        messages.removeFirst(min(restoredCount, messages.count))
        var restored: [ChatMessage] = []
        for t in turns where turnToMessage[t.turnId] == nil {
            let at = Date(timeIntervalSince1970: t.sentAt / 1000)
            restored.append(ChatMessage(id: ChatMessage.storedID(turnId: t.turnId, role: .user), role: .user, text: t.question,
                                        status: .done, sentAt: at))
            let status: ChatMessage.Status = switch t.status {
            case "completed": .done
            case "interrupted": .interrupted
            case "failed", "abandoned": .failed(t.error ?? "The reply stopped.")
            default: .failed("The reply did not finish.")
            }
            restored.append(ChatMessage(id: ChatMessage.storedID(turnId: t.turnId, role: .assistant), role: .assistant,
                                        text: t.answer, status: status, threadId: t.threadId, turnId: t.turnId, sentAt: at))
        }
        messages.insert(contentsOf: restored, at: 0)
        restoredCount = restored.count
    }

    public mutating func attach(_ id: UUID, threadId: String, turnId: String) {
        guard let i = index(id) else { return }
        messages[i].threadId = threadId
        messages[i].turnId = turnId
        if messages[i].status == .sending { messages[i].status = .streaming }
        turnToMessage[turnId] = id
        earlyOrder.removeAll { $0 == turnId }
        for e in early.removeValue(forKey: turnId) ?? [] { apply(e) }
    }

    public mutating func fail(_ id: UUID, message: String, retry: PendingSend? = nil) {
        guard let i = index(id) else { return }
        messages[i].status = .failed(message)
        messages[i].activity = nil
        messages[i].retry = retry
    }

    /// The user's question right before an assistant message.
    public func question(before id: UUID) -> String? {
        guard let i = index(id), i > 0, messages[i - 1].role == .user else { return nil }
        return messages[i - 1].text
    }

    /// Removes an assistant placeholder and the question before it (a send that never started).
    public mutating func discard(_ id: UUID) {
        guard let i = index(id) else { return }
        messages.remove(at: i)
        if i > 0, messages[i - 1].role == .user { messages.remove(at: i - 1) }
    }

    public mutating func apply(_ e: TurnEvent) {
        guard let id = turnToMessage[e.turnId], let i = index(id) else {
            buffer(e)
            return
        }
        guard messages[i].isRunning else { return } // late events after the end are dropped
        switch e {
        case let .delta(turnId, itemId, text):
            if !(itemOrder[turnId]?.contains(itemId) ?? false) { itemOrder[turnId, default: []].append(itemId) }
            itemText[turnId + "\u{0}" + itemId, default: ""] += text
            messages[i].text = (itemOrder[turnId] ?? []).compactMap { itemText[turnId + "\u{0}" + $0] }.joined(separator: "\n\n")
            messages[i].status = .streaming
        case let .item(_, phase, item):
            if item.type == "mcpToolCall" { messages[i].activity = phase == "started" ? "Reading the repository…" : nil }
        case let .completed(_, status, error):
            messages[i].activity = nil
            messages[i].status = switch status {
            case "completed": .done
            case "interrupted": .interrupted
            default: .failed(error ?? "The reply stopped (\(status)).")
            }
        }
    }

    public mutating func stopRunning(reason: String) {
        for i in messages.indices where messages[i].isRunning {
            messages[i].status = .failed(reason)
            messages[i].activity = nil
        }
    }

    public func owns(turnId: String) -> Bool { turnToMessage[turnId] != nil }

    public func message(forTurn turnId: String) -> ChatMessage? {
        turnToMessage[turnId].flatMap { id in messages.first { $0.id == id } }
    }

    private func index(_ id: UUID) -> Int? { messages.firstIndex { $0.id == id } }

    private mutating func buffer(_ e: TurnEvent) {
        let t = e.turnId
        if early[t] == nil {
            if earlyOrder.count >= Self.earlyTurnCap, let oldest = earlyOrder.first {
                earlyOrder.removeFirst()
                early[oldest] = nil
            }
            earlyOrder.append(t)
        }
        var list = early[t] ?? []
        guard list.count < Self.earlyEventCap else { return }
        list.append(e)
        early[t] = list
    }
}
