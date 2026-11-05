import Foundation

/// Jira settings (owner ruling B). The Keychain item is the only place the token is kept. companiond gets it at
/// every start and keeps it in memory. Errors show fixed texts, never the token.
extension AppModel {
    func loadJira(_ api: any DaemonAPI) async {
        do {
            if let c = try jiraStore.load() {
                jira = try await api.jiraConfigure(c)
            } else {
                jira = try await api.jiraStatus()
            }
        } catch let e as DaemonError {
            jira = try? await api.jiraStatus()
            jiraNote = e.message
        } catch {
            jira = try? await api.jiraStatus()
            jiraNote = "The Jira token could not be read from the Keychain."
        }
    }

    public func saveJira(site: String, email: String, token: String) async {
        guard let api = currentAPI else { return }
        let c = JiraCredentials(site: site.trimmingCharacters(in: .whitespacesAndNewlines), email: email.trimmingCharacters(in: .whitespacesAndNewlines), token: token)
        do {
            jira = try await api.jiraConfigure(c)
        } catch let e as DaemonError {
            jiraNote = e.message
            return
        } catch {
            jiraNote = "Jira could not be set up."
            return
        }
        do {
            try jiraStore.save(c)
            jiraNote = "Saved. Use Test connection to check it."
        } catch {
            jira = try? await api.jiraClear()
            jiraNote = "The token could not be saved in the Keychain, so Jira stays off."
        }
    }

    public func removeJira() async {
        var failed = false
        do { try jiraStore.delete() } catch { failed = true }
        if let api = currentAPI { jira = try? await api.jiraClear() }
        jiraNote = failed ? "The Keychain item could not be removed." : "Jira removed."
    }

    public func checkJira() async {
        guard let api = currentAPI else { return }
        jiraNote = "Checking…"
        do { jiraNote = try await api.jiraCheck().detail } catch let e as DaemonError { jiraNote = e.message } catch { jiraNote = "Jira could not be checked." }
    }
}
