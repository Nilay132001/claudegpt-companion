import CompanionCore
import SwiftUI

/// The user's question: trailing, quiet accent fill, selectable.
struct QuestionBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            Spacer(minLength: Design.Space.xl + 16)
            Text(verbatim: message.text)
                .font(.body)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Design.Space.m)
                .padding(.vertical, Design.Space.s + 1)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: Design.Radius.bubble, style: .continuous))
                .contextMenu {
                    Button("Copy") { Design.copy(message.text) }
                }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You asked: \(message.text)")
        .accessibilityAction(named: "Copy") { Design.copy(message.text) }
    }
}

/// GPT's answer: full-width document text, a small label row, actions on hover.
struct AnswerView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReadAloudController.self) private var readAloud
    let message: ChatMessage
    let readOnly: Bool
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.s) {
            labelRow
            if message.text.isEmpty && message.isRunning {
                if let a = message.activity { ActivityRow(text: a) } else { TypingIndicator() }
            } else if !message.text.isEmpty {
                ReplyView(markdown: message.text, root: model.currentRoot)
            }
            if !message.text.isEmpty, message.isRunning, let a = message.activity { ActivityRow(text: a) }
            statusRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        // No contextMenu here: right-click on selected text keeps the system menu (Copy, Look Up, Share).
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityAction(named: "Copy") { Design.copy(CopyFormat.markdown(message)) }
        .accessibilityAction(named: "Copy as plain text") { Design.copy(CopyFormat.plain(message)) }
        .accessibilityAction(named: readAloud.isActive(message.id) ? "Pause or resume reading" : "Read aloud") {
            readAloud.toggle(id: message.id, markdown: message.text)
        }
        .accessibilityActions {
            if message.retry != nil && !readOnly {
                Button("Send again") { Task { await model.sendAgain(message) } }
            }
        }
    }

    private var accessibilityText: String {
        if message.isRunning && message.text.isEmpty { return "GPT is thinking" }
        if case .failed(let why) = message.status { return "GPT's reply failed: \(why)" }
        return "GPT answered: \(ReplyMarkdown.plainText(message.text))"
    }

    /// Read Aloud state of this answer: nil when it is not being read.
    private var speaking: Bool? {
        readAloud.isActive(message.id) ? readAloud.isSpeaking(message.id) : nil
    }

    private var labelRow: some View {
        HStack(spacing: 5) {
            Image(systemName: "sparkle")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tint)
            Text("GPT").font(.caption.weight(.semibold))
            if let at = message.sentAt {
                Text(verbatim: at.shortStamp).font(.caption).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
            if let on = speaking {
                SpeakingBadge(paused: !on)
            }
            // Actions share the label row, so they take no height of their own.
            if !message.isRunning && !message.text.isEmpty { actions }
        }
    }

    @ViewBuilder private var statusRow: some View {
        switch message.status {
        case .streaming where !message.text.isEmpty && message.activity == nil:
            Text("Answering…").font(.caption).foregroundStyle(.secondary)
        case .interrupted:
            Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .failed(let why):
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.s) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(verbatim: why).font(.callout).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if message.retry != nil && !readOnly {
                    Button("Send Again") { Task { await model.sendAgain(message) } }
                        .controlSize(.small)
                        .buttonStyle(.bordered)
                }
            }
            .padding(Design.Space.s + 2)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: Design.Radius.status))
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var copyItems: some View {
        Button("Copy as Markdown") { Design.copy(CopyFormat.markdown(message)) }
        Button("Copy as Plain Text") { Design.copy(CopyFormat.plain(message)) }
        if !message.text.isEmpty && !message.isRunning {
            Divider()
            Button(readAloud.isActive(message.id) ? "Pause or Resume Reading" : "Read Aloud") {
                readAloud.toggle(id: message.id, markdown: message.text)
            }
            if readAloud.isActive(message.id) { Button("Stop Reading") { readAloud.stop() } }
        }
    }

    private var actions: some View {
        HStack(spacing: 2) {
            Menu {
                copyItems
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            } primaryAction: {
                Design.copy(CopyFormat.markdown(message))
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .controlSize(.small)
            .fixedSize()
            .help("Copy (click), or choose Markdown or plain text")
            .accessibilityLabel("Copy answer")
            IconButton(symbol: readAloud.icon(for: message.id),
                       label: readAloud.isActive(message.id) ? "Pause or resume reading" : "Read aloud") {
                readAloud.toggle(id: message.id, markdown: message.text)
            }
            if readAloud.isActive(message.id) {
                IconButton(symbol: "stop.fill", label: "Stop reading") { readAloud.stop() }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        // Visible on hover; always reachable by keyboard and VoiceOver (opacity keeps them in both).
        .opacity(hovering || speaking != nil ? 1 : 0)
        .animation(Design.Motion.quick, value: hovering)
    }
}

/// "Speaking" with a live waveform while Read Aloud plays this answer.
struct SpeakingBadge: View {
    let paused: Bool
    var body: some View {
        Label(paused ? "Paused" : "Speaking", systemImage: "waveform")
            .symbolEffect(.variableColor.iterative, isActive: !paused)
            .font(.caption)
            .foregroundStyle(.tint)
            .accessibilityLabel(paused ? "Reading paused" : "Reading aloud")
    }
}

/// Tool activity while GPT works ("Reading the repository…").
struct ActivityRow: View {
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Image(systemName: "doc.text.magnifyingglass").foregroundStyle(.secondary)
            Text(verbatim: text).foregroundStyle(.secondary)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
    }
}

/// Three dots before the first words arrive; static under Reduce Motion.
struct TypingIndicator: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                dots(phase: -1)
            } else {
                PhaseAnimator([0, 1, 2]) { phase in dots(phase: phase) } animation: { _ in .easeInOut(duration: 0.35) }
            }
        }
        .padding(.vertical, Design.Space.xs)
        .accessibilityElement()
        .accessibilityLabel("GPT is thinking")
    }

    private func dots(phase: Int) -> some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(.secondary)
                    .frame(width: 7, height: 7)
                    .opacity(phase < 0 ? 0.6 : (i == phase ? 0.9 : 0.3))
            }
        }
    }
}
