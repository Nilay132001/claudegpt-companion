import Foundation
import Testing
@testable import CompanionCore

/// Shapes copied from the M4b plan ("Interfaces produced for M5", Task 6 tests). SYNTHETIC FIXTURE values only.
@Suite struct DaemonModelsTests {
    private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

    @Test func hostAndAuthStates() throws {
        #expect(try RPCCodec.value(json(#"{"state":"ready","warnings":["w"]}"#), as: HostState.self) == .ready(warnings: ["w"]))
        #expect(try RPCCodec.value(json(#"{"state":"failed","detail":"Chat is off (COMPANIOND_CODEX=off)."}"#), as: HostState.self)
            == .failed(detail: "Chat is off (COMPANIOND_CODEX=off)."))
        #expect(try RPCCodec.value(json(#"{"state":"weird"}"#), as: HostState.self) == .failed(detail: "Unknown Codex state: weird"))
        #expect(try RPCCodec.value(json(#"{"state":"signed_in","planType":null}"#), as: AuthState.self) == .signedIn(planType: nil))
        #expect(try RPCCodec.value(json(#"{"state":"unsupported","mode":"apikey"}"#), as: AuthState.self) == .unsupported(mode: "apikey"))
    }

    static let snapshotJSON = #"""
    {"sessions":[{"sessionId":"s1","cliSessionId":"c1","title":"SYNTHETIC FIXTURE fix login","status":"busy","isArchived":false,
      "lastFocusedAt":10,"lastActivityAt":11,"recordCwd":"/r","recordBranch":"main","resolvedRoot":"/r","source":"desktop",
      "transcriptPath":"/t.jsonl","transcriptMissing":null},
     {"sessionId":"s2","cliSessionId":null,"title":"SYNTHETIC FIXTURE two","status":"strange","isArchived":true,
      "lastFocusedAt":null,"lastActivityAt":null,"recordCwd":null,"recordBranch":null,"resolvedRoot":null,"source":"transcript_only",
      "transcriptPath":null,"transcriptMissing":"not_found"}],
     "selection":{"sessionId":"s1","via":"focus","focusedSessionId":"s1","focusLabel":"Claude focus (from Claude's records)",
      "focusMovedTo":null,"pinnedMissing":false},
     "desktopRecordsError":null,"refreshedAt":12}
    """#

    @Test func snapshotDecodes() throws {
        let s = try RPCCodec.value(json(Self.snapshotJSON), as: SessionsSnapshot.self)
        #expect(s.sessions.map(\.id) == ["s1", "s2"])
        #expect(s.sessions[0].status == .busy)
        #expect(s.sessions[1].status == .inactive) // unknown status tolerated
        #expect(s.selection.via == "focus")
        #expect(s.selection.focusLabel == "Claude focus (from Claude's records)")
    }

    @Test func worktreeResolutions() throws {
        #expect(try RPCCodec.value(json(#"{"kind":"resolved","root":"/r","gitDir":"/r/.git","gitCommonDir":"/r/.git","isLinkedWorktree":false,"branch":"main","candidate":"/r","candidateSource":"transcript"}"#), as: WorktreeResolution.self)
            == .resolved(root: "/r", branch: "main", isLinkedWorktree: false))
        #expect(try RPCCodec.value(json(#"{"kind":"unavailable","reason":"not_approved","detail":"not approved","candidate":"/r","candidateSource":"transcript","root":"/r","gitCommonDir":"/r/.git"}"#), as: WorktreeResolution.self)
            == .unavailable(reason: "not_approved", detail: "not approved", root: "/r", candidate: "/r"))
        #expect(try RPCCodec.value(.null, as: WorktreeResolution?.self) == nil)
    }

    @Test func preparedAndSent() throws {
        let p = try RPCCodec.value(json(#"""
        {"prepareId":"p1","sessionId":"s1","mode":"ask","needsConfirm":true,"repoNote":null,"sessionTitle":"SYNTHETIC FIXTURE title",
         "repo":{"state":"bound","root":"/r","branch":"main","detail":null},
         "preview":{"items":[{"id":"item-1","kind":"user","label":"You","text":"SYNTHETIC FIXTURE first","redactions":1}],
           "notes":["Cursor reset"],"omitted":2,"bytes":120,"cursorAfter":"u2","subagents":[]}}
        """#), as: Prepared.self)
        #expect(p.needsConfirm)
        #expect(p.mode == .ask)
        #expect(p.preview?.items.first?.redactions == 1)
        #expect(p.preview?.omitted == 2)
        #expect(p.sessionTitle == "SYNTHETIC FIXTURE title")
        let off = try RPCCodec.value(json(#"{"prepareId":"p2","sessionId":"s1","mode":"off","needsConfirm":false,"repoNote":null,"sessionTitle":null,"repo":{"state":"none","root":null,"branch":null,"detail":null},"preview":null}"#), as: Prepared.self)
        #expect(off.preview == nil)
        #expect(off.sessionTitle == nil)
        #expect(try RPCCodec.value(json(#"{"revoked":true,"pendingClose":2}"#), as: RevokeResult.self) == RevokeResult(revoked: true, pendingClose: 2))
        let sent = try RPCCodec.value(json(#"[{"sessionId":"s1","threadId":"t1","turnId":"u1","contextBlock":"<untrusted_data>x</untrusted_data>","question":"q","sentAt":5}]"#), as: [SentRecord].self)
        #expect(sent.first?.turnId == "u1")
    }

    @Test func syncStatsTolerateMissingCounters() throws {
        let s = try RPCCodec.value(json(#"{"state":"live","stats":{"records":4,"malformedLines":1},"lastPollAt":3}"#), as: SyncStatus.self)
        #expect(s.stats?.records == 4)
        #expect(s.stats?.malformedLines == 1)
        #expect(s.stats?.droppedEvents == 0)
    }

    @Test func eventsDecode() throws {
        #expect(DaemonEvent.decode(method: "chat.delta", params: try json(#"{"sessionId":"s1","threadId":"t","turnId":"u","itemId":"i","text":"Hi"}"#))
            == .chatDelta(ChatDelta(sessionId: "s1", threadId: "t", turnId: "u", itemId: "i", text: "Hi")))
        #expect(DaemonEvent.decode(method: "chat.turnCompleted", params: try json(#"{"sessionId":null,"threadId":"t","turnId":"u","status":"completed","error":null}"#))
            == .turnCompleted(TurnCompleted(sessionId: nil, threadId: "t", turnId: "u", status: "completed", error: nil)))
        #expect(DaemonEvent.decode(method: "security.alert", params: try json(#"{"sessionId":"s1","threadId":"t","turnId":"u","kind":"guard","detail":"Codex started a commandExecution item"}"#))
            == .securityAlert(SecurityAlert(sessionId: "s1", threadId: "t", turnId: "u", kind: "guard", detail: "Codex started a commandExecution item")))
        if case .sessionWorktree(let w) = DaemonEvent.decode(method: "session.worktree", params: try json(#"{"sessionId":"s1","resolution":{"kind":"resolved","root":"/r","branch":null,"isLinkedWorktree":true},"change":{"from":"/a","to":"/r","banner":"Claude is now in /r (main)","contextNote":"Repository changed from /a to /r"}}"#)) {
            #expect(w.change?.banner == "Claude is now in /r (main)")
        } else { Issue.record("session.worktree did not decode") }
        #expect(DaemonEvent.decode(method: "chat.threadReplaced", params: try json(#"{"sessionId":"s1","threadId":"t2","reason":"resume_refused"}"#))
            == .threadReplaced(ThreadReplaced(sessionId: "s1", threadId: "t2", reason: "resume_refused")))
        #expect(DaemonEvent.decode(method: "host.changed", params: .string("bad")) == .unknown("host.changed"))
        #expect(DaemonEvent.decode(method: "something.new", params: .null) == .unknown("something.new"))
    }

    @Test func errorReason() {
        let e = DaemonError(code: DaemonErrorCode.approvalRefused, message: "no", data: .object(["reason": .string("home_or_root")]))
        #expect(e.reason == "home_or_root")
        #expect(DaemonError.stopped.code == DaemonErrorCode.stopped)
    }
}
