import Carbon.HIToolbox

/// The show/hide shortcut (spec §8, default ⌥⌘G). Stored as e.g. "opt+cmd+G".
public struct HotkeySpec: Equatable, Sendable {
    public var key: String
    public var control: Bool
    public var option: Bool
    public var shift: Bool
    public var command: Bool

    public static let `default` = HotkeySpec(key: "G", option: true, command: true)

    public init(key: String, control: Bool = false, option: Bool = false, shift: Bool = false, command: Bool = false) {
        self.key = key
        self.control = control
        self.option = option
        self.shift = shift
        self.command = command
    }

    public init?(string: String) {
        var s = HotkeySpec(key: "")
        for part in string.split(separator: "+").map({ $0.lowercased() }) {
            switch part {
            case "ctrl": s.control = true
            case "opt": s.option = true
            case "shift": s.shift = true
            case "cmd": s.command = true
            default:
                guard part.count == 1, s.key.isEmpty else { return nil }
                s.key = part.uppercased()
            }
        }
        guard s.isValid else { return nil }
        self = s
    }

    public var isValid: Bool { Self.keyCodes[key] != nil && (control || option || command) }

    public var string: String {
        var p: [String] = []
        if control { p.append("ctrl") }
        if option { p.append("opt") }
        if shift { p.append("shift") }
        if command { p.append("cmd") }
        return (p + [key]).joined(separator: "+")
    }

    public var display: String {
        (control ? "⌃" : "") + (option ? "⌥" : "") + (shift ? "⇧" : "") + (command ? "⌘" : "") + key
    }

    public var carbonModifiers: UInt32 {
        var m = 0
        if control { m |= controlKey }
        if option { m |= optionKey }
        if shift { m |= shiftKey }
        if command { m |= cmdKey }
        return UInt32(m)
    }

    public var carbonKeyCode: UInt32? { Self.keyCodes[key].map { UInt32($0) } }

    static let keyCodes: [String: Int] = [
        "A": kVK_ANSI_A, "B": kVK_ANSI_B, "C": kVK_ANSI_C, "D": kVK_ANSI_D, "E": kVK_ANSI_E, "F": kVK_ANSI_F,
        "G": kVK_ANSI_G, "H": kVK_ANSI_H, "I": kVK_ANSI_I, "J": kVK_ANSI_J, "K": kVK_ANSI_K, "L": kVK_ANSI_L,
        "M": kVK_ANSI_M, "N": kVK_ANSI_N, "O": kVK_ANSI_O, "P": kVK_ANSI_P, "Q": kVK_ANSI_Q, "R": kVK_ANSI_R,
        "S": kVK_ANSI_S, "T": kVK_ANSI_T, "U": kVK_ANSI_U, "V": kVK_ANSI_V, "W": kVK_ANSI_W, "X": kVK_ANSI_X,
        "Y": kVK_ANSI_Y, "Z": kVK_ANSI_Z, "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
    ]
}
