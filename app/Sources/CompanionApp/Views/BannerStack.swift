import CompanionCore
import SwiftUI

private struct ApprovalTarget: Identifiable { let root: String; var id: String { root } }

struct BannerStack: View {
    @Environment(AppModel.self) private var model
    @State private var approving: ApprovalTarget?

    var body: some View {
        VStack(spacing: 6) {
            ForEach(model.alerts) { a in
                Banner(text: a.bannerText, tone: .danger, onDismiss: { model.dismiss(alert: a) })
            }
            if let msg = model.snapshot?.desktopRecordsError { Banner(text: msg, tone: .warning) }
            if let msg = model.syncError { Banner(text: "Sync problem: \(msg)", tone: .warning, onDismiss: { model.dismissSyncError() }) }
            if let banner = model.currentRepoBanner { Banner(text: banner, onDismiss: { model.dismissRepoBanner() }) }
            if let notice = model.currentThreadNotice { Banner(text: notice, tone: .warning, onDismiss: { model.dismissThreadNotice() }) }
            if let moved = model.focusMovedTitle {
                Banner(text: "Claude focus moved to \(moved) — switch?", actionTitle: "Switch", action: { Task { await model.followFocus() } })
            }
            if model.snapshot?.selection.pinnedMissing == true {
                Banner(text: "The pinned session is no longer listed.", tone: .warning, actionTitle: "Unpin", action: { Task { await model.followFocus() } })
            }
            if let u = model.unavailableRepo {
                Banner(text: u.detail, tone: .warning, actionTitle: u.approvableRoot == nil ? nil : "Approve…",
                       action: u.approvableRoot.map { root in { approving = ApprovalTarget(root: root) } })
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, model.alerts.isEmpty && model.unavailableRepo == nil && model.currentRepoBanner == nil ? 0 : 6)
        .sheet(item: $approving) { t in ApproveSheet(root: t.root) }
    }
}
