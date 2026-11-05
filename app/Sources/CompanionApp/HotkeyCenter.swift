import Carbon.HIToolbox
import CompanionCore

/// Global show/hide shortcut through RegisterEventHotKey (spec §7.8, F13: no permission needed).
@MainActor final class HotkeyCenter {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var action: (@MainActor () -> Void)?

    /// nil on success, else a message for Settings › Window.
    func register(_ spec: HotkeySpec, action: @escaping @MainActor () -> Void) -> String? {
        unregister()
        guard let code = spec.carbonKeyCode, spec.isValid else { return "That shortcut is not valid." }
        self.action = action
        if handlerRef == nil {
            var type = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let refcon = Unmanaged.passUnretained(self).toOpaque()
            InstallEventHandler(GetApplicationEventTarget(), { _, _, refcon in
                guard let refcon else { return OSStatus(eventNotHandledErr) }
                let center = Unmanaged<HotkeyCenter>.fromOpaque(refcon).takeUnretainedValue()
                MainActor.assumeIsolated { center.action?() }
                return noErr
            }, 1, &type, refcon, &handlerRef)
        }
        let id = EventHotKeyID(signature: OSType(0x4347_5054), id: 1) // "CGPT"
        let status = RegisterEventHotKey(code, spec.carbonModifiers, id, GetApplicationEventTarget(), 0, &hotKeyRef)
        return status == noErr ? nil : "Another app already uses \(spec.display). Choose another shortcut."
    }

    func unregister() {
        if let r = hotKeyRef { UnregisterEventHotKey(r) }
        hotKeyRef = nil
    }
}
