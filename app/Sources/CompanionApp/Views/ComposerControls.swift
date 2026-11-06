import AppKit
import CompanionCore
import SwiftUI

/// The composer's leading controls (M8 desktop-style D2/D3): the repository menu and the context-mode menu. Both are
/// single-line; when the full labels do not fit, ViewThatFits drops to the compact ones and the repository name
/// truncates in the middle, so nothing ever overlaps the trailing buttons.
struct ComposerControls: View {
    @Binding var showSees: Bool

    var body: some View {
        // In order: everything in full; the repository name middle-truncated (ideal 120 pt) with "Context: Ask";
        // then "Ask". The ideal widths are what ViewThatFits measures; the real width is whatever is left.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: Design.Space.xs) {
                RepoMenu()
                ContextModeMenu(compact: false, showSees: $showSees)
            }
            .fixedSize()
            HStack(spacing: Design.Space.xs) {
                RepoMenu().frame(idealWidth: 120, alignment: .leading)
                ContextModeMenu(compact: false, showSees: $showSees).fixedSize().layoutPriority(1)
            }
            HStack(spacing: Design.Space.xs) {
                RepoMenu().frame(idealWidth: 60, alignment: .leading)
                ContextModeMenu(compact: true, showSees: $showSees).fixedSize().layoutPriority(1)
            }
        }
        // Outside ViewThatFits, so the popover keeps its anchor when the labels switch.
        .popover(isPresented: $showSees, arrowEdge: .top) { WhatGPTSeesView() }
        #if DEBUG
        .task {
            guard HeaderView.demoOpen("whatGPTSees") else { return }
            try? await Task.sleep(for: .milliseconds(600))
            showSees = true
        }
        #endif
    }
}

/// [folder repo ▾]: the repository GPT can read. The branch is never inline (D3): it is in the tooltip, the menu,
/// the accessibility label and the What GPT can see popover.
struct RepoMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Menu {
            switch model.currentWorktree {
            case .resolved(let root, let branch, _)?:
                Section("Read-only for GPT") {
                    Text(verbatim: root)
                    Text(verbatim: "Branch: \(branch ?? "detached HEAD")")
                }
                Button("Copy Repository Path") { Design.copy(root) }
            case .unavailable?:
                Text(verbatim: model.repoHelp.isEmpty ? "Repository unavailable" : model.repoHelp)
            case nil:
                Text("Finding the repository…")
            }
        } label: {
            label
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.visible)
        .controlSize(.small)
        .help(help)
        .accessibilityLabel(accessibility)
    }

    @ViewBuilder private var label: some View {
        switch model.currentWorktree {
        case .resolved(let root, _, _)?:
            HStack(spacing: 4) {
                Image(systemName: "folder")
                Text(verbatim: URL(fileURLWithPath: root).lastPathComponent).lineLimit(1).truncationMode(.middle)
            }
        case .unavailable?:
            Label {
                Text("No repository").lineLimit(1)
            } icon: {
                Image(systemName: "folder.badge.questionmark").foregroundStyle(.orange)
            }
        case nil:
            Label {
                Text("Repository…").lineLimit(1)
            } icon: {
                Image(systemName: "folder")
            }
        }
    }

    private var help: String {
        switch model.currentWorktree {
        case .resolved(let root, let branch, _)?:
            "\(root)\nBranch: \(branch ?? "detached HEAD")\nRead-only: GPT can read this repository but can never change it."
        case .unavailable?: model.repoHelp.isEmpty ? "Repository unavailable" : model.repoHelp
        case nil: "Finding the repository…"
        }
    }

    private var accessibility: String {
        switch model.currentWorktree {
        case .resolved?: "Repository: \(model.repoSummary), read-only"
        default: "Repository: \(model.repoSummary)"
        }
    }
}

extension SharingMode {
    /// "Context: Ask" in the composer when there is room.
    var label: String { "Context: " + compactLabel }

    /// The composer's label when the row is narrow.
    var compactLabel: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask"
        case .automatic: "Auto"
        }
    }

    var menuTitle: String {
        switch self {
        case .off: "Off"
        case .ask: "Ask before sending"
        case .automatic: "Automatic"
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
}

/// [Context: Ask ▾]: the three sharing modes, then "What GPT Can See…" (D2).
struct ContextModeMenu: View {
    @Environment(AppModel.self) private var model
    var compact = false
    @Binding var showSees: Bool
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
            Divider()
            Button {
                showSees = true
            } label: {
                Label("What GPT Can See…", systemImage: "eye")
            }
        } label: {
            Text(verbatim: current.map { compact ? $0.compactLabel : $0.label } ?? "Context: …")
                .lineLimit(1)
        }
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.visible)
        .controlSize(.small)
        .help(Self.help)
        .accessibilityLabel("Context: \(current?.title ?? "unknown")")
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
    }
}
