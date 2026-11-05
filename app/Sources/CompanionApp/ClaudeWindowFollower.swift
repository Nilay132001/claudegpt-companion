import AppKit
import ApplicationServices
import CompanionCore

/// Reads Claude Desktop's focused window frame (spec §8, D2). Read-only: no AX action, no attribute is ever set.
@MainActor final class ClaudeWindowFollower {
    static let claudeBundleId = "com.anthropic.claudefordesktop"
    var onFrame: ((CGRect?) -> Void)?
    private var observer: AXObserver?
    private var appElement: AXUIElement?
    private var window: AXUIElement?
    private var workspaceTokens: [NSObjectProtocol] = []

    /// False when Claude Desktop is not running (the follower attaches when it launches).
    func start() -> Bool {
        stop()
        let nc = NSWorkspace.shared.notificationCenter
        workspaceTokens = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification].map { name in
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                let id = (note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?.bundleIdentifier
                MainActor.assumeIsolated { if id == Self.claudeBundleId { _ = self?.attach() } }
            }
        }
        return attach()
    }

    func stop() {
        detach()
        for t in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(t) }
        workspaceTokens = []
    }

    private func attach() -> Bool {
        detach()
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: Self.claudeBundleId).first else {
            onFrame?(nil)
            return false
        }
        var created: AXObserver?
        let callback: AXObserverCallback = { _, _, notification, refcon in
            guard let refcon else { return }
            let me = Unmanaged<ClaudeWindowFollower>.fromOpaque(refcon).takeUnretainedValue()
            let name = notification as String
            MainActor.assumeIsolated { me.handle(name) }
        }
        guard AXObserverCreate(app.processIdentifier, callback, &created) == .success, let obs = created else { return false }
        let element = AXUIElementCreateApplication(app.processIdentifier)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(obs, element, kAXFocusedWindowChangedNotification as CFString, refcon)
        AXObserverAddNotification(obs, element, kAXMainWindowChangedNotification as CFString, refcon)
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
        observer = obs
        appElement = element
        watchFocusedWindow()
        return true
    }

    private func detach() {
        if let obs = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode) }
        observer = nil
        appElement = nil
        window = nil
    }

    private func handle(_ name: String) {
        if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification { watchFocusedWindow() } else { report() }
    }

    private func watchFocusedWindow() {
        guard let obs = observer, let app = appElement else { return }
        if let w = window {
            AXObserverRemoveNotification(obs, w, kAXMovedNotification as CFString)
            AXObserverRemoveNotification(obs, w, kAXResizedNotification as CFString)
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
            window = nil
            onFrame?(nil)
            return
        }
        let w = value as! AXUIElement // type id checked above
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        AXObserverAddNotification(obs, w, kAXMovedNotification as CFString, refcon)
        AXObserverAddNotification(obs, w, kAXResizedNotification as CFString, refcon)
        window = w
        report()
    }

    private func report() { onFrame?(window.flatMap(Self.frame(of:))) }

    private static func frame(of w: AXUIElement) -> CGRect? {
        var p: CFTypeRef?
        var s: CFTypeRef?
        guard AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &p) == .success,
              AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &s) == .success,
              let p, let s, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &origin), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return PanelGeometry.appKitRect(fromTopLeft: CGRect(origin: origin, size: size),
                                        primaryScreenHeight: NSScreen.screens.first?.frame.height ?? 0)
    }

    /// Claude's front window bounds without any permission (window geometry only; ruling 16).
    static func windowListBounds() -> CGRect? {
        guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: claudeBundleId).first,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list where (w[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier && (w[kCGWindowLayer as String] as? Int) == 0 {
            if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary) {
                return PanelGeometry.appKitRect(fromTopLeft: r, primaryScreenHeight: NSScreen.screens.first?.frame.height ?? 0)
            }
        }
        return nil
    }
}
