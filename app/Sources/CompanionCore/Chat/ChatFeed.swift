import Foundation
import Observation

public struct TurnRef: Identifiable, Equatable, Sendable {
    public let question: UUID?
    public let answer: UUID?
    public var id: UUID { question ?? answer! }
    public init(question: UUID?, answer: UUID?) { self.question = question; self.answer = answer }
}

/// One shown message. A delta changes only its own model, so only its view re-renders (M9 §5.5).
@MainActor @Observable public final class MessageModel: Identifiable {
    public let id: UUID
    public private(set) var message: ChatMessage
    /// nil until rendered (the view then renders synchronously).
    public private(set) var rendered: RenderedAnswer?

    init(_ message: ChatMessage, rendered: RenderedAnswer?) {
        id = message.id
        self.message = message
        self.rendered = rendered
    }

    func update(_ m: ChatMessage, rendered r: RenderedAnswer?) {
        if message != m { message = m }
        if rendered != r { rendered = r }
    }

    func setRendered(_ r: RenderedAnswer) { if rendered != r { rendered = r } }
}

/// A session's chat as the views see it. Mirrors `Conversation.messages`; views read only `turns` and the models.
@MainActor @Observable public final class ChatFeed {
    public private(set) var turns: [TurnRef] = []
    public private(set) var isRunning = false
    @ObservationIgnored private var models: [UUID: MessageModel] = [:]

    public init() {}

    public var isEmpty: Bool { turns.isEmpty }
    public func model(_ id: UUID) -> MessageModel? { models[id] }

    public nonisolated static func pair(_ messages: [ChatMessage]) -> [TurnRef] {
        var out: [TurnRef] = []
        var pending: UUID?
        for m in messages {
            switch m.role {
            case .user:
                if let q = pending { out.append(TurnRef(question: q, answer: nil)) }
                pending = m.id
            case .assistant:
                out.append(TurnRef(question: pending, answer: m.id))
                pending = nil
            }
        }
        if let q = pending { out.append(TurnRef(question: q, answer: nil)) }
        return out
    }

    /// `render(message, isNew)` is called for new messages and for messages whose text or running state changed.
    public func sync(_ messages: [ChatMessage], render: (ChatMessage, _ isNew: Bool) -> RenderedAnswer?) {
        var seen = Set<UUID>()
        for m in messages {
            seen.insert(m.id)
            if let model = models[m.id] {
                guard model.message != m else { continue }
                let changed = model.message.text != m.text || model.message.isRunning != m.isRunning
                model.update(m, rendered: changed ? render(m, false) : model.rendered)
            } else {
                models[m.id] = MessageModel(m, rendered: render(m, true))
            }
        }
        for id in models.keys where !seen.contains(id) { models[id] = nil }
        let paired = Self.pair(messages)
        if paired != turns { turns = paired }
        let running = messages.contains { $0.isRunning }
        if running != isRunning { isRunning = running }
    }

    /// A background render finished; applied only if the message still has that text.
    public func setRendered(_ r: RenderedAnswer, for id: UUID, text: String) {
        guard let m = models[id], m.message.text == text else { return }
        m.setRendered(r)
    }
}
