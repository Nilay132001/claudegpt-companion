import Foundation
import Testing
@testable import CompanionCore

/// SYNTHETIC FIXTURE credentials only.
final class MemoryJiraStore: JiraSecretStore, @unchecked Sendable {
    var item: JiraCredentials?
    var failSave = false
    func load() throws -> JiraCredentials? { item }
    func save(_ c: JiraCredentials) throws {
        if failSave { throw KeychainError.status(-25293) }
        item = c
    }
    func delete() throws { item = nil }
}

let synthetic = JiraCredentials(site: "example-synthetic.atlassian.net", email: "someone@example.invalid", token: "SYNTHETIC-TOKEN-0123456789abcdef")

@MainActor @Suite struct JiraTests {
    @Test func credentialsNeverPrintTheToken() {
        #expect(!String(describing: synthetic).contains(synthetic.token))
        #expect(!String(reflecting: synthetic).contains(synthetic.token))
    }

    @Test func startSendsTheStoredCredentialToTheDaemon() async {
        let d = FakeDaemon()
        let store = MemoryJiraStore()
        store.item = synthetic
        let m = AppModel(connector: { d.connection }, jiraStore: store)
        await m.start()
        #expect(d.jiraConfigured == synthetic)
        #expect(m.jira == JiraStatus(configured: true, site: synthetic.site, email: synthetic.email))
    }

    @Test func noStoredCredentialMeansNoConfigureCall() async {
        let d = FakeDaemon()
        let m = AppModel(connector: { d.connection }, jiraStore: MemoryJiraStore())
        await m.start()
        #expect(!d.calls.contains("jira.configure"))
        #expect(m.jira?.configured == false)
    }

    @Test func saveStoresOnlyAfterTheDaemonAccepts() async {
        let d = FakeDaemon()
        let store = MemoryJiraStore()
        let m = AppModel(connector: { d.connection }, jiraStore: store)
        await m.start()
        d.jiraConfigureError = DaemonError(code: DaemonErrorCode.invalidParams, message: "The Jira site must look like your-team.atlassian.net.")
        await m.saveJira(site: "evil.com", email: synthetic.email, token: synthetic.token)
        #expect(store.item == nil)
        #expect(m.jiraNote == "The Jira site must look like your-team.atlassian.net.")
        d.jiraConfigureError = nil
        await m.saveJira(site: synthetic.site, email: synthetic.email, token: synthetic.token)
        #expect(store.item == synthetic)
        #expect(m.jira?.configured == true)
    }

    @Test func aKeychainFailureUndoesTheDaemonConfigure() async {
        let d = FakeDaemon()
        let store = MemoryJiraStore()
        store.failSave = true
        let m = AppModel(connector: { d.connection }, jiraStore: store)
        await m.start()
        await m.saveJira(site: synthetic.site, email: synthetic.email, token: synthetic.token)
        #expect(d.calls.contains("jira.clear"))
        #expect(m.jira?.configured == false)
        #expect(m.jiraNote?.contains("Keychain") == true)
    }

    @Test func removeDeletesTheItemAndClearsTheDaemon() async {
        let d = FakeDaemon()
        let store = MemoryJiraStore()
        store.item = synthetic
        let m = AppModel(connector: { d.connection }, jiraStore: store)
        await m.start()
        await m.removeJira()
        #expect(store.item == nil)
        #expect(d.calls.contains("jira.clear"))
        #expect(m.jira?.configured == false)
    }

    @Test func checkShowsTheDaemonsDetail() async {
        let d = FakeDaemon()
        let m = AppModel(connector: { d.connection }, jiraStore: MemoryJiraStore())
        await m.start()
        d.jiraCheckResult = JiraCheckResult(ok: false, detail: "Jira refused the token. It needs read:jira-work and read:jira-user.")
        await m.checkJira()
        #expect(m.jiraNote == "Jira refused the token. It needs read:jira-work and read:jira-user.")
    }

    @Test func withoutADaemonEveryActionSaysSo() async {
        let store = MemoryJiraStore()
        store.item = synthetic
        let m = AppModel(connector: { throw DaemonError.stopped }, jiraStore: store)
        await m.saveJira(site: synthetic.site, email: synthetic.email, token: synthetic.token)
        #expect(m.jiraNote == "companiond is not running.")
        m.jiraNote = nil
        await m.checkJira()
        #expect(m.jiraNote == "companiond is not running.")
        m.jiraNote = nil
        await m.removeJira()
        #expect(m.jiraNote == "companiond is not running.")
    }

    @Test func theTokenIsTrimmedBeforeUse() async {
        let d = FakeDaemon()
        let store = MemoryJiraStore()
        let m = AppModel(connector: { d.connection }, jiraStore: store)
        await m.start()
        await m.saveJira(site: synthetic.site, email: synthetic.email, token: " \(synthetic.token)\n")
        #expect(d.jiraConfigured == synthetic)
        #expect(store.item == synthetic)
    }

    /// Opt-in: COMPANION_KEYCHAIN_TESTS=1 runs a real round trip under a separate test service name.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_KEYCHAIN_TESTS"] == "1"))
    func realKeychainRoundTrip() throws {
        let k = KeychainJiraStore(service: "ClaudeGPT Companion Jira (test)")
        try k.delete()
        #expect(try k.load() == nil)
        try k.save(synthetic)
        #expect(try k.load() == synthetic)
        try k.save(JiraCredentials(site: synthetic.site, email: synthetic.email, token: "SYNTHETIC-TOKEN-second-0123456789"))
        #expect(try k.load()?.token == "SYNTHETIC-TOKEN-second-0123456789")
        try k.delete()
        #expect(try k.load() == nil)
    }
}
