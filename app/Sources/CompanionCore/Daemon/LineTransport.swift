import Foundation

/// A newline-delimited message pipe to companiond. `lines` yields complete lines without the "\n".
public protocol LineTransport: Sendable {
    var lines: AsyncThrowingStream<Data, any Error> { get }
    func send(_ line: Data) async throws
    func close() async
}

/// Splits a byte stream into lines. Bytes after the last "\n" wait for the next chunk.
public struct LineSplitter: Sendable {
    public static let maxLineBytes = 16 * 1024 * 1024
    public enum Failure: Error, Equatable { case lineTooLong }
    private var buffer = Data()
    public init() {}

    public mutating func push(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var out: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if !line.isEmpty { out.append(line) }
        }
        if buffer.count > Self.maxLineBytes {
            buffer.removeAll()
            throw Failure.lineTooLong
        }
        return out
    }
}

/// companiond as a child process: stdin/stdout pipes, stderr discarded (Global Constraints, ruling 7).
public final class ProcessTransport: LineTransport, @unchecked Sendable {
    // @unchecked: `splitter` is touched only under `lock`; Process and the pipes are thread-safe for this use.
    public let lines: AsyncThrowingStream<Data, any Error>
    private let continuation: AsyncThrowingStream<Data, any Error>.Continuation
    private let process = Process()
    private let stdinPipe = Pipe()
    private let stdoutPipe = Pipe()
    private let writeQueue = DispatchQueue(label: "companion.daemon.stdin")
    private let lock = NSLock()
    private var splitter = LineSplitter()

    public init(launch: DaemonLaunch) throws {
        signal(SIGPIPE, SIG_IGN) // a write to a dead daemon must fail, not kill the app
        let (s, c) = AsyncThrowingStream.makeStream(of: Data.self)
        lines = s
        continuation = c
        process.executableURL = URL(fileURLWithPath: launch.executable)
        process.arguments = launch.arguments
        process.environment = launch.environment
        process.currentDirectoryURL = URL(fileURLWithPath: launch.currentDirectory, isDirectory: true)
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty {
                handle.readabilityHandler = nil
                c.finish()
                return
            }
            self?.consume(chunk)
        }
        try process.run()
    }

    private func consume(_ chunk: Data) {
        lock.lock()
        defer { lock.unlock() }
        do {
            for line in try splitter.push(chunk) { continuation.yield(line) }
        } catch {
            continuation.finish(throwing: error)
        }
    }

    public func send(_ line: Data) async throws {
        let handle = stdinPipe.fileHandleForWriting
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, any Error>) in
            writeQueue.async {
                do {
                    try handle.write(contentsOf: line)
                    c.resume()
                } catch {
                    c.resume(throwing: error)
                }
            }
        }
    }

    /// Closing stdin shuts companiond down (M4b). Wait up to 3 s, then terminate.
    public func close() async {
        try? stdinPipe.fileHandleForWriting.close()
        for _ in 0..<30 where process.isRunning { try? await Task.sleep(for: .milliseconds(100)) }
        if process.isRunning { process.terminate() }
    }
}
