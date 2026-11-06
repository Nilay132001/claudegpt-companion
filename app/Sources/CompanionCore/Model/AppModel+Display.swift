import Foundation

extension AppModel {
    public var gate: Gate {
        switch connection {
        case .connecting: return .connecting
        case .stopped(let why): return .daemonStopped(why)
        case .connected: break
        }
        switch host {
        case .starting, .stopped: return .hostStarting
        case .failed(let d): return d.hasPrefix(DaemonErrorCode.securityStopPrefix) ? .securityStop(d) : .hostFailed(d)
        case .ready: break
        }
        switch auth {
        case nil: return authError.map { .authError($0) } ?? .hostStarting
        case .signedOut?: return .signedOut
        case .unsupported(let mode)?: return .authUnsupported(mode)
        case .signedIn?: break
        }
        return selectedSessionId == nil ? .noSession : .ready
    }

    public var currentMessages: [ChatMessage] { selectedSessionId.flatMap { conversations[$0]?.messages } ?? [] }
    public var isAnswering: Bool { selectedSessionId.flatMap { conversations[$0]?.isRunning } ?? false }
    public var canSend: Bool { gate == .ready && !isAnswering && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    public var currentWorktree: WorktreeResolution? { selectedSessionId.flatMap { worktrees[$0] } }
    public var currentRoot: String? {
        if case .resolved(let root, _, _)? = currentWorktree { root } else { nil }
    }

    public var repoSummary: String {
        switch currentWorktree {
        case .resolved(let root, let branch, _)?: "\(URL(fileURLWithPath: root).lastPathComponent) · \(branch ?? "detached HEAD")"
        case .unavailable?: "Repository unavailable"
        case nil: selectedSessionId == nil ? "No session" : "Repository not resolved yet"
        }
    }

    public var repoHelp: String {
        switch currentWorktree {
        case .resolved(let root, _, _)?: root
        case .unavailable(_, let detail, _, _)?: detail
        case nil: ""
        }
    }

    public var selectionLabel: String {
        guard let s = snapshot?.selection else { return "No session" }
        switch s.via {
        case "pin": return "Pinned"
        case "focus": return s.focusLabel
        default: return "No session"
        }
    }

    public var syncSummary: String {
        guard let id = selectedSessionId, let s = syncs[id] else { return "Sync: checking" }
        switch s.state {
        case "live":
            let n = s.stats?.malformedLines ?? 0
            return n > 0 ? "Live · \(n) unreadable line\(n == 1 ? "" : "s") skipped" : "Live"
        case "missing": return "Transcript not found"
        default: return "Not tracked"
        }
    }

    public var focusMovedTitle: String? {
        guard let s = snapshot, let id = s.selection.focusMovedTo else { return nil }
        return s.sessions.first { $0.sessionId == id }?.title ?? "another session"
    }

    public var currentRepoBanner: String? { selectedSessionId.flatMap { repoBanners[$0] } }
    public var currentThreadNotice: String? { selectedSessionId.flatMap { threadNotices[$0] } }

    public struct UnavailableRepo: Equatable, Sendable {
        public let detail: String
        /// Set only when approval would fix it (reason not_approved and git answered with a root).
        public let approvableRoot: String?
    }

    public var unavailableRepo: UnavailableRepo? {
        guard case .unavailable(let reason, let detail, let root, _)? = currentWorktree else { return nil }
        return UnavailableRepo(detail: detail, approvableRoot: reason == "not_approved" ? root : nil)
    }

    public var redactionNotice: String { privacy?.redactionNotice ?? RedactionNotice.text }
}

extension SecurityAlert {
    public var bannerText: String {
        switch kind {
        case "guard": "Security check stopped the reply: \(detail)"
        case "server_request": "Security check: \(detail)"
        default: detail
        }
    }
}

extension SessionSummary {
    public var locationLine: String {
        let place = (resolvedRoot ?? recordCwd).map { URL(fileURLWithPath: $0).lastPathComponent } ?? "no folder"
        return recordBranch.map { "\(place) · \($0)" } ?? place
    }
}

extension RepoLine {
    public var summary: String {
        switch state {
        case "bound": "Repository: \(root ?? "?") (\(branch ?? "detached HEAD")). GPT can read it with read-only tools."
        case "unavailable": "Repository tools are off: \(detail ?? "unavailable")."
        default: "No repository: GPT gets no repository tools."
        }
    }
}

extension PendingPreview {
    public var summaryLine: String {
        let items = prepared.preview?.items.count ?? 0
        let kb = Double(prepared.preview?.bytes ?? 0) / 1024
        var s = "\(items - removed.count) of \(items) items · \(String(format: "%.1f", kb)) KB before removals"
        if let o = prepared.preview?.omitted, o > 0 { s += " · \(o) older items left out by the size cap" }
        return s
    }
}

// MARK: Status line (M8)

/// One notice for the status line. The view shows the first and pages through the rest.
public struct StatusItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case securityAlert(SecurityAlert)
        case repoUnavailable(approvableRoot: String?)
        case desktopRecords, focusMoved, pinnedMissing, threadReplaced, syncProblem, repoChanged
    }
    public enum Tone: Equatable, Sendable { case danger, warning, info }
    public let kind: Kind
    public let text: String
    public let tone: Tone
    /// Title of the one action, if any (Approve…, Switch, Follow Claude).
    public let actionTitle: String?
    /// False for notices that stay until their cause goes away.
    public let dismissible: Bool
    public var id: String {
        switch kind {
        case .securityAlert(let a): "alert|" + a.id
        case .repoUnavailable: "repoUnavailable"
        case .desktopRecords: "desktopRecords"
        case .focusMoved: "focusMoved"
        case .pinnedMissing: "pinnedMissing"
        case .threadReplaced: "threadReplaced"
        case .syncProblem: "syncProblem"
        case .repoChanged: "repoChanged"
        }
    }
}

