import CompanionCore
import SwiftUI

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    @Environment(DictationController.self) private var dictation

    var body: some View {
        @Bindable var model = model
        content
            .frame(minWidth: 280, maxWidth: 640, minHeight: 320)
            .background(Color(nsColor: .windowBackgroundColor))
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 0) {
                    HeaderView()
                    StatusLine()
                    if let past = model.pastChat { PastChatBar(past: past) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if model.gate == .ready && model.pastChat == nil {
                    InputBar()
                }
            }
            // The header's first row shares the titlebar with the traffic lights.
            .ignoresSafeArea(.container, edges: .top)
            .onChange(of: model.gate) { _, gate in
                // The Stop button lives in InputBar, shown only while .ready: never leave the mic on without it.
                if DictationController.mustStop(for: gate) { Task { await dictation.stopIfActive() } }
            }
            .onChange(of: model.pastChat != nil) { _, past in
                // The composer (and its mic button) is hidden while a past chat is open.
                if past { Task { await dictation.stopIfActive() } }
            }
            .sheet(item: $model.preview) { _ in PreviewSheet() }
            .sheet(item: $model.sentView) { view in SentSheet(view: view) }
            .alert("Something went wrong", isPresented: Binding(get: { model.errorMessage != nil }, set: { if !$0 { model.errorMessage = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(verbatim: model.errorMessage ?? "")
            }
    }

    @ViewBuilder private var content: some View {
        switch model.gate {
        case .ready:
            if let past = model.pastChat {
                ChatView(messages: past.messages, readOnly: true)
            } else if model.currentMessages.isEmpty {
                if model.isLoadingCurrentChat {
                    GateView(symbol: nil, title: "Loading this chat…", spinner: true)
                } else {
                    EmptyStateView()
                }
            } else {
                ChatView(messages: model.currentMessages, readOnly: false)
            }
        case .connecting:
            GateView(symbol: nil, title: "Starting companiond…", detail: "The companion's local helper is starting up.", spinner: true)
        case .daemonStopped(let why):
            GateView(symbol: "bolt.horizontal.circle", tint: .red, title: "companiond isn't running", detail: why) {
                Button("Restart companiond") { Task { await model.restartDaemon() } }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
        case .hostStarting:
            GateView(symbol: nil, title: "Starting Codex…", detail: "Running its security checks before GPT can answer.", spinner: true)
        case .hostFailed(let why):
            GateView(symbol: "exclamationmark.triangle", tint: .orange, title: "Chat is off", detail: why) {
                Button("Try Again") { Task { await model.restartHost() } }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
        case .securityStop(let why):
            // Ruling 18: no "Try again" here. Only this button clears the stop (host.acknowledgeSecurityStop).
            GateView(symbol: "lock.trianglebadge.exclamationmark", tint: .red, title: "Security check failed. Chat stopped.",
                     detail: why + "\n\nGPT was stopped because something it did was outside the read-only rules. Read the reason, then acknowledge to start Codex again.") {
                Button("I've read this — acknowledge and restart") { Task { await model.acknowledgeSecurityStop() } }
                    .buttonStyle(.borderedProminent).tint(.red).controlSize(.large)
            }
        case .authError(let why):
            GateView(symbol: "person.crop.circle.badge.exclamationmark", tint: .orange, title: "Couldn't check your ChatGPT sign-in", detail: why) {
                Button("Retry") { Task { await model.loadAuth() } }
                    .buttonStyle(.borderedProminent).controlSize(.large)
            }
        case .signedOut:
            GateView(symbol: "person.crop.circle.badge.questionmark", tint: .accentColor, title: "Sign in with ChatGPT",
                     detail: "GPT answers through your ChatGPT plan, so no API key is needed. The sign-in page opens in your browser; Codex keeps the sign-in, not this app.") {
                SignInButton()
            }
        case .authUnsupported(let mode):
            GateView(symbol: "person.crop.circle.badge.exclamationmark", tint: .orange, title: "This sign-in isn't supported",
                     detail: "Codex reports the “\(mode)” sign-in. The companion works with a ChatGPT plan sign-in instead.") {
                SignInButton()
            }
        case .noSession:
            GateView(symbol: "rectangle.on.rectangle.slash", tint: .secondary, title: "No Claude session",
                     detail: "Open Claude Code Desktop and select a session.") {
                Button("Refresh") { Task { await model.refresh() } }
                    .buttonStyle(.bordered).controlSize(.large)
                    .help("Look for Claude sessions again (⌘R)")
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
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .keyboardShortcut(.defaultAction)
    }
}

/// Under the header while a past chat is open: it is read-only, and the way back is one click.
struct PastChatBar: View {
    @Environment(AppModel.self) private var model
    let past: PastChat

    var body: some View {
        HStack(spacing: Design.Space.s) {
            Image(systemName: "clock").foregroundStyle(.secondary)
            Text(verbatim: "Past chat · \(Date(timeIntervalSince1970: past.summary.lastAt / 1000).shortStamp) · read-only")
                .font(.callout).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: Design.Space.s)
            Button("Back to Current Chat") { model.closePastChat() }
                .buttonStyle(.borderless)
                .font(.callout.weight(.medium))
        }
        .padding(.horizontal, Design.Space.m)
        .padding(.vertical, Design.Space.s)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: Design.Radius.status))
        .padding(.horizontal, Design.Space.m)
        .padding(.bottom, Design.Space.s)
        .accessibilityElement(children: .contain)
    }
}
