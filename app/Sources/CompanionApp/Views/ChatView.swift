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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let messages: [ChatMessage]
    /// The session id, or `"past:" + threadId` for a past chat.
    let sessionKey: String
    let readOnly: Bool

    @State private var position = ScrollPosition(idType: UUID.self, edge: ChatView.initialEdge)
    @State private var follow = ScrollFollow()

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
            // The entrance transition needs a transaction: animate only the turn-count change, on the stack and not
            // the scroll view (spec §5.8). Older rows use .identity, so only the newly inserted newest turn animates;
            // under Reduce Motion EntranceTransition is opacity only.
            .animation(Design.Motion.standard(reduceMotion: reduceMotion), value: turns.count)
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
        .defaultScrollAnchor(Self.initialAnchor, for: .initialOffset)
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
        .onChange(of: sessionKey) { old, new in
            model.scrollMemory.save(session: old, firstVisible: position.viewID(type: UUID.self), following: follow.following)
            if let id = model.scrollMemory.position(for: new) {
                follow = ScrollFollow(following: false)
                position.scrollTo(id: id, anchor: .top)
            } else {
                follow = ScrollFollow()
                position.scrollTo(edge: .bottom)
            }
        }
        .overlay(alignment: .bottomTrailing) { jumpButton }
        .modifier(FirstVisibleProbe(id: position.viewID(type: UUID.self)))
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
        // Kept in the hierarchy so ⌘↓ always works; hidden and inert at the bottom.
        .opacity(follow.showsJumpToLatest ? 1 : 0)
        .allowsHitTesting(follow.showsJumpToLatest)
        .accessibilityHidden(!follow.showsJumpToLatest)
    }
}

private struct ScrollMetrics: Equatable { let offset: Double; let distance: Double }

/// DEBUG: reports the first visible turn to the perf harness (`position` driver). A no-op in release.
private struct FirstVisibleProbe: ViewModifier {
    let id: UUID?
    func body(content: Content) -> some View {
        #if DEBUG
        content.onChange(of: id, initial: true) { _, id in PerfProbe.firstVisibleTurn = id }
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
