import CompanionCore
import SwiftUI

/// The chat: one column of turns on the window background, newest at the bottom.
/// It follows streaming text while the reader is at the bottom and stops the moment they scroll up (ScrollFollow,
/// M9 §5.7), offers "Jump to latest" (⌘↓) while they read above it, and brings each chat back to the same line
/// after a session switch or a past chat (ChatScrollMemory).
/// It reads only the feed's turn ids (M9 §5.5): a streamed delta re-renders the growing answer, not the chat.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    let feed: ChatFeed
    /// The session id, or `"past:" + threadId` for a past chat.
    let sessionKey: String
    let readOnly: Bool

    var body: some View {
        // One scroll view for every session: a session switch keeps it and swaps the feed (a new scroll view per
        // session made each switch measure the new chat's rows from scratch: 247 ms at d1cb92b). The reading
        // position is saved per chat when the session changes or the view goes away (past chat, empty or loading
        // state), and restored for the chat it shows next.
        ChatScroll(feed: feed, sessionKey: sessionKey, readOnly: readOnly,
                   restore: model.scrollMemory.position(for: sessionKey))
    }
}

private struct ChatScroll: View {
    @Environment(AppModel.self) private var model
    let feed: ChatFeed
    let sessionKey: String
    let readOnly: Bool
    /// Where the reader was in the chat this view first shows, or nil to start at the bottom.
    let restore: ChatScrollAnchor?
    /// The position being restored (the first chat's, then each chat switched to), for the marker in its turn.
    @State private var restoring: ChatScrollAnchor?

    /// The follow state changes on every scroll and resize frame; a @State struct would start a SwiftUI transaction
    /// (a second graph update in the frame) each time, and re-run this body. Only the Jump button observes it, and
    /// only its visibility, which changes rarely.
    @State private var follow: FollowBox
    /// The laid-out turns' frames and the viewport, written by the rows and the scroll geometry; read when the chat
    /// goes away. Not observed: scrolling never re-renders a view through it.
    @State private var tracker = TurnTracker()

    init(feed: ChatFeed, sessionKey: String, readOnly: Bool, restore: ChatScrollAnchor?) {
        self.feed = feed
        self.sessionKey = sessionKey
        self.readOnly = readOnly
        self.restore = restore
        _follow = State(initialValue: FollowBox(ScrollFollow(following: restore == nil)))
        _restoring = State(initialValue: restore)
    }

    private static var initialAnchor: UnitPoint {
        #if DEBUG
        if DemoFlags.is_("context") || DemoFlags.is_("raw") { return .top }
        if DemoFlags.is_("rich") { return DemoFlags.anchor == "bottom" ? .bottom : .top }
        #endif
        return .bottom
    }

