import SwiftUI
import CompanionCore

@main
struct CompanionApp: App {
    var body: some Scene {
        WindowGroup("ClaudeGPT Companion") {
            Text(SpeechText.plainText(fromMarkdown: "**ClaudeGPT Companion** — read-only"))
                .padding()
        }
    }
}
