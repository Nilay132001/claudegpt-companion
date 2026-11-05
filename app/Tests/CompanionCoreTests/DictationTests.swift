import Foundation
import Testing
@testable import CompanionCore

@MainActor final class FakeEngine: DictationEngine {
    var emit: (@MainActor (DictationEvent) -> Void)?
    var started = 0
    var stopped = 0
    var startError: (any Error)?
    var finalOnStop: String?
    var holdStart = false
    var held: CheckedContinuation<Void, Never>?
    /// Set only when the fake "turns the microphone on": after the last await, once it has re-checked for a Stop.
    var micStarted = false
    func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws {
        started += 1
        let stopsAtStart = stopped
        if holdStart { await withCheckedContinuation { held = $0 } }
        if let e = startError { throw e }
        // Like SpeechAnalyzerEngine: a Stop that arrived during an await cancels the start before the mic goes on.
        guard stopped == stopsAtStart else { throw CancellationError() }
        emit = events
        events(.installing(0.5))
        micStarted = true
    }
    func stop() async {
        stopped += 1
        if let f = finalOnStop { emit?(.final(f)) }
    }
}

/// Ignores Stop during start (no cancellation check): exercises the controller's own guard.
@MainActor final class LateEngine: DictationEngine {
    var stopped = 0
    var held: CheckedContinuation<Void, Never>?
    func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws {
        await withCheckedContinuation { held = $0 }
    }
    func stop() async { stopped += 1 }
}

struct FakePermissions: DictationPermissions {
    let mic: Bool
    let speech: Bool
    func microphone() async -> Bool { mic }
    func speechRecognition() async -> Bool { speech }
}

@MainActor @Suite struct DictationTests {
    @Test func deniedPermissionsExplainAndNeverStart() async {
        let e = FakeEngine()
        let c = DictationController(engine: e, permissions: FakePermissions(mic: false, speech: true))
        await c.toggle(appendTo: { _ in })
        #expect(c.state == .failed(DictationController.microphoneDenied))
        #expect(c.isError)
        let c2 = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: false))
        await c2.toggle(appendTo: { _ in })
        #expect(c2.state == .failed(DictationController.speechDenied))
        #expect(e.started == 0)
    }

    @Test func recordsShowsLiveTextAndAppendsFinals() async {
        let e = FakeEngine()
        e.finalOnStop = "and the rest"
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        var got: [String] = []
        await c.toggle(appendTo: { got.append($0) })
        #expect(c.state == .recording(live: ""))
        #expect(c.isRecording)
        e.emit?(.volatile("what is"))
        #expect(c.state == .recording(live: "what is"))
        e.emit?(.final(" What is this file? "))
        #expect(got == ["What is this file?"])
        #expect(c.state == .recording(live: ""))
        await c.toggle(appendTo: { got.append($0) })
        #expect(got == ["What is this file?", "and the rest"])
        #expect(c.state == .idle)
        #expect(e.stopped == 1)
    }

    @Test func stopWhileStartingNeverLeavesTheMicOn() async {
        let e = FakeEngine()
        e.holdStart = true
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        let starting = Task { await c.toggle(appendTo: { _ in }) }
        while e.held == nil { await Task.yield() }
        await c.toggle(appendTo: { _ in })      // Stop pressed while the engine is still starting
        #expect(c.state == .idle)
        e.held?.resume()
        await starting.value
        #expect(!e.micStarted)                   // the start was cancelled: the mic never turned on after Stop
        #expect(e.stopped == 1)
        #expect(c.state == .idle)
        #expect(!c.isRecording)
    }

    @Test func aLateStartThatIgnoresStopIsStoppedAgain() async {
        // Second layer: an engine that turns the mic on anyway is stopped again by the controller's generation guard.
        let e = LateEngine()
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        let starting = Task { await c.toggle(appendTo: { _ in }) }
        while e.held == nil { await Task.yield() }
        await c.toggle(appendTo: { _ in })
        e.held?.resume()
        await starting.value
        #expect(e.stopped == 2)
        #expect(c.state == .idle)
    }

    @Test func aFailureWhileRecordingStopsTheEngine() async {
        let e = FakeEngine()
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        await c.toggle(appendTo: { _ in })
        e.emit?(.failed("Dictation stopped."))
        for _ in 0..<100 where e.stopped == 0 { await Task.yield() }
        #expect(e.stopped == 1)
        #expect(c.state == .failed("Dictation stopped."))
        #expect(!c.isRecording)
    }

    @Test func engineErrorsAreShown() async {
        let e = FakeEngine()
        e.startError = DictationError.unsupportedLocale
        let c = DictationController(engine: e, permissions: FakePermissions(mic: true, speech: true))
        await c.toggle(appendTo: { _ in })
        #expect(c.state == .failed(DictationError.unsupportedLocale.errorDescription!))
        #expect(c.statusText == DictationError.unsupportedLocale.errorDescription)
    }

    /// The real engine: Stop pressed while start() is still awaiting (locale, assets, analyzer) cancels the start
    /// before the microphone would open. The mic is replaced by a seam, so the runner never asks for it. Needs speech assets.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(5)))
    func realEngineStopDuringStartNeverOpensTheMic() async throws {
        let control = SpeechAnalyzerEngine()
        var controlOpened = false
        control.microphoneOverride = { controlOpened = true }
        try await control.start { _ in }
        #expect(controlOpened)                   // without a Stop, start() does reach the microphone
        // Not stopped here: with no audio ever fed (the seam), stop() waits on a results stream that never ends.

        let engine = SpeechAnalyzerEngine()
        var opened = false
        engine.microphoneOverride = { opened = true }
        let starting = Task { try await engine.start { _ in } }
        await Task.yield()                       // start() is now suspended at its first await
        await engine.stop()
        let result = await starting.result
        #expect(!opened)
        #expect(throws: CancellationError.self) { try result.get() }
    }

    /// Spec §12.3: a clip made with `say -o`, fed through SpeechAnalyzer from a file. Needs speech assets: opt-in (ruling 10).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(5)))
    func transcribesASaidClip() async throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "companion-speech-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let clip = dir.appending(path: "clip.aiff")
        let say = Process()
        say.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        say.arguments = ["-o", clip.path, "The quick brown fox jumps over the lazy dog."]
        try say.run()
        say.waitUntilExit()
        #expect(say.terminationStatus == 0)
        let text = try await SpeechAnalyzerEngine.transcribe(file: clip, locale: Locale(identifier: "en-US")).lowercased()
        #expect(text.contains("brown fox"))
        #expect(text.contains("lazy dog"))
    }
}
