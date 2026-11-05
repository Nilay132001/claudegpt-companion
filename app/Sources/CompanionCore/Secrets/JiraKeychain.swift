import Foundation
import Security

/// The Jira credential (owner ruling B, M6). The token never leaves this struct except into the app's own Keychain
/// item and the jira.configure call to companiond.
public struct JiraCredentials: Codable, Sendable, Equatable, CustomStringConvertible, CustomDebugStringConvertible {
    public let site: String
    public let email: String
    public let token: String
    public init(site: String, email: String, token: String) {
        self.site = site
        self.email = email
        self.token = token
    }
    public var description: String { "JiraCredentials(site: \(site), email: \(email), token: <hidden>)" }
    public var debugDescription: String { description }
}

public enum KeychainError: Error, Equatable { case status(OSStatus), badData }

public protocol JiraSecretStore: Sendable {
    func load() throws -> JiraCredentials?
    func save(_ c: JiraCredentials) throws
    func delete() throws
}

/// Nothing stored (tests, and before the owner sets Jira up).
public struct NoJiraStore: JiraSecretStore {
    public init() {}
    public func load() throws -> JiraCredentials? { nil }
    public func save(_ c: JiraCredentials) throws {}
    public func delete() throws {}
}

/// One generic-password item that belongs to this app only: service "ClaudeGPT Companion Jira", account "jira".
/// It never reads, writes or deletes any other item.
public struct KeychainJiraStore: JiraSecretStore {
    public static let service = "ClaudeGPT Companion Jira"
    let service: String
    let account = "jira"
    public init(service: String = KeychainJiraStore.service) { self.service = service }

    private var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    public func load() throws -> JiraCredentials? {
        var q = base
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let s = SecItemCopyMatching(q as CFDictionary, &out)
        if s == errSecItemNotFound { return nil }
        guard s == errSecSuccess else { throw KeychainError.status(s) }
        guard let data = out as? Data, let c = try? JSONDecoder().decode(JiraCredentials.self, from: data) else { throw KeychainError.badData }
        return c
    }

    public func save(_ c: JiraCredentials) throws {
        let data = try JSONEncoder().encode(c)
        let update = SecItemUpdate(base as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError.status(update) }
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        add[kSecAttrLabel as String] = "ClaudeGPT Companion — Jira (read-only)"
        let s = SecItemAdd(add as CFDictionary, nil)
        guard s == errSecSuccess else { throw KeychainError.status(s) }
    }

    public func delete() throws {
        let s = SecItemDelete(base as CFDictionary)
        guard s == errSecSuccess || s == errSecItemNotFound else { throw KeychainError.status(s) }
    }
}
