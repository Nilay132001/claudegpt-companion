import AppKit
import CompanionCore
import SwiftUI

/// The sidebar's visual tokens (docs/superpowers/specs/2026-11-05-m8-ui-design.md). Everything else uses system
/// text styles and semantic colours.
enum Design {
    enum Space {
        static let xs: CGFloat = 4
        static let s: CGFloat = 8
        static let m: CGFloat = 12
        static let l: CGFloat = 16
        static let xl: CGFloat = 24
    }

    enum Radius {
        static let bubble: CGFloat = 16
        static let composer: CGFloat = 16
        static let code: CGFloat = 8
    }

    enum Fill {
        /// The question bubble: a soft neutral fill that reads in light and dark.
        static let bubble = Color.primary.opacity(0.07)
        /// The composer field, opaque: white on the light window, a faint lift on the dark one.
        static let composer = Color(nsColor: NSColor(name: nil) { appearance in
            guard appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua else { return .white }
            var lifted = NSColor.white
            appearance.performAsCurrentDrawingAppearance {
                lifted = NSColor.windowBackgroundColor.usingColorSpace(.deviceRGB)?.blended(withFraction: 0.06, of: .white) ?? .white
            }
            return lifted
        })
        /// Hairlines: composer and code block borders, the context list rule.
        static let hairline = Color.primary.opacity(0.12)

        /// The hairline under Increase Contrast: the system separator colour (drawn at `hairlineWidth`).
        static func hairline(_ contrast: ColorSchemeContrast) -> Color {
            contrast == .increased ? Color(nsColor: .separatorColor) : hairline
        }

        static func hairlineWidth(_ contrast: ColorSchemeContrast) -> CGFloat { contrast == .increased ? 1 : 0.5 }
    }

    /// Answer type tokens (M9 §6). Point sizes at the default text size; multiply by `scale(_:)`.
    enum Typography {
        static func scale(_ size: DynamicTypeSize) -> CGFloat {
            let step: TextScale.Step = switch size {
            case .xSmall: .xSmall
            case .small: .small
            case .medium: .medium
            case .large: .large
            case .xLarge: .xLarge
            case .xxLarge: .xxLarge
            case .xxxLarge: .xxxLarge
            default: .accessibility
            }
            return CGFloat(TextScale.factor(step))
        }

        static let answerBody: CGFloat = 14, answerLineSpacing: CGFloat = 4
        /// Semibold.
        static let h1: CGFloat = 20, h2: CGFloat = 17, h3: CGFloat = 15
        /// Line height 18.
        static let code: CGFloat = 12.5, codeLineSpacing: CGFloat = 5.5
        static let tableCell: CGFloat = 13, caption: CGFloat = 11
        static let listItemGap: CGFloat = 4, nestingIndent: CGFloat = 18, bulletColumn = CGFloat(ListLayout.bulletColumn)

        static func heading(_ level: Int) -> CGFloat { level <= 1 ? h1 : level == 2 ? h2 : h3 }
    }
    /// Space between turns.
    static let turnGap: CGFloat = 18

    enum Motion {
        static let quick = Animation.snappy(duration: 0.12)
        static let standard = Animation.smooth(duration: 0.18)
        static let emphasized = Animation.smooth(duration: 0.24)
        /// Exits run at 0.7× the entrance.
        static let exit = Animation.smooth(duration: 0.24 * 0.7)

        /// nil (no animation) is never needed: reduce motion keeps the fade and drops offsets (see `entrance`).
        static func standard(reduceMotion: Bool) -> Animation { reduceMotion ? .linear(duration: 0.12) : standard }
    }

    /// The question bubble's maximum share of the column width.
    static let bubbleMaxFraction: CGFloat = 0.8

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// New messages fade in and rise 6 pt (opacity only under Reduce Motion). Disabled rows (every turn but the
/// newest) get no transition, so a lazy row scrolled into view never animates in.
/// Selectable chat text, except while the panel is being live-resized (WindowStatus.liveResizing): then the text
/// has no selection overlay to update on every frame. A selection made before the drag is cleared by it.
struct ChatTextSelection: ViewModifier {
    @Environment(WindowStatus.self) private var window: WindowStatus?
    func body(content: Content) -> some View {
        if window?.liveResizing == true {
            content.textSelection(.disabled)
        } else {
            content.textSelection(.enabled)
        }
    }
}

extension View {
    func chatTextSelection() -> some View { modifier(ChatTextSelection()) }
}

struct EntranceTransition: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let enabled: Bool
    init(enabled: Bool = true) { self.enabled = enabled }
    func body(content: Content) -> some View {
        if enabled {
            content.transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
        } else {
            content.transition(.identity)
        }
    }
}

/// A small icon button for the header and message actions: label + tooltip always set.
struct IconButton: View {
    let symbol: String
    let label: String
    var help: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .frame(width: 22, height: 22)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(label)
        .help(help ?? label)
    }
}

/// "Copied" confirmation that reverts after 1.2 s.
@MainActor @Observable final class CopiedFlag {
    private(set) var on = false
    private var task: Task<Void, Never>?
    func flash() {
        task?.cancel()
        withAnimation(Design.Motion.quick) { on = true }
        task = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1.2))
            guard !Task.isCancelled else { return }
            withAnimation(Design.Motion.quick) { self?.on = false }
        }
    }
}

extension Date {
    /// "14:32" today, "Tue 14:32" this week, else a short date.
    var shortStamp: String {
        let cal = Calendar.current
        if cal.isDateInToday(self) { return formatted(date: .omitted, time: .shortened) }
        if let d = cal.dateComponents([.day], from: self, to: Date()).day, d < 6 {
            return formatted(.dateTime.weekday(.abbreviated).hour().minute())
        }
        return formatted(date: .abbreviated, time: .shortened)
    }
}

/// Behind the header and the composer: the window background, fading out over 16 pt into the chat, so text
/// scrolling under them never shows around the composer or ends in a hard cut mid-glyph. It never takes clicks.
struct EdgeBacking: View {
    /// The edge facing the chat: .bottom for the header, .top for the composer.
    let fadeEdge: VerticalEdge
    static let fade: CGFloat = 16

    var body: some View {
        let bg = Color(nsColor: .windowBackgroundColor)
        let gradient = LinearGradient(colors: [bg.opacity(0), bg], startPoint: fadeEdge == .top ? .top : .bottom,
                                      endPoint: fadeEdge == .top ? .bottom : .top)
        VStack(spacing: 0) {
            if fadeEdge == .top { gradient.frame(height: Self.fade) }
            bg
            if fadeEdge == .bottom { gradient.frame(height: Self.fade) }
        }
        .padding(fadeEdge == .top ? .top : .bottom, -Self.fade)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Places one child on the trailing edge, at most `fraction` of the offered width (the question bubble).
struct TrailingFraction: Layout {
    var fraction: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let width = proposal.width ?? .infinity
        let size = child.sizeThatFits(ProposedViewSize(width: width.isFinite ? width * fraction : nil, height: nil))
        return CGSize(width: width.isFinite ? width : size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let size = child.sizeThatFits(ProposedViewSize(width: bounds.width * fraction, height: nil))
        child.place(at: CGPoint(x: bounds.maxX - size.width, y: bounds.minY), proposal: ProposedViewSize(size))
    }
}
