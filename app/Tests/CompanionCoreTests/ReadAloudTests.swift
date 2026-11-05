import AVFoundation
import Foundation
import Synchronization
import Testing
@testable import CompanionCore

@MainActor final class FakeSynth: SpeechSynthesizing {
    var onEnd: ((Int) -> Void)?
    var log: [String] = []
    var lastToken = 0
    func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int) {
        log.append("speak:\(text)@\(rate)")
        lastToken = token
    }
    func pause() { log.append("pause") }
    func resume() { log.append("resume") }
    func stop(atWordBoundary: Bool) { log.append(atWordBoundary ? "stop:word" : "stop:now") }
}

/// File scope (nonisolated): the synthesizer calls these from its own threads.
final class WriteBox: Sendable {
    let frames = Mutex<UInt32>(0)
    let cont = Mutex<CheckedContinuation<Void, Never>?>(nil)
    func finish() { cont.withLock { $0?.resume(); $0 = nil } }
}

final class SpeechRecorder: NSObject, AVSpeechSynthesizerDelegate, Sendable {
    let events = Mutex<[String]>([])
    func add(_ e: String) { events.withLock { $0.append(e) } }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didStart u: AVSpeechUtterance) { add("start") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didPause u: AVSpeechUtterance) { add("pause") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didContinue u: AVSpeechUtterance) { add("continue") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { add("cancel") }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { add("finish") }
}

@MainActor @Suite struct ReadAloudTests {
    @Test func rateMapping() {
        #expect(ReadAloudController.avRate(multiplier: 1) == AVSpeechUtteranceDefaultSpeechRate)
        #expect(ReadAloudController.avRate(multiplier: 0.5) == AVSpeechUtteranceDefaultSpeechRate * 0.5)
        #expect(ReadAloudController.avRate(multiplier: 2) == min(AVSpeechUtteranceDefaultSpeechRate * 2, AVSpeechUtteranceMaximumSpeechRate))
        #expect(ReadAloudController.avRate(multiplier: 9) == ReadAloudController.avRate(multiplier: 2))
        #expect(ReadAloudController.avRate(multiplier: 0) == ReadAloudController.avRate(multiplier: 0.5))
    }

    @Test func playPauseResumeStop() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID()
        c.toggle(id: a, markdown: "**Hi**\n```\ncode\n```")
        #expect(c.playback == .playing(a))
        #expect(s.log == ["speak:Hi\nCode block omitted.@\(AVSpeechUtteranceDefaultSpeechRate)"])
        #expect(c.icon(for: a) == "pause.fill")
        c.toggle(id: a, markdown: "")
        #expect(c.playback == .paused(a))
        #expect(c.icon(for: a) == "play.fill")
        c.toggle(id: a, markdown: "")
        #expect(c.playback == .playing(a))
        c.stop()
        #expect(c.playback == .idle)
        #expect(Array(s.log.dropFirst()) == ["pause", "resume", "stop:word"])
    }

    @Test func newPlaybackStopsTheOldOneAndStaleEndsAreIgnored() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID(), b = UUID()
        c.play(id: a, markdown: "one")
        let first = s.lastToken
        c.play(id: b, markdown: "two")
        #expect(s.log.contains("stop:now"))
        s.onEnd?(first)                 // the cancelled utterance reports late
        #expect(c.playback == .playing(b))
        s.onEnd?(s.lastToken)
        #expect(c.playback == .idle)
        #expect(!c.isActive(b))
    }

    @Test func readCodeAndRateSettingsApply() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        c.readCode = true
        c.rateMultiplier = 0.5
        c.play(id: UUID(), markdown: "```\nlet x = 1\n```")
        #expect(s.log == ["speak:let x = 1@\(AVSpeechUtteranceDefaultSpeechRate * 0.5)"])
    }

    /// Spec §12.3: write(_:toBufferCallback:) produces non-empty audio. Needs at least one installed voice.
    /// nonisolated: the buffer callback runs on a synthesizer thread; a main-actor closure would trap there.
    @Test(.enabled(if: !AVSpeechSynthesisVoice.speechVoices().isEmpty), .timeLimit(.minutes(1)))
    nonisolated func writeProducesAudio() async {
        let box = WriteBox()
        let synth = AVSpeechSynthesizer()
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            box.cont.withLock { $0 = c }
            Task { try? await Task.sleep(for: .seconds(30)); box.finish() }
            synth.write(AVSpeechUtterance(string: "Hello from the companion.")) { buffer in
                guard let pcm = buffer as? AVAudioPCMBuffer else { return }
                if pcm.frameLength == 0 { box.finish() } else { box.frames.withLock { $0 += pcm.frameLength } }
            }
        }
        withExtendedLifetime(synth) {} // keep the synthesizer alive until the write has finished
        #expect(box.frames.withLock { $0 } > 0)
    }

    /// Spec §12.3 delegate sequence on the real synthesizer. Needs an audio device: opt-in (ruling 10).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(1)))
    nonisolated func realDelegateSequence() async throws {
        func waitFor(_ e: String, _ r: SpeechRecorder) async throws {
            for _ in 0..<200 where !r.events.withLock({ $0.contains(e) }) { try await Task.sleep(for: .milliseconds(50)) }
        }
        let s = AVSpeechSynthesizer()
        let r = SpeechRecorder()
        s.delegate = r
        s.speak(AVSpeechUtterance(string: "This sentence is long enough to pause, resume and then stop before it ends, at a word boundary, on this Mac."))
        try await waitFor("start", r)
        s.pauseSpeaking(at: .word)
        try await waitFor("pause", r)
        s.continueSpeaking()
        try await waitFor("continue", r)
        s.stopSpeaking(at: .word)
        try await waitFor("cancel", r)
        #expect(r.events.withLock { $0 } == ["start", "pause", "continue", "cancel"])
    }
}
