// Draws the ClaudeGPT Companion app icon with CoreGraphics.
// Usage: swift app/bundle/icon/make-icon.swift <outdir>
//
// Writes, into <outdir>:
//   background.png, panel.png, lens.png  1024x1024 full-bleed layers. AppIcon.icon/Assets holds panel.png
//                                        and lens.png; its icon.json draws the background as a gradient fill
//                                        (same two colours) so the system can tint it.
//   master-1024.png                      the flattened icon on the macOS grid (tile, mask and shadow)
//   AppIcon.iconset/                     16...1024 incl. @2x, each size drawn directly (simpler detail
//                                        below 64 px), ready for `iconutil -c icns`
//
// Concept: an editor window with a narrow side column (the sidebar) and a warm lens on that column:
// "a second pair of eyes next to your editor". Original artwork, no text, no third-party marks.
// All geometry is in a 1024-unit design space where (0,0) is the top-left of the icon tile.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// MARK: - Palette

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
    blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

let bgTop = rgb(0x2F7FA0)
let bgBottom = rgb(0x0B2A41)
let panelTop = rgb(0xFBFDFE)
let panelBottom = rgb(0xE2ECF2)
let columnTop = rgb(0xD3E5EE)
let columnBottom = rgb(0xBFD7E3)
let lineSlate = rgb(0xA7BAC7)
let lineTeal = rgb(0x4F9DBB)
let lineColumn = rgb(0x93B6C6)
let ringTop = rgb(0xFFC867)
let ringBottom = rgb(0xEE7F24)
let glassCenter = rgb(0xF2FAFC)
let glassEdge = rgb(0xB9D8E4)
let pupil = rgb(0x0F3D56)

let space = CGColorSpace(name: CGColorSpace.sRGB)!

// MARK: - Helpers

enum Detail { case full, medium, small }

/// A context whose user space is the 1024-unit design space of a tile placed at `tile` (in pixels, y down).
struct Canvas {
  let ctx: CGContext
  let scale: CGFloat  // pixels per design unit

