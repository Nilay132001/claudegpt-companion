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
