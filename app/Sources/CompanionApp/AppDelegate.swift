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

    #if DEBUG
    static let demo: DemoDaemon? = DemoFlags.scene.map { DemoDaemon(scene: $0) }
    #endif

    override init() {
        #if DEBUG
        if let demo = Self.demo {
            model = AppModel(connector: demo.connector)
            let status = WindowStatus()
            windowStatus = status
            window = WindowCoordinator(status: status)
            super.init()
            return
        }
        #endif
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
        #if DEBUG
        PerfDriver.shared.markLaunch()
        #endif
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
        #if DEBUG
        switch ProcessInfo.processInfo.environment["COMPANION_DEMO_APPEARANCE"] {
        case "light": NSApp.appearance = NSAppearance(named: .aqua)
        case "dark": NSApp.appearance = NSAppearance(named: .darkAqua)
        default: break
        }
        DemoShot.scheduleIfAsked()
        #endif
        apply(initialSettings(), byUser: false)
        window.show()
        Task {
            await model.start()
            #if DEBUG
            if let demo = Self.demo {
                demo.afterStart()
                if demo.scene == "pastChat" {
                    await model.loadHistory()
                    if let c = model.history?.chats.first(where: { $0.threadId == "th0" }) { await model.openPastChat(c) }
                }
                if let q = demo.autoQuestion {
                    model.draft = q
                    await model.submitDraft()
                }
                PerfDriver.shared.run(model: model)
            }
            #endif
        }
    }

    /// The settings for the first layout. DEBUG: COMPANION_DEMO_WIDTH sizes the panel before it, so a demo chat lays
    /// out once at that width.
    private func initialSettings() -> UISettings {
        #if DEBUG
        if let w = DemoFlags.width.flatMap(Double.init) {
            var s = model.settings
            s.panelWidth = w
            return s
        }
        #endif
        return model.settings
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
