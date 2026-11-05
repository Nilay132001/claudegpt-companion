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
