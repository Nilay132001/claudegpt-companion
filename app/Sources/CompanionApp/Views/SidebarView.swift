import CompanionCore
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            HeaderView()
            Divider()
            BannerStack()
            gateContent
            if model.gate == .ready {
                Divider()
                InputBar()
            }
        }
        .frame(minWidth: 280, maxWidth: 640, minHeight: 320)
        .onChange(of: model.gate) { _, gate in
            // The Stop button lives in InputBar, shown only while .ready: never leave the mic on without it.
            if DictationController.mustStop(for: gate) { Task { await dictation.stopIfActive() } }
        }
        .sheet(item: $model.preview) { _ in PreviewSheet() }
        .sheet(item: $model.sentView) { view in SentSheet(view: view) }
        .alert("Something went wrong", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.errorMessage ?? "")
        }
    }

    @ViewBuilder private var gateContent: some View {
        switch model.gate {
        case .ready:
            ChatView()
        case .connecting:
            CenterMessage(title: "Starting companiond…", spinner: true)
        case .daemonStopped(let why):
            CenterMessage(title: "companiond is not running", detail: why) {
                Button("Restart companiond") { Task { await model.restartDaemon() } }
            }
        case .hostStarting:
            CenterMessage(title: "Starting Codex and running its security checks…", spinner: true)
        case .hostFailed(let why):
            CenterMessage(title: "Chat is off", detail: why) {
                Button("Try again") { Task { await model.restartHost() } }
            }
        case .securityStop(let why):
            // Ruling 18: no "Try again" here. Only this button clears the stop (host.acknowledgeSecurityStop).
            CenterMessage(title: "Security check failed. Chat stopped.",
                          detail: why + "\n\nGPT was stopped because something it did was outside the read-only rules. Read the reason, then acknowledge to start Codex again.") {
                Button("I've read this — acknowledge and restart") { Task { await model.acknowledgeSecurityStop() } }
            }
        case .authError(let why):
            CenterMessage(title: "Could not check your ChatGPT sign-in", detail: why) {
                Button("Retry") { Task { await model.loadAuth() } }
            }
        case .signedOut:
            CenterMessage(title: "Sign in with ChatGPT",
                          detail: "GPT answers through your ChatGPT plan. The sign-in page opens in your browser. No API key is used.") {
                SignInButton()
            }
        case .authUnsupported(let mode):
            CenterMessage(title: "This sign-in is not supported", detail: "Codex reports the \"\(mode)\" sign-in. Sign in with ChatGPT instead.") {
                SignInButton()
            }
        case .noSession:
            CenterMessage(title: "No Claude session found", detail: "Open Claude Code Desktop and select a session, then press Refresh (⌘R).") {
                Button("Refresh") { Task { await model.refresh() } }
            }
        }
    }
}

struct SignInButton: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    var body: some View {
        Button("Sign in with ChatGPT") {
            Task { if let url = await model.signIn() { openURL(url) } }
        }
        .keyboardShortcut(.defaultAction)
    }
}
