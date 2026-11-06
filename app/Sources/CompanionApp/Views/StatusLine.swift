import CompanionCore
import SwiftUI

private struct ApprovalTarget: Identifiable { let root: String; var id: String { root } }

/// One compact, borderless row for everything that needs attention (replaces the v0.7.0 banner stack). The highest-priority
/// notice shows first; "1/3" pages through the rest. Clicking the text shows it in full.
struct StatusLine: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index = 0
    @State private var expanded = false
    @State private var approving: ApprovalTarget?

    var body: some View {
        let items = model.statusItems
        // Always present, so the sheet and the change handlers survive the list emptying.
        VStack(spacing: 0) {
            if !items.isEmpty {
                let i = min(index, items.count - 1)
                row(items[i], position: i, count: items.count)
                    .padding(.horizontal, Design.Space.m)
                    .padding(.bottom, Design.Space.s)
                    .transition(.opacity)
            }
        }
        .animation(Design.Motion.standard(reduceMotion: reduceMotion), value: items.map(\.id))
        .onChange(of: items.map(\.id)) { old, new in
            // A new top notice (e.g. a security alert) is shown first.
            if new.first != old.first { index = 0; expanded = false }
        }
        .sheet(item: $approving) { t in ApproveSheet(root: t.root) }
    }

    private func row(_ item: StatusItem, position: Int, count: Int) -> some View {
        HStack(alignment: expanded ? .firstTextBaseline : .center, spacing: Design.Space.s) {
            Image(systemName: symbol(item.tone))
                .foregroundStyle(tint(item.tone))
                .font(.callout)
                .accessibilityLabel(item.tone == .danger ? "Security" : item.tone == .warning ? "Warning" : "Note")
            Text(verbatim: item.text)
                .font(.callout)
                .lineLimit(expanded ? nil : 1)
                .truncationMode(.tail)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .onTapGesture { withAnimation(Design.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() } }
                .help(item.text)
            if let title = item.actionTitle {
                Button(title) { act(item) }
                    .buttonStyle(.borderless)
                    .font(.callout.weight(.medium))
                    .fixedSize()
            }
            if count > 1 {
                Button {
                    index = (position + 1) % count
                    expanded = false
                } label: {
                    Text(verbatim: "\(position + 1)/\(count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .fixedSize()
                .help("Next notice")
                .accessibilityLabel("Notice \(position + 1) of \(count). Show the next one")
            }
            if item.dismissible {
                IconButton(symbol: "xmark", label: "Dismiss") { model.dismiss(status: item) }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        // Borderless on the window background (D8): the tinted icon carries the tone.
        .padding(.leading, Design.Space.xs)
        .frame(minHeight: 26)
        .padding(.vertical, expanded ? Design.Space.xs : 0)
        .accessibilityElement(children: .contain)
    }

    private func act(_ item: StatusItem) {
        switch item.kind {
        case .repoUnavailable(let root?): approving = ApprovalTarget(root: root)
        case .focusMoved, .pinnedMissing: Task { await model.followFocus() }
        default: break
        }
    }

    private func symbol(_ tone: StatusItem.Tone) -> String {
        switch tone {
        case .danger: "exclamationmark.octagon.fill"
        case .warning: "exclamationmark.triangle.fill"
        case .info: "info.circle.fill"
        }
    }

    private func tint(_ tone: StatusItem.Tone) -> Color {
        switch tone {
        case .danger: .red
        case .warning: .orange
        case .info: .accentColor
        }
    }
}

/// A one-line notice with an optional dismiss button (Settings › Privacy revoke notice).
struct Banner: View {
    enum Tone { case info, warning, danger }
    let text: String
    var tone: Tone = .info
    var onDismiss: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: tone == .danger ? "exclamationmark.octagon.fill" : tone == .warning ? "exclamationmark.triangle.fill" : "info.circle.fill")
                .foregroundStyle(tone == .danger ? Color.red : tone == .warning ? Color.orange : Color.accentColor)
            Text(verbatim: text).font(.callout).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
            if let onDismiss {
                Button { onDismiss() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).help("Dismiss").accessibilityLabel("Dismiss")
            }
        }
        .padding(8)
        .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
    }
}
