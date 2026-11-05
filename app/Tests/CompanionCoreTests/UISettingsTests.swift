import Testing
@testable import CompanionCore

@Suite struct UISettingsTests {
    @Test func defaults() {
        let s = UISettings()
        #expect(s.speechRate == 1.0 && s.voiceIdentifier == nil && !s.autoPlay && !s.readCode && !s.followClaude)
        #expect(s.panelWidth == 360 && s.hotkey == .default && s.editor == .auto)
    }

    @Test func loadsAndClampsStoredValues() async {
        let stored = ["ui.speech.rate": "3", "ui.speech.voice": "com.apple.voice.x", "ui.speech.autoplay": "true",
                      "ui.window.width": "100", "ui.hotkey": "ctrl+opt+K", "ui.editor": "cursor", "ui.window.follow": "nonsense"]
        let s = await UISettings.load { stored[$0] }
        #expect(s.speechRate == 2.0)
        #expect(s.voiceIdentifier == "com.apple.voice.x")
        #expect(s.autoPlay)
        #expect(s.panelWidth == 280)
        #expect(s.hotkey == HotkeySpec(key: "K", control: true, option: true))
        #expect(s.editor == .cursor)
        #expect(!s.followClaude)
    }

    @Test func aFailingStoreGivesDefaults() async {
        struct Boom: Error {}
        #expect(await UISettings.load { _ in throw Boom() } == UISettings())
    }

    @Test func changesListOnlyWhatDiffers() {
        var s = UISettings()
        let old = s
        s.speechRate = 1.5
        s.voiceIdentifier = nil
        s.hotkey = HotkeySpec(key: "J", command: true)
        #expect(s.changes(from: old).map(\.key) == ["ui.hotkey", "ui.speech.rate"])
        #expect(s.values["ui.speech.voice"] == "")
    }

    @Test func everyKeyIsAcceptedByTheStore() {
        // companiond/src/store/store.ts: const UI_KEY = /^ui\.[a-z0-9_.]{1,64}$/
        for k in UIKey.all { #expect(k.wholeMatch(of: /ui\.[a-z0-9_.]{1,64}/) != nil, "\(k)") }
        #expect(Set(UIKey.all) == Set(UISettings().values.keys))
    }
}
