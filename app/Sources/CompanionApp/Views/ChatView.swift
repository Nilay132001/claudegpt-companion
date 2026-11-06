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
struct ChatView: View {
    @Environment(AppModel.self) private var model
    let messages: [ChatMessage]
    let readOnly: Bool

    private static var initialAnchor: UnitPoint {
        #if DEBUG
        if DemoFlags.is_("context") || DemoFlags.is_("raw") { return .top }
        #endif
        return .bottom
    }

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.ChatView")
        #endif
        ScrollViewReader { proxy in
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
                .padding(.horizontal, Design.Space.l)
                .padding(.top, Design.Space.m)
                .padding(.bottom, Design.Space.l)
                Color.clear.frame(height: 1).id("bottom")
            }
            .scrollEdgeEffectStyle(.hard, for: .top)
            // Text scrolling under the composer fades out instead of showing around the field.
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .defaultScrollAnchor(Self.initialAnchor)
            // No .animation(value: messages.count) here: it animated the whole scroll view (spec §5.8).
            .onChange(of: messages.last?.text) {
                if messages.last?.isRunning == true { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: messages.count) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
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
