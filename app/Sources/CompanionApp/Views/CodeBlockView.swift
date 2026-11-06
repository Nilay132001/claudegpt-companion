import CompanionCore
import SwiftUI

/// A code card: language + Copy header, highlighted selectable body. Long lines soft-wrap so nothing is clipped at
/// sidebar widths; Copy always copies the original text.
struct CodeBlockView: View {
    let language: String?
    let code: String
    /// Header text instead of the language (e.g. the raw context block).
    var title: String? = nil
    var copyHelp = "Copy code"
    @State private var copied = CopiedFlag()

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.CodeBlockView")
        #endif
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Design.Space.s) {
                Text(verbatim: title ?? language?.lowercased() ?? "code")
                    .font(title == nil ? .caption.monospaced() : .caption.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: Design.Space.s)
                Button {
                    Design.copy(code)
                    copied.flash()
                } label: {
                    Label(copied.on ? "Copied" : "Copy", systemImage: copied.on ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .fixedSize()
                .foregroundStyle(copied.on ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
                .help(copyHelp)
                .accessibilityLabel(copied.on ? "Copied" : copyHelp)
            }
            .padding(.leading, Design.Space.m)
            .padding(.trailing, Design.Space.s)
            .padding(.vertical, 4)
            Rectangle().fill(Design.Fill.hairline).frame(height: 0.5)
            Text(Self.highlighted(code, language: language))
                .font(.system(.callout, design: .monospaced))
                .lineSpacing(2)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Design.Space.m)
        }
        // The one deliberate box inside answers (D6): hairline border, faint fill.
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: Design.Radius.code, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Design.Radius.code, style: .continuous).strokeBorder(Design.Fill.hairline, lineWidth: 0.5))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title ?? "Code block\(language.map { ", \($0)" } ?? "")")
    }

    static func color(_ t: CodeToken) -> Color? {
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
    static func highlighted(_ code: String, language: String?) -> AttributedString {
        #if DEBUG
        PerfProbe.measure("parse.highlight") { highlight(code, language: language) }
        #else
        highlight(code, language: language)
        #endif
    }

    private static func highlight(_ code: String, language: String?) -> AttributedString {
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