    /// DEBUG: tells the perf harness the app is about to scroll by itself.
    static func note(_ reason: String) {
        #if DEBUG
        PerfProbe.programmaticScroll(reason)
        #endif
    }

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.ChatView")
        #endif
        // A session switch re-runs this body with the new key before any of the new chat's rows is laid out, while
        // the tracker still holds the old chat's frames: save the old chat's position now (only if its rows and
        // viewport were reported since it was shown; otherwise its saved position stays as it was).
        let _ = tracker.bind(session: sessionKey) { old, anchor in
            model.scrollMemory.save(session: old, anchor: anchor, following: follow.state.following)
        }
        // No .scrollPosition binding (M9 Task 4b): with one, SwiftUI kept the bottom edge pinned while content grew
        // under a reader it had not seen scroll, re-anchored every row on each resize frame, and adjusted the content
        // offset from inside lazy placement. Programmatic scrolls go through the proxy; the reading position is
        // tracked from the rows' frames. The body reads neither `follow` nor `tracker`, so scrolling and following
        // never re-run it.
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    TurnList(feed: feed, readOnly: readOnly, tracker: tracker, restore: restoring)
                    Color.clear.frame(height: 1).id(Self.bottomID)
                }
                .coordinateSpace(.named(TurnTracker.space))
            }
            .scrollEdgeEffectStyle(.hard, for: .top)
            // Text scrolling under the composer fades out instead of showing around the field.
            .scrollEdgeEffectStyle(.soft, for: .bottom)
            .defaultScrollAnchor(restore == nil ? Self.initialAnchor : .top, for: .initialOffset)
            // No .animation(value: messages.count) here: it animated the whole scroll view (spec §5.8).
            .onScrollGeometryChange(for: ScrollMetrics.self) { g in
                #if DEBUG
                PerfProbe.contentInsetTop = g.contentInsets.top
                #endif
                // The reading area is the visible rect minus the insets (the header above, the composer below):
                // scrollTo(…, anchor: .top) aligns to its top, so the saved position is measured from there too.
                let top = g.visibleRect.minY + g.contentInsets.top
                return ScrollMetrics(offset: g.contentOffset.y, top: top,
                                     height: g.visibleRect.height - g.contentInsets.top - g.contentInsets.bottom,
                                     distance: g.contentSize.height - g.visibleRect.maxY)
            } action: { _, m in
                follow.state.geometry(offset: m.offset, distanceFromBottom: m.distance)
                tracker.viewport(top: m.top, height: m.height)
                publish()
                // A restore in progress: once the saved turn is the first visible one, put the marker (that many
                // points into it) at the top, and check again on the next geometry until it is there.
                if tracker.restoreNeedsMarker() {
                    Self.note("restore")
                    proxy.scrollTo(RestoreMarker.id, anchor: .top)
                }
                // Following, and the bottom moved away without the reader scrolling up (the answer grew, the panel
                // was resized, a row above was measured): back to the bottom. Nothing else pins the bottom, so a
                // reader above it is never moved.
                // Not while an animated Jump to latest is under way: it scrolls there itself.
                if follow.state.shouldStickToBottom && !follow.jumping {
                    Self.note("follow")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .onChange(of: LastTurn(feed: ObjectIdentifier(feed), id: feed.turns.last?.id)) { old, new in
                // A new live turn (the user just asked): follow it. A restore inserts at the front and keeps the last
                // id; a session switch swaps the feed, and onChange(of: sessionKey) restores that chat's position.
                if old.feed == new.feed, feed.isRunning {
                    follow.state.followAgain()
                    publish()
                    Self.note("newTurn")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .onAppear {
                if let restore { scroll(to: restore, proxy) }
            }
            .onChange(of: sessionKey) { _, new in
                // Another session's chat in the same scroll view: its saved line, or its bottom.
                let r = model.scrollMemory.position(for: new)
                follow.state = ScrollFollow(following: r == nil)
                publish()
                restoring = r
                if let r {
                    scroll(to: r, proxy)
                } else {
                    Self.note("switch")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .onDisappear {
                if tracker.isFresh {
                    model.scrollMemory.save(session: sessionKey, anchor: tracker.firstVisible,
                                            following: follow.state.following)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                JumpToLatest(follow: follow) { animated in
                    follow.state.followAgain()
                    publish()
                    if animated != nil { follow.jumpUntil = .now + .milliseconds(400) }
                    Self.note("jump")
                    withAnimation(animated) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
                }
            }
        }
    }

    private static let bottomID = "chat.bottom"

    private struct LastTurn: Equatable { let feed: ObjectIdentifier; let id: UUID? }

    private func publish() { follow.publish() }

    /// Back to where the reader was: first the saved turn (the lazy list lays it out), then, once it has a frame,
    /// the marker `inset` points into it, so the same line is at the top as before.
    private func scroll(to anchor: ChatScrollAnchor, _ proxy: ScrollViewProxy) {
        guard feed.turns.contains(where: { $0.id == anchor.turn }) else { return }
        Self.note("restore")
        proxy.scrollTo(anchor.turn, anchor: .top)
        tracker.restore(anchor)
    }
}

/// ScrollFollow in a reference (see ChatScroll.follow): `state` is not observed; `showsJump` is, by the Jump button.
@MainActor @Observable final class FollowBox {
    @ObservationIgnored var state: ScrollFollow
    /// An animated Jump to latest is scrolling until then; sticking to the bottom would cut it short.
    @ObservationIgnored var jumpUntil: ContinuousClock.Instant?
    var jumping: Bool { jumpUntil.map { ContinuousClock.now < $0 } ?? false }
    private(set) var showsJump = false
    init(_ state: ScrollFollow) { self.state = state }

    /// Copies the Jump button's visibility from `state`, only when it changes.
    func publish() {
        if state.showsJumpToLatest != showsJump { showsJump = state.showsJumpToLatest }
    }
}

/// The turns' frames in the scroll content and the viewport, for the reading position (ChatScrollMemory).
/// A reference held in @State and never observed: rows write into it as the lazy list lays them out.
/// Frames and the viewport are kept per session (the session shown when they were reported), so a switch never
/// saves one chat's turn for another, and rows that survive a rapid switch-and-back keep their frames.
@MainActor final class TurnTracker {
    nonisolated static let space = "chat.content"
    private var frames: [String: VisibleTurns] = [:]
    private var top = 0.0
    private var height = 0.0
    /// The session the viewport was last reported under.
    private var viewportSession: String?
    private var session: String?
    private var restoring: (anchor: ChatScrollAnchor, until: ContinuousClock.Instant, tries: Int)?

    /// The current chat's reading position, or nil when its rows or its viewport have not been reported since it
    /// was shown (then nothing is saved and its stored position stays as it was).
    var firstVisible: ChatScrollAnchor? { session.flatMap(anchor(for:)) }
    var isFresh: Bool { session.map(isFresh(_:)) ?? false }

    private func isFresh(_ s: String) -> Bool { viewportSession == s && (frames[s]?.count ?? 0) > 0 }
    private func anchor(for s: String) -> ChatScrollAnchor? {
        guard isFresh(s) else { return nil }
        return frames[s]?.first(top: top, viewportHeight: height)
    }

    /// Called from ChatScroll's body with the session it shows. On a change, hands the previous session's position
    /// to `save`, if it is known (a rapid switch-through never overwrites a stored position with nothing).
    func bind(session new: String, save: (String, ChatScrollAnchor?) -> Void) {
        defer { session = new }
        guard let old = session, old != new else { return }
        if isFresh(old) { save(old, anchor(for: old)) }
        restoring = nil
    }

    func viewport(top: Double, height: Double) {
        self.top = top
        self.height = height
        viewportSession = session
        report()
    }

    func set(_ id: UUID, frame: CGRect) {
        frames[session ?? "", default: VisibleTurns()].set(id, minY: frame.minY, maxY: frame.maxY)
        report()
    }

    /// A restore scrolled to `anchor.turn`; the marker step follows from the geometry (restoreNeedsMarker).
    func restore(_ anchor: ChatScrollAnchor) { restoring = (anchor, .now + .seconds(3), 0) }

    /// True when the restoring turn is the first visible one but not yet at the saved inset: scroll the marker to
    /// the top. Only within 3 s of the restore (laying out a just-loaded chat can take a second) and at most 3
    /// times, so it never fights a reader who has moved on; done once the inset is within 2 pt.
    func restoreNeedsMarker() -> Bool {
        guard let r = restoring else { return false }
        guard ContinuousClock.now < r.until, r.tries < 3 else { restoring = nil; return false }
        guard let now = firstVisible, now.turn == r.anchor.turn else { return false }
        if abs(now.inset - r.anchor.inset) <= 2 { restoring = nil; return false }
        restoring?.tries += 1
        return true
    }

    func remove(_ id: UUID) {
        for k in Array(frames.keys) { frames[k]?.remove(id) }
    }

    private func report() {
        #if DEBUG
        guard PerfProbe.enabled else { return }
        let first = firstVisible
        PerfProbe.firstVisibleTurn = first?.turn
        PerfProbe.firstVisibleInset = first?.inset
        #endif
    }
}

/// "Jump to latest": shown while the reader is above the bottom and not following.
private struct JumpToLatest: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let follow: FollowBox
    let jump: (Animation?) -> Void

    var body: some View {
        // Only in the hierarchy while shown: absent, its ⌘↓ does not fire, so the composer keeps ⌘↓ (move to end),
        // and it is out of the focus order and the accessibility tree.
        if follow.showsJump {
            Button {
                // Reduce Motion: the jump is instant.
                jump(reduceMotion ? nil : Design.Motion.standard)
            } label: {
                Label("Jump to latest", systemImage: "arrow.down")
            }
            .buttonStyle(.glass)
            .controlSize(.small)
            .keyboardShortcut(.downArrow, modifiers: .command)
            .help("Jump to the latest message (⌘↓)")
            .accessibilityLabel("Jump to latest message")
            .padding(.trailing, Design.Space.l)
            .padding(.bottom, Design.Space.m)
        }
    }
}

/// The turns. Reads only the feed's turn ids (M9 §5.5); each row observes its own message models.
private struct TurnList: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let feed: ChatFeed
    let readOnly: Bool
    let tracker: TurnTracker
    let restore: ChatScrollAnchor?

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.TurnList")
        #endif
        let turns = feed.turns
        LazyVStack(alignment: .leading, spacing: Design.turnGap) {
            ForEach(turns) { turn in
                let latest = turn.id == turns.last?.id
                TurnView(turn: turn, feed: feed, readOnly: readOnly, isLatest: latest)
                    .id(turn.id)
                    // The row's frame in the content (it changes with layout, not with scrolling).
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(TurnTracker.space)) } action: { f in
                        tracker.set(turn.id, frame: f)
                    }
                    .onDisappear { tracker.remove(turn.id) }
                    .overlay(alignment: .top) {
                        if let restore, restore.turn == turn.id { RestoreMarker(inset: restore.inset) }
                    }
                    .modifier(EntranceTransition(enabled: latest))
            }
        }
        // The entrance transition needs a transaction: animate only a newly appended turn, on the stack and not
        // the scroll view (spec §5.8). Keyed on the last turn's id, not the count: a restore inserts older turns
        // at the front and keeps the last id, and a chat switch swaps the feed (below), so neither animates.
        // Older rows use .identity; under Reduce Motion EntranceTransition is opacity only.
        // A session switch swaps the feed in this same list: no entrance then. Nearer the rows than the entrance
        // animation, so it wins when both values change in one update.
        .animation(nil, value: ObjectIdentifier(feed))
        .animation(Design.Motion.standard(reduceMotion: reduceMotion), value: turns.last?.id)
        .padding(.horizontal, Design.Space.l)
        .padding(.top, Design.Space.m)
        .padding(.bottom, Design.Space.l)
    }
}

