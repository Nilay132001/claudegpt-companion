import AVFoundation
import Foundation
import Observation

/// The synthesizer seam (tests use a fake). `token` identifies one utterance; `onEnd` reports it finished or cancelled.
@MainActor public protocol SpeechSynthesizing: AnyObject {
    var onEnd: ((Int) -> Void)? { get set }
    func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int)
    func pause()
    func resume()
    func stop(atWordBoundary: Bool)
}

public enum Playback: Equatable, Sendable { case idle, playing(UUID), paused(UUID) }

/// Read Aloud (spec §8, §9): one synthesizer, pause/resume/stop at word boundaries, 0.5×–2×, new playback stops the old.
@MainActor @Observable
public final class ReadAloudController {
    public private(set) var playback: Playback = .idle
    public var rateMultiplier = 1.0
    public var voiceIdentifier: String?
    public var readCode = false
    @ObservationIgnored private let synth: any SpeechSynthesizing
    @ObservationIgnored private var token = 0

    public init(synth: any SpeechSynthesizing) {
        self.synth = synth
        synth.onEnd = { [weak self] t in self?.ended(t) }
    }

    public static func avRate(multiplier: Double) -> Float {
        let m = Float(min(max(multiplier, 0.5), 2.0))
        return min(max(AVSpeechUtteranceDefaultSpeechRate * m, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }

    public func play(id: UUID, markdown: String) {
        if playback != .idle { synth.stop(atWordBoundary: false) }
        token += 1
        playback = .playing(id)
        synth.speak(SpeechText.plainText(fromMarkdown: markdown, readCode: readCode),
                    rate: Self.avRate(multiplier: rateMultiplier), voiceIdentifier: voiceIdentifier, token: token)
    }

    public func toggle(id: UUID, markdown: String) {
        switch playback {
        case .playing(id):
            synth.pause()
            playback = .paused(id)
        case .paused(id):
            synth.resume()
            playback = .playing(id)
        default:
            play(id: id, markdown: markdown)
        }
    }

    public func stop() {
        guard playback != .idle else { return }
        synth.stop(atWordBoundary: true)
        playback = .idle
    }

    public func isActive(_ id: UUID) -> Bool { playback == .playing(id) || playback == .paused(id) }

    public func icon(for id: UUID) -> String {
        switch playback {
        case .playing(id): "pause.fill"
        case .paused(id): "play.fill"
        default: "speaker.wave.2"
        }
    }

    private func ended(_ t: Int) {
        if t == token { playback = .idle }
    }
}

/// The real synthesizer. Delegate callbacks arrive off the main actor and hop back with the utterance's identity.
@MainActor
public final class AVSpeechAdapter: NSObject, SpeechSynthesizing, AVSpeechSynthesizerDelegate {
    public var onEnd: ((Int) -> Void)?
    private let synth = AVSpeechSynthesizer()
    private var tokens: [ObjectIdentifier: Int] = [:]

    public override init() {
        super.init()
        synth.delegate = self
    }

    public func speak(_ text: String, rate: Float, voiceIdentifier: String?, token: Int) {
        let u = AVSpeechUtterance(string: text)
        u.rate = rate
        if let v = voiceIdentifier.flatMap({ AVSpeechSynthesisVoice(identifier: $0) }) { u.voice = v }
        tokens[ObjectIdentifier(u)] = token
        synth.speak(u)
    }

    public func pause() { synth.pauseSpeaking(at: .word) }
    public func resume() { synth.continueSpeaking() }
    public func stop(atWordBoundary: Bool) { synth.stopSpeaking(at: atWordBoundary ? .word : .immediate) }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.end(id) }
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.end(id) }
    }

    private func end(_ id: ObjectIdentifier) {
        if let t = tokens.removeValue(forKey: id) { onEnd?(t) }
    }
}
