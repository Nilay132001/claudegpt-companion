import CompanionCore
import SwiftUI

/// Ask mode (spec §4.3, §7.5): the exact items, each removable. Nothing is sent until Send. Item text is
/// selectable: the checkbox is its own column, never a Toggle wrapping the text.
struct PreviewSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let p = model.preview {
            VStack(alignment: .leading, spacing: 0) {
                header(p)
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: Design.Space.s) {
                        if let notice = p.notice {
                            Label { Text(verbatim: notice) } icon: { Image(systemName: "exclamationmark.triangle.fill") }
                                .font(.callout).foregroundStyle(.orange)
                        }
                        questionBox(p)
                        Text("Claude session context").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                            .padding(.top, Design.Space.s)
                        let items = p.prepared.preview?.items ?? []
                        if items.isEmpty {
                            Text("Nothing new from the Claude session.").font(.callout).foregroundStyle(.secondary)
                        }
                        ForEach(items) { item in row(item, removed: p.removed.contains(item.id)) }
                        ForEach(p.prepared.preview?.notes ?? [], id: \.self) { note in
                            Text(verbatim: note).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(Design.Space.l)
                }
                Divider()
                footer(p)
            }
            .frame(width: 460, height: 600)
        }
    }

    private func header(_ p: PendingPreview) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Check what GPT will see").font(.title3.weight(.semibold))
            if let title = p.prepared.sessionTitle {
                Text(verbatim: "Claude session: " + title).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Text(verbatim: p.prepared.repo.summary).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
            if let note = p.prepared.repoNote { Text(verbatim: note).font(.callout).foregroundStyle(.secondary) }
        }
        .padding(Design.Space.l)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func questionBox(_ p: PendingPreview) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Your question").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(verbatim: p.question).font(.callout).textSelection(.enabled).lineLimit(4)
        }
        .padding(Design.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.accentColor.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func row(_ item: PreviewItem, removed: Bool) -> some View {
        HStack(alignment: .top, spacing: Design.Space.s + 2) {
            Toggle(isOn: Binding(get: { !removed }, set: { _ in model.toggle(itemId: item.id) })) { EmptyView() }
                .toggleStyle(.checkbox)
                .labelsHidden()
                .accessibilityLabel(removed ? "Include \(item.label)" : "Remove \(item.label)")
                .help(removed ? "Send this item" : "Leave this item out")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: item.label).font(.caption.weight(.semibold))
                    if item.redactions > 0 {
                        Text(verbatim: "\(item.redactions) masked").font(.caption2.weight(.medium)).foregroundStyle(.orange)
                    }
                    if removed { Text("Left out").font(.caption2).foregroundStyle(.secondary) }
                }
                Text(verbatim: item.text)
                    .font(.system(.caption, design: .monospaced))
                    .lineLimit(8)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .foregroundStyle(removed ? .tertiary : .primary)
                    .strikethrough(removed, color: .secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(Design.Space.s + 2)
        .background(.quaternary.opacity(removed ? 0.2 : 0.45), in: RoundedRectangle(cornerRadius: 8))
    }

    private func footer(_ p: PendingPreview) -> some View {
        VStack(alignment: .leading, spacing: Design.Space.s) {
            Text(verbatim: p.summaryLine).font(.caption).foregroundStyle(.secondary)
            Text(verbatim: model.redactionNotice).font(.caption).foregroundStyle(.secondary)
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { model.cancelPreview() }.keyboardShortcut(.cancelAction)
                Button("Send") { Task { await model.confirmPreview() } }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding(Design.Space.l)
    }
}
