import AppKit
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
        static let chip: CGFloat = 7
        static let status: CGFloat = 8
        static let bubble: CGFloat = 14
        static let composer: CGFloat = 18
    }

    enum Motion {
        static let quick = Animation.snappy(duration: 0.12)
        static let standard = Animation.smooth(duration: 0.18)
        static let emphasized = Animation.smooth(duration: 0.24)
        /// Exits run at 0.7× the entrance.
        static let exit = Animation.smooth(duration: 0.24 * 0.7)

        /// nil (no animation) is never needed: reduce motion keeps the fade and drops offsets (see `entrance`).
        static func standard(reduceMotion: Bool) -> Animation { reduceMotion ? .linear(duration: 0.12) : standard }
    }

    /// The panel's reading width for the question bubble.
    static let bubbleMaxFraction: CGFloat = 0.85

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

/// New messages fade in and rise 6 pt (opacity only under Reduce Motion).
struct EntranceTransition: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
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

extension View {
    /// Liquid Glass for the navigation layer only (R9): the header controls and the floating composer.
    /// DEBUG demo screenshots cannot capture glass (it renders out of process), so a demo shot draws a material
    /// stand-in with the same shape; the running app always uses glassEffect.
    @ViewBuilder func panelGlass<S: InsettableShape>(in shape: S, interactive: Bool = false) -> some View {
        #if DEBUG
        if DemoFlags.scene != nil && ProcessInfo.processInfo.environment["COMPANION_DEMO_SHOT"] != nil {
            self.background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.1), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        } else {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        }
        #else
        glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        #endif
    }
}
