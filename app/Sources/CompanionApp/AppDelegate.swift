import AppKit
import CompanionCore
import SwiftUI

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let model: AppModel
    let readAloud = ReadAloudController(synth: AVSpeechAdapter())
    let dictation = DictationController(engine: SpeechAnalyzerEngine(), permissions: SystemDictationPermissions())
    let windowStatus: WindowStatus
    let window: WindowCoordinator
    private var observers: [NSObjectProtocol] = []

    override init() {
        model = AppModel(connector: DaemonLocator.live(
            env: ProcessInfo.processInfo.environment,
            configuredNode: { UserDefaults.standard.string(forKey: "nodePath") },
            resourceURL: Bundle.main.resourceURL), jiraStore: KeychainJiraStore())
        let status = WindowStatus()
        windowStatus = status
        window = WindowCoordinator(status: status)
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGPIPE, SIG_IGN)
        let root = SidebarView()
            .environment(model).environment(readAloud).environment(dictation).environment(windowStatus)
        window.install(rootView: root, onWidthChange: { [weak self] w in self?.model.setSetting(\.panelWidth, Double(w)) })
        model.onSettingsChanged = { [weak self] s, byUser in self?.apply(s, byUser: byUser) }
        window.onHide = { [weak self] in
            guard let self else { return }
            Task { await self.dictation.stopIfActive() }
        }
        model.onReplyCompleted = { [weak self] id, text in self?.readAloud.play(id: id, markdown: text) }
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { if let self { Task { await self.model.refresh() } } }
        })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.window.retryFollowIfNeeded() }
        })
        apply(model.settings, byUser: false)
        window.show()
        Task { await model.start() }
    }

    private func apply(_ s: UISettings, byUser: Bool) {
        readAloud.rateMultiplier = s.speechRate
        readAloud.voiceIdentifier = s.voiceIdentifier
        readAloud.readCode = s.readCode
        window.apply(s, byUser: byUser, onHotkey: { [weak self] in self?.window.toggle() })
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        readAloud.stop()
        Task {
            await dictation.stopIfActive()
            await model.shutdown()
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window.show()
        return true
    }
}
