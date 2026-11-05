import CompanionCore
import SwiftUI

/// Settings › Jira (owner ruling B). The token field is a SecureField, cleared after Save, and never shown again.
struct JiraSettings: View {
    @Environment(AppModel.self) private var model
    @State private var site = ""
    @State private var email = ""
    @State private var token = ""
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                LabeledContent("Status") { Text(verbatim: statusText) }
                TextField("Site (your-team.atlassian.net)", text: $site)
                TextField("Atlassian account email", text: $email)
                // The token is never read back into the UI: changing the site or email means entering the token again.
                SecureField("API token", text: $token)
                HStack {
                    Button("Save") { run { await model.saveJira(site: site, email: email, token: token); token = "" } }
                        .disabled(busy || site.isEmpty || email.isEmpty || token.isEmpty)
                    Button("Test connection") { run { await model.checkJira() } }.disabled(busy || model.jira?.configured != true)
                    Button("Remove", role: .destructive) { run { await model.removeJira(); token = "" } }.disabled(busy || model.jira?.configured != true)
                }
                if let note = model.jiraNote { Text(verbatim: note).font(.callout) }
            }
            Section("How to make a read-only token") {
                Text("Create a scoped API token at id.atlassian.com › Security › API tokens › Create API token with scopes. Pick the Jira app and only read:jira-work and read:jira-user.")
                Text("GPT can then read issues, JQL searches and comments. It can never create, edit, comment on or move issues.")
                Text("The token stays in your Keychain (item \"ClaudeGPT Companion Jira\"). companiond keeps it in memory; Codex and GPT never see it. Jira text GPT reads is redacted (best effort) and treated as untrusted.")
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
        .onAppear {
            site = model.jira?.site ?? ""
            email = model.jira?.email ?? ""
        }
    }

    private var statusText: String {
        guard let j = model.jira else { return "Unknown" }
        return j.configured ? "Set up for \(j.site ?? "?")" : "Not set up"
    }

    private func run(_ f: @escaping @MainActor () async -> Void) {
        busy = true
        Task { @MainActor in
            await f()
            busy = false
        }
    }
}
