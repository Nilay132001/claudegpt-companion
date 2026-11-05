import CompanionCore
import SwiftUI

struct PickerView: View {
    @Environment(AppModel.self) private var model
    let close: () -> Void
    @State private var query = ""
    @State private var groups: PickerGroups?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Search sessions", text: $query).textFieldStyle(.roundedBorder)
            Button("Follow Claude's focused session") { Task { await model.followFocus(); close() } }.buttonStyle(.link)
            Group {
                if groups == nil {
                    VStack(spacing: Design.Space.s) {
                        ProgressView().controlSize(.small)
                        Text("Loading sessions…").font(.callout).foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        section("Busy", groups?.busy)
                        section("Idle", groups?.idle)
                        section("Recent", groups?.recent)
                        if !query.isEmpty { section("Older", groups?.older) }
                    }
                }
            }
            .frame(width: 320, height: 380)
        }
        .padding(10)
        .task(id: query) {
            try? await Task.sleep(for: .milliseconds(200))
            groups = await model.picker(query: query)
        }
    }

    @ViewBuilder private func section(_ title: String, _ items: [SessionSummary]?) -> some View {
        if let items, !items.isEmpty {
            Section(title) {
                ForEach(items) { s in
                    Button {
                        Task { await model.pin(s.sessionId); close() }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: s.title).lineLimit(1)
                            Text(verbatim: s.locationLine).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}
