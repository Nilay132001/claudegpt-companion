import CompanionCore
import SwiftUI

/// The user's question: a soft neutral bubble on the trailing side, at most 80 % of the column, selectable.
struct QuestionBubble: View {
    let message: ChatMessage

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.QuestionBubble")
        #endif
        TrailingFraction(fraction: Design.bubbleMaxFraction) {
            Text(verbatim: message.text)
                .font(.body)
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, Design.Space.m + 2)
                .padding(.vertical, Design.Space.s + 2)
                .background(Design.Fill.bubble, in: RoundedRectangle(cornerRadius: Design.Radius.bubble, style: .continuous))
                .contextMenu {
                    Button("Copy") { Design.copy(message.text) }
                }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You asked: \(message.text)")
        .accessibilityAction(named: "Copy") { Design.copy(message.text) }
    }
}

/// GPT's answer: plain full-width text, no label row (D4). A compact actions row sits directly under it: always
/// shown for the latest answer, on hover for older ones (it keeps its height, so hovering never moves the text).
struct AnswerView: View {
    @Environment(AppModel.self) private var model
    @Environment(ReadAloudController.self) private var readAloud
    let message: ChatMessage
    let readOnly: Bool
    var isLatest = false
    @State private var hovering = false

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count(message.isRunning ? "body.AnswerView.running" : "body.AnswerView.settled")
        #endif
        VStack(alignment: .leading, spacing: Design.Space.s) {
            if message.text.isEmpty && message.isRunning {
                if let a = message.activity { ActivityRow(text: a) } else { TypingIndicator() }
            } else if !message.text.isEmpty {
                ReplyView(markdown: message.text, root: model.currentRoot)
            }
            if !message.text.isEmpty, message.isRunning, let a = message.activity { ActivityRow(text: a) }
            statusRow
            if !message.isRunning && !message.text.isEmpty {
                actionsRow.padding(.top, -Design.Space.s + 2)
            }
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
        #if DEBUG
        return "GPT answered: \(PerfProbe.measure("parse.plainText") { ReplyMarkdown.plainText(message.text) })"
        #else
        return "GPT answered: \(ReplyMarkdown.plainText(message.text))"
        #endif
    }

    /// Read Aloud state of this answer: nil when it is not being read.
    private var speaking: Bool? {
        readAloud.isActive(message.id) ? readAloud.isSpeaking(message.id) : nil
    }

    @ViewBuilder private var statusRow: some View {
        switch message.status {
        case .streaming where !message.text.isEmpty && message.activity == nil:
            Text("Answering…").font(.caption).foregroundStyle(.secondary)
        case .interrupted:
            Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .failed(let why):
            // Borderless on the canvas (D1): icon, the reason, and the retry.
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.s) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(verbatim: why).font(.callout).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if message.retry != nil && !readOnly {
                    Button("Send Again") { Task { await model.sendAgain(message) } }
                        .controlSize(.small)
                        .buttonStyle(.borderless)
                        .fixedSize()
                }
            }
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

    /// Copy ▾, Read aloud (and Stop while reading), the Speaking badge, then the time: one line, at most 22 pt
    /// tall. ViewThatFits drops the time, then the badge's text, so it fits at 280 pt by construction.
    private var actionsRow: some View {
        ViewThatFits(in: .horizontal) {
            actions(time: true, badgeText: true)
            actions(time: false, badgeText: true)
            actions(time: false, badgeText: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(height: 22)
        // Shown for the latest answer, on hover for older ones; opacity keeps them for keyboard and VoiceOver.
        .opacity(isLatest || hovering || speaking != nil ? 1 : 0)
        .animation(Design.Motion.quick, value: hovering)
    }

    private func actions(time: Bool, badgeText: Bool) -> some View {
        HStack(spacing: 2) {
            Menu {
                copyItems
            } label: {
                Image(systemName: "doc.on.doc")
            } primaryAction: {
                Design.copy(CopyFormat.markdown(message))
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .menuIndicator(.visible)
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
            if let on = speaking {
                SpeakingBadge(paused: !on, showText: badgeText).padding(.leading, Design.Space.xs)
            }
            if time, let at = message.sentAt {
                Text(verbatim: at.shortStamp)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .padding(.leading, Design.Space.xs)
                    .accessibilityLabel("Answered \(at.shortStamp)")
            }
        }
        .fixedSize()
    }
}

/// "Speaking" with a live waveform while Read Aloud plays this answer.
struct SpeakingBadge: View {
    let paused: Bool
    /// false: the waveform only (narrow actions row); the accessibility label is the same.
    var showText = true
    var body: some View {
        Label(paused ? "Paused" : "Speaking", systemImage: "waveform")
            .labelStyle(BadgeLabelStyle(showText: showText))
            .symbolEffect(.variableColor.iterative, isActive: !paused)
            .font(.caption)
            .foregroundStyle(.tint)
            .accessibilityLabel(paused ? "Reading paused" : "Reading aloud")
    }
}

private struct BadgeLabelStyle: LabelStyle {
    let showText: Bool
    func makeBody(configuration: Configuration) -> some View {
        if showText {
            Label(configuration)
        } else {
            configuration.icon
        }
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
