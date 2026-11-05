import CompanionCore
import SwiftUI

/// A code card: language + Copy header, highlighted selectable body that scrolls sideways.
struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var copied = CopiedFlag()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Design.Space.s) {
                Text(verbatim: language?.lowercased() ?? "code")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    Design.copy(code)
                    copied.flash()
                } label: {
                    Label(copied.on ? "Copied" : "Copy", systemImage: copied.on ? "checkmark" : "doc.on.doc")
                        .contentTransition(.symbolEffect(.replace))
                }
                .buttonStyle(.borderless)
                .font(.caption)
                .foregroundStyle(copied.on ? AnyShapeStyle(.green) : AnyShapeStyle(.secondary))
                .help("Copy code")
                .accessibilityLabel(copied.on ? "Copied" : "Copy code")
            }
            .padding(.horizontal, Design.Space.m)
            .padding(.vertical, 6)
            Divider().opacity(0.6)
            ScrollView(.horizontal) {
                Text(Self.highlighted(code, language: language))
                    .font(.system(.callout, design: .monospaced))
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(Design.Space.m)
            }
            .scrollIndicators(.never)
        }
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Code block\(language.map { ", \($0)" } ?? "")")
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
