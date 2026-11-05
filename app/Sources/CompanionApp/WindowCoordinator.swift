import AppKit
import ApplicationServices
import CompanionCore
import SwiftUI

@MainActor final class WindowCoordinator {
    private let status: WindowStatus
    private let follower = ClaudeWindowFollower()
    private let hotkeys = HotkeyCenter()
    private var panel: SidePanel?
    private var width = PanelGeometry.defaultWidth
    private var wantFollow = false
    private var following = false
    private var registered: HotkeySpec?
    private var resizeObserver: NSObjectProtocol?

    init(status: WindowStatus) {
        self.status = status
        status.accessibilityTrusted = AXIsProcessTrusted()
    }

    func install(rootView: some View, onWidthChange: @escaping @MainActor (CGFloat) -> Void) {
        let p = SidePanel(content: NSHostingView(rootView: rootView))
        panel = p
        resizeObserver = NotificationCenter.default.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let p = self.panel else { return }
                self.width = p.frame.width
                onWidthChange(p.frame.width)
            }
        }
        let claude = ClaudeWindowFollower.windowListBounds()
        if let screen = claude.flatMap(Self.screen(containing:)) ?? NSScreen.main {
            p.setFrame(PanelGeometry.dockedFrame(width: width, claudeFrame: nil, visibleFrame: screen.visibleFrame), display: true)
        }
    }

    func show() {
        panel?.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func toggle() {
        guard let p = panel else { return }
        if p.isVisible && p.isKeyWindow { p.orderOut(nil) } else { show() }
    }

    func apply(_ s: UISettings, onHotkey: @escaping @MainActor () -> Void) {
        let w = PanelGeometry.clampWidth(CGFloat(s.panelWidth))
        if let p = panel, abs(p.frame.width - w) > 1 {
            var f = p.frame
            f.size.width = w
            p.setFrame(f, display: true)
        }
        width = w
        if registered != s.hotkey {
            status.hotkeyError = hotkeys.register(s.hotkey, action: onHotkey)
            registered = s.hotkey
        }
        if s.followClaude != wantFollow {
            wantFollow = s.followClaude
            setFollow(s.followClaude, prompt: true)
        }
    }

    /// After the user grants Accessibility in System Settings and comes back.
    func retryFollowIfNeeded() {
        if wantFollow && !following { setFollow(true, prompt: false) }
    }

    private func setFollow(_ on: Bool, prompt: Bool) {
        guard on else {
            follower.stop()
            following = false
            status.followNote = nil
            return
        }
        let trusted = prompt ? AXIsProcessTrustedWithOptions(["AXTrustedCheckOptionPrompt": true] as CFDictionary) : AXIsProcessTrusted()
        status.accessibilityTrusted = trusted
        guard trusted else {
            status.followNote = "Allow ClaudeGPT Companion in System Settings › Privacy & Security › Accessibility. Until then the panel is a normal window you can move."
            return
        }
        following = true
        follower.onFrame = { [weak self] frame in self?.place(claudeFrame: frame) }
        status.followNote = follower.start() ? nil : "Claude Desktop is not running. The panel follows it once it opens."
    }

    private func place(claudeFrame: CGRect?) {
        guard let p = panel, let screen = claudeFrame.flatMap(Self.screen(containing:)) ?? p.screen ?? NSScreen.main else { return }
        p.setFrame(PanelGeometry.dockedFrame(width: width, claudeFrame: claudeFrame, visibleFrame: screen.visibleFrame), display: true)
    }

    private static func screen(containing r: CGRect) -> NSScreen? {
        func overlap(_ s: NSScreen) -> CGFloat { let i = s.frame.intersection(r); return i.isNull ? 0 : i.width * i.height }
        return NSScreen.screens.filter { overlap($0) > 0 }.max { overlap($0) < overlap($1) }
    }
}
