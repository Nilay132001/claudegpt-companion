import CompanionCore
import SwiftUI

/// Ask mode (spec §4.3, §7.5): the exact items, each removable. Nothing is sent until Send.
struct PreviewSheet: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let p = model.preview {
            VStack(alignment: .leading, spacing: 10) {
                Text("Check what GPT will see").font(.headline)
                if let notice = p.notice { Text(notice).font(.callout).foregroundStyle(.orange) }
                if let title = p.prepared.sessionTitle { Text("Claude session: " + title).font(.callout).textSelection(.enabled) }
                Text(p.prepared.repo.summary).font(.callout)
                if let note = p.prepared.repoNote { Text(note).font(.callout) }
                ForEach(p.prepared.preview?.notes ?? [], id: \.self) { note in
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                List {
                    ForEach(p.prepared.preview?.items ?? []) { item in
                        Toggle(isOn: Binding(get: { !p.removed.contains(item.id) }, set: { _ in model.toggle(itemId: item.id) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack {
                                    Text(item.label).font(.caption.bold())
                                    if item.redactions > 0 { Text("\(item.redactions) masked").font(.caption2).foregroundStyle(.orange) }
                                }
                                Text(item.text).font(.system(.caption, design: .monospaced)).textSelection(.enabled).lineLimit(8)
                            }
                        }
                    }
                }
                .frame(minHeight: 240)
                Text(p.summaryLine).font(.caption).foregroundStyle(.secondary)
                Text("Your question: " + p.question).font(.caption).lineLimit(2)
                Text(model.redactionNotice).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Spacer()
                    Button("Cancel", role: .cancel) { model.cancelPreview() }.keyboardShortcut(.cancelAction)
                    Button("Send") { Task { await model.confirmPreview() } }.keyboardShortcut(.defaultAction)
                }
            }
            .padding(16)
            .frame(width: 520, height: 580)
        }
    }
}
