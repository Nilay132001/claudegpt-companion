import Carbon.HIToolbox
import Testing
@testable import CompanionCore

@Suite struct HotkeySpecTests {
    @Test func defaultIsOptionCommandG() {
        #expect(HotkeySpec.default.string == "opt+cmd+G")
        #expect(HotkeySpec.default.display == "⌥⌘G")
        #expect(HotkeySpec.default.carbonKeyCode == UInt32(kVK_ANSI_G))
        #expect(HotkeySpec.default.carbonModifiers == UInt32(optionKey | cmdKey))
    }

    @Test func parsesAndRoundTrips() {
        let s = HotkeySpec(string: "cmd+shift+ctrl+7")
        #expect(s == HotkeySpec(key: "7", control: true, shift: true, command: true))
        #expect(s?.string == "ctrl+shift+cmd+7")
        #expect(s?.display == "⌃⇧⌘7")
        #expect(HotkeySpec(string: s!.string) == s)
    }

    @Test func rejectsBadShortcuts() {
        #expect(HotkeySpec(string: "G") == nil)            // no modifier
        #expect(HotkeySpec(string: "shift+G") == nil)      // shift alone is not enough
        #expect(HotkeySpec(string: "cmd+F1") == nil)       // only one letter or digit
        #expect(HotkeySpec(string: "cmd+G+H") == nil)
        #expect(HotkeySpec(string: "cmd+é") == nil)
    }
}
