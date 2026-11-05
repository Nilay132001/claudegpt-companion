import Foundation
import Testing
@testable import CompanionCore

@MainActor @Suite struct AppModelTests {
    func started(_ d: FakeDaemon = FakeDaemon()) async -> (AppModel, FakeDaemon) {
        let m = AppModel(connector: { d.connection })
        await m.start()
        await m.detailLoad?.value
        return (m, d)
    }

    @Test func startLoadsEverything() async {
        let (m, d) = await started()
        #expect(m.connection == .connected(daemonVersion: "0.4.0"))
        #expect(m.gate == .ready)
        #expect(Array(d.calls.prefix(3)) == ["daemon.hello", "host.status", "privacy.get"])
        #expect(d.calls.contains("auth.status"))
        #expect(m.repoSummary == "r · main")
        #expect(m.selectionLabel == "Claude focus (from Claude's records)")
        #expect(m.syncSummary == "Live · 1 unreadable line skipped")
        #expect(m.redactionNotice == RedactionNotice.text)
    }

    @Test func gates() async {
        let m0 = AppModel(connector: { throw DaemonLaunchError.nodeNotFound })
        await m0.start()
        #expect(m0.gate == .daemonStopped(DaemonLaunchError.nodeNotFound.errorDescription!))

        let d1 = FakeDaemon()
        d1.host = .failed(detail: "Codex is not installed.")
        #expect(await started(d1).0.gate == .hostFailed("Codex is not installed."))

        let d2 = FakeDaemon()
        d2.auth = .signedOut
        #expect(await started(d2).0.gate == .signedOut)

        let d3 = FakeDaemon()
        d3.snapshot = FakeDaemon.snap(selected: nil)
        #expect(await started(d3).0.gate == .noSession)
    }

