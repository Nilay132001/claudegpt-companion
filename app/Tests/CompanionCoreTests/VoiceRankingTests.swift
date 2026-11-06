import Testing
@testable import CompanionCore

@Suite struct VoiceRankingTests {
    private func v(_ id: String, _ lang: String = "en-US", _ q: VoiceQuality = .standard, novelty: Bool = false, personal: Bool = false) -> VoiceDescriptor {
        VoiceDescriptor(identifier: id, name: id, language: lang, quality: q, isNovelty: novelty, isPersonal: personal)
    }

    @Test func premiumBeatsEnhancedBeatsStandard() {
        let all = [v("a", "en-US", .standard), v("b", "en-US", .enhanced), v("c", "en-US", .premium), v("d", "en-US", .enhanced)]
        #expect(VoiceRanking.best(all, for: "en-US")?.identifier == "c")
        #expect(VoiceRanking.best(Array(all.prefix(2)), for: "en-US")?.identifier == "b")
        #expect(VoiceRanking.candidates(all, for: "en-US").map(\.identifier) == ["c", "b", "d", "a"])
    }
    @Test func noveltyAndPersonalVoicesAreNeverChosen() {
        let all = [v("n", "en-US", .premium, novelty: true), v("p", "en-US", .premium, personal: true), v("ok")]
        #expect(VoiceRanking.best(all, for: "en-US")?.identifier == "ok")
        #expect(VoiceRanking.best([v("n", "en-US", .premium, novelty: true)], for: "en-US") == nil)
    }
    @Test func exactLocaleBeatsSameLanguageAtTheSameQuality() {
        let all = [v("gb", "en-GB", .enhanced), v("us", "en-US", .enhanced), v("fr", "fr-FR", .premium)]
        #expect(VoiceRanking.best(all, for: "en-US")?.identifier == "us")
        #expect(VoiceRanking.best(all, for: "en_GB")?.identifier == "gb")
        #expect(VoiceRanking.best(all, for: "en")?.identifier == "gb")      // no exact match: name order
        #expect(VoiceRanking.candidates(all, for: "en-US").map(\.identifier) == ["us", "gb"])
    }
    @Test func nilWhenNothingFits() {
        #expect(VoiceRanking.best([], for: "en-US") == nil)
        #expect(VoiceRanking.best([v("fr", "fr-FR")], for: "en-US") == nil)
    }
    @Test func tiesBreakByName() {
        #expect(VoiceRanking.best([v("zed"), v("amy")], for: "en-US")?.identifier == "amy")
    }
    @Test func currentVoiceFamiliesBeatRoboticOnesAtTheSameQuality() {
        let all = [v("com.apple.eloquence.en-US.Eddy"), v("com.apple.speech.synthesis.voice.Fred"),
                   v("com.apple.voice.super-compact.en-US.Zed"), v("com.apple.voice.compact.en-US.Samantha")]
        #expect(VoiceRanking.candidates(all, for: "en-US").map(\.identifier).first == "com.apple.voice.compact.en-US.Samantha")
        #expect(VoiceRanking.candidates(all, for: "en-US").map(\.identifier)[1] == "com.apple.voice.super-compact.en-US.Zed")
        // Quality still dominates the family.
        #expect(VoiceRanking.best(all + [v("com.apple.eloquence.en-US.Rocko", "en-US", .enhanced)], for: "en-US")?.identifier == "com.apple.eloquence.en-US.Rocko")
    }
}