extension AppModel {
    /// Everything that needs attention, highest priority first: security alerts, repository unavailable, Claude's
    /// records unreadable, focus moved, kept session missing, thread replaced, sync problem, repository changed.
    public var statusItems: [StatusItem] {
        var out: [StatusItem] = alerts.reversed().map {
            StatusItem(kind: .securityAlert($0), text: $0.bannerText, tone: .danger, actionTitle: nil, dismissible: true)
        }
        if let u = unavailableRepo {
            out.append(StatusItem(kind: .repoUnavailable(approvableRoot: u.approvableRoot), text: u.detail, tone: .warning,
                                  actionTitle: u.approvableRoot == nil ? nil : "Approve…", dismissible: false))
        }
        if let msg = snapshot?.desktopRecordsError {
            out.append(StatusItem(kind: .desktopRecords, text: msg, tone: .warning, actionTitle: nil, dismissible: false))
        }
        if let moved = focusMovedTitle {
            out.append(StatusItem(kind: .focusMoved, text: "Claude is now on “\(moved)”", tone: .info, actionTitle: "Switch", dismissible: false))
        }
        if snapshot?.selection.pinnedMissing == true {
            out.append(StatusItem(kind: .pinnedMissing, text: "The session you kept is no longer listed.", tone: .warning,
                                  actionTitle: "Follow Claude", dismissible: false))
        }
        if let notice = currentThreadNotice {
            out.append(StatusItem(kind: .threadReplaced, text: notice, tone: .warning, actionTitle: nil, dismissible: true))
        }
        if let msg = syncError {
            out.append(StatusItem(kind: .syncProblem, text: "Can't read Claude's transcript: \(msg)", tone: .warning, actionTitle: nil, dismissible: true))
        }
        if let banner = currentRepoBanner {
            out.append(StatusItem(kind: .repoChanged, text: banner, tone: .info, actionTitle: nil, dismissible: true))
        }
        return out
    }

