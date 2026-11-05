import CoreGraphics
import Testing
@testable import CompanionCore

@Suite struct PanelGeometryTests {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944) // visibleFrame, AppKit coordinates

    @Test func clampsWidth() {
        #expect(PanelGeometry.clampWidth(100) == 280)
        #expect(PanelGeometry.clampWidth(900) == 640)
        #expect(PanelGeometry.clampWidth(400) == 400)
    }

    @Test func noClaudeWindowDocksAtTheScreenEdge() {
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: nil, visibleFrame: screen) == CGRect(x: 0, y: 0, width: 360, height: 944))
    }

    @Test func flushLeftOfClaude() {
        let claude = CGRect(x: 500, y: 100, width: 900, height: 700)
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: claude, visibleFrame: screen) == CGRect(x: 140, y: 100, width: 360, height: 700))
    }

    @Test func noRoomGoesToTheScreenEdge() {
        let claude = CGRect(x: 100, y: 0, width: 1400, height: 944)
        #expect(PanelGeometry.dockedFrame(width: 360, claudeFrame: claude, visibleFrame: screen).minX == 0)
    }

    @Test func heightStaysOnScreen() {
        let claude = CGRect(x: 800, y: -50, width: 600, height: 1200)
        let f = PanelGeometry.dockedFrame(width: 300, claudeFrame: claude, visibleFrame: screen)
        #expect(f.minY == 0 && f.maxY == 944)
    }

    @Test func convertsTopLeftCoordinates() {
        // AX and CGWindowList use a top-left origin on the primary screen; AppKit uses bottom-left.
        #expect(PanelGeometry.appKitRect(fromTopLeft: CGRect(x: 10, y: 20, width: 100, height: 200), primaryScreenHeight: 982)
            == CGRect(x: 10, y: 762, width: 100, height: 200))
    }
}