  init(pixels: Int, tile: CGRect) {
    ctx = CGContext(
      data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: space,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setShouldAntialias(true)
    // Flip to y-down, then map the design space onto the tile.
    ctx.translateBy(x: 0, y: CGFloat(pixels))
    ctx.scaleBy(x: 1, y: -1)
    ctx.translateBy(x: tile.minX, y: tile.minY)
    scale = tile.width / 1024
    ctx.scaleBy(x: scale, y: scale)
  }

  /// Shadows are specified in device space (y up), so convert from design units.
  func shadow(dy: CGFloat, blur: CGFloat, color: CGColor) {
    ctx.setShadow(offset: CGSize(width: 0, height: -dy * scale), blur: blur * scale, color: color)
  }

  func linear(_ path: CGPath, _ top: CGColor, _ bottom: CGColor, from y0: CGFloat, to y1: CGFloat) {
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    let g = CGGradient(colorsSpace: space, colors: [top, bottom] as CFArray, locations: [0, 1])!
    ctx.drawLinearGradient(
      g, start: CGPoint(x: 0, y: y0), end: CGPoint(x: 0, y: y1),
      options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    ctx.restoreGState()
  }

  func image() -> CGImage { ctx.makeImage()! }
}

func rounded(_ r: CGRect, _ radius: CGFloat) -> CGPath {
  CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

/// The macOS icon tile: a superellipse ("squircle") filling `r`.
func squircle(_ r: CGRect) -> CGPath {
  let p = CGMutablePath()
  let n: CGFloat = 4.6
  let steps = 720
  for i in 0..<steps {
    let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
    let c = cos(t)
    let s = sin(t)
    let x = pow(abs(c), 2 / n) * (c < 0 ? -1 : 1)
    let y = pow(abs(s), 2 / n) * (s < 0 ? -1 : 1)
    let pt = CGPoint(x: r.midX + x * r.width / 2, y: r.midY + y * r.height / 2)
    if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
  }
  p.closeSubpath()
  return p
}

// MARK: - Layers (design space, 1024 x 1024 full bleed)

/// The window, its corner radius and the x of the side column, per detail level: bigger and bolder when small.
func panelGeometry(_ detail: Detail) -> (rect: CGRect, radius: CGFloat, columnX: CGFloat) {
  switch detail {
  case .full: return (CGRect(x: 152, y: 228, width: 720, height: 568), 80, 610)
  case .medium: return (CGRect(x: 132, y: 220, width: 760, height: 584), 84, 600)
  case .small: return (CGRect(x: 104, y: 200, width: 816, height: 624), 96, 572)
  }
}

func drawBackground(_ c: Canvas) {
  let full = CGPath(rect: CGRect(x: 0, y: 0, width: 1024, height: 1024), transform: nil)
  c.linear(full, bgTop, bgBottom, from: 0, to: 1024)
  // A soft glow from the top, so the tile has light falling on it.
  let ctx = c.ctx
  ctx.saveGState()
  let glow = CGGradient(
    colorsSpace: space, colors: [rgb(0xFFFFFF, 0.22), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(
    glow, startCenter: CGPoint(x: 512, y: -120), startRadius: 0, endCenter: CGPoint(x: 512, y: -120),
    endRadius: 820, options: [])
  ctx.restoreGState()
}

func drawPanel(_ c: Canvas, _ detail: Detail, shadow: Bool) {
  let ctx = c.ctx
  let (panelRect, panelRadius, columnX) = panelGeometry(detail)
  let body = rounded(panelRect, panelRadius)

  // Body, with a soft shadow beneath it.
  ctx.saveGState()
  if shadow { c.shadow(dy: 22, blur: 46, color: rgb(0x031722, 0.45)) }
  ctx.addPath(body)
  ctx.setFillColor(panelBottom)
  ctx.fillPath()
  ctx.restoreGState()
  c.linear(body, panelTop, panelBottom, from: panelRect.minY, to: panelRect.maxY)

  // Side column: the right part of the window, slightly tinted.
  ctx.saveGState()
  ctx.addPath(body)
  ctx.clip()
  let column = CGPath(
    rect: CGRect(x: columnX, y: panelRect.minY, width: panelRect.maxX - columnX, height: panelRect.height),
    transform: nil)
  c.linear(column, columnTop, columnBottom, from: panelRect.minY, to: panelRect.maxY)
  // Hairline divider.
  ctx.setFillColor(rgb(0x8FB0C0, 0.55))
  ctx.fill(CGRect(x: columnX - 2, y: panelRect.minY, width: 4, height: panelRect.height))
  ctx.restoreGState()

  // Lines of code in the editor area.
  let left: CGFloat = panelRect.minX + 62
  switch detail {
  case .full, .medium:
    // (indent, width, accent) per row.
    let rows: [(CGFloat, CGFloat, Bool)] =
      detail == .full
      ? [(0, 250, true), (48, 300, false), (48, 210, false), (96, 230, false), (48, 160, true), (0, 120, false)]
      : [(0, 250, true), (56, 290, false), (56, 200, false), (0, 140, true)]
    let h: CGFloat = detail == .full ? 30 : 42
    let top: CGFloat = detail == .full ? 306 : 318
    let step: CGFloat = detail == .full ? 72 : 104
    for (i, row) in rows.enumerated() {
      let r = CGRect(x: left + row.0, y: top + CGFloat(i) * step, width: row.1, height: h)
      ctx.addPath(rounded(r, h / 2))
      ctx.setFillColor(row.2 ? lineTeal : lineSlate)
      ctx.fillPath()
    }
  case .small:
    let rows: [(CGFloat, Bool)] = [(300, true), (220, false), (330, false)]
    for (i, row) in rows.enumerated() {
      let r = CGRect(x: left, y: 318 + CGFloat(i) * 150, width: row.0, height: 76)
      ctx.addPath(rounded(r, 38))
      ctx.setFillColor(row.1 ? lineTeal : lineSlate)
      ctx.fillPath()
    }
  }

  // Two short reply lines in the column, under the lens.
  if detail == .full {
    for (i, w) in [CGFloat(150), 104].enumerated() {
      let r = CGRect(x: 668, y: 650 + CGFloat(i) * 60, width: w, height: 26)
      ctx.addPath(rounded(r, 13))
      ctx.setFillColor(lineColumn)
      ctx.fillPath()
    }
  }

  // Top-edge highlight: a thin bright rim that fades down the sides.
  ctx.saveGState()
  ctx.addPath(body)
  ctx.clip()
  let rim = rounded(panelRect.insetBy(dx: 3, dy: 3), panelRadius - 3)
  ctx.addPath(rim)
  ctx.setLineWidth(5)
  ctx.replacePathWithStrokedPath()
  ctx.clip()
  let g = CGGradient(
    colorsSpace: space, colors: [rgb(0xFFFFFF, 0.95), rgb(0xFFFFFF, 0)] as CFArray, locations: [0, 1])!
  ctx.drawLinearGradient(
    g, start: CGPoint(x: 0, y: panelRect.minY), end: CGPoint(x: 0, y: panelRect.minY + 180), options: [])
  ctx.restoreGState()
}

func lensGeometry(_ detail: Detail) -> (center: CGPoint, radius: CGFloat, ring: CGFloat) {
  switch detail {
  case .full: return (CGPoint(x: 741, y: 474), 112, 30)
  case .medium: return (CGPoint(x: 746, y: 500), 124, 38)
  case .small: return (CGPoint(x: 746, y: 512), 150, 58)
  }
}

func drawLens(_ c: Canvas, _ detail: Detail, shadow: Bool) {
  let ctx = c.ctx
  let (o, r, w) = lensGeometry(detail)
  let outer = CGRect(x: o.x - r, y: o.y - r, width: 2 * r, height: 2 * r)
  let inner = outer.insetBy(dx: w, dy: w)

  // Ring, with a shadow so it sits above the window.
  ctx.saveGState()
  if shadow { c.shadow(dy: 12, blur: 26, color: rgb(0x07202F, 0.42)) }
  ctx.addEllipse(in: outer)
  ctx.setFillColor(ringBottom)
  ctx.fillPath()
  ctx.restoreGState()
  c.linear(CGPath(ellipseIn: outer, transform: nil), ringTop, ringBottom, from: outer.minY, to: outer.maxY)

  // Glass inside the ring.
  ctx.saveGState()
  ctx.addEllipse(in: inner)
  ctx.clip()
  let glass = CGGradient(colorsSpace: space, colors: [glassCenter, glassEdge] as CFArray, locations: [0, 1])!
  ctx.drawRadialGradient(
    glass, startCenter: CGPoint(x: o.x - r * 0.25, y: o.y - r * 0.3), startRadius: 0, endCenter: o,
    endRadius: inner.width / 2 + 8, options: [.drawsAfterEndLocation])
  // Inner shadow cast by the ring onto the glass.
  ctx.addRect(inner.insetBy(dx: -60, dy: -60))
  ctx.addEllipse(in: inner)
  c.shadow(dy: 6, blur: 14, color: rgb(0x0B3346, 0.45))
  ctx.setFillColor(rgb(0x000000))
  ctx.fillPath(using: .evenOdd)
  ctx.restoreGState()

  // Pupil and catch-light: the "second look".
  // The pupil glances left, towards the editor.
  let pr: CGFloat = detail == .small ? 44 : (detail == .medium ? 40 : 38)
  let p = CGPoint(x: o.x - (r - w) * 0.22, y: o.y + (r - w) * 0.04)
  ctx.addEllipse(in: CGRect(x: p.x - pr, y: p.y - pr, width: 2 * pr, height: 2 * pr))
  ctx.setFillColor(pupil)
  ctx.fillPath()
  if detail != .small {
    let cr: CGFloat = pr * 0.34
    ctx.addEllipse(in: CGRect(x: p.x - pr * 0.4 - cr, y: p.y - pr * 0.42 - cr, width: 2 * cr, height: 2 * cr))
    ctx.setFillColor(rgb(0xFFFFFF, 0.92))
    ctx.fillPath()
  }

  // Specular arc on the ring's upper left.
  if detail != .small {
    ctx.saveGState()
    ctx.addEllipse(in: outer)
    ctx.clip()
    let arc = CGMutablePath()
    arc.addArc(
      center: o, radius: r - w / 2, startAngle: .pi * 1.05, endAngle: .pi * 1.45, clockwise: false)
    ctx.addPath(arc)
    ctx.setLineWidth(w * 0.32)
    ctx.setLineCap(.round)
    ctx.setStrokeColor(rgb(0xFFFFFF, 0.55))
    ctx.strokePath()
    ctx.restoreGState()
  }
}

// MARK: - Flattened icon on the macOS grid

/// The tile occupies 824/1024 of the canvas, centred, with the standard drop shadow.
func drawMaster(pixels: Int, detail: Detail) -> CGImage {
  let s = CGFloat(pixels)
  let tile = CGRect(x: s * 100 / 1024, y: s * 100 / 1024, width: s * 824 / 1024, height: s * 824 / 1024)
  let c = Canvas(pixels: pixels, tile: tile)
  let ctx = c.ctx
  let mask = squircle(CGRect(x: 0, y: 0, width: 1024, height: 1024))

  ctx.saveGState()
  c.shadow(dy: 14, blur: 34, color: rgb(0x000000, 0.32))
  ctx.addPath(mask)
  ctx.setFillColor(bgBottom)
  ctx.fillPath()
  ctx.restoreGState()

  ctx.saveGState()
  ctx.addPath(mask)
  ctx.clip()
  drawBackground(c)
  drawPanel(c, detail, shadow: true)
  drawLens(c, detail, shadow: true)
  // Inner rim light on the tile.
  ctx.addPath(mask)
  ctx.setLineWidth(detail == .small ? 16 : 6)
  ctx.setStrokeColor(rgb(0xFFFFFF, 0.16))
  ctx.strokePath()
  ctx.restoreGState()
  return c.image()
}

func layer(_ draw: (Canvas) -> Void) -> CGImage {
  let c = Canvas(pixels: 1024, tile: CGRect(x: 0, y: 0, width: 1024, height: 1024))
  draw(c)
  return c.image()
}

// MARK: - Output

func writePNG(_ image: CGImage, _ url: URL) {
  let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, image, nil)
  guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(url.path)") }
}

let args = CommandLine.arguments
guard args.count == 2 else {
  FileHandle.standardError.write("usage: swift make-icon.swift <outdir>\n".data(using: .utf8)!)
  exit(2)
}
let out = URL(fileURLWithPath: args[1], isDirectory: true)
let iconset = out.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

// Layers for Icon Composer: the system draws the tile mask, glass and shadows, so none are baked in.
writePNG(layer { drawBackground($0) }, out.appendingPathComponent("background.png"))
writePNG(layer { drawPanel($0, .full, shadow: false) }, out.appendingPathComponent("panel.png"))
writePNG(layer { drawLens($0, .full, shadow: false) }, out.appendingPathComponent("lens.png"))
writePNG(drawMaster(pixels: 1024, detail: .full), out.appendingPathComponent("master-1024.png"))

for pt in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    let px = pt * scale
    let detail: Detail = px < 64 ? .small : (px < 128 ? .medium : .full)
    let name = scale == 1 ? "icon_\(pt)x\(pt).png" : "icon_\(pt)x\(pt)@2x.png"
    writePNG(drawMaster(pixels: px, detail: detail), iconset.appendingPathComponent(name))
  }
}
print("wrote \(out.path)")
