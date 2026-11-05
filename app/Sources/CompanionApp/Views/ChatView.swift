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
                VStack(alignment: .leading, spacing: Design.Space.l + 4) {
                    ForEach(Turn.pair(messages)) { turn in
                        TurnView(turn: turn, readOnly: readOnly)
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

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.s + 2) {
            if let q = turn.question { QuestionBubble(message: q) }
            if let a = turn.answer {
                if let t = a.turnId, let record = model.records[t] {
                    ContextSentView(record: record)
                }
                AnswerView(message: a, readOnly: readOnly)
            }
        }
    }
}
