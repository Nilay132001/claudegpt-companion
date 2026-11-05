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
        _expanded = State(initialValue: DemoFlags.is_("context") && record.turnId == "h1")
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
                Text(verbatim: "\(record.omitted) older item\(record.omitted == 1 ? " was" : "s were") left out by the 12 KB cap.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if showRaw {
                ScrollView(.horizontal) {
                    Text(verbatim: record.contextBlock)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: true)
                        .padding(Design.Space.s)
                }
                .frame(maxHeight: 220)
                .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 6))
            }
            HStack(spacing: Design.Space.m) {
                Button {
                    Design.copy(record.contextBlock)
                    copied.flash()
                } label: {
                    Label(copied.on ? "Copied" : "Copy Context", systemImage: copied.on ? "checkmark" : "doc.on.doc")
                }
                Button(showRaw ? "Hide Raw Block" : "Show Raw Block") { showRaw.toggle() }
                    .help("The exact block GPT received, wrapped as untrusted data")
            }
            .buttonStyle(.borderless)
            .font(.caption)
        }
        .padding(Design.Space.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// One sent item: label, masked count, selectable mono text (6 lines, then "Show more").
private struct ItemRow: View {
    let item: TurnItem
    @State private var full = false

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
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(full ? nil : 6)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            if !full && item.text.split(separator: "\n", omittingEmptySubsequences: false).count > 6 || (!full && item.text.count > 420) {
                Button("Show More") { full = true }.buttonStyle(.link).font(.caption)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
