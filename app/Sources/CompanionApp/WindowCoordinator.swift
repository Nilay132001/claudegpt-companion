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
    private var resizeStartObserver: NSObjectProtocol?
    private var closeObserver: NSObjectProtocol?
    /// Called when the panel is hidden (hotkey) or closed: nothing keeps listening behind a hidden panel (spec §7.8).
    var onHide: (@MainActor () -> Void)?

    init(status: WindowStatus) {
        self.status = status
        status.accessibilityTrusted = AXIsProcessTrusted()
    }

    func install(rootView: some View, onWidthChange: @escaping @MainActor (CGFloat) -> Void) {
        let hosting = NSHostingView(rootView: rootView)
        // The panel's min/max size comes from SidePanel.contentMinSize/contentMaxSize. With the default options the
        // hosting view re-measured the whole chat on every update to derive them (21% of streaming main-thread time).
        hosting.sizingOptions = []
        let p = SidePanel(content: hosting)
        panel = p
        resizeStartObserver = NotificationCenter.default.addObserver(forName: NSWindow.willStartLiveResizeNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.status.liveResizing = true }
        }
        resizeObserver = NotificationCenter.default.addObserver(forName: NSWindow.didEndLiveResizeNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let p = self.panel else { return }
                self.status.liveResizing = false
                self.width = p.frame.width
                onWidthChange(p.frame.width)
            }
        }
        closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: p, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onHide?() }
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
        if p.isVisible && p.isKeyWindow {
            p.orderOut(nil)
            onHide?()
        } else {
            show()
        }
    }

    /// `byUser`: the user turned a setting on in this run. Only then may the Accessibility prompt show; at launch
    /// (settings loaded with Follow already on) the trust is just checked and the note set.
    func apply(_ s: UISettings, byUser: Bool, onHotkey: @escaping @MainActor () -> Void) {
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
            setFollow(s.followClaude, prompt: byUser)
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
