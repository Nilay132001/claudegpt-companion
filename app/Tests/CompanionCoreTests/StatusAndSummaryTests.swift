import Foundation
import Testing
@testable import CompanionCore

@MainActor @Suite struct StatusItemsTests {
    func started(_ d: FakeDaemon = FakeDaemon()) async -> AppModel {
        let m = AppModel(connector: { d.connection })
        await m.start()
        await m.detailLoad?.value
        return m
    }

    @Test func emptyWhenNothingNeedsAttention() async {
        let m = await started()
        #expect(m.statusItems.isEmpty)
    }

    @Test func ordersByPriorityAndDismisses() async {
        let d = FakeDaemon()
        d.snapshot = FakeDaemon.snap(selected: "s1", focusMovedTo: "s2")
        d.worktree = .unavailable(reason: "not_approved", detail: "SYNTHETIC FIXTURE not approved", root: "/r", candidate: nil)
        let m = await started(d)
        m.handle(.syncError("SYNTHETIC FIXTURE sync"))
        m.handle(.threadReplaced(ThreadReplaced(sessionId: "s1", threadId: "t9", reason: "x")))
        m.handle(.securityAlert(SecurityAlert(sessionId: "s1", threadId: nil, turnId: nil, kind: "guard", detail: "SYNTHETIC FIXTURE blocked")))
        let kinds = m.statusItems.map(\.id)
        #expect(kinds.first?.hasPrefix("alert|") == true)
        #expect(Array(kinds.dropFirst()) == ["repoUnavailable", "focusMoved", "threadReplaced", "syncProblem"])
        #expect(m.statusItems[1].actionTitle == "Approve…")
        #expect(m.statusItems[1].kind == .repoUnavailable(approvableRoot: "/r"))
        #expect(m.statusItems[2].text == "Claude is now on “SYNTHETIC FIXTURE two”")
        #expect(m.statusItems[0].tone == .danger)

        m.dismiss(status: m.statusItems[0])
        m.dismiss(status: m.statusItems.first { $0.kind == .syncProblem }!)
        m.dismiss(status: m.statusItems.first { $0.kind == .focusMoved }!) // not dismissible: stays
        #expect(m.statusItems.map(\.id) == ["repoUnavailable", "focusMoved", "threadReplaced"])
    }

    @Test func followSummaryInPlainWords() async {
        let m = await started()
        #expect(m.followSummary == "Following Claude's focused session · transcript up to date (1 unreadable line skipped)")
        let d = FakeDaemon()
        d.snapshot = FakeDaemon.snap(selected: nil)
        #expect(await started(d).followSummary == "No Claude session selected")
    }
}

@Suite struct ContextSummaryTests {
    func record(mode: SharingMode, items: Int, bytes: Int) -> TurnRecord {
        TurnRecord(turnId: "u1", sessionId: "s1", threadId: "t1", mode: mode, question: "q",
                   contextBlock: String(repeating: "x", count: bytes),
                   items: (0..<items).map { TurnItem(kind: "user", label: "L", text: "SYNTHETIC FIXTURE", redactions: 0, index: $0) },
                   answer: "a")
    }

    @Test func lines() {
        #expect(ContextSummary.line(record(mode: .ask, items: 6, bytes: 3174)) == "Context sent · 6 items · 3.1 KB")
        #expect(ContextSummary.line(record(mode: .automatic, items: 1, bytes: 412)) == "Context sent · 1 item · 412 B")
        #expect(ContextSummary.line(record(mode: .off, items: 0, bytes: 0)) == "No session context · Off")
        #expect(ContextSummary.line(record(mode: .ask, items: 0, bytes: 0)) == "Context: question only")
    }

    /// The quiet line under the question bubble (M8 desktop-style D5); the size stays in line() for the tooltip.
    @Test func shortLines() {
        #expect(ContextSummary.short(record(mode: .ask, items: 7, bytes: 3174)) == "7 context items sent")
        #expect(ContextSummary.short(record(mode: .automatic, items: 1, bytes: 412)) == "1 context item sent")
        #expect(ContextSummary.short(record(mode: .off, items: 0, bytes: 0)) == "Question only · Context off")
        #expect(ContextSummary.short(record(mode: .ask, items: 0, bytes: 0)) == "Question only")
    }
}

