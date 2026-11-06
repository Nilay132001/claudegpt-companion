import CompanionCore
import SwiftUI

@main
struct CompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        Settings {
            SettingsView()
                .environment(delegate.model)
                .environment(delegate.readAloud)
                .environment(delegate.dictation)
                .environment(delegate.windowStatus)
        }
        .commands {
            CommandGroup(after: .sidebar) {
                Button("Show or Hide Panel") { delegate.window.toggle() }
                Button("Refresh Sessions") { Task { await delegate.model.refresh() } }
                    .keyboardShortcut("r", modifiers: .command)
            }
            CommandGroup(replacing: .newItem) {
                Button("New Chat") { Task { await delegate.model.newChat() } }
                    .keyboardShortcut("k", modifiers: .command)
                    .disabled(delegate.model.gate != .ready || delegate.model.isAnswering)
            }
            CommandGroup(after: .pasteboard) {
                Button("Copy Conversation") { Design.copy(delegate.model.conversationMarkdown(includeContext: false)) }
                    .keyboardShortcut("c", modifiers: [.command, .shift])
                    .disabled(delegate.model.currentMessages.isEmpty && delegate.model.pastChat == nil)
            }
        }
    }
}
