import Foundation
import Testing
@testable import CompanionCore

@Suite struct DaemonLocatorTests {
    @Test func nodeCandidatesInOrder() {
        #expect(DaemonLocator.nodeCandidates(env: ["COMPANION_NODE": "/x/node"], configured: "/y/node")
            == ["/x/node", "/y/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"])
        #expect(DaemonLocator.nodeCandidates(env: [:], configured: "") == ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
    }

    @Test func parsesNodeVersions() {
        #expect(DaemonLocator.nodeMajor("v24.3.0\n") == 24)
        #expect(DaemonLocator.nodeMajor("v26.7.0") == 26)
        #expect(DaemonLocator.nodeMajor("24.3.0") == nil)
        #expect(DaemonLocator.nodeMajor("") == nil)
    }

    @Test func picksTheFirstNewEnoughNode() {
        let versions = ["/a": "v22.1.0", "/b": "v24.0.0", "/c": "v26.0.0"]
        let r = DaemonLocator.findNode(candidates: ["/missing", "/a", "/b", "/c"], isExecutable: { versions[$0] != nil }, version: { versions[$0] })
        #expect(r == .success("/b"))
        #expect(DaemonLocator.findNode(candidates: ["/a"], isExecutable: { _ in true }, version: { versions[$0] })
            == .failure(.nodeNotFound))
    }

    @Test func findsTheDaemonFolder() {
        let have: Set<String> = ["/dev/companiond/src/daemon/main.ts", "/App.app/Contents/Resources/companiond/src/daemon/main.ts"]
        #expect(DaemonLocator.daemonDirectory(env: ["COMPANIOND_DIR": "/dev/companiond"], resourceURL: URL(fileURLWithPath: "/App.app/Contents/Resources"), fileExists: have.contains)
            == .success("/dev/companiond"))
        #expect(DaemonLocator.daemonDirectory(env: [:], resourceURL: URL(fileURLWithPath: "/App.app/Contents/Resources"), fileExists: have.contains)
            == .success("/App.app/Contents/Resources/companiond"))
        #expect(DaemonLocator.daemonDirectory(env: [:], resourceURL: nil, fileExists: have.contains) == .failure(.daemonNotFound))
    }

    @Test func launchPassesOnlyTheMinimalEnvironment() {
        let env = ["HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t/", "PATH": "/evil", "OPENAI_API_KEY": "SYNTHETIC FIXTURE not-a-key", "COMPANIOND_CODEX": "off"]
        let l = DaemonLocator.launch(node: "/n/node", daemonDir: "/d", env: env)
        #expect(l.executable == "/n/node")
        #expect(l.arguments == ["--disable-warning=ExperimentalWarning", "/d/src/daemon/main.ts"])
        #expect(l.environment == ["HOME": "/h", "USER": "u", "LOGNAME": "u", "TMPDIR": "/t/", "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "COMPANIOND_CODEX": "off"])
        #expect(l.currentDirectory == "/d")
    }
}
