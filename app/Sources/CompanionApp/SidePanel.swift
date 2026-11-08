import AppKit

/// The side panel (spec §8): a titled, resizable NSPanel at normal level (ruling 2), 280–640 pt wide.
final class SidePanel: NSPanel {
    init(content: NSView) {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 360, height: 700),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                   backing: .buffered, defer: false)
        title = "ClaudeGPT Companion"
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        // R7: a drag over text must select it, not move the window. The header's titlebar row still drags.
        isMovableByWindowBackground = false
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        level = .normal
        collectionBehavior = [.fullScreenAuxiliary]
        contentMinSize = NSSize(width: 280, height: 320)
        contentMaxSize = NSSize(width: 640, height: CGFloat.greatestFiniteMagnitude)
        contentView = content
    }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}
