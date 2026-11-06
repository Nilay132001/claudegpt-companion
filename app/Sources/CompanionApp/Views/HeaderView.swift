import CompanionCore
import SwiftUI

/// Header (spec "Layout" 1): identity only. A titlebar row with plain History / New chat / More buttons beside the
/// traffic lights, then the session title (it opens the session picker) and one secondary line (what the panel
/// follows). The repository and the context mode live in the composer's control row (M8 desktop-style D2).
struct HeaderView: View {
    @Environment(AppModel.self) private var model
    @State private var showPicker = false
    @State private var showHistory = Self.demoOpen("history")

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.xs) {
            titlebarRow
            sessionButton
        }
        .padding(.horizontal, Design.Space.m)
        .padding(.bottom, Design.Space.s + 2)
    }

    static func demoOpen(_ scene: String) -> Bool {
        #if DEBUG
        DemoFlags.is_(scene)
        #else
        false
        #endif
    }

    private var ready: Bool { model.gate == .ready }

    // MARK: Row 1 — beside the traffic lights

    private var titlebarRow: some View {
        HStack(spacing: 2) {
            Color.clear.frame(height: 32).contentShape(Rectangle()).gesture(WindowDragGesture())
            IconButton(symbol: "clock.arrow.circlepath", label: "History", help: "Past chats") { showHistory.toggle() }
                .popover(isPresented: $showHistory, arrowEdge: .bottom) { HistoryView(close: { showHistory = false }) }
                .disabled(!ready)
            IconButton(symbol: "square.and.pencil", label: "New chat", help: "New chat (⌘K)") { Task { await model.newChat() } }
                .disabled(!ready || model.isAnswering)
            MoreMenu()
        }
        .foregroundStyle(.secondary)
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
                            .layoutPriority(1)
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
        .help(model.selectedSession.map { "\($0.title)\nChoose session" } ?? "Choose session")
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
                .disabled((model.currentFeed?.isEmpty ?? true) && model.pastChat == nil)
            Button("Copy Conversation with Context") { Design.copy(model.conversationMarkdown(includeContext: true)) }
                .disabled((model.currentFeed?.isEmpty ?? true) && model.pastChat == nil)
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
