import Foundation

public struct RPCErrorBody: Error, Decodable, Sendable, Equatable {
    public let code: Int
    public let message: String
    public let data: JSONValue?
    public init(code: Int, message: String, data: JSONValue?) {
        self.code = code
        self.message = message
        self.data = data
    }
}

public enum Incoming: Sendable, Equatable {
    case response(id: Int, result: Result<JSONValue, RPCErrorBody>)
    case notification(method: String, params: JSONValue)
    /// An error with `id: null` (the daemon could not read our line).
    case orphanError(RPCErrorBody)
}

public enum RPCCodecError: Error, Equatable { case notAMessage }

/// JSON-RPC 2.0, one object per line (M4b "Daemon API"). The app only sends requests.
public enum RPCCodec {
    private struct Request<P: Encodable>: Encodable {
        let jsonrpc = "2.0"
        let id: Int
        let method: String
        let params: P
    }

    private struct Envelope: Decodable {
        let id: JSONValue?
        let method: String?
        let params: JSONValue?
        let hasResult: Bool
        let result: JSONValue?
        let error: RPCErrorBody?

        enum K: String, CodingKey { case jsonrpc, id, method, params, result, error }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: K.self)
            guard try c.decodeIfPresent(String.self, forKey: .jsonrpc) == "2.0" else { throw RPCCodecError.notAMessage }
            id = try c.decodeIfPresent(JSONValue.self, forKey: .id)
            method = try c.decodeIfPresent(String.self, forKey: .method)
            params = try c.decodeIfPresent(JSONValue.self, forKey: .params)
            hasResult = c.contains(.result)
            if hasResult {
                result = try c.decode(JSONValue.self, forKey: .result)
            } else {
                result = nil
            }
            error = try c.decodeIfPresent(RPCErrorBody.self, forKey: .error)
        }
    }

    public static func encodeRequest<P: Encodable>(id: Int, method: String, params: P) throws -> Data {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        var data = try e.encode(Request(id: id, method: method, params: params))
        data.append(0x0A)
        return data
    }

    public static func decode(line: Data) throws -> Incoming {
        let env = try JSONDecoder().decode(Envelope.self, from: line)
        if let method = env.method, env.id == nil {
            return .notification(method: method, params: env.params ?? .null)
        }
        if let err = env.error {
            if case .number(let n)? = env.id { return .response(id: try requestId(n), result: .failure(err)) }
            return .orphanError(err)
        }
        if env.hasResult, case .number(let n)? = env.id {
            return .response(id: try requestId(n), result: .success(env.result ?? .null))
        }
        throw RPCCodecError.notAMessage
    }

    /// Our ids are small integers. A fractional, huge or NaN id is not one of ours (and `Int(n)` would trap on it).
    private static func requestId(_ n: Double) throws -> Int {
        guard let id = Int(exactly: n) else { throw RPCCodecError.notAMessage }
        return id
    }

    public static func value<T: Decodable>(_ v: JSONValue, as type: T.Type) throws -> T {
        try JSONDecoder().decode(T.self, from: JSONEncoder().encode(v))
    }
}