    @Test func askShowsThePreviewAndSendsOnlyAfterConfirm() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true))]
        let (m, _) = await started(d)
        m.draft = "  What broke?  "
        await m.submitDraft()
        #expect(m.draft == "")
        #expect(m.preview?.prepared.prepareId == "p1")
        #expect(!d.calls.contains { $0.hasPrefix("chat.send") })
        m.toggle(itemId: "item-2")
        #expect(m.preview?.summaryLine.hasPrefix("1 of 2 items") == true)
        await m.confirmPreview()
        #expect(m.preview == nil)
        #expect(d.sendParams.map(\.prepareId) == ["p1"])
        #expect(d.sendParams.first?.removed == ["item-2"])
        #expect(d.sendParams.first?.confirmed == true)
        #expect(m.currentMessages.map(\.text) == ["What broke?", ""])
        #expect(m.currentMessages.last?.turnId == "u1")
        #expect(m.isAnswering)
    }

    @Test func cancellingThePreviewSendsNothingAndRestoresTheDraft() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true))]
        let (m, _) = await started(d)
        m.draft = "Why?"
        await m.submitDraft()
        m.cancelPreview()
        #expect(m.preview == nil)
        #expect(m.draft == "Why?")
        #expect(!d.calls.contains { $0.hasPrefix("chat.send") })
        #expect(m.currentMessages.isEmpty)
    }

    @Test func offAndAutomaticSendAtOnce() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .off))]
        let (m, _) = await started(d)
        #expect(await m.ask("q"))
        #expect(m.preview == nil)
        #expect(d.sendParams.map(\.prepareId) == ["p1"])
        #expect(d.sendParams.first?.confirmed == false)
    }

    @Test func anAskPrepareAlwaysShowsTheSheet() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .ask))]
        let (m, _) = await started(d)
        await m.ask("q")
        #expect(m.preview?.prepared.prepareId == "p1")
        #expect(d.sendParams.isEmpty)
    }

    @Test func aRefusedUnconfirmedSendIsPreviewedAgain() async {
        let d = FakeDaemon()
        // Automatic prepare, then the mode became Ask: the daemon refuses the unconfirmed send (1011).
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: false, mode: .automatic)),
                            .success(FakeDaemon.prepared("p2", needsConfirm: true))]
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.confirmRequired, message: "Confirm what will be shared before sending."))]
        let (m, _) = await started(d)
        await m.ask("q")
        #expect(m.preview?.prepared.prepareId == "p2")
        #expect(m.currentMessages.isEmpty)
        await m.confirmPreview()
        #expect(d.sendParams.map(\.confirmed) == [false, true])
    }

    @Test func tooLongQuestionsAreRefusedLocally() async {
        let (m, d) = await started()
        #expect(await m.ask(String(repeating: "x", count: 20_001)) == false)
        #expect(m.errorMessage != nil)
        #expect(!d.calls.contains { $0.hasPrefix("chat.prepare") })
    }

    @Test func anExpiredPrepareIsPreparedAgain() async {
        let d = FakeDaemon()
        d.prepareResults = [.success(FakeDaemon.prepared("p1", needsConfirm: true)), .success(FakeDaemon.prepared("p2", needsConfirm: true))]
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.prepareExpired, message: "expired"))]
        let (m, _) = await started(d)
        await m.ask("q")
        await m.confirmPreview()
        #expect(m.preview?.prepared.prepareId == "p2")
        #expect(m.preview?.notice != nil)
        #expect(m.currentMessages.isEmpty)
    }

    @Test func eventsBeforeTheSendAnswerLandInTheReplyAndAutoPlay() async {
        let (m, d) = await started()
        m.setSetting(\.autoPlay, true)
        var played: [String] = []
        m.onReplyCompleted = { _, text in played.append(text) }
        d.duringSend = {
            m.handle(.chatDelta(ChatDelta(sessionId: "s1", threadId: "t1", turnId: "u1", itemId: "i1", text: "See src/a.ts:3")))
            m.handle(.turnCompleted(TurnCompleted(sessionId: "s1", threadId: "t1", turnId: "u1", status: "completed", error: nil)))
        }
        await m.ask("q")
        #expect(m.currentMessages.last?.text == "See src/a.ts:3")
        #expect(m.currentMessages.last?.status == .done)
        #expect(played == ["See src/a.ts:3"])
    }

    @Test func busyOffersSendAgainWithTheSamePrepare() async {
        let d = FakeDaemon()
        d.sendResults = [.failure(DaemonError(code: DaemonErrorCode.hostBusy, message: "Too many … busy"))]
        let (m, _) = await started(d)
        await m.ask("one")
        let failed = m.currentMessages.last!
        #expect(failed.status == .failed("Too many repositories are busy right now. Try again in a moment."))
        #expect(failed.retry?.prepareId == "p-auto")
        await m.sendAgain(failed)
        #expect(d.sendParams.map(\.prepareId) == ["p-auto", "p-auto"])
        #expect(m.currentMessages.map(\.text) == ["one", ""])
        #expect(m.isAnswering)
    }

    @Test func abandonedRepliesEndOnTheDaemonsWord() async {
        let (m, _) = await started()
        await m.ask("two")
        m.handle(.hostChanged(.starting))
        #expect(m.isAnswering) // no guessing from host state
        m.handle(.turnCompleted(TurnCompleted(sessionId: "s1", threadId: "t1", turnId: "u1", status: "abandoned",
                                              error: "Codex restarted before this reply finished. Ask again.")))
        #expect(m.currentMessages.last?.status == .failed("Codex restarted before this reply finished. Ask again."))
        #expect(m.gate == .hostStarting)
    }

    @Test func eventsWithoutASessionIdWaitForTheSendAnswer() async {
        let (m, d) = await started()
        d.duringSend = {
            m.handle(.chatDelta(ChatDelta(sessionId: nil, threadId: "t1", turnId: "u1", itemId: "i1", text: "early")))
        }
        await m.ask("q")
        #expect(m.currentMessages.last?.text == "early")
    }

    @Test func securityStopNeedsAcknowledgeAndRestartsAreRefused() async {
        let d = FakeDaemon()
        d.host = .failed(detail: "Security check failed: Codex started a commandExecution item")
        let (m, _) = await started(d)
        #expect(m.gate == .securityStop("Security check failed: Codex started a commandExecution item"))
        await m.restartHost()
        await m.restartDaemon()
        #expect(!d.calls.contains("host.restart"))
        #expect(!d.calls.contains("daemon.shutdown"))
        await m.acknowledgeSecurityStop()
        #expect(d.calls.contains("host.acknowledgeSecurityStop"))
        #expect(m.gate == .ready)
    }

    @Test func aDisconnectedDaemonCanBeRestartedEvenAfterASecurityStop() async {
        let d = FakeDaemon()
        d.host = .failed(detail: "Security check failed: x")
        let (m, _) = await started(d)
        m.handle(.disconnected)
        #expect(m.gate == .daemonStopped("companiond stopped."))
        await m.restartDaemon()
        #expect(d.calls.filter { $0 == "daemon.hello" }.count == 2) // connected again
    }

    @Test func aFailureAfterHelloKeepsTheDaemonConnectedAndTheSecurityStopBinding() async {
        let d = FakeDaemon()
        d.host = .failed(detail: "Security check failed: x")
        d.privacyError = DaemonError(code: DaemonErrorCode.invalidParams, message: "privacy unavailable")
        let (m, _) = await started(d)
        #expect(m.connection == .connected(daemonVersion: "0.4.0"))
        #expect(m.gate == .securityStop("Security check failed: x"))
        #expect(m.errorMessage == "privacy unavailable")
        await m.restartDaemon()
        #expect(!d.calls.contains("daemon.shutdown"))
    }

    @Test func authErrorHasAWayOut() async {
        let d = FakeDaemon()
        d.authError = DaemonError(code: DaemonErrorCode.hostNotReady, message: "Codex is not ready.")
        let (m, _) = await started(d)
        #expect(m.gate == .authError("Codex is not ready."))
        d.authError = nil
        await m.loadAuth()
        #expect(m.gate == .ready)
    }

    @Test func revokeShowsRepliesStillFinishing() async {
        let (m, d) = await started()
        await m.revoke(root: "/r")
        #expect(d.calls.contains("privacy.revoke:/r"))
        #expect(m.revokeNotice == nil) // nothing pending
        d.revokePending = 2
        await m.revoke(root: "/r")
        #expect(m.revokeNotice?.hasPrefix("2 conversations are still being stopped") == true)
        #expect(m.revokeNotice?.contains("GPT may still read") == true)
        d.revokePending = 0
        await m.revoke(root: "/r") // fake answers revoked: true, pendingClose: 0 → the notice is replaced (now nothing pending)
        #expect(m.revokeNotice == nil)
        d.revokePending = 1
        await m.revoke(root: "/r")
        m.dismissRevokeNotice()
        #expect(m.revokeNotice == nil)
        #expect(AppModel.revokeText(RevokeResult(revoked: false, pendingClose: 3)) == nil)
    }

    @Test func threadNoticesAndExplainInOff() async {
        let (m, _) = await started()
        m.handle(.threadReplaced(ThreadReplaced(sessionId: "s1", threadId: "t9", reason: "resume_refused")))
        #expect(m.currentThreadNotice == AppModel.threadReplacedNotice)
        m.dismissThreadNotice()
        #expect(m.currentThreadNotice == nil)
        await m.setSharingMode(.off)
        #expect(!m.canExplain)
    }

    @Test func approvals() async {
        let d = FakeDaemon()
        d.worktree = .unavailable(reason: "not_approved", detail: "This repository is not approved.", root: "/r", candidate: "/r")
        let (m, _) = await started(d)
        #expect(m.unavailableRepo == AppModel.UnavailableRepo(detail: "This repository is not approved.", approvableRoot: "/r"))
        d.approveError = DaemonError(code: DaemonErrorCode.approvalRefused, message: "refused", data: .object(["reason": .string("home_or_root")]))
        #expect(await m.approve(root: "/r", includeWorktrees: true) == "Your home folder, a folder that contains it, or the disk root cannot be approved.")
        d.approveError = nil
        d.worktree = .resolved(root: "/r", branch: "main", isLinkedWorktree: true)
        #expect(await m.approve(root: "/r", includeWorktrees: true) == nil)
        #expect(d.calls.contains("privacy.approve:/r:true"))
        #expect(m.unavailableRepo == nil)

        d.worktree = .unavailable(reason: "repo_refused", detail: "Refused: core.pager is set.", root: "/r", candidate: "/r")
        await m.refresh()
        #expect(m.unavailableRepo?.approvableRoot == nil) // only not_approved offers approval
    }

    @Test func alertsBannersAndDisconnect() async {
        let (m, _) = await started()
        let a = SecurityAlert(sessionId: "s1", threadId: "t1", turnId: "u1", kind: "guard", detail: "Codex started a commandExecution item")
        m.handle(.securityAlert(a))
        m.handle(.securityAlert(a))
        #expect(m.alerts.count == 1)
        #expect(a.bannerText == "Security check stopped the reply: Codex started a commandExecution item")
        m.handle(.sessionWorktree(WorktreeEvent(sessionId: "s1", resolution: .resolved(root: "/r2", branch: "b", isLinkedWorktree: true),
                                                change: RepoChange(from: "/r", to: "/r2", banner: "Claude is now in /r2 (b)", contextNote: "Repository changed from /r to /r2"))))
        #expect(m.currentRepoBanner == "Claude is now in /r2 (b)")
        #expect(m.repoSummary == "r2 · b")
        m.dismissRepoBanner()
        #expect(m.currentRepoBanner == nil)
        m.handle(.disconnected)
        #expect(m.gate == .daemonStopped("companiond stopped."))
    }

    @Test func viewSentFindsTheRecordOrSaysNotKept() async {
        let (m, d) = await started()
        await m.ask("q")
        let reply = m.currentMessages.last!
        await m.viewSent(reply)
        #expect(m.sentView == .notKept(turnId: "u1"))
        d.sent = [SentRecord(sessionId: "s1", threadId: "t1", turnId: "u1", contextBlock: "<untrusted_data source=\"claude-session\">SYNTHETIC FIXTURE</untrusted_data>", question: "q", sentAt: 1)]
        await m.viewSent(reply)
        if case .found(let r)? = m.sentView { #expect(r.question == "q") } else { Issue.record("record not found") }
    }

    @Test func pinFocusChipAndSettings() async {
        let d = FakeDaemon()
        d.snapshot = FakeDaemon.snap(selected: "s1", via: "pin", focusMovedTo: "s2")
        let (m, _) = await started(d)
        #expect(m.selectionLabel == "Pinned")
        #expect(m.focusMovedTitle == "SYNTHETIC FIXTURE two")
        await m.followFocus()
        #expect(d.calls.contains("sessions.pin:null"))
        await m.pin("s2")
        #expect(m.selectedSessionId == "s2")
        m.setSetting(\.speechRate, 1.5)
        await m.settingsWrite?.value
        #expect(d.stored["ui.speech.rate"] == "1.5")
        await m.setSharingMode(.off)
        #expect(m.privacy?.sharingMode == .off)
    }
}
