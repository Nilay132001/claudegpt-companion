import Foundation
import Synchronization
import Testing
@testable import CompanionCore

/// In-memory transport: records what the client wrote; the test pushes daemon lines.
final class MemoryTransport: LineTransport {
    let lines: AsyncThrowingStream<Data, any Error>
    private let input: AsyncThrowingStream<Data, any Error>.Continuation
    private let written = Mutex<[JSONValue]>([])
    private let closed = Mutex(false)

    init() {
        let (s, c) = AsyncThrowingStream.makeStream(of: Data.self)
        lines = s
        input = c
    }
    func send(_ line: Data) async throws {
        if closed.withLock({ $0 }) { throw DaemonError.stopped }
        let v = try JSONDecoder().decode(JSONValue.self, from: line)
        written.withLock { $0.append(v) }
    }
    func close() async { closed.withLock { $0 = true }; input.finish() }

    func push(_ s: String) { input.yield(Data(s.utf8)) }
    func end() { input.finish() }
    var requests: [JSONValue] { written.withLock { $0 } }

    /// Waits until the client has written n requests.
    func waitForRequests(_ n: Int) async throws {
        for _ in 0..<200 where requests.count < n { try await Task.sleep(for: .milliseconds(5)) }
        #expect(requests.count >= n)
    }
}

@Suite struct DaemonClientTests {
    @Test func correlatesResponsesByIdOutOfOrder() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        async let host = client.hostStatus()
        async let privacy = client.privacyGet()
        try await t.waitForRequests(2)
        let ids = t.requests.compactMap { r -> (String, Int)? in
            guard case .string(let m)? = r["method"], case .number(let n)? = r["id"] else { return nil }
            return (m, Int(n))
        }
        let byMethod = Dictionary(uniqueKeysWithValues: ids)
        t.push(#"{"jsonrpc":"2.0","id":\#(byMethod["privacy.get"]!),"result":{"sharingMode":"ask","approvals":[],"redactionNotice":"Redaction reduces risk; it does not guarantee every secret is removed."}}"#)
        t.push(#"{"jsonrpc":"2.0","id":\#(byMethod["host.status"]!),"result":{"state":"starting"}}"#)
        #expect(try await host == .starting)
        #expect(try await privacy.sharingMode == .ask)
    }

    @Test func sendsTheExactParams() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        async let r = client.chatSend(prepareId: "p1", removeItemIds: ["item-2"], confirmed: true)
        try await t.waitForRequests(1)
        let req = t.requests[0]
        #expect(req["method"] == .string("chat.send"))
        #expect(req["params"] == .object(["prepareId": .string("p1"), "removeItemIds": .array([.string("item-2")]), "confirmed": .bool(true)]))
        t.push(#"{"jsonrpc":"2.0","id":1,"result":{"threadId":"t1","turnId":"u1"}}"#)
        #expect(try await r == SendResult(threadId: "t1", turnId: "u1"))

        async let pin = client.sessionsPin(nil)
        try await t.waitForRequests(2)
        #expect(t.requests[1]["params"] == .object(["sessionId": .null]))
        t.push(#"{"jsonrpc":"2.0","id":2,"result":{"sessionId":null,"via":"none","focusedSessionId":null,"focusLabel":"Claude focus (from Claude's records)","focusMovedTo":null,"pinnedMissing":false}}"#)
        #expect(try await pin.via == "none")
    }

    @Test func mapsErrors() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let r = Task { try await client.privacyApprove(root: "/", includeWorktrees: true) }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","id":1,"error":{"code":1006,"message":"Your home folder or / cannot be approved.","data":{"reason":"home_or_root"}}}"#)
        await #expect(throws: DaemonError(code: 1006, message: "Your home folder or / cannot be approved.", data: .object(["reason": .string("home_or_root")]))) { try await r.value }
    }

    @Test func notificationsBecomeEventsAndEndOfStreamFailsPendingCalls() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let pending = Task { try await client.hostStatus() }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","method":"host.changed","params":{"state":"ready","warnings":[]}}"#)
        t.push("not json at all")
        t.end()
        await #expect(throws: DaemonError.stopped) { try await pending.value }
        var got: [DaemonEvent] = []
        for await e in client.events { got.append(e) }
        #expect(got == [.hostChanged(.ready(warnings: [])), .disconnected])
        await #expect(throws: DaemonError.stopped) { try await client.hostStatus() }
    }

    @Test func refusesANonHttpsSignInLink() async throws {
        let t = MemoryTransport()
        let client = DaemonClient(transport: t)
        await client.start()
        let url = Task { try await client.authLogin() }
        try await t.waitForRequests(1)
        t.push(#"{"jsonrpc":"2.0","id":1,"result":{"authUrl":"http://example.invalid/login"}}"#)
        await #expect(throws: DaemonError.self) { try await url.value }
    }

    @Test func clipsByUTF16Units() {
        #expect(DaemonLimits.clip("abc", utf16: 5) == "abc")
        #expect(DaemonLimits.clip("😀😀😀", utf16: 5) == "😀😀") // each emoji is 2 UTF-16 units
        #expect(DaemonLimits.clip(String(repeating: "x", count: 300), utf16: DaemonLimits.queryUTF16).utf16.count == 200)
    }

    @Test func lineSplitterHandlesPartsAndCaps() throws {
        var s = LineSplitter()
        #expect(try s.push(Data("{\"a\":".utf8)).isEmpty)
        #expect(try s.push(Data("1}\n\n{\"b\":2}\n{\"c\"".utf8)).map { String(decoding: $0, as: UTF8.self) } == ["{\"a\":1}", "{\"b\":2}"])
        #expect(try s.push(Data(":3}\n".utf8)).map { String(decoding: $0, as: UTF8.self) } == ["{\"c\":3}"])
        var big = LineSplitter()
        #expect(throws: LineSplitter.Failure.lineTooLong) { try big.push(Data(count: LineSplitter.maxLineBytes + 1)) }
    }

    /// An over-long line ends the stream and stops the child: "disconnected" must match reality.
    @Test func anOverLongLineStopsTheChildProcess() async throws {
        let launch = DaemonLaunch(executable: "/bin/sh",
                                  arguments: ["-c", "head -c \(LineSplitter.maxLineBytes + 1024) /dev/zero; exec sleep 30"],
                                  environment: [:], currentDirectory: "/")
        let t = try ProcessTransport(launch: launch)
        await #expect(throws: LineSplitter.Failure.lineTooLong) { for try await _ in t.lines {} }
        for _ in 0..<50 where t.isRunning { try await Task.sleep(for: .milliseconds(100)) }
        #expect(!t.isRunning)
        await t.close()
    }
}
