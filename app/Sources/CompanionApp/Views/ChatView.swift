import CompanionCore
import SwiftUI

/// A question and the answer to it.
struct Turn: Identifiable {
    let question: ChatMessage?
    let answer: ChatMessage?
    var id: UUID { question?.id ?? answer!.id }

    static func pair(_ messages: [ChatMessage]) -> [Turn] {
        var out: [Turn] = []
        var pending: ChatMessage?
        for m in messages {
            switch m.role {
            case .user:
                if let q = pending { out.append(Turn(question: q, answer: nil)) }
                pending = m
            case .assistant:
                out.append(Turn(question: pending, answer: m))
                pending = nil
            }
        }
        if let q = pending { out.append(Turn(question: q, answer: nil)) }
        return out
    }
}

/// The chat: one column of turns on the window background, newest at the bottom.
/// It follows streaming text only while the reader is within `ScrollFollow.nearBottom` of the bottom (M9 §5.7),
/// offers "Jump to latest" (⌘↓) otherwise, and remembers each chat's position across session switches.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    let messages: [ChatMessage]
    /// The session id, or `"past:" + threadId` for a past chat.
    let sessionKey: String
    let readOnly: Bool

    var body: some View {
        // One scroll view per chat: a new key is a new view (fresh scroll state, no turn-count animation across
        // chats). Each saves its position when it goes away (switch, past chat, empty or loading state) and the
        // next view for that key starts from it.
        ChatScroll(messages: messages, sessionKey: sessionKey, readOnly: readOnly,
                   restore: model.scrollMemory.position(for: sessionKey))
            .id(sessionKey)
    }
}

