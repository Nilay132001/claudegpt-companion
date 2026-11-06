import CompanionCore
import SwiftUI

/// One quiet line under the question bubble (M8 desktop-style D5): "7 context items sent ›". Expanded, the exact
/// items that went to GPT as a list with a thin leading rule (no filled box), plus the raw `<untrusted_data>` block.
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
        #if DEBUG
        let _ = PerfProbe.count("body.ContextSentView")
        #endif
        VStack(alignment: .trailing, spacing: Design.Space.s) {
            Button {
                guard expandable else { return }
                withAnimation(Design.Motion.standard(reduceMotion: reduceMotion)) { expanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(verbatim: ContextSummary.short(record))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if expandable {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.semibold))
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.trailing, Design.Space.xs)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!expandable)
            .help(expandable ? ContextSummary.line(record) + (expanded ? "\nHide what was sent" : "\nShow exactly what was sent to GPT") : ContextSummary.line(record))
            .accessibilityLabel(ContextSummary.line(record))
            .accessibilityHint(expandable ? (expanded ? "Hide what was sent" : "Show what was sent") : "")
            .accessibilityAddTraits(expandable ? .isButton : [])

            if expanded { details.transition(.opacity) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: Design.Space.m) {
            ForEach(record.items) { item in ItemRow(item: item) }
            if record.omitted > 0 {
                Text(verbatim: "\(record.omitted) item\(record.omitted == 1 ? " was" : "s were") left out to stay within the size limits.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Design.Space.m) {
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
                    Label(showRaw ? "Hide Raw Block" : "Raw Block", systemImage: "chevron.left.forwardslash.chevron.right")
                }
                .help("The exact block GPT received, wrapped as untrusted data")
                .accessibilityLabel(showRaw ? "Hide raw block" : "Show raw block")
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            if showRaw {
                CodeBlock(model: CodeModel(language: nil, text: record.contextBlock, isOpen: false,
                                           lineCount: record.contextBlock.split(separator: "\n", omittingEmptySubsequences: false).count,
                                           reference: nil), root: nil, title: "Raw block sent to GPT", copyHelp: "Copy raw block")
                    .transition(.opacity)
            }
        }
        .padding(.leading, Design.Space.m)
        .padding(.vertical, Design.Space.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) {
            Rectangle().fill(Design.Fill.hairline).frame(width: 2)
        }
    }
}

/// One sent item: caption label (+ orange masked count), then the text: prose in body, commands and output in mono,
/// file paths as one line of file name + parent folder (6 lines, then "Show more", for long text).
private struct ItemRow: View {
    let item: TurnItem
    @State private var full = false

    /// Commands and failure output are code-like; messages and subagent text are prose.
    static func isMono(_ kind: String) -> Bool { ["command", "failure"].contains(kind) }

    private var path: (name: String, parent: String?)? {
        switch item.kind {
        case "file_edit": PathDisplay.split(item.text)
        case "folder": PathDisplay.split(PathDisplay.folderTarget(item.text))
        default: nil
        }
    }

    private var long: Bool {
        item.text.split(separator: "\n", omittingEmptySubsequences: false).count > 6 || item.text.count > 420
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: item.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if item.redactions > 0 {
                    Text(verbatim: "\(item.redactions) masked")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.orange)
                        .fixedSize()
                }
            }
            if let path {
                PathLine(name: path.name, parent: path.parent, full: item.text, arrow: item.kind == "folder")
            } else {
                Text(verbatim: item.text)
                    .font(Self.isMono(item.kind) ? .system(.callout, design: .monospaced) : .body)
                    .lineSpacing(Self.isMono(item.kind) ? 1 : 2)
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
        }
        .accessibilityElement(children: .combine)
    }
}

/// "ledgerMatcher.ts  /Volumes/…/src/reconcile" on one line: the name never truncates before the folder does.
/// The full text is in the tooltip and the accessibility label (and selectable in the raw block).
private struct PathLine: View {
    let name: String
    let parent: String?
    let full: String
    var arrow = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            if arrow {
                Image(systemName: "arrow.turn.down.right").font(.caption).foregroundStyle(.secondary)
            }
            Text(verbatim: name)
                .font(.callout.monospaced())
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            if let parent {
                Text(verbatim: parent)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        .help(full)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(full)
    }
}
