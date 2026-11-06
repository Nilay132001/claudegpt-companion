import CompanionCore
import SwiftUI

/// "What GPT can see" (owner journey review): everything GPT gets, in plain words, for the current settings.
struct WhatGPTSeesView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            Text("What GPT can see").font(.headline)
            row("text.bubble", "Your question", "Always. Nothing is sent until you ask.", tint: .accentColor)
            row("doc.text.magnifyingglass", "Recent Claude conversation", contextLine,
                tint: mode == .off ? .secondary : .accentColor, muted: mode == .off)
            row("folder", "This repository, read-only", repoLine, tint: repoApproved ? .accentColor : .secondary, muted: !repoApproved)
            row("list.bullet.rectangle", "Jira, read-only", model.jira?.configured == true
                ? "Issues and comments it looks up, redacted."
                : "Not set up. Settings › Jira.", tint: model.jira?.configured == true ? .accentColor : .secondary,
                muted: model.jira?.configured != true)
            Divider()
            row("hand.raised", "Nothing else", "No Claude credentials, no files outside approved repositories, no other apps.", tint: .secondary)
            Text(verbatim: model.redactionNotice)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(Design.Space.l)
        .frame(width: 320)
    }

    private var mode: SharingMode { model.privacy?.sharingMode ?? .ask }

    private var contextLine: String {
        switch mode {
        case .off: "Off: nothing from the Claude session is sent."
        case .ask: "Ask: up to 12 KB, redacted. You check it before each send."
        case .automatic: "Automatic: the new part, up to 12 KB, redacted, without a preview."
        }
    }

    private var repoApproved: Bool { model.currentRoot != nil }

    private var repoLine: String {
        if case .resolved(let root, let branch, _)? = model.currentWorktree {
            // The branch lives here, not in the composer row (M8 desktop-style D3).
            return "\(URL(fileURLWithPath: root).lastPathComponent) on \(branch ?? "a detached HEAD"): GPT can list, read and search files with read-only tools. It never writes, and secret files (.env, keys) stay hidden."
        }
        return "No repository tools: this repository isn't approved or available."
    }

    private func row(_ symbol: String, _ title: String, _ detail: String, tint: Color, muted: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Design.Space.s + 2) {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .frame(width: 18)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.callout.weight(.medium)).foregroundStyle(muted ? .secondary : .primary)
                Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