@Suite struct PathDisplayTests {
    @Test func fileNameAndParent() {
        let p = PathDisplay.split("/Volumes/Work/acme/packages/worker/src/ledgerMatcher.ts")
        #expect(p?.name == "ledgerMatcher.ts")
        #expect(p?.parent == "/Volumes/Work/acme/packages/worker/src")
        #expect(PathDisplay.split("/tokenize.ts")?.parent == "/")
        #expect(PathDisplay.split("tokenize.ts")?.parent == nil)
        #expect(PathDisplay.split("src/a.ts")?.parent == "src")
    }

    @Test func notAPath() {
        #expect(PathDisplay.split("") == nil)
        #expect(PathDisplay.split("two\nlines/a.ts") == nil)
        #expect(PathDisplay.split("/Volumes/Work/")?.name == "Work")
    }

    @Test func folderChangeTarget() {
        #expect(PathDisplay.folderTarget("/a/b → /a/b/c") == "/a/b/c")
        #expect(PathDisplay.folderTarget("/a/b") == "/a/b")
    }
}

@Suite struct HistorySectionsTests {
    @Test func groupsAndFilters() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_000_000) // 1970-01-12 13:46 UTC
        func chat(_ id: String, _ title: String, _ q: String, hoursAgo: Double) -> ChatSummary {
            let at = (now.timeIntervalSince1970 - hoursAgo * 3600) * 1000
            return ChatSummary(sessionId: "s", threadId: id, sessionTitle: title, firstQuestion: q, turns: 1, startedAt: at, lastAt: at)
        }
        let chats = [chat("a", "Parser", "Why?", hoursAgo: 30), chat("b", "CSV export", "How?", hoursAgo: 1), chat("c", "Parser", "Fix", hoursAgo: 2)]
        let all = HistorySections.group(chats, query: "", now: now, calendar: cal)
        #expect(all.map(\.title) == ["Today", "Earlier"])
        #expect(all[0].chats.map(\.threadId) == ["b", "c"])
        #expect(all[1].chats.map(\.threadId) == ["a"])
        #expect(HistorySections.group(chats, query: "parser", now: now, calendar: cal).flatMap(\.chats).map(\.threadId) == ["c", "a"])
        #expect(HistorySections.group(chats, query: "how", now: now, calendar: cal).flatMap(\.chats).map(\.threadId) == ["b"])
        #expect(HistorySections.group(chats, query: "zzz", now: now, calendar: cal).isEmpty)
    }
}

@Suite struct ReplySegmentsTests {
    @Test func proseRunsAreOneStringBetweenCodeBlocks() {
        let md = "# Title\nIntro\n\n- one\n- two\n\n```ts\nlet x = 1\n```\nAfter `code`"
        var roles: [ProseRole] = []
        let segs = ReplyMarkdown.segments(md, root: nil) { role, _ in roles.append(role) }
        #expect(segs.count == 3)
        guard case .prose(let first) = segs[0], case .code(let lang, let code) = segs[1], case .prose(let last) = segs[2] else {
            Issue.record("unexpected segments \(segs)")
            return
        }
        #expect(String(first.characters) == "Title\n\nIntro\n\n•  one\n•  two")
        #expect(lang == "ts" && code == "let x = 1")
        #expect(String(last.characters) == "After code")
        #expect(roles == [.heading(level: 1), .paragraph, .gap, .bullet, .gap, .bullet, .paragraph]) // each piece, then the gap before it
    }

    @Test func styleIsApplied() {
        let segs = ReplyMarkdown.segments("## Head", root: nil) { role, s in
            if case .heading = role { s.link = URL(string: "x:") }
        }
        guard case .prose(let s) = segs.first else { Issue.record("no prose"); return }
        #expect(s.runs.allSatisfy { $0.link != nil })
    }

    @Test func linksStayRemovedInsideRuns() {
        let segs = ReplyMarkdown.segments("See [x](https://evil.example)\n\n- ![p](https://evil.example/p.png)", root: nil)
        guard case .prose(let s) = segs.first else { Issue.record("no prose"); return }
        #expect(s.runs.allSatisfy { $0.link == nil && $0.imageURL == nil })
    }
}