/// An invisible point `inset` below the top of the turn being restored: scrolling it to the top restores the exact
/// reading position.
private struct RestoreMarker: View {
    static let id = "chat.restore"
    let inset: Double
    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: inset)
            Color.clear.frame(height: 1).id(Self.id)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct ScrollMetrics: Equatable { let offset: Double; let top: Double; let height: Double; let distance: Double }

struct TurnView: View {
    let turn: TurnRef
    let feed: ChatFeed
    let readOnly: Bool
    var isLatest = false
    /// One hover tracker per row: the answer's actions row shows while the pointer is anywhere on the turn.
    @State private var hovering = false

    var body: some View {
        #if DEBUG
        let _ = PerfProbe.count("body.TurnView")
        #endif
        let answer = turn.answer.flatMap(feed.model)
        VStack(alignment: .leading, spacing: Design.Space.m) {
            // The question and its "context sent" line read as one unit.
            VStack(alignment: .trailing, spacing: Design.Space.xs + 2) {
                if let q = turn.question.flatMap(feed.model) { QuestionBubble(model: q) }
                if let answer { ContextSentLine(answer: answer) }
            }
            if let answer { AnswerView(model: answer, readOnly: readOnly, isLatest: isLatest, rowHovered: hovering) }
        }
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }
}

/// "Context sent" for an answer's turn. Its own view: it reads the answer's message, which changes with every delta.
private struct ContextSentLine: View {
    @Environment(AppModel.self) private var app
    let answer: MessageModel

    var body: some View {
        if let t = answer.message.turnId, let record = app.records[t] {
            ContextSentView(record: record)
        }
    }
}
