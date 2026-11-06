import CompanionCore
import SwiftUI

/// An answer's blocks, top to bottom, spaced by `BlockSpacing`. Blocks are keyed by `BlockID`, so closed blocks keep
/// their identity while the answer streams. The single link kind is companion-open (path:line inside the root).
struct BlockStack: View {
    @Environment(AppModel.self) private var model
    let answer: RenderedAnswer
    let root: String?

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.BlockStack")
        #endif
        VStack(alignment: .leading, spacing: 0) {
            // The enumeration only looks up the previous block; the id is the BlockID.
            ForEach(Array(answer.blocks.enumerated()), id: \.element.id) { i, b in
                BlockView(block: b.block, root: root, listDepth: 0)
                    .padding(.top, BlockSpacing.gap(before: b.block, after: i > 0 ? answer.blocks[i - 1].block : nil))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            // Checked again here: the root may have changed since the reply was rendered.
            guard let ref = EditorLink.parseCompanionURL(url), let root,
                  let path = FileReferences.contained(ref.path, root: root) else { return .discarded }
            FileOpener.open(FileReference(path: path, line: ref.line), root: root, editor: model.settings.editor)
            return .handled
        })
    }
}

/// One block. Lists and quotes contain blocks, so they come back here for their content.
struct BlockView: View {
    let block: AnswerBlock
    let root: String?
    let listDepth: Int

    var body: some View {
        switch block {
        case .paragraphs(let t): ProseBlock(text: t)
        case .heading(let level, let t): HeadingBlock(level: level, text: t)
        case .list(let l): ListBlock(list: l, root: root, depth: listDepth)
        case .quote(let bs): QuoteBlock(blocks: bs, root: root)
        case .code(let c): CodeBlock(model: c, root: root)
        case .table(let t): TableBlock(table: t)
        case .rule: RuleBlock()
        case .math(let m): MathBlock(text: m)
        }
    }
}

/// Blocks inside a list item or a quote, with the same spacing as at the top level.
struct NestedBlocks: View {
    let blocks: [AnswerBlock]
    let root: String?
    let listDepth: Int
    /// Inside a list item: a nested list follows its item's text at the list item gap, not the paragraph gap.
    var inListItem = false

    private func gap(_ i: Int) -> Double {
        guard i > 0 else { return 0 }
        if inListItem, case .list = blocks[i] { return Double(Design.Typography.listItemGap) }
        return BlockSpacing.gap(before: blocks[i], after: blocks[i - 1])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Nested blocks have no BlockID; their order inside a closed chunk never changes, and an open chunk only
            // appends, so the index is a stable identity here.
            ForEach(blocks.indices, id: \.self) { i in
                BlockView(block: blocks[i], root: root, listDepth: listDepth)
                    .padding(.top, gap(i))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
