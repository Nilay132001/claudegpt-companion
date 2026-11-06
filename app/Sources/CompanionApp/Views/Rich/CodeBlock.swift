import CompanionCore
import Foundation
import SwiftUI

/// A code card: language (or title), the file chip, Wrap, Copy, and the code. By default (R1) a long line scrolls
/// sideways inside the card and never widens the panel; the global Wrap setting soft-wraps instead. Blocks of more
/// than 40 lines show their first 24 until expanded. Copy always copies the original text.
struct CodeBlock: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var typeSize
    let model: CodeModel
    let root: String?
    /// Header text instead of the language (e.g. the raw context block).
    var title: String? = nil
    var copyHelp = "Copy code"
    @State private var copied = CopiedFlag()
    @State private var expanded = false
    /// Bumped when a highlight lands in the cache, so the body reads it.
    @State private var highlightTick = 0
    /// Content overflows the card and is not scrolled to its end: the trailing edge fades.
    @State private var fadeEdge = false

    private static let fade: CGFloat = 12

    /// Highlighted code by (language, text): a re-realized block, or Show all, never re-highlights or flashes plain.
    @MainActor private static var highlightCache = BoundedCache<HighlightCacheKey, AttributedString>(capacity: 48, maxCost: 2_000_000)
    private struct HighlightCacheKey: Hashable { let language: String?; let text: String }

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.CodeBlock")
        #endif
        // A block with a very long line always wraps: giant single-line text renders blank or clipped.
        let forced = model.hasVeryLongLine
        let wrap = app.settings.codeWrap || forced
        let preview = (model.isOpen || expanded) ? nil : model.preview()
        let shown = preview?.text ?? model.text
        VStack(alignment: .leading, spacing: 0) {
            header(wrap: wrap, forced: forced)
            Rectangle().fill(Design.Fill.hairline(contrast)).frame(height: Design.Fill.hairlineWidth(contrast))
            if wrap { codeText(shown).frame(maxWidth: .infinity, alignment: .leading).padding(codeInsets) } else { scroller(shown) }
            if forced {
                Text("Wrapped: very long lines").font(.caption).foregroundStyle(.tertiary)
                    .padding(.horizontal, Design.Space.m).padding(.bottom, 6)
            }
            if let preview {
                Rectangle().fill(Design.Fill.hairline(contrast)).frame(height: Design.Fill.hairlineWidth(contrast))
                Button {
                    expanded = true
                } label: {
                    Text("Show all \(model.lineCount) lines")
                        .font(.caption)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.secondary)
                .padding(.horizontal, Design.Space.m)
                .padding(.vertical, 6)
                .help("\(preview.hiddenLines) more lines")
            }
        }
        // The one deliberate box inside answers (D6): hairline border, faint fill.
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: Design.Radius.code, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Design.Radius.code, style: .continuous).strokeBorder(Design.Fill.hairline(contrast), lineWidth: Design.Fill.hairlineWidth(contrast)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title ?? "Code block\(model.language.map { ", \($0)" } ?? "")")
        // Keyed on the open state too: a stream closing the fence changes it without changing the text.
        .task(id: HighlightKey(text: shown, isOpen: model.isOpen)) {
            guard !model.isOpen else { return }
            // The shown text first, then (a previewed block) the full text, so Show all is instant.
            let language = model.language
            for text in shown == model.text ? [shown] : [shown, model.text] {
                let key = HighlightCacheKey(language: language, text: text)
                if Self.highlightCache.value(for: key) == nil {
                    // Off the main actor; the task is cancelled when the key changes, so a stale result is dropped.
                    let (styled, nanos) = await Task.detached(priority: .userInitiated) { () -> (AttributedString, UInt64) in
                        let t0 = DispatchTime.now().uptimeNanoseconds
                        let out = Self.highlight(text, language: language)
                        return (out, DispatchTime.now().uptimeNanoseconds - t0)
                    }.value
                    #if DEBUG
                    PerfProbe.record("parse.highlight", nanos: nanos)
                    #else
                    _ = nanos
                    #endif
                    if Task.isCancelled { return }
                    Self.highlightCache.insert(styled, for: key, cost: text.utf16.count)
                }
                // Always: another block with the same text may have filled the cache while this one was plain.
                highlightTick += 1
            }
        }
    }

    // MARK: Pieces

    /// The header already has its own padding: a small top inset reads as one unit with the first line.
    private var codeInsets: EdgeInsets {
        EdgeInsets(top: 7, leading: Design.Space.m, bottom: 6, trailing: Design.Space.m)
    }

    private func header(wrap: Bool, forced: Bool) -> some View {
        HStack(spacing: Design.Space.s) {
            Text(verbatim: title ?? model.language?.lowercased() ?? "code")
                .font(title == nil ? .caption.monospaced() : .caption.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .layoutPriority(1)
            Spacer(minLength: Design.Space.s)
            if let ref = model.reference { fileChip(ref) }
            Toggle(isOn: Binding(get: { wrap }, set: { app.setSetting(\.codeWrap, $0) })) {
                Text("Wrap").font(.caption)
            }
            .toggleStyle(.button)
            .buttonStyle(.borderless)
            .controlSize(.small)
            .fixedSize()
            .layoutPriority(1)
            .foregroundStyle(wrap ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
            .background(wrap ? Color.accentColor.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .disabled(forced)
            .help(forced ? "This block has very long lines, so it wraps" : wrap ? "Turn off line wrap" : "Wrap long lines")
            .accessibilityLabel("Wrap long lines")
            Button {
                Design.copy(model.text)
                copied.flash()
            } label: {
                Label(copied.on ? "Copied" : "Copy", systemImage: copied.on ? "checkmark" : "doc.on.doc")
                    .contentTransition(.symbolEffect(.replace))
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .fixedSize()
            .layoutPriority(1)
            .foregroundStyle(copied.on ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
            .help(copyHelp)
            .accessibilityLabel(copied.on ? "Copied" : copyHelp)
        }
        .padding(.leading, Design.Space.m)
        .padding(.trailing, Design.Space.s)
        .padding(.vertical, 2)
    }

    /// `path:line` from the info string: opens through the same companion-open check as a link.
    private func fileChip(_ ref: FileReference) -> some View {
        let name = FileDisplay.relative(ref.path, root: root)
        return Button {
            openURL(EditorLink.companionURL(ref))
        } label: {
            Label {
                Text(verbatim: "\(name):\(ref.line)").lineLimit(1).truncationMode(.head)
            } icon: {
                Image(systemName: "doc.text")
            }
            .font(.caption)
        }
        .buttonStyle(.borderless)
        .foregroundStyle(.secondary)
        .help("\(ref.path):\(ref.line)")
        .accessibilityLabel("Open \(name) at line \(ref.line)")
    }

    /// The code as one selectable Text: coloured once it is closed and highlighted, plain while it streams.
    private func codeText(_ shown: String) -> some View {
        let font = Font.system(size: Design.Typography.code * Design.Typography.scale(typeSize), design: .monospaced)
        _ = highlightTick
        let styled = model.isOpen ? nil : Self.highlightCache.value(for: HighlightCacheKey(language: model.language, text: shown))
        return Group {
            if let styled { Text(styled) } else { Text(verbatim: shown) }
        }
        .font(font)
        .lineSpacing(Design.Typography.codeLineSpacing)
        .chatTextSelection()
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Lines never wrap; the card scrolls sideways, with a 12 pt fade at the trailing edge while there is more.
    private func scroller(_ shown: String) -> some View {
        ScrollView(.horizontal) {
            codeText(shown)
                .fixedSize(horizontal: true, vertical: true)
                .padding(codeInsets)
        }
        .scrollIndicators(.automatic)
        .contentMargins(0, for: .scrollContent)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .onScrollGeometryChange(for: Bool.self) { g in
            g.contentSize.width > g.containerSize.width + 1 && g.visibleRect.maxX < g.contentSize.width - 1
        } action: { _, more in
            fadeEdge = more
        }
        // The window colour under the card's own faint fill, fading to clear: it matches the card and never takes hits.
        .overlay(alignment: .trailing) {
            if fadeEdge {
                ZStack {
                    LinearGradient(colors: [Color(nsColor: .windowBackgroundColor), Color(nsColor: .windowBackgroundColor).opacity(0)], startPoint: .trailing, endPoint: .leading)
                    LinearGradient(colors: [Color.primary.opacity(0.035), .clear], startPoint: .trailing, endPoint: .leading)
                }
                .frame(width: Self.fade)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
        }
    }

    // MARK: Helpers

    nonisolated static func color(_ t: CodeToken) -> Color? {
        switch t {
        case .keyword: Color(nsColor: .systemPink)
        case .string: Color(nsColor: .systemRed)
        case .comment: Color(nsColor: .systemGray)
        case .number: Color(nsColor: .systemBlue)
        case .type: Color(nsColor: .systemTeal)
        case .plain: nil
        }
    }

    /// The code with token colours, built piece by piece (tokens are ordered and never overlap).
    nonisolated private static func highlight(_ code: String, language: String?) -> AttributedString {
        var out = AttributedString()
        var at = code.startIndex
        for t in CodeHighlighter.tokens(code, language: language) where t.range.lowerBound >= at {
            if at < t.range.lowerBound { out.append(AttributedString(String(code[at..<t.range.lowerBound]))) }
            var piece = AttributedString(String(code[t.range]))
            piece.foregroundColor = color(t.kind)
            out.append(piece)
            at = t.range.upperBound
        }
        if at < code.endIndex { out.append(AttributedString(String(code[at...]))) }
        return out
    }
}
