import CompanionCore
import AppKit
import SwiftUI

/// The user's question: a soft neutral bubble on the trailing side, at most 80 % of the column, selectable.
struct QuestionBubble: View {
    let model: MessageModel

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.QuestionBubble")
        #endif
        let message = model.message
        TrailingFraction(fraction: Design.bubbleMaxFraction) {
            Text(verbatim: message.text)
                .font(.body)
                .lineSpacing(2)
                .chatTextSelection()
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
/// shown for the latest answer, on hover for older ones, as a zero-height overlay, so hovering never moves the text).
/// It observes only its own message model and its own Read Aloud state (M9 §5.5).
struct AnswerView: View {
    @Environment(AppModel.self) private var app
    @Environment(ReadAloudController.self) private var readAloud
    let model: MessageModel
    let readOnly: Bool
    var isLatest = false
    /// Set by the TurnView that owns the hover tracking.
    var rowHovered = false
    /// The pointer is on the overlaid actions row itself (it sits just outside the turn's own bounds).
    @State private var overlayHovered = false
    /// The Copy menu is open: the pointer is in the menu, not on the row, but the row stays until it closes.
    @State private var menuOpen = false
    private static let overlayRowHeight: CGFloat = 22

    var body: some View {
        let message = model.message
        #if DEBUG
        let _ = PerfProbe.count(message.isRunning ? "body.AnswerView.running" : "body.AnswerView.settled")
        #endif
        // Once per body. Normally the model carries it (rendered by
        // the coalesced update or the background prewarm); otherwise render now, with the feed's root (closed chunks
        // come from the cache).
        let rendered = model.rendered ?? render(message)
        let speech = readAloud.speech(for: message.id)
        VStack(alignment: .leading, spacing: Design.Space.s) {
            if message.text.isEmpty && message.isRunning {
                if let a = message.activity { ActivityRow(text: a) } else { TypingIndicator() }
            } else if !message.text.isEmpty {
                BlockStack(answer: rendered, root: model.root)
            }
            if !message.text.isEmpty, message.isRunning, let a = message.activity { ActivityRow(text: a) }
            statusRow(message)
            if isLatest && !message.isRunning && !message.text.isEmpty {
                actionsRow(message, phase: speech.phase).padding(.top, -Design.Space.s + 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Older answers: a zero-height overlay just below the last block, so nothing reserves space under the text
        // (the gap to the next turn is the plain turn gap) and revealing it never moves a line.
        .overlay(alignment: .bottomLeading) {
            if !isLatest && !message.isRunning && !message.text.isEmpty {
                let shown = rowHovered || overlayHovered || menuOpen || speech.phase != .idle
                actionsRow(message, phase: speech.phase)
                    .opacity(shown ? 1 : 0)
                    .animation(Design.Motion.quick, value: shown)
                    .allowsHitTesting(shown)
                    .accessibilityHidden(!shown)
                    .onHover { overlayHovered = $0 }
                    // Only the answer whose row the pointer is on (or whose menu is open) listens for menus.
                    .background {
                        // The subscription exists only while this view does.
                        if overlayHovered || menuOpen {
                            Color.clear.frame(width: 0, height: 0)
                                .onReceive(NotificationCenter.default.publisher(for: NSMenu.didBeginTrackingNotification)) { _ in
                                    if overlayHovered { menuOpen = true }
                                }
                                .onReceive(NotificationCenter.default.publisher(for: NSMenu.didEndTrackingNotification)) { _ in
                                    menuOpen = false
                                }
                        }
                    }
                    .onDisappear { menuOpen = false; overlayHovered = false }
                    // The in-layout row of the latest answer sits 2 pt below the last block (8 pt stack gap minus the
                    // 6 pt pull-up); the overlay's bottom edge is the last block's, so its row starts at +height+2.
                    .offset(y: Self.overlayRowHeight + 2)
            }
        }
        // No contextMenu here: right-click on selected text keeps the system menu (Copy, Look Up, Share).
        // A container, not a combined element: each block keeps its own label and headings stay in the rotor.
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel(message))
        .accessibilityAction(named: "Copy") { Design.copy(CopyFormat.markdown(message)) }
        .accessibilityAction(named: "Copy as plain text") { Design.copy(CopyFormat.plain(message)) }
        .accessibilityAction(named: speech.phase != .idle ? "Pause or resume reading" : "Read aloud") {
            readAloud.toggle(id: message.id, markdown: message.text)
        }
        .accessibilityActions {
            if speech.phase != .idle {
                Button("Stop reading") { readAloud.stop() }
            }
            if message.retry != nil && !readOnly {
                Button("Send again") { Task { await app.sendAgain(message) } }
            }
        }
    }

    private func render(_ message: ChatMessage) -> RenderedAnswer {
        guard !message.text.isEmpty else { return .empty }
        #if DEBUG
        return PerfProbe.measure("render.answer") {
            app.renderCache.answer(for: message.text, root: model.root, streaming: message.isRunning)
        }
        #else
        return app.renderCache.answer(for: message.text, root: model.root, streaming: message.isRunning)
        #endif
    }

    private func accessibilityLabel(_ message: ChatMessage) -> String {
        if message.isRunning && message.text.isEmpty { return "GPT is thinking" }
        if case .failed(let why) = message.status { return "GPT's reply failed: \(why)" }
        return "GPT answer"
    }

    private static func icon(_ phase: SpeechPhase) -> String {
        switch phase {
        case .playing: "pause.fill"
        case .paused: "play.fill"
        case .idle: "speaker.wave.2"
        }
    }

    @ViewBuilder private func statusRow(_ message: ChatMessage) -> some View {
        switch message.status {
        case .streaming where !message.text.isEmpty && message.activity == nil:
            Text("Answering…").font(.caption).foregroundStyle(.secondary)
        case .interrupted:
            Label("Stopped", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .failed(let why):
            // Borderless on the canvas (D1): icon, the reason, and the retry.
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.s) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                Text(verbatim: why).font(.callout).chatTextSelection()
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if message.retry != nil && !readOnly {
                    Button("Send Again") { Task { await app.sendAgain(message) } }
                        .controlSize(.small)
                        .buttonStyle(.borderless)
                        .fixedSize()
                }
            }
        default:
            EmptyView()
        }
    }

    @ViewBuilder private func copyItems(_ message: ChatMessage, phase: SpeechPhase) -> some View {
        Button("Copy as Markdown") { Design.copy(CopyFormat.markdown(message)) }
        Button("Copy as Plain Text") { Design.copy(CopyFormat.plain(message)) }
        if !message.text.isEmpty && !message.isRunning {
            Divider()
            Button(phase != .idle ? "Pause or Resume Reading" : "Read Aloud") {
                readAloud.toggle(id: message.id, markdown: message.text)
            }
            if phase != .idle { Button("Stop Reading") { readAloud.stop() } }
        }
    }

    /// Copy ▾, Read aloud (and Stop while reading), the Speaking badge, then the time: one line, at most 22 pt
    /// tall. ViewThatFits drops the time, then the badge's text, so it fits at 280 pt by construction.
    private func actionsRow(_ message: ChatMessage, phase: SpeechPhase) -> some View {
        ViewThatFits(in: .horizontal) {
            actions(message, phase: phase, time: true, badgeText: true)
            actions(message, phase: phase, time: false, badgeText: true)
            actions(message, phase: phase, time: false, badgeText: false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(height: Self.overlayRowHeight)
    }

    private func actions(_ message: ChatMessage, phase: SpeechPhase, time: Bool, badgeText: Bool) -> some View {
        HStack(spacing: 2) {
            Menu {
                copyItems(message, phase: phase)
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
            IconButton(symbol: Self.icon(phase),
                       label: phase != .idle ? "Pause or resume reading" : "Read aloud") {
                readAloud.toggle(id: message.id, markdown: message.text)
            }
            if phase != .idle {
                IconButton(symbol: "stop.fill", label: "Stop reading") { readAloud.stop() }
            }
            if phase != .idle {
                SpeakingBadge(paused: phase == .paused, showText: badgeText).padding(.leading, Design.Space.xs)
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
