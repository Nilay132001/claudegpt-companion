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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let messages: [ChatMessage]
    let readOnly: Bool

    private static var initialAnchor: UnitPoint {
        #if DEBUG
        if DemoFlags.is_("context") || DemoFlags.is_("raw") { return .top }
        #endif
        return .bottom
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                let turns = Turn.pair(messages)
                VStack(alignment: .leading, spacing: Design.turnGap) {
                    ForEach(turns) { turn in
                        TurnView(turn: turn, readOnly: readOnly, isLatest: turn.id == turns.last?.id)
                            .id(turn.id)
                            .modifier(EntranceTransition())
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
            .animation(Design.Motion.standard(reduceMotion: reduceMotion), value: messages.count)
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

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            // The question and its "context sent" line read as one unit.
            VStack(alignment: .trailing, spacing: Design.Space.xs + 2) {
                if let q = turn.question { QuestionBubble(message: q) }
                if let t = turn.answer?.turnId, let record = model.records[t] {
                    ContextSentView(record: record)
                }
            }
            if let a = turn.answer { AnswerView(message: a, readOnly: readOnly, isLatest: isLatest) }
        }
    }
}
