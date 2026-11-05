import Foundation

public struct DaemonLaunch: Equatable, Sendable {
    public let executable: String
    public let arguments: [String]
    public let environment: [String: String]
    public let currentDirectory: String
}

public enum DaemonLaunchError: Error, LocalizedError, Equatable {
    case nodeNotFound, daemonNotFound
    public var errorDescription: String? {
        switch self {
        case .nodeNotFound: "Node.js 24 or newer was not found. The app's own Node.js is missing or broken: rebuild it with scripts/build-app.sh, or set a path in Settings › Advanced."
        case .daemonNotFound: "companiond was not found in the app bundle. Rebuild the app with scripts/build-app.sh, or set COMPANIOND_DIR."
        }
    }
}

/// Finds Node and companiond and builds the child-process launch (ruling 1, ruling 7).
public enum DaemonLocator {
    public static let minimumNodeMajor = 24
    static let passedEnv = ["HOME", "USER", "LOGNAME", "TMPDIR", "COMPANIOND_CODEX"]

    /// Ruling R5 (M7): `COMPANION_NODE`, the bundled Node, the Settings › Advanced path, then the system paths.
    /// The bundled Node comes before the setting so an older stored path does not shadow it.
    public static func nodeCandidates(env: [String: String], bundled: String?, configured: String?) -> [String] {
        var out: [String] = []
        if let p = env["COMPANION_NODE"], !p.isEmpty { out.append(p) }
        if let p = bundled, !p.isEmpty { out.append(p) }
        if let p = configured, !p.isEmpty { out.append(p) }
        out += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return out
    }

    /// The official Node.js that scripts/build-app.sh puts into the bundle.
    public static func bundledNode(resourceURL: URL?) -> String? {
        resourceURL?.appending(path: "node/bin/node").path
    }

    public static func nodeMajor(_ versionOutput: String) -> Int? {
        let t = versionOutput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.hasPrefix("v"), let first = t.dropFirst().split(separator: ".").first else { return nil }
        return Int(first)
    }

    public static func findNode(candidates: [String], isExecutable: (String) -> Bool, version: (String) -> String?) -> Result<String, DaemonLaunchError> {
        for c in candidates where isExecutable(c) {
            if let v = version(c), let major = nodeMajor(v), major >= minimumNodeMajor { return .success(c) }
        }
        return .failure(.nodeNotFound)
    }

    /// `node --version`, at most 5 s. The path is one of our own candidates, never user text from a page.
    public static func runVersion(_ node: String) -> String? {
        let p = Process()
        let out = Pipe()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["--version"]
        p.environment = ["PATH": "/usr/bin:/bin"]
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return nil }
        let deadline = Date().addingTimeInterval(5)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate(); return nil }
        return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)
    }

    public static func daemonDirectory(env: [String: String], resourceURL: URL?, fileExists: (String) -> Bool) -> Result<String, DaemonLaunchError> {
        var dirs: [String] = []
        if let d = env["COMPANIOND_DIR"], !d.isEmpty { dirs.append(d) }
        if let r = resourceURL { dirs.append(r.appending(path: "companiond").path) }
        for d in dirs where fileExists(d + "/src/daemon/main.ts") { return .success(d) }
        return .failure(.daemonNotFound)
    }

    public static func launch(node: String, daemonDir: String, env: [String: String]) -> DaemonLaunch {
        var e = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin"]
        for k in passedEnv { if let v = env[k] { e[k] = v } }
        return DaemonLaunch(executable: node,
                            arguments: ["--disable-warning=ExperimentalWarning", daemonDir + "/src/daemon/main.ts"],
                            environment: e, currentDirectory: daemonDir)
    }

    /// The production connector. `configuredNode` is read at every (re)connect.
    public static func live(env: [String: String], configuredNode: @escaping @Sendable () -> String?, resourceURL: URL?) -> Connector {
        return {
            let node = try findNode(candidates: nodeCandidates(env: env, bundled: bundledNode(resourceURL: resourceURL), configured: configuredNode()),
                                    isExecutable: FileManager.default.isExecutableFile(atPath:), version: runVersion).get()
            let dir = try daemonDirectory(env: env, resourceURL: resourceURL, fileExists: FileManager.default.fileExists(atPath:)).get()
            let client = DaemonClient(transport: try ProcessTransport(launch: launch(node: node, daemonDir: dir, env: env)))
            await client.start()
            return Connection(api: client, events: client.events, close: { await client.close() })
        }
    }
}
