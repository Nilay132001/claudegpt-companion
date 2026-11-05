import Foundation

public enum EditorChoice: String, CaseIterable, Sendable {
    case auto, vscode, cursor, xcode, system
    public var title: String {
        switch self {
        case .auto: "Automatic (VS Code if installed)"
        case .vscode: "Visual Studio Code"
        case .cursor: "Cursor"
        case .xcode: "Xcode"
        case .system: "Default app for the file"
        }
    }
}

/// Keys in the daemon Store (`settings.get/set`). The Store accepts only `^ui\.[a-z0-9_.]{1,64}$` (lowercase).
public enum UIKey {
    public static let speechRate = "ui.speech.rate"
    public static let voice = "ui.speech.voice"
    public static let autoPlay = "ui.speech.autoplay"
    public static let readCode = "ui.speech.read_code"
    public static let follow = "ui.window.follow"
    public static let width = "ui.window.width"
    public static let hotkey = "ui.hotkey"
    public static let editor = "ui.editor"
    public static let all = [speechRate, voice, autoPlay, readCode, follow, width, hotkey, editor]
}

public struct UISettings: Equatable, Sendable {
    public var speechRate = 1.0
    public var voiceIdentifier: String? = nil
    public var autoPlay = false
    public var readCode = false
    public var followClaude = false
    public var panelWidth = 360.0
    public var hotkey = HotkeySpec.default
    public var editor = EditorChoice.auto

    public init() {}

    /// Reads every key; anything missing, unreadable or malformed keeps its default.
    public static func load(_ get: @Sendable (String) async throws -> String?) async -> UISettings {
        var s = UISettings()
        func read(_ k: String) async -> String? { (try? await get(k)) ?? nil }
        func finite(_ k: String) async -> Double? { await read(k).flatMap(Double.init).flatMap { $0.isFinite ? $0 : nil } }
        if let v = await finite(UIKey.speechRate) { s.speechRate = min(max(v, 0.5), 2.0) }
        if let v = await read(UIKey.voice), !v.isEmpty { s.voiceIdentifier = v }
        if let v = await read(UIKey.autoPlay) { s.autoPlay = v == "true" }
        if let v = await read(UIKey.readCode) { s.readCode = v == "true" }
        if let v = await read(UIKey.follow) { s.followClaude = v == "true" }
        if let v = await finite(UIKey.width) { s.panelWidth = Double(PanelGeometry.clampWidth(v)) }
        if let v = await read(UIKey.hotkey).flatMap(HotkeySpec.init(string:)) { s.hotkey = v }
        if let v = await read(UIKey.editor).flatMap(EditorChoice.init(rawValue:)) { s.editor = v }
        return s
    }

    public var values: [String: String] {
        [UIKey.speechRate: String(speechRate), UIKey.voice: voiceIdentifier ?? "", UIKey.autoPlay: String(autoPlay),
         UIKey.readCode: String(readCode), UIKey.follow: String(followClaude), UIKey.width: String(Int(panelWidth)),
         UIKey.hotkey: hotkey.string, UIKey.editor: editor.rawValue]
    }

    public func changes(from old: UISettings) -> [(key: String, value: String)] {
        let a = old.values
        return values.filter { a[$0.key] != $0.value }.sorted { $0.key < $1.key }.map { (key: $0.key, value: $0.value) }
    }
}
