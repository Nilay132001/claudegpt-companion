import AVFoundation
import Foundation
import Observation

/// The synthesizer seam (tests use a fake). `token` identifies one utterance; `onEnd` reports it finished or cancelled.
@MainActor public protocol SpeechSynthesizing: AnyObject {
    var onEnd: ((Int) -> Void)? { get set }
    /// Speaks the segments in order as one playback; `onEnd(token)` fires once, after the last one or when stopped.
    func speak(_ segments: [SpeechSegment], rate: Float, voiceIdentifier: String?, token: Int)
    func pause()
    func resume()
    func stop(atWordBoundary: Bool)
}

public enum Playback: Equatable, Sendable { case idle, playing(UUID), paused(UUID) }

public enum SpeechPhase: Equatable, Sendable { case idle, playing, paused }

/// One message's Read Aloud state: a playback change touches only the messages involved (M9 §5.5).
@MainActor @Observable public final class MessageSpeech {
    public internal(set) var phase: SpeechPhase = .idle
}

extension Playback {
    var messageId: UUID? {
        switch self { case .idle: nil; case .playing(let id), .paused(let id): id }
    }
    func phase(of id: UUID) -> SpeechPhase {
        switch self {
        case .playing(id): .playing
        case .paused(id): .paused
        default: .idle
        }
    }
}

/// Read Aloud (spec §8, §9): one synthesizer, pause/resume/stop at word boundaries, 0.5×–2×, new playback stops the old.
@MainActor @Observable
public final class ReadAloudController {
    public private(set) var playback: Playback = .idle
    public var rateMultiplier = 1.0
    public var voiceIdentifier: String?
    public var readCode = false
    @ObservationIgnored private let synth: any SpeechSynthesizing
    @ObservationIgnored private let installedVoices: () -> [VoiceDescriptor]
    @ObservationIgnored private var token = 0
    @ObservationIgnored private var speech: [UUID: MessageSpeech] = [:]

    public init(synth: any SpeechSynthesizing, voices: @escaping () -> [VoiceDescriptor] = VoiceDescriptor.installed) {
        self.synth = synth
        self.installedVoices = voices
        synth.onEnd = { [weak self] t in self?.ended(t) }
    }

    /// 1.0× is a natural pace, a little under AVSpeech's brisk default; the multiplier scales from there.
    public static let naturalRate = AVSpeechUtteranceDefaultSpeechRate * 0.92

    public static func avRate(multiplier: Double) -> Float {
        let m = Float(min(max(multiplier, 0.5), 2.0))
        return min(max(naturalRate * m, AVSpeechUtteranceMinimumSpeechRate), AVSpeechUtteranceMaximumSpeechRate)
    }

    /// The chosen voice if it is still installed, else the best installed one (never AVSpeech's compact default).
    func resolvedVoice() -> String? {
        let all = installedVoices()
        if let id = voiceIdentifier, all.contains(where: { $0.identifier == id }) { return id }
        return VoiceRanking.best(all, for: VoiceRanking.currentLanguageCode)?.identifier
    }

    /// `rendered`: the answer's cached render when the caller has it (else the Markdown is rendered here).
    public func play(id: UUID, markdown: String, rendered: RenderedAnswer? = nil) {
        if playback != .idle { synth.stop(atWordBoundary: false) }
        token += 1
        set(.playing(id))
        let segments = rendered.map { SpeechText.segments(for: $0, readCode: readCode) }
            ?? SpeechText.segments(fromMarkdown: markdown, readCode: readCode)
        synth.speak(segments,
                    rate: Self.avRate(multiplier: rateMultiplier), voiceIdentifier: resolvedVoice(), token: token)
    }

    public func toggle(id: UUID, markdown: String, rendered: RenderedAnswer? = nil) {
        switch playback {
        case .playing(id):
            synth.pause()
            set(.paused(id))
        case .paused(id):
            synth.resume()
            set(.playing(id))
        default:
            play(id: id, markdown: markdown, rendered: rendered)
        }
    }

    public func stop() {
        guard playback != .idle else { return }
        synth.stop(atWordBoundary: true)
        set(.idle)
    }

    /// Playing (not paused) this message: drives the speaking indicator.
    public func isSpeaking(_ id: UUID) -> Bool { playback == .playing(id) }

    public func isActive(_ id: UUID) -> Bool { playback == .playing(id) || playback == .paused(id) }

    public func icon(for id: UUID) -> String {
        switch playback {
        case .playing(id): "pause.fill"
        case .paused(id): "play.fill"
        default: "speaker.wave.2"
        }
    }

    private func ended(_ t: Int) {
        if t == token { set(.idle) }
    }

    /// Never pruned: a view may hold the object it read, and entries are one small object per answer shown.
    public func speech(for id: UUID) -> MessageSpeech {
        if let s = speech[id] { return s }
        let s = MessageSpeech()
        s.phase = playback.phase(of: id)
        speech[id] = s
        return s
    }

    private func set(_ new: Playback) {
        let old = playback
        playback = new
        for id in Set([old.messageId, new.messageId].compactMap { $0 }) { speech[id]?.phase = new.phase(of: id) }
    }
}

/// The real synthesizer. Delegate callbacks arrive off the main actor and hop back with the utterance's identity.
@MainActor
public final class AVSpeechAdapter: NSObject, SpeechSynthesizing, AVSpeechSynthesizerDelegate {
    public var onEnd: ((Int) -> Void)?
    private let synth = AVSpeechSynthesizer()
    /// Which playback each queued utterance belongs to, and how many of a playback's utterances are still queued.
    private var owner: [ObjectIdentifier: Int] = [:]
    private var remaining: [Int: Int] = [:]

    public override init() {
        super.init()
        synth.delegate = self
    }

    public func speak(_ segments: [SpeechSegment], rate: Float, voiceIdentifier: String?, token: Int) {
        let voice = voiceIdentifier.flatMap { AVSpeechSynthesisVoice(identifier: $0) }
        let items = segments.filter { !$0.text.isEmpty }
        guard !items.isEmpty else {
            Task { @MainActor in self.onEnd?(token) }
            return
        }
        remaining[token] = items.count
        for (i, seg) in items.enumerated() {
            let u = AVSpeechUtterance(string: seg.text)
            u.rate = rate
            u.pitchMultiplier = 1.0
            u.prefersAssistiveTechnologySettings = false
            u.postUtteranceDelay = i == items.count - 1 ? 0 : seg.pause.seconds
            if let voice { u.voice = voice }
            owner[ObjectIdentifier(u)] = token
            synth.speak(u)
        }
    }

    public func pause() { synth.pauseSpeaking(at: .word) }
    public func resume() { synth.continueSpeaking() }
    public func stop(atWordBoundary: Bool) { synth.stopSpeaking(at: atWordBoundary ? .word : .immediate) }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.finished(id) }
    }

    nonisolated public func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) {
        let id = ObjectIdentifier(u)
        Task { @MainActor in self.cancelled(id) }
    }

    private func finished(_ id: ObjectIdentifier) {
        guard let t = owner.removeValue(forKey: id), let n = remaining[t] else { return }
        if n <= 1 {
            remaining[t] = nil
            onEnd?(t)
        } else {
            remaining[t] = n - 1
        }
    }

    /// A cancel drops the playback's whole queue; report it once.
    private func cancelled(_ id: ObjectIdentifier) {
        guard let t = owner.removeValue(forKey: id), remaining.removeValue(forKey: t) != nil else { return }
        onEnd?(t)
    }
}
