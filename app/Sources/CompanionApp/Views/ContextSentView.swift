import CompanionCore
import SwiftUI

/// "Context sent · 6 items · 3.1 KB" under a question: collapsed by default; expands to the exact items that went
/// to GPT, plus the raw `<untrusted_data>` block.
struct ContextSentView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let record: TurnRecord
    @State private var expanded: Bool
    @State private var showRaw = false
    @State private var copied = CopiedFlag()

    init(record: TurnRecord) {
        self.record = record
        #if DEBUG
        _expanded = State(initialValue: (DemoFlags.is_("context") || DemoFlags.is_("raw")) && record.turnId == "h1")
        _showRaw = State(initialValue: DemoFlags.is_("raw") && record.turnId == "h1")
        #else
        _expanded = State(initialValue: false)
        #endif
    }

    private var expandable: Bool { !record.items.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: Design.Space.s) {
            Button {
                guard expandable else { return }
                withAnimation(Design.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: record.mode == .off ? "eye.slash" : "doc.text.magnifyingglass")
                    Text(verbatim: ContextSummary.line(record))
                    if expandable {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!expandable)
            .help(expandable ? (expanded ? "Hide what was sent" : "Show exactly what was sent to GPT") : "")
            .accessibilityLabel(ContextSummary.line(record))
            .accessibilityHint(expandable ? (expanded ? "Hide what was sent" : "Show what was sent") : "")
            .accessibilityAddTraits(expandable ? .isButton : [])

            if expanded { details.transition(.opacity) }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            ForEach(record.items) { item in ItemRow(item: item) }
            if record.omitted > 0 {
                Text(verbatim: "\(record.omitted) item\(record.omitted == 1 ? " was" : "s were") left out to stay within the size limits.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: Design.Space.s) {
                Button {
                    Design.copy(record.contextBlock)
                    copied.flash()
                } label: {
                    Label(copied.on ? "Copied" : "Copy Context", systemImage: copied.on ? "checkmark" : "doc.on.doc")
                }
                .help("Copy the exact block GPT received")
                Button {
                    withAnimation(Design.Motion.standard(reduceMotion: reduceMotion)) { showRaw.toggle() }
                } label: {
                    Label(showRaw ? "Hide Raw Block" : "Show Raw Block", systemImage: "chevron.left.forwardslash.chevron.right")
                }
                .help("The exact block GPT received, wrapped as untrusted data")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            if showRaw {
                CodeBlockView(language: nil, code: record.contextBlock, title: "Raw block sent to GPT", copyHelp: "Copy raw block")
                    .transition(.opacity)
            }
        }
        .padding(Design.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// One sent item: label, masked count, selectable text (6 lines, then "Show more"). Mono only for code-like kinds.
private struct ItemRow: View {
    let item: TurnItem
    @State private var full = false

    /// Commands, failure output, edited-file and folder paths are code-like; messages and subagent text are prose.
    static func isMono(_ kind: String) -> Bool { ["command", "failure", "file_edit", "folder"].contains(kind) }

    private var long: Bool {
        item.text.split(separator: "\n", omittingEmptySubsequences: false).count > 6 || item.text.count > 420
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: item.label).font(.caption.weight(.semibold))
                if item.redactions > 0 {
                    Text(verbatim: "\(item.redactions) masked")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                }
            }
            Text(verbatim: item.text)
                .font(Self.isMono(item.kind) ? .system(.callout, design: .monospaced) : .body)
                .foregroundStyle(Self.isMono(item.kind) ? .secondary : .primary)
                .lineLimit(full ? nil : 6)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if long {
                Button {
                    full.toggle()
                } label: {
                    Label(full ? "Show Less" : "Show More", systemImage: full ? "chevron.up" : "chevron.down")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.tint)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
