import AVFoundation
import CompanionCore
import Observation
import SwiftUI

/// Window state the settings show; written by WindowCoordinator (Task 12).
@MainActor @Observable final class WindowStatus {
    var accessibilityTrusted = false
    var followNote: String?
    var hotkeyError: String?
}

struct SettingsView: View {
    var body: some View {
        TabView {
            AccountSettings().tabItem { Label("Account", systemImage: "person.crop.circle") }
            PrivacySettings().tabItem { Label("Privacy", systemImage: "hand.raised") }
            JiraSettings().tabItem { Label("Jira", systemImage: "list.bullet.rectangle") }
            SpeechSettings().tabItem { Label("Speech", systemImage: "speaker.wave.2") }
            WindowSettings().tabItem { Label("Window", systemImage: "sidebar.left") }
            AdvancedSettings().tabItem { Label("Advanced", systemImage: "gearshape.2") }
        }
        .frame(width: 540, height: 440)
        .padding()
    }
}

struct AccountSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Form {
            LabeledContent("ChatGPT") { Text(authText) }
            if !isSignedIn { SignInButton() }
            LabeledContent("Codex") { Text(hostText) }
            ForEach(warnings, id: \.self) { w in Text(w).font(.caption).foregroundStyle(.orange) }
            Text("The companion never reads or stores your ChatGPT token; Codex keeps it in your Keychain.")
                .font(.caption).foregroundStyle(.secondary)
        }
        .formStyle(.grouped)
    }
    private var isSignedIn: Bool { if case .signedIn? = model.auth { true } else { false } }
    private var warnings: [String] { if case .ready(let w) = model.host { w } else { [] } }
    private var authText: String {
        switch model.auth {
        case .signedIn(let plan)?: "Signed in" + (plan.map { " (\($0))" } ?? "")
        case .signedOut?: "Signed out"
        case .unsupported(let mode)?: "Unsupported sign-in: \(mode)"
        case nil: "Unknown"
        }
    }
    private var hostText: String {
        switch model.host {
        case .ready: "Ready"
        case .starting: "Starting"
        case .stopped: "Stopped"
        case .failed(let d): d
        }
    }
}

struct PrivacySettings: View {
    @Environment(AppModel.self) private var model
    @State private var confirmAutomatic = false
    var body: some View {
        Form {
            Picker("Claude session context", selection: Binding(
                get: { model.privacy?.sharingMode ?? .ask },
                set: { m in if m == .automatic { confirmAutomatic = true } else { Task { await model.setSharingMode(m) } } })) {
                ForEach(SharingMode.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.radioGroup)
            Text(modeHelp).font(.caption).foregroundStyle(.secondary)
            Section("Approved repositories") {
                if let notice = model.revokeNotice {
                    Banner(text: notice, tone: .warning, onDismiss: { model.dismissRevokeNotice() })
                }
                if model.privacy?.approvals.isEmpty ?? true {
                    Text("None yet. GPT gets repository tools only for repositories you approve.").foregroundStyle(.secondary)
                }
                ForEach(model.privacy?.approvals ?? []) { a in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(a.root).font(.callout.monospaced()).lineLimit(1).truncationMode(.middle)
                            Text(a.includeWorktrees ? "Includes this repository's worktrees" : "This folder only").font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Revoke") { Task { await model.revoke(root: a.root) } }
                    }
                }
            }
            Text(model.redactionNotice).font(.callout)
        }
        .formStyle(.grouped)
        .automaticModeConfirmation(isPresented: $confirmAutomatic)
    }
    private var modeHelp: String {
        switch model.privacy?.sharingMode ?? .ask {
        case .off: "Nothing from the Claude session is sent. GPT gets your question and, if approved, read-only repository tools."
        case .ask: "Before each question you see exactly what will be sent and can remove items."
        case .automatic: "The new part of the Claude session (capped at 12 KB, redacted) is sent without a preview."
        }
    }
}

