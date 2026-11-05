import CoreGraphics

/// Panel placement math (spec §8). All rects are AppKit screen coordinates unless named otherwise.
public enum PanelGeometry {
    public static let minWidth: CGFloat = 280
    public static let maxWidth: CGFloat = 640
    public static let defaultWidth: CGFloat = 360

    public static func clampWidth(_ w: CGFloat) -> CGFloat { min(max(w, minWidth), maxWidth) }

    /// Flush to Claude's left edge with Claude's height, or at the screen's left edge when there is no room
    /// or no Claude window. Always inside `visibleFrame` vertically.
    public static func dockedFrame(width: CGFloat, claudeFrame: CGRect?, visibleFrame v: CGRect) -> CGRect {
        let w = clampWidth(width)
        guard let c = claudeFrame else { return CGRect(x: v.minX, y: v.minY, width: w, height: v.height) }
        let x = c.minX - w >= v.minX ? c.minX - w : v.minX
        let y = max(c.minY, v.minY)
        let top = min(c.maxY, v.maxY)
        return CGRect(x: x, y: y, width: w, height: max(top - y, 200))
    }

    /// AX and CGWindowList rects have their origin at the top left of the primary screen.
    public static func appKitRect(fromTopLeft r: CGRect, primaryScreenHeight h: CGFloat) -> CGRect {
        CGRect(x: r.minX, y: h - r.maxY, width: r.width, height: r.height)
    }
}
