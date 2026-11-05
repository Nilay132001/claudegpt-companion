import AVFoundation
import Foundation
import Observation
import Speech

public enum DictationEvent: Equatable, Sendable {
    case installing(Double)
    case volatile(String)
    case final(String)
    case failed(String)
}

@MainActor public protocol DictationEngine: AnyObject {
    func start(_ events: @escaping @MainActor (DictationEvent) -> Void) async throws
    func stop() async
}

public protocol DictationPermissions: Sendable {
    func microphone() async -> Bool
    func speechRecognition() async -> Bool
}

/// Microphone and Speech Recognition on first use (spec §7.8, ruling 9).
public struct SystemDictationPermissions: DictationPermissions {
    public init() {}
    public func microphone() async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return true
        case .notDetermined: return await AVCaptureDevice.requestAccess(for: .audio)
        default: return false
        }
    }
    public func speechRecognition() async -> Bool {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return true
        case .notDetermined:
            return await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0 == .authorized) } }
        default: return false
        }
    }
}

public enum DictationState: Equatable, Sendable {
    case idle, preparing, installing(Double), recording(live: String), finishing, failed(String)
}

/// Dictation (spec §8, §9): continuous until stopped, live text shown, final text appended to the editable draft.
@MainActor @Observable
public final class DictationController {
    public static let microphoneDenied = "Microphone access is off. Turn it on in System Settings › Privacy & Security › Microphone."
    public static let speechDenied = "Speech Recognition is off. Turn it on in System Settings › Privacy & Security › Speech Recognition."

    public private(set) var state: DictationState = .idle
    @ObservationIgnored private let engine: any DictationEngine
    @ObservationIgnored private let permissions: any DictationPermissions
    @ObservationIgnored private var sink: ((String) -> Void)?
    @ObservationIgnored private var startGeneration = 0

    public init(engine: any DictationEngine, permissions: any DictationPermissions) {
        self.engine = engine
        self.permissions = permissions
    }

    public var isRecording: Bool { if case .recording = state { true } else { false } }
    public var isError: Bool { if case .failed = state { true } else { false } }
    public var statusText: String? {
        switch state {
        case .preparing: "Getting the microphone ready…"
        case .installing(let p): "Downloading the speech model… \(Int(p * 100))%"
        case .finishing: "Finishing…"
        case .failed(let m): m
        case .idle, .recording: nil
        }
    }

    public func toggle(appendTo sink: @escaping (String) -> Void) async {
        switch state {
        case .recording, .installing, .preparing: await stop()
        case .finishing: return
        case .idle, .failed: await start(sink)
        }
    }

    private func start(_ sink: @escaping (String) -> Void) async {
        self.sink = sink
        startGeneration += 1
        let gen = startGeneration
        state = .preparing
        // After every await: if Stop was pressed meanwhile (generation moved), give up, and never leave the mic on.
        guard await permissions.microphone() else { if gen == startGeneration { state = .failed(Self.microphoneDenied) }; return }
        guard gen == startGeneration else { return }
        guard await permissions.speechRecognition() else { if gen == startGeneration { state = .failed(Self.speechDenied) }; return }
        guard gen == startGeneration else { return }
        do {
            try await engine.start { [weak self] e in self?.on(e) }
            guard gen == startGeneration else {
                await engine.stop()
                return
            }
            switch state {
            case .preparing, .installing: state = .recording(live: "")
            default: break
            }
        } catch {
            if gen == startGeneration { state = .failed((error as? any LocalizedError)?.errorDescription ?? "Dictation could not start.") }
        }
    }

    public func stop() async {
        startGeneration += 1
        state = .finishing
        await engine.stop()
        if state == .finishing { state = .idle }
    }

    private func on(_ e: DictationEvent) {
        switch e {
        case .installing(let p):
            switch state {
            case .preparing, .installing: state = .installing(p)
            default: break
            }
        case .volatile(let t):
            if case .recording = state { state = .recording(live: t) }
        case .final(let t):
            let clean = t.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty { sink?(clean) }
            if case .recording = state { state = .recording(live: "") }
        case .failed(let m):
            // The engine failed mid-recording: turn the microphone off too, never leave it running behind an error.
            startGeneration += 1
            state = .failed(m)
            Task { await self.engine.stop() }
        }
    }
}