    public func dismiss(status item: StatusItem) {
        switch item.kind {
        case .securityAlert(let a): dismiss(alert: a)
        case .threadReplaced: dismissThreadNotice()
        case .syncProblem: dismissSyncError()
        case .repoChanged: dismissRepoBanner()
        case .repoUnavailable, .desktopRecords, .focusMoved, .pinnedMissing: break
        }
    }

    /// The selection and transcript state in plain words, e.g. "Following Claude's focused session · transcript up to date".
    public var followSummary: String {
        guard let s = snapshot?.selection, s.sessionId != nil else { return "No Claude session selected" }
        let who = s.via == "pin" ? "Kept on this session" : "Following Claude's focused session"
        guard let id = selectedSessionId, let sync = syncs[id] else { return who + " · checking the transcript" }
        switch sync.state {
        case "live":
            let n = sync.stats?.malformedLines ?? 0
            return who + (n > 0 ? " · transcript up to date (\(n) unreadable line\(n == 1 ? "" : "s") skipped)" : " · transcript up to date")
        case "missing": return who + " · transcript not found"
        default: return who + " · transcript not tracked"
        }
    }

    public var isKeepingSession: Bool { snapshot?.selection.via == "pin" }
}

// MARK: Context sent (M8)

public enum ContextSummary {
    /// "412 B", "3.1 KB".
    public static func size(_ bytes: Int) -> String {
        bytes < 1024 ? "\(bytes) B" : String(format: "%.1f KB", Double(bytes) / 1024)
    }

    /// The collapsed "Context sent" line for a stored turn.
    public static func line(_ r: TurnRecord) -> String {
        if r.mode == .off { return "No session context · Off" }
        if r.items.isEmpty { return "Context: question only" }
        let n = r.items.count
        return "Context sent · \(n) item\(n == 1 ? "" : "s") · \(size(r.contextBlock.utf8.count))"
    }

    /// The quiet line under the question bubble: "7 context items sent". The size is in `line` (tooltip).
    public static func short(_ r: TurnRecord) -> String {
        if r.mode == .off { return "Question only · Context off" }
        if r.items.isEmpty { return "Question only" }
        let n = r.items.count
        return "\(n) context item\(n == 1 ? "" : "s") sent"
    }
}

/// A path shown on one line as file name (primary) + parent folder (secondary, middle-truncated).
public enum PathDisplay {
    /// nil when `text` is not a single-line path.
    public static func split(_ text: String) -> (name: String, parent: String?)? {
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, !t.contains("\n") else { return nil }
        var parts = t.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        while parts.count > 1, parts.last == "" { parts.removeLast() }
        guard let name = parts.last, !name.isEmpty else { return nil }
        let rest = parts.dropLast()
        if rest.isEmpty { return (name, nil) }
        let parent = rest.joined(separator: "/")
        return (name, parent.isEmpty ? "/" : parent)
    }

    /// "from → to" (Claude changed folder) shows the folder it moved to.
    public static func folderTarget(_ text: String) -> String {
        text.components(separatedBy: " → ").last ?? text
    }
}

// MARK: History list (M8)

public struct HistorySection: Equatable, Sendable, Identifiable {
    public let title: String
    public let chats: [ChatSummary]
    public var id: String { title }
}

public enum HistorySections {
    /// Filters by `query` (session title or first question, case-insensitive) and groups into Today / Earlier,
    /// newest first. Empty sections are left out.
    public static func group(_ chats: [ChatSummary], query: String, now: Date = Date(), calendar: Calendar = .current) -> [HistorySection] {
        let q = query.trimmingCharacters(in: .whitespaces)
        let shown = chats.filter { c in
            q.isEmpty || (c.sessionTitle ?? "").localizedCaseInsensitiveContains(q) || c.firstQuestion.localizedCaseInsensitiveContains(q)
        }.sorted { $0.lastAt > $1.lastAt }
        let start = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
        let today = shown.filter { $0.lastAt >= start }
        let earlier = shown.filter { $0.lastAt < start }
        return [HistorySection(title: "Today", chats: today), HistorySection(title: "Earlier", chats: earlier)].filter { !$0.chats.isEmpty }
    }
}
