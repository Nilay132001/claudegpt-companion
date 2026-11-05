import CompanionCore
import SwiftUI

struct ApproveSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let root: String
    @State private var includeWorktrees = true
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Let GPT read this repository?").font(.headline)
            Text(root).font(.callout.monospaced()).textSelection(.enabled)
            Text("GPT reads files here only through read-only tools. It cannot change, create or delete files. Secret-looking files (.env, keys, credentials) stay hidden. You can revoke this in Settings › Privacy.")
                .font(.callout)
            Toggle("Also approve this repository's worktrees (Claude Desktop runs each session in its own worktree)", isOn: $includeWorktrees)
            if let error { Text(error).font(.callout).foregroundStyle(.red) }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Approve") {
                    busy = true
                    Task {
                        error = await model.approve(root: root, includeWorktrees: includeWorktrees)
                        busy = false
                        if error == nil { dismiss() }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(busy)
            }
        }
        .padding(20)
        .frame(width: 440)
    }
}
