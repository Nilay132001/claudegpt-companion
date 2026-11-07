import CompanionCore
import SwiftUI

/// A bulleted, numbered or task list. Each row is a marker column (bullet, trailing-aligned number or checkbox) and
/// the item's blocks; a nested list sits inside its item's content, so each level is indented by one marker column.
struct ListBlock: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    let list: ListModel
    let root: String?
    let depth: Int
    let path: String

    var body: some View {
        let scale = Design.Typography.scale(typeSize)
        let column = CGFloat(ListLayout.markerColumn(list)) * scale
        VStack(alignment: .leading, spacing: Design.Typography.listItemGap) {
            // Items are identified by their index inside the list: they only append while streaming.
            ForEach(list.items.indices, id: \.self) { i in
                let item = list.items[i]
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    marker(item, column: column, scale: scale)
                    NestedBlocks(blocks: item.content, root: root, listDepth: depth + 1, path: path + ".\(i)", inListItem: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func marker(_ item: ListItem, column: CGFloat, scale: CGFloat) -> some View {
        let size = Design.Typography.answerBody * scale
        if let check = item.check {
            Image(systemName: check == .done ? "checkmark.square" : "square")
                .font(.system(size: size))
                .foregroundStyle(check == .done ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                .frame(width: column, alignment: .leading)
                .accessibilityLabel(check == .done ? "done" : "to do")
        } else {
            Text(verbatim: item.marker)
                .font(.system(size: size).monospacedDigit())
                .foregroundStyle(.secondary)
                .frame(width: column, alignment: list.ordered ? .trailing : .leading)
                .accessibilityHidden(!list.ordered)
        }
    }
}
