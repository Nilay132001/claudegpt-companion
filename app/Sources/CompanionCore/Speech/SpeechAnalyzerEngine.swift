import AVFoundation
import Foundation
import Speech

public enum DictationError: Error, LocalizedError, Equatable {
    case unsupportedLocale, noAudioFormat
    public var errorDescription: String? {
        switch self {
        case .unsupportedLocale: "Dictation does not support this Mac's language yet."
        case .noAudioFormat: "The microphone's audio could not be prepared for dictation."
        }
    }
}

/// SpeechAnalyzer + SpeechTranscriber only (spec §9, F15). Missing locale assets are installed with progress.
@MainActor
public final class SpeechAnalyzerEngine: DictationEngine {
    private var audioEngine: AVAudioEngine?
    private var analyzer: SpeechAnalyzer?
    private var input: AsyncStream<AnalyzerInput>.Continuation?
    private var results: Task<Void, Never>?

    public init() {}

    static func transcriber(_ locale: Locale, volatile: Bool) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale, transcriptionOptions: [],
                          reportingOptions: volatile ? [.volatileResults] : [], attributeOptions: [])
    }

    static func ensureAssets(_ t: SpeechTranscriber, progress: @escaping @MainActor (Double) -> Void) async throws {
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [t]) else { return }
        let p = request.progress
        let watcher = Task { @MainActor in
            while !Task.isCancelled {
                progress(p.fractionCompleted)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { watcher.cancel() }
        try await request.downloadAndInstall()
    }

    public func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws {
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current) else { throw DictationError.unsupportedLocale }
        let transcriber = Self.transcriber(locale, volatile: true)
        try await Self.ensureAssets(transcriber) { events(.installing($0)) }
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else { throw DictationError.noAudioFormat }

        let (stream, builder) = AsyncStream.makeStream(of: AnalyzerInput.self)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        // Stored before anything below can throw, so stop() (or the catch) can always clean up.
        self.analyzer = analyzer
        input = builder
        results = Task { @MainActor in
            do {
                for try await r in transcriber.results {
                    let text = String(r.text.characters)
                    events(r.isFinal ? .final(text) : .volatile(text))
                }
            } catch {
                events(.failed("Dictation stopped."))
            }
        }
        do {
            try await analyzer.start(inputSequence: stream)
            let engine = AVAudioEngine()
            audioEngine = engine
            let node = engine.inputNode
            let micFormat = node.outputFormat(forBus: 0)
            guard let converter = AVAudioConverter(from: micFormat, to: format) else { throw DictationError.noAudioFormat }
            node.installTap(onBus: 0, bufferSize: 4096, format: micFormat,
                            block: MicTap.block(converter: ConverterBox(converter, to: format), builder: builder))
            engine.prepare()
            try engine.start()
        } catch {
            audioEngine?.inputNode.removeTap(onBus: 0)
            audioEngine?.stop()
            audioEngine = nil
            builder.finish()
            input = nil
            await analyzer.cancelAndFinishNow()
            self.analyzer = nil
            results?.cancel()
            results = nil
            throw error
        }
    }

    public func stop() async {
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        input?.finish()
        input = nil
        try? await analyzer?.finalizeAndFinishThroughEndOfInput()
        analyzer = nil
        await results?.value
        results = nil
    }

    /// Spec §12.3 test path: transcribe an audio file, return the final text.
    public static func transcribe(file url: URL, locale: Locale) async throws -> String {
        guard let l = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else { throw DictationError.unsupportedLocale }
        let t = transcriber(l, volatile: false)
        try await ensureAssets(t) { _ in }
        let analyzer = SpeechAnalyzer(modules: [t])
        let collect = Task {
            var parts: [String] = []
            for try await r in t.results { parts.append(String(r.text.characters)) }
            return parts.joined(separator: " ")
        }
        let audio = try AVAudioFile(forReading: url)
        if let last = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await collect.value
    }
}

/// AVAudioEngine calls the tap on its own audio thread. The block is built in a nonisolated function so it does not
/// inherit @MainActor (a main-actor closure called there traps at run time under Swift 6).
enum MicTap {
    /// Captures only the Sendable box and the continuation (the tap block may be @Sendable in the SDK).
    nonisolated static func block(converter: ConverterBox,
                                  builder: AsyncStream<AnalyzerInput>.Continuation) -> AVAudioNodeTapBlock {
        return { buffer, _ in
            if let out = converter.convert(buffer) { builder.yield(AnalyzerInput(buffer: out)) }
        }
    }
}

/// Used only on the audio thread, one buffer at a time. Holds the target format so the tap captures no
/// non-Sendable AVFoundation object directly.
final class ConverterBox: @unchecked Sendable {
    private let converter: AVAudioConverter
    private let format: AVAudioFormat
    init(_ converter: AVAudioConverter, to format: AVAudioFormat) {
        self.converter = converter
        self.format = format
    }

    func convert(_ input: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let ratio = format.sampleRate / input.format.sampleRate
        let capacity = AVAudioFrameCount((Double(input.frameLength) * ratio).rounded(.up)) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        // The input block may be @Sendable in the SDK: keep the flag in a box and the buffer as nonisolated(unsafe).
        final class Fed: @unchecked Sendable { var done = false }
        let fed = Fed()
        nonisolated(unsafe) let source = input
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed.done {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed.done = true
            inputStatus.pointee = .haveData
            return source
        }
        return status == .error || out.frameLength == 0 ? nil : out
    }
}
