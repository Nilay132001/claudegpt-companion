import Foundation
import Testing
@testable import CompanionCore

@Suite struct RPCCodecTests {
    private func line(_ s: String) -> Data { Data(s.utf8) }

    @Test func encodesOneLineRequest() throws {
        let data = try RPCCodec.encodeRequest(id: 7, method: "chat.prepare",
            params: JSONValue.object(["sessionId": .string("s1"), "question": .string("why?\nreally")]))
        let text = String(decoding: data, as: UTF8.self)
        #expect(text.hasSuffix("\n"))
        #expect(text.dropLast().contains("\n") == false)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(back["jsonrpc"] == .string("2.0"))
        #expect(back["id"] == .number(7))
        #expect(back["method"] == .string("chat.prepare"))
        #expect(back["params"]?["question"] == .string("why?\nreally"))
    }

    @Test func decodesResultIncludingNull() throws {
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":1,"result":{"a":1}}"#))
            == .response(id: 1, result: .success(.object(["a": .number(1)]))))
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":2,"result":null}"#))
            == .response(id: 2, result: .success(.null)))
    }

    @Test func decodesErrorsWithData() throws {
        let m = try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":3,"error":{"code":1006,"message":"no","data":{"reason":"missing"}}}"#))
        guard case let .response(3, .failure(e)) = m else { Issue.record("not an error response"); return }
        #expect(e.code == 1006)
        #expect(e.data?["reason"]?.stringValue == "missing")
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}"#))
            == .orphanError(RPCErrorBody(code: -32700, message: "Parse error", data: nil)))
    }

    @Test func decodesNotifications() throws {
        #expect(try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0","method":"host.changed","params":{"state":"starting"}}"#))
            == .notification(method: "host.changed", params: .object(["state": .string("starting")])))
    }

    @Test func rejectsGarbage() {
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line("{nope")) }
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line(#"{"jsonrpc":"2.0"}"#)) }
        #expect(throws: (any Error).self) { try RPCCodec.decode(line: line(#"[1,2]"#)) }
    }

    @Test func typedValues() throws {
        struct P: Decodable, Equatable { let x: Int; let y: String? }
        #expect(try RPCCodec.value(.object(["x": .number(2), "y": .null]), as: P.self) == P(x: 2, y: nil))
        #expect(try RPCCodec.value(.null, as: P?.self) == nil)
    }

    @Test func redactionNoticeIsTheSpecSentence() {
        #expect(RedactionNotice.text == "Redaction reduces risk; it does not guarantee every secret is removed.")
    }
}
