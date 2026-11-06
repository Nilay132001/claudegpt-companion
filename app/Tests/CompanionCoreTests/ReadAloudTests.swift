import AVFoundation
import Foundation
import Synchronization
import Testing
@testable import CompanionCore

@MainActor final class FakeSynth: SpeechSynthesizing {
    var onEnd: ((Int) -> Void)?
    var log: [String] = []
    var lastToken = 0
    var lastVoice: String?
    var lastSegments: [SpeechSegment] = []
    func speak(_ segments: [SpeechSegment], rate: Float, voiceIdentifier: String?, token: Int) {
        log.append("speak:\(segments.map(\.text).joined(separator: "|"))@\(rate)")
        lastToken = token
        lastVoice = voiceIdentifier
        lastSegments = segments
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

/// File scope (nonisolated): collects the adapter's onEnd tokens.
final class EndBox: Sendable {
    let tokens = Mutex<[Int]>([])
    func add(_ t: Int) { tokens.withLock { $0.append(t) } }
}

@MainActor @Suite struct ReadAloudTests {
    @Test func rateMapping() {
        let natural = AVSpeechUtteranceDefaultSpeechRate * 0.92
        #expect(ReadAloudController.avRate(multiplier: 1) == natural)
        #expect(ReadAloudController.avRate(multiplier: 0.5) == max(natural * 0.5, AVSpeechUtteranceMinimumSpeechRate))
        #expect(ReadAloudController.avRate(multiplier: 2) == min(natural * 2, AVSpeechUtteranceMaximumSpeechRate))
        #expect(ReadAloudController.avRate(multiplier: 9) == ReadAloudController.avRate(multiplier: 2))
        #expect(ReadAloudController.avRate(multiplier: 0) == ReadAloudController.avRate(multiplier: 0.5))
    }

    @Test func playPauseResumeStop() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID()
        c.toggle(id: a, markdown: "**Hi**\n```\ncode\n```")
        #expect(c.playback == .playing(a))
        #expect(s.log == ["speak:Hi|Code block omitted.@\(ReadAloudController.naturalRate)"])
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
        #expect(s.log == ["speak:let x = 1@\(ReadAloudController.avRate(multiplier: 0.5))"])
    }

    @Test func multipleSegmentsEndOnceAndOnlyThePlayingMessageIsSpeaking() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID()
        c.play(id: a, markdown: "One. Two. Three.\n\nFour.")
        #expect(s.lastSegments.map(\.text) == ["One.", "Two.", "Three.", "Four."])
        #expect(c.isSpeaking(a))
        c.toggle(id: a, markdown: "")
        #expect(c.isActive(a) && !c.isSpeaking(a))
        c.toggle(id: a, markdown: "")
        #expect(c.isSpeaking(a) && !c.isSpeaking(UUID()))
        s.onEnd?(s.lastToken)
        #expect(c.playback == .idle)
        #expect(!c.isSpeaking(a))
    }

    @Test func stopMidwayGoesIdleAndALateEndIsHarmless() {
        let s = FakeSynth()
        let c = ReadAloudController(synth: s)
        let a = UUID()
        c.play(id: a, markdown: "One. Two. Three.")
        let t = s.lastToken
        c.stop()
        #expect(c.playback == .idle)
        #expect(s.log.last == "stop:word")
        s.onEnd?(t)
        #expect(c.playback == .idle)
    }

    @Test func voiceFallsBackToTheBestInstalledVoice() {
        let voices = [VoiceDescriptor(identifier: "std", name: "Aaron", language: VoiceRanking.currentLanguageCode),
                      VoiceDescriptor(identifier: "prem", name: "Zoe", language: VoiceRanking.currentLanguageCode, quality: .premium)]
        let s = FakeSynth()
        let c = ReadAloudController(synth: s, voices: { voices })
        c.play(id: UUID(), markdown: "Hi.")
        #expect(s.lastVoice == "prem")                  // nothing stored
        c.voiceIdentifier = "gone"
        c.play(id: UUID(), markdown: "Hi.")
        #expect(s.lastVoice == "prem")                  // stored voice no longer installed
        c.voiceIdentifier = "std"
        c.play(id: UUID(), markdown: "Hi.")
        #expect(s.lastVoice == "std")                   // a stored, installed choice wins
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

    /// Starting a new playback while the synthesizer is paused must actually speak (not queue silently).
    /// Both stop modes: play() from paused uses immediate; stop() then play() uses word boundary.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["COMPANION_SPEECH_TESTS"] == "1"), .timeLimit(.minutes(1)), arguments: [false, true])
    nonisolated func newSpeakWhilePausedActuallyStarts(atWordBoundary: Bool) async throws {
        let box = EndBox()
        let adapter = await MainActor.run { () -> AVSpeechAdapter in
            let a = AVSpeechAdapter()
            a.onEnd = { box.add($0) }
            a.speak([SpeechSegment("This sentence is long enough to be paused in the middle of it, on this Mac.")], rate: AVSpeechUtteranceDefaultSpeechRate, voiceIdentifier: nil, token: 1)
            return a
        }
        try await Task.sleep(for: .milliseconds(600))
        await MainActor.run { adapter.pause() }
        try await Task.sleep(for: .milliseconds(600))
        await MainActor.run {
            adapter.stop(atWordBoundary: atWordBoundary)
            adapter.speak([SpeechSegment("Okay.")], rate: AVSpeechUtteranceDefaultSpeechRate, voiceIdentifier: nil, token: 2)
        }
        for _ in 0..<200 where !box.tokens.withLock({ $0.contains(2) }) { try await Task.sleep(for: .milliseconds(50)) }
        #expect(box.tokens.withLock { $0.contains(2) })
        withExtendedLifetime(adapter) {}
    }
}
