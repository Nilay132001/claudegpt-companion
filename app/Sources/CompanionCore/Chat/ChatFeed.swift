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
    /// nil until rendered (the view then renders synchronously, with `root`).
    public private(set) var rendered: RenderedAnswer?
    /// The root `rendered` was made with, and the one a view renders with when `rendered` is nil: the feed's root.
    /// `path:line` links resolve against it, so a render made with another root is never kept (M9 §5.3).
    public private(set) var root: String?
    /// The answer's open chart Data disclosures: outside the lazy row, so they survive the row being recycled.
    @ObservationIgnored public let chartDisclosures = ChartDisclosures()
    /// The turn's "Context sent" disclosure (on its answer's model): outside the lazy row, so an expanded list
    /// survives the row being recycled when it scrolls far away.
    @ObservationIgnored public let contextDisclosure = ContextDisclosure()

    init(_ message: ChatMessage, root: String?, rendered: RenderedAnswer?) {
        id = message.id
        self.message = message
        self.root = root
        self.rendered = rendered
    }

    func update(_ m: ChatMessage, root newRoot: String?, rendered r: RenderedAnswer?) {
        if message != m { message = m }
        if root != newRoot { root = newRoot }
        if rendered != r { rendered = r }
    }

    func setRendered(_ r: RenderedAnswer) { if rendered != r { rendered = r } }
    func clearRendered() { if rendered != nil { rendered = nil } }
}

/// A turn's "Context sent" disclosure: the item list and the raw block, each open or closed.
@MainActor @Observable public final class ContextDisclosure {
    public var expanded = false
    public var showRaw = false
    /// Set once the first view has given it its initial state (DEBUG demo scenes open one).
    @ObservationIgnored public var seeded = false
    public init() {}
}

/// Which chart Data disclosures of one answer are open, by block path ("chunk.index", then ".i" per nesting level).
/// A key is set when its chart first appears (open only if VoiceOver ran then) and when the reader toggles it.
@MainActor @Observable public final class ChartDisclosures {
    private var open: [String: Bool] = [:]
    public init() {}
    public func isOpen(_ key: String) -> Bool? { open[key] }
    public func set(_ key: String, open value: Bool) { if open[key] != value { open[key] = value } }
}

/// A session's chat as the views see it. Mirrors `Conversation.messages`; views read only `turns` and the models.
@MainActor @Observable public final class ChatFeed {
    public private(set) var turns: [TurnRef] = []
    public private(set) var isRunning = false
    /// The root the answers render with (the session's, or for a past chat the one it was opened with).
    @ObservationIgnored public private(set) var root: String?
    /// This feed's background render (M9 §5.3); a new one for the same feed cancels it, other feeds' never do.
    @ObservationIgnored var prewarmTask: Task<Void, Never>?
    @ObservationIgnored private var models: [UUID: MessageModel] = [:]
    /// The message ids of the last sync, in order: when unchanged (a delta), pairing and pruning are skipped.
    @ObservationIgnored private var ids: [UUID] = []

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

    /// `render(message, isNew)` is called for new messages and for messages whose text or running state changed
    /// (`isNew` false). `render` must render with `root`. When `root` differs from the last sync's, every other
    /// rendered message is dropped and asked for again with `isNew` true (a settled one then takes only what the
    /// cache already holds for the new root; prewarm fills the rest).
    public func sync(_ messages: [ChatMessage], root: String? = nil,
                     render: (ChatMessage, _ isNew: Bool) -> RenderedAnswer?) {
        let rootChanged = root != self.root
        self.root = root
        for m in messages {
            if let model = models[m.id] {
                let changed = model.message.text != m.text || model.message.isRunning != m.isRunning
                if changed {
                    model.update(m, root: root, rendered: render(m, false))
                } else if rootChanged {
                    model.update(m, root: root, rendered: model.rendered == nil ? nil : render(m, true))
                } else if model.message != m {
                    model.update(m, root: root, rendered: model.rendered)
                }
            } else {
                models[m.id] = MessageModel(m, root: root, rendered: render(m, true))
            }
        }
        let newIds = messages.map(\.id)
        if newIds != ids {
            ids = newIds
            let seen = Set(newIds)
            for id in models.keys where !seen.contains(id) { models[id] = nil }
            let paired = Self.pair(messages)
            if paired != turns { turns = paired }
        }
        let running = messages.contains { $0.isRunning }
        if running != isRunning { isRunning = running }
    }

    /// The feed is no longer shown: drop its settled answers' renders (and stop its prewarm), so memory does not grow
    /// with every session viewed. The RenderCache keeps the chunks it can within its bound; showing the feed again
    /// prewarms it again, and a row renders from the cache on demand meanwhile. A streaming answer keeps its render.
    public func dropRenders() {
        prewarmTask?.cancel()
        prewarmTask = nil
        for m in models.values where !m.message.isRunning { m.clearRendered() }
    }

    /// A background render finished; applied only if the message still has that text and the feed still renders
    /// with that root (a late batch from before a root change is dropped).
    public func setRendered(_ r: RenderedAnswer, for id: UUID, text: String, root: String?) {
        guard root == self.root, let m = models[id], m.message.text == text, m.root == root else { return }
        m.setRendered(r)
    }
}
