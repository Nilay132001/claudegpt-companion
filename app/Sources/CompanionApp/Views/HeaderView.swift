import CompanionCore
import SwiftUI

struct HeaderView: View {
    @Environment(AppModel.self) private var model
    @State private var showPicker = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Circle().fill(statusColor).frame(width: 8, height: 8).help(model.selectedSession?.status.rawValue ?? "")
                Text(model.selectedSession?.title ?? "No Claude session").font(.headline).lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 4)
                Button { showPicker.toggle() } label: { Image(systemName: "list.bullet") }
                    .help("Choose a Claude session")
                    .popover(isPresented: $showPicker) { PickerView(close: { showPicker = false }) }
                Button { Task { await model.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh (⌘R)")
            }
            .buttonStyle(.borderless)
            HStack(spacing: 6) {
                Label(model.repoSummary, systemImage: "folder").lineLimit(1).truncationMode(.middle).help(model.repoHelp)
                Spacer(minLength: 4)
                Text("🔒 Read-only").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1).background(.quaternary, in: Capsule())
                    .help("GPT can read this repository but cannot change it.")
                SharingChip()
            }
            .font(.caption)
            HStack(spacing: 6) {
                Text(model.selectionLabel).foregroundStyle(.secondary)
                Text("·").foregroundStyle(.secondary)
                Text(model.syncSummary).foregroundStyle(.secondary)
                Spacer(minLength: 4)
                if model.snapshot?.selection.via == "pin" {
                    Button("Unpin") { Task { await model.followFocus() } }.buttonStyle(.link)
                } else if let id = model.selectedSessionId {
                    Button("Pin") { Task { await model.pin(id) } }.buttonStyle(.link)
                }
            }
            .font(.caption2)
        }
        .padding(10)
    }

    private var statusColor: Color {
        switch model.selectedSession?.status {
        case .busy?: .orange
        case .idle?: .green
        case .recent?: .gray
        default: .secondary
        }
    }
}

struct SharingChip: View {
    @Environment(AppModel.self) private var model
    @State private var confirmAutomatic = false

    var body: some View {
        Menu {
            ForEach(SharingMode.allCases, id: \.self) { mode in
                Button(mode.title) {
                    if mode == .automatic { confirmAutomatic = true } else { Task { await model.setSharingMode(mode) } }
                }
            }
        } label: {
            Text("Context: \(model.privacy?.sharingMode.title ?? "…")")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("What GPT gets from the Claude session")
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
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
            Text("Each question then includes the new part of the Claude session (capped at 12 KB, redacted) without a preview. " + model.redactionNotice)
        }
    }
}
