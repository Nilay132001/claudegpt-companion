import CompanionCore
import SwiftUI

struct SentSheet: View {
    @Environment(\.dismiss) private var dismiss
    let view: SentView

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What was sent to GPT").font(.headline)
            switch view {
            case .found(let r):
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Question").font(.caption.bold())
                        Text(r.question).textSelection(.enabled)
                        Text("Context").font(.caption.bold())
                        Text(r.contextBlock.isEmpty ? "(no context)" : r.contextBlock)
                            .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            case .notKept:
                Text("companiond keeps this only until it restarts, and it has restarted since. The same text is in the Codex thread history.")
                    .font(.callout)
            }
            HStack { Spacer(); Button("Close") { dismiss() }.keyboardShortcut(.defaultAction) }
        }
        .padding(16)
        .frame(width: 520, height: 480)
    }
}
