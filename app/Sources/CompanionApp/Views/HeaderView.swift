import CompanionCore
import SwiftUI

/// Header (spec "Layout" 1): a titlebar row with the History / New chat / More controls in one glass group, the
/// session button, and the repository + context row.
struct HeaderView: View {
    @Environment(AppModel.self) private var model
    @State private var showPicker = false
    @State private var showHistory = Self.demoOpen("history")
    @State private var showSees = Self.demoOpen("whatGPTSees")
    @State private var width: CGFloat = 360

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.s) {
            titlebarRow
            sessionButton
            if model.selectedSessionId != nil && ready { contextRow }
        }
        .padding(.horizontal, Design.Space.m)
        .padding(.bottom, Design.Space.s + 2)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    private static func demoOpen(_ scene: String) -> Bool {
        #if DEBUG
        DemoFlags.is_(scene)
        #else
        false
        #endif
    }

    private var ready: Bool { model.gate == .ready }

    // MARK: Row 1 — beside the traffic lights

    private var titlebarRow: some View {
        HStack(spacing: 0) {
            Color.clear.frame(height: 32).contentShape(Rectangle()).gesture(WindowDragGesture())
            GlassEffectContainer {
                HStack(spacing: 2) {
                    IconButton(symbol: "clock.arrow.circlepath", label: "History", help: "Past chats") { showHistory.toggle() }
                        .popover(isPresented: $showHistory, arrowEdge: .bottom) { HistoryView(close: { showHistory = false }) }
                        .disabled(!ready)
                    IconButton(symbol: "square.and.pencil", label: "New chat", help: "New chat (⌘K)") { Task { await model.newChat() } }
                        .disabled(!ready || model.isAnswering)
                    MoreMenu()
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .panelGlass(in: Capsule(), interactive: true)
            }
        }
        .frame(height: 32)
        .padding(.top, 1)
    }

    // MARK: Row 2 — the session

    private var sessionButton: some View {
        Button { showPicker.toggle() } label: {
            HStack(alignment: .firstTextBaseline, spacing: Design.Space.s) {
                Circle().fill(statusColor).frame(width: 8, height: 8)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        Text(verbatim: model.selectedSession?.title ?? "No Claude session")
                            .font(.headline)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Image(systemName: "chevron.down")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    if model.selectedSessionId != nil {
                        Text(verbatim: model.followSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Choose session")
        .accessibilityLabel("Session: \(model.selectedSession?.title ?? "none"), \(statusText). \(model.followSummary)")
        .accessibilityHint("Choose session")
        .popover(isPresented: $showPicker, arrowEdge: .bottom) { PickerView(close: { showPicker = false }) }
        .disabled(model.snapshot == nil)
    }

    private var statusColor: Color {
        switch model.selectedSession?.status {
        case .busy?: .orange
        case .idle?: .green
        case .recent?: .gray
        default: Color.secondary.opacity(0.5)
        }
    }

    private var statusText: String {
        switch model.selectedSession?.status {
        case .busy?: "Claude is working"
        case .idle?: "idle"
        case .recent?: "recent"
        default: "inactive"
        }
    }

    // MARK: Row 3 — repository and context

    private var contextRow: some View {
        HStack(spacing: Design.Space.s) {
            // The branch shows when there is room; it is always in the tooltip and the accessibility label.
            RepoChip(showBranch: width >= 420)
            Spacer(minLength: Design.Space.xs)
            ContextModeMenu(compact: width < 320)
            IconButton(symbol: "eye", label: "What GPT can see", help: "What GPT can see") { showSees.toggle() }
                .foregroundStyle(.secondary)
                .popover(isPresented: $showSees, arrowEdge: .bottom) { WhatGPTSeesView() }
        }
    }
}

struct RepoChip: View {
    @Environment(AppModel.self) private var model
    var showBranch = true

    var body: some View {
        HStack(spacing: 5) {
            switch model.currentWorktree {
            case .resolved(let root, let branch, _)?:
                Image(systemName: "folder.fill").foregroundStyle(.tint).imageScale(.small)
                Text(verbatim: URL(fileURLWithPath: root).lastPathComponent).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.middle)
                if showBranch {
                    Text(verbatim: "·").foregroundStyle(.tertiary)
                    Text(verbatim: branch ?? "detached HEAD").foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                }
                Image(systemName: "lock.fill").font(.caption2).foregroundStyle(.secondary)
                    .help("Read-only: GPT can read this repository but can never change it.")
            case .unavailable?:
                Image(systemName: "folder.badge.questionmark").foregroundStyle(.orange).imageScale(.small)
                Text("Repository unavailable").foregroundStyle(.secondary)
            case nil:
                ProgressView().controlSize(.mini)
                Text("Finding the repository…").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .help(model.repoHelp.isEmpty ? "The repository of this Claude session" : model.repoSummary + "\n" + model.repoHelp)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Repository: \(model.repoSummary), read-only")
    }
}

extension SharingMode {
    var shortTitle: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask"
        case .automatic: "Automatic"
        }
    }

    /// The header menu's label: "Context: Ask before sending".
    var label: String {
        switch self {
        case .off: "Context: Off"
        case .ask: "Context: Ask before sending"
        case .automatic: "Context: Automatic"
        }
    }

    var menuTitle: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask before sending"
        case .automatic: "Automatic"
        }
    }

    /// The label when the panel is narrower than about 320 pt.
    var compactLabel: String {
        switch self {
        case .off: "Context: Off"
        case .ask: "Context: Ask"
        case .automatic: "Context: Auto"
        }
    }

    /// One line on what the mode sends (owner journey review).
    var detail: String {
        switch self {
        case .off: "Only your question; no Claude session context."
        case .ask: "Recent Claude context, shown to you before each send."
        case .automatic: "New Claude context, redacted, sent without a preview."
        }
    }

    /// The composer's hint row.
    var hint: String {
        switch self {
        case .off: "Off · only your question and the repo"
        case .ask: "Ask · you'll check before it's sent"
        case .automatic: "Automatic · new context, redacted"
        }
    }
}

struct ContextModeMenu: View {
    @Environment(AppModel.self) private var model
    var compact = false
    @State private var confirmAutomatic = false

    static let help = """
    What GPT gets from the Claude session with each question:
    Off: only your question, no session context.
    Ask before sending: recent context (redacted, up to 12 KB); you check it and can remove items first.
    Automatic: the new part of the session (redacted, up to 12 KB), sent without a preview.
    """

    var body: some View {
        let current = model.privacy?.sharingMode
        Menu {
            // A toggle per mode: the current one gets the menu checkmark; the second Text is the item's subtitle.
            ForEach(SharingMode.allCases, id: \.self) { mode in
                Toggle(isOn: Binding(get: { mode == current }, set: { _ in
                    guard mode != current else { return }
                    if mode == .automatic { confirmAutomatic = true } else { Task { await model.setSharingMode(mode) } }
                })) {
                    Text(mode.menuTitle)
                    Text(mode.detail)
                }
            }
        } label: {
            Text(verbatim: current.map { compact ? $0.compactLabel : $0.label } ?? "Context: …")
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.visible)
        .controlSize(.small)
        .fixedSize()
        .help(Self.help)
        .accessibilityLabel("Context: \(current?.title ?? "unknown")")
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
    }
}

struct MoreMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Menu {
            Button("Refresh Sessions") { Task { await model.refresh() } }
            if model.isKeepingSession {
                Button("Follow Claude's Focused Session") { Task { await model.followFocus() } }
                    .help("Switch sessions when you switch them in Claude")
            } else if let id = model.selectedSessionId {
                Button("Keep This Session") { Task { await model.pin(id) } }
                    .help("Stay on this session even when you switch sessions in Claude")
            }
            if model.privacy?.sharingMode != .off {
                Button("Explain Claude's Last Message") { Task { await model.explainLastMessage() } }
                    .disabled(!model.canExplain)
            }
            Divider()
            Button("Copy Conversation") { Design.copy(model.conversationMarkdown(includeContext: false)) }
                .disabled(model.currentMessages.isEmpty && model.pastChat == nil)
            Button("Copy Conversation with Context") { Design.copy(model.conversationMarkdown(includeContext: true)) }
                .disabled(model.currentMessages.isEmpty && model.pastChat == nil)
            Divider()
            Button("Settings…") { openSettings() }
        } label: {
            Image(systemName: "ellipsis")
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.hidden)
        .fixedSize()
        .help("More")
        .accessibilityLabel("More")
    }
}

extension View {
    /// Choosing Automatic needs a confirmation that shows the redaction notice (ruling 14).
    func automaticModeConfirmation(isPresented: Binding<Bool>) -> some View {
        modifier(AutomaticModeConfirmation(isPresented: isPresented))
    }
}

struct AutomaticModeConfirmation: ViewModifier {
    @Environment(AppModel.self) private var model
    @Binding var isPresented: Bool
    func body(content: Content) -> some View {
        content.confirmationDialog("Send Claude's session context without asking?", isPresented: $isPresented) {
            Button("Use Automatic") { Task { await model.setSharingMode(.automatic) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(verbatim: "Each question then includes the new part of the Claude session (capped at 12 KB, redacted) without a preview. " + model.redactionNotice)
        }
    }
}
