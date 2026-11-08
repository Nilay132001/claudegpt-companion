import AVFoundation
import Foundation

public enum VoiceQuality: Int, Comparable, Sendable, CaseIterable {
    case standard = 0, enhanced = 1, premium = 2
    public static func < (a: VoiceQuality, b: VoiceQuality) -> Bool { a.rawValue < b.rawValue }
    public var title: String {
        switch self {
        case .standard: "Standard"
        case .enhanced: "Enhanced"
        case .premium: "Premium"
        }
    }
}

/// What the ranking needs to know about one installed voice (built from AVSpeechSynthesisVoice; plain data for tests).
public struct VoiceDescriptor: Equatable, Sendable {
    public var identifier: String
    public var name: String
    public var language: String
    public var quality: VoiceQuality
    public var isNovelty: Bool
    public var isPersonal: Bool

    public init(identifier: String, name: String, language: String, quality: VoiceQuality = .standard,
                isNovelty: Bool = false, isPersonal: Bool = false) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.quality = quality
        self.isNovelty = isNovelty
        self.isPersonal = isPersonal
    }

    public init(_ v: AVSpeechSynthesisVoice) {
        let q: VoiceQuality
        switch v.quality {
        case .premium: q = .premium
        case .enhanced: q = .enhanced
        default: q = .standard
        }
        self.init(identifier: v.identifier, name: v.name, language: v.language, quality: q,
                  isNovelty: v.voiceTraits.contains(.isNoveltyVoice), isPersonal: v.voiceTraits.contains(.isPersonalVoice))
    }

    /// Every voice installed on this Mac.
    public static func installed() -> [VoiceDescriptor] {
        AVSpeechSynthesisVoice.speechVoices().map(VoiceDescriptor.init)
    }
}

/// Picks the voice that sounds best. Quality first (Premium, Enhanced, Standard), then the voice family (Apple's
/// current neural-era voices before the robotic Eloquence and legacy formant voices that are only Standard in name),
/// then an exact locale match (en-US for en-US) before another region of the same language, then name for a stable order.
/// Novelty voices and Personal Voices are never chosen.
public enum VoiceRanking {
    /// "en_US", "en-US" and "en" all work; the result is lowercase "en" / "en-us".
    static func normalized(_ code: String) -> String { code.replacingOccurrences(of: "_", with: "-").lowercased() }
    static func languagePart(_ code: String) -> String { String(normalized(code).prefix { $0 != "-" }) }

    /// 0 current voices (com.apple.voice.compact/enhanced/premium), 1 super-compact, 2 Eloquence and legacy voices.
    static func family(_ v: VoiceDescriptor) -> Int {
        if v.identifier.hasPrefix("com.apple.voice.super-compact.") { return 1 }
        return v.identifier.hasPrefix("com.apple.voice.") ? 0 : 2
    }

    /// The voices a person may choose for this language, best first.
    public static func candidates(_ voices: [VoiceDescriptor], for languageCode: String) -> [VoiceDescriptor] {
        let lang = languagePart(languageCode), exact = normalized(languageCode)
        return voices
            .filter { !$0.isNovelty && !$0.isPersonal && languagePart($0.language) == lang }
            .sorted { a, b in
                if a.quality != b.quality { return a.quality > b.quality }
                if family(a) != family(b) { return family(a) < family(b) }
                let ea = normalized(a.language) == exact, eb = normalized(b.language) == exact
                if ea != eb { return ea }
                if a.name != b.name { return a.name < b.name }
                return a.identifier < b.identifier
            }
    }

    public static func best(_ voices: [VoiceDescriptor], for languageCode: String) -> VoiceDescriptor? {
        candidates(voices, for: languageCode).first
    }

    public static func best(for languageCode: String) -> VoiceDescriptor? {
        best(VoiceDescriptor.installed(), for: languageCode)
    }

    /// The first preferred language as "en-GB" (language and region, no script or regional-format override).
    public static var currentLanguageCode: String {
        let l = Locale(identifier: Locale.preferredLanguages.first ?? "en-US").language
        guard let code = l.languageCode?.identifier else { return "en-US" }
        return l.region.map { code + "-" + $0.identifier } ?? code
    }
}