private struct ChatScroll: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let messages: [ChatMessage]
    let sessionKey: String
    let readOnly: Bool
    /// The first visible turn saved for this chat, or nil to start at the bottom.
    let restore: UUID?

    @State private var position: ScrollPosition
    @State private var follow: ScrollFollow

    init(messages: [ChatMessage], sessionKey: String, readOnly: Bool, restore: UUID?) {
        self.messages = messages
        self.sessionKey = sessionKey
        self.readOnly = readOnly
        self.restore = restore
        _position = State(initialValue: restore.map { ScrollPosition(id: $0, anchor: .top) }
            ?? ScrollPosition(idType: UUID.self, edge: Self.initialEdge))
        _follow = State(initialValue: ScrollFollow(following: restore == nil))
    }

    private static var initialAnchor: UnitPoint {
        #if DEBUG
        if DemoFlags.is_("context") || DemoFlags.is_("raw") { return .top }
        #endif
        return .bottom
    }

    private static var initialEdge: Edge { initialAnchor == .top ? .top : .bottom }

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.ChatView")
        #endif
        ScrollView {
            let turns = Turn.pair(messages)
            LazyVStack(alignment: .leading, spacing: Design.turnGap) {
                ForEach(turns) { turn in
                    let latest = turn.id == turns.last?.id
                    TurnView(turn: turn, readOnly: readOnly, isLatest: latest)
                        .id(turn.id)
                        .modifier(EntranceTransition(enabled: latest))
                }
            }
            // The entrance transition needs a transaction: animate only a newly appended turn, on the stack and not
            // the scroll view (spec §5.8). Keyed on the last turn's id, not the count: a restore inserts older turns
            // at the front and keeps the last id, and a chat switch is a new view (ChatView's .id), so neither
            // animates. Older rows use .identity; under Reduce Motion EntranceTransition is opacity only.
            .animation(Design.Motion.standard(reduceMotion: reduceMotion), value: turns.last?.id)
            .scrollTargetLayout()
            .padding(.horizontal, Design.Space.l)
            .padding(.top, Design.Space.m)
            .padding(.bottom, Design.Space.l)
        }
        .scrollEdgeEffectStyle(.hard, for: .top)
        // Text scrolling under the composer fades out instead of showing around the field.
        .scrollEdgeEffectStyle(.soft, for: .bottom)
        .scrollPosition($position, anchor: .top)
        // Only the first appearance starts at the bottom. Size changes keep the turn being read in place
        // (scrollPosition), instead of keeping the bottom pinned while the reader is above it.
        .defaultScrollAnchor(restore == nil ? Self.initialAnchor : .top, for: .initialOffset)
        // No .animation(value: messages.count) here: it animated the whole scroll view (spec §5.8).
        .onScrollGeometryChange(for: ScrollMetrics.self) { g in
            ScrollMetrics(offset: g.contentOffset.y, distance: g.contentSize.height - g.visibleRect.maxY)
        } action: { _, m in
            follow.geometry(offset: m.offset, distanceFromBottom: m.distance)
        }
        .onChange(of: messages.last?.text) {
            if messages.last?.isRunning == true && follow.following { position.scrollTo(edge: .bottom) }
        }
        .onChange(of: messages.last?.id) { _, _ in
            // A new live turn (the user just asked): follow it. A restore inserts at the front and keeps the last id.
            if messages.last?.isRunning == true { follow.followAgain(); position.scrollTo(edge: .bottom) }
        }
        .onAppear {
            // The initial ScrollPosition carries the saved turn; scrolling to it again once the lazy rows exist
            // makes the restore exact.
            if let restore { position.scrollTo(id: restore, anchor: .top) }
        }
        .onDisappear {
            model.scrollMemory.save(session: sessionKey, firstVisible: position.viewID(type: UUID.self),
                                    following: follow.following)
        }
        .overlay(alignment: .bottomTrailing) { jumpButton }
        .modifier(FirstVisibleProbe(position: position))
    }

    private var jumpButton: some View {
        Button {
            follow.followAgain()
            // Reduce Motion: the jump is instant.
            withAnimation(reduceMotion ? nil : Design.Motion.standard) { position.scrollTo(edge: .bottom) }
        } label: {
            Label("Jump to latest", systemImage: "arrow.down")
        }
        .buttonStyle(.glass)
        .controlSize(.small)
        .keyboardShortcut(.downArrow, modifiers: .command)
        .help("Jump to the latest message (⌘↓)")
        .accessibilityLabel("Jump to latest message")
        .padding(.trailing, Design.Space.l)
        .padding(.bottom, Design.Space.m)
        // Hidden and disabled at the bottom: a disabled button's ⌘↓ does not fire, so the composer keeps ⌘↓
        // (move to end), and the button leaves the focus order.
        .opacity(follow.showsJumpToLatest ? 1 : 0)
        .disabled(!follow.showsJumpToLatest)
        .accessibilityHidden(!follow.showsJumpToLatest)
    }
}

private struct ScrollMetrics: Equatable { let offset: Double; let distance: Double }

/// DEBUG: reports the first visible turn to the perf harness (`position` driver). A no-op in release.
private struct FirstVisibleProbe: ViewModifier {
    let position: ScrollPosition
    func body(content: Content) -> some View {
        #if DEBUG
        content.onChange(of: position.viewID(type: UUID.self), initial: true) { _, id in PerfProbe.firstVisibleTurn = id }
        #else
        content
        #endif
    }
}

struct TurnView: View {
    @Environment(AppModel.self) private var model
    let turn: Turn
    let readOnly: Bool
    var isLatest = false
    /// One hover tracker per row: the answer's actions row shows while the pointer is anywhere on the turn.
    @State private var hovering = false

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count(turn.answer?.isRunning == true ? "body.TurnView.running" : "body.TurnView.settled")
        #endif
        VStack(alignment: .leading, spacing: Design.Space.m) {
            // The question and its "context sent" line read as one unit.
            VStack(alignment: .trailing, spacing: Design.Space.xs + 2) {
                if let q = turn.question { QuestionBubble(message: q) }
                if let t = turn.answer?.turnId, let record = model.records[t] {
                    ContextSentView(record: record)
                }
            }
            if let a = turn.answer { AnswerView(message: a, readOnly: readOnly, isLatest: isLatest, rowHovered: hovering) }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}
