import Foundation
import Testing
@testable import CompanionCore

/// Spawns the real companiond (M4b Task 7) with chat off and a fresh HOME, like M4b's main.test.ts.
/// Turns itself on when the daemon entry point exists and Node >= 24 is found (ruling 11).
enum DaemonITest {
    static let companiond = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "companiond").path
    static let node: String? = try? DaemonLocator.findNode(
        candidates: DaemonLocator.nodeCandidates(env: ProcessInfo.processInfo.environment, bundled: nil, configured: nil),
        isExecutable: FileManager.default.isExecutableFile(atPath:),
        version: DaemonLocator.runVersion).get()
    static var available: Bool {
        node != nil && FileManager.default.fileExists(atPath: companiond + "/src/daemon/main.ts")
            && FileManager.default.fileExists(atPath: companiond + "/node_modules")
    }
}

@Suite(.serialized) struct DaemonIntegrationTests {
    @Test(.enabled(if: DaemonITest.available), .timeLimit(.minutes(1)))
    func answersOverStdioThenShutsDown() async throws {
        let home = FileManager.default.temporaryDirectory.appending(path: "companion-itest-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: home) }
        let env = ["HOME": home.path, "COMPANIOND_CODEX": "off", "TMPDIR": FileManager.default.temporaryDirectory.path]
        let launch = DaemonLocator.launch(node: DaemonITest.node!, daemonDir: DaemonITest.companiond, env: env)
        let client = DaemonClient(transport: try ProcessTransport(launch: launch))
        await client.start()

        #expect(try await client.hello().protocolVersion == 1)
        #expect(try await client.hostStatus() == .failed(detail: "Chat is off (COMPANIOND_CODEX=off)."))
        #expect(try await client.sessionsRefresh().desktopRecordsError == "Claude Desktop sessions not found")
        #expect(try await client.privacyGet().sharingMode == .ask)
        #expect(try await client.privacyGet().redactionNotice == RedactionNotice.text)
        try await client.settingsSet("ui.speech.rate", "1.5")
        #expect(try await client.settingsGet("ui.speech.rate") == "1.5")
        await #expect(throws: DaemonError.self) { try await client.settingsSet("ui.speech.autoPlay", "true") } // Store keys are lowercase
        for (k, v) in UISettings().values {
            try await client.settingsSet(k, v)
            #expect(try await client.settingsGet(k) == v, "\(k)")
        }
        // Jira: status, configure, clear. No jira.check (it would use the network). SYNTHETIC FIXTURE credentials.
        #expect(try await client.jiraStatus().configured == false)
        #expect(try await client.jiraConfigure(synthetic) == JiraStatus(configured: true, site: synthetic.site, email: synthetic.email))
        #expect(try await client.jiraClear().configured == false)
        try await client.shutdown()
        var sawDisconnect = false
        for await e in client.events where e == .disconnected { sawDisconnect = true }
        #expect(sawDisconnect)
        let support = home.appending(path: "Library/Application Support/ClaudeGPTCompanion").path
        let mode = try FileManager.default.attributesOfItem(atPath: support)[.posixPermissions] as? Int
        #expect(mode == 0o700)
    }
}