struct SpeechSettings: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        Form {
            LabeledContent("Speed") {
                HStack {
                    Slider(value: Binding(get: { model.settings.speechRate }, set: { model.setSetting(\.speechRate, ($0 * 4).rounded() / 4) }),
                           in: 0.5...2.0, step: 0.25)
                    Text(String(format: "%.2f×", model.settings.speechRate)).monospacedDigit().frame(width: 48)
                }
            }
            Picker("Voice", selection: Binding(get: { model.settings.voiceIdentifier ?? "" },
                                               set: { model.setSetting(\.voiceIdentifier, $0.isEmpty ? nil : $0) })) {
                Text("System default").tag("")
                ForEach(Self.voices, id: \.identifier) { v in Text(v.name + " (" + v.language + ")").tag(v.identifier) }
            }
            Toggle("Read each reply aloud when it finishes", isOn: Binding(get: { model.settings.autoPlay }, set: { model.setSetting(\.autoPlay, $0) }))
            Toggle("Read code blocks (otherwise it says \"code block omitted\")", isOn: Binding(get: { model.settings.readCode }, set: { model.setSetting(\.readCode, $0) }))
        }
        .formStyle(.grouped)
    }
    static var voices: [AVSpeechSynthesisVoice] {
        let lang = Locale.current.language.languageCode?.identifier ?? "en"
        return AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix(lang) }.sorted { $0.name < $1.name }
    }
}

struct WindowSettings: View {
    @Environment(AppModel.self) private var model
    @Environment(WindowStatus.self) private var status
    @State private var key = ""
    var body: some View {
        Form {
            Toggle("Follow the Claude window", isOn: Binding(get: { model.settings.followClaude }, set: { model.setSetting(\.followClaude, $0) }))
            Text("Uses the Accessibility permission only to read where Claude Desktop's window is, and keeps the panel against its left edge. Nothing in Claude is changed.")
                .font(.caption).foregroundStyle(.secondary)
            if let note = status.followNote { Text(note).font(.callout).foregroundStyle(.orange) }
            Section("Show or hide shortcut") {
                HStack {
                    Toggle("⌃", isOn: modifier(\.control))
                    Toggle("⌥", isOn: modifier(\.option))
                    Toggle("⇧", isOn: modifier(\.shift))
                    Toggle("⌘", isOn: modifier(\.command))
                    TextField("Key", text: $key).frame(width: 44).onChange(of: key) { applyKey() }
                }
                .toggleStyle(.button)
                Text("Now: " + model.settings.hotkey.display).font(.caption)
                if let e = status.hotkeyError { Text(e).font(.caption).foregroundStyle(.red) }
            }
        }
        .formStyle(.grouped)
        .onAppear { key = model.settings.hotkey.key }
    }
    private func modifier(_ kp: WritableKeyPath<HotkeySpec, Bool>) -> Binding<Bool> {
        Binding(get: { model.settings.hotkey[keyPath: kp] }, set: { v in
            var h = model.settings.hotkey
            h[keyPath: kp] = v
            if h.isValid { model.setSetting(\.hotkey, h) }
        })
    }
    private func applyKey() {
        var h = model.settings.hotkey
        h.key = String(key.uppercased().suffix(1))
        if h.isValid { model.setSetting(\.hotkey, h) }
    }
}

struct AdvancedSettings: View {
    @Environment(AppModel.self) private var model
    @AppStorage("nodePath") private var nodePath = ""
    var body: some View {
        Form {
            Picker("Open path:line in", selection: Binding(get: { model.settings.editor }, set: { model.setSetting(\.editor, $0) })) {
                ForEach(EditorChoice.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            TextField("Node.js path (empty = automatic)", text: $nodePath)
            Text("companiond needs Node.js 24 or newer. Empty uses /opt/homebrew/bin/node or /usr/local/bin/node. Restart companiond after a change.")
                .font(.caption).foregroundStyle(.secondary)
            LabeledContent("companiond") { Text(daemonText) }
            if model.isSecurityStop {
                Text("A security stop is waiting for you in the panel. Read it and acknowledge it there first.").font(.callout).foregroundStyle(.red)
            } else {
                HStack {
                    Button("Restart companiond") { Task { await model.restartDaemon() } }
                    Button("Restart Codex") { Task { await model.restartHost() } }
                }
            }
        }
        .formStyle(.grouped)
    }
    private var daemonText: String {
        switch model.connection {
        case .connecting: "Starting"
        case .connected(let v): "Running (version \(v))"
        case .stopped(let why): why
        }
    }
}
