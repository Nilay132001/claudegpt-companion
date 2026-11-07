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
        _follow = State(initialValue: FollowBox(ScrollFollow.opening(restored: restore != nil, atBottom: Self.initialAnchor == .bottom),
                                                session: sessionKey))
    }

    private static var initialAnchor: UnitPoint {
        #if DEBUG
        if DemoFlags.is_("context") || DemoFlags.is_("raw") { return .top }
        if DemoFlags.is_("rich-tables") { return .top }
        if DemoFlags.is_("rich") || DemoFlags.is_("rich-charts") { return DemoFlags.anchor == "bottom" ? .bottom : .top }
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
        let _ = tracker.bind(session: sessionKey, feed: feed) { old, anchor in
            // The follow state is reset for a chat by the ShownChat onChange, which runs after this body: in a rapid
            // switch-through it can still be another chat's. Then it says nothing about `old`: keep its position.
            guard follow.session == old else { return }
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
                    TurnList(feed: feed, readOnly: readOnly, tracker: tracker)
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
                PerfProbe.contentInsetBottom = g.contentInsets.bottom
                #endif
                // The reading area is the visible rect minus the insets (the header above, the composer below):
                // scrollTo(…, anchor: .top) aligns to its top, so the saved position is measured from there too.
                let top = g.visibleRect.minY + g.contentInsets.top
                return ScrollMetrics(offset: g.contentOffset.y, top: top,
                                     height: g.visibleRect.height - g.contentInsets.top - g.contentInsets.bottom,
                                     distance: g.contentSize.height - g.visibleRect.maxY)
            } action: { _, m in
                // While a restore moves the chat to its saved line, the geometry does not start following.
                follow.state.geometry(offset: m.offset, distanceFromBottom: m.distance, hold: tracker.isRestoring)
                tracker.viewport(top: m.top, height: m.height)
                publish()
                // A restore in progress ends once its scroll has landed (or the reader scrolls, or it times out).
                tracker.restoreStep()
                // Following, and the bottom moved away without the reader scrolling up (the answer grew, the panel
                // was resized, a row above was measured): back to the bottom. Nothing else pins the bottom, so a
                // reader above it is never moved.
                // Not while an animated Jump to latest is under way: it scrolls there itself. After a Jump to latest,
                // until it ends (RowJump.update), the stick goes to the jumped-to row, never to the marker, and not
                // while that row is at the bottom.
                if var j = follow.rowJump {
                    let h = tracker.turnHeight(j.turn)
                    follow.rowJump = j.update(lastTurn: feed.turns.last?.id, following: follow.state.following, rowHeight: h,
                                             streaming: feed.isRunning) ? j : nil
                }
                #if DEBUG
                if PerfProbe.enabled && PerfFlags.mode == "jump" {
                    PerfProbe.following = "\(follow.state.following) jump=\(follow.rowJump != nil) d=\(Int(m.distance))"
                }
                #endif
                if let j = follow.rowJump {
                    // Whenever the jumped-to row is not at the bottom, whatever the distance to the content's
                    // (estimated) end says: a re-measure (a 1 pt resize at 300 pt) left the chat at that end with the
                    // row placed above it, blank, at a distance of 0.
                    if follow.state.following && !follow.jumping
                        && !j.atBottom(gapBelow: tracker.gapBelow(j.turn), slack: Self.rowJumpSlack, now: .now) {
                        Self.note("follow")
                        proxy.scrollTo(j.turn, anchor: .bottom)
                    }
                } else if follow.state.shouldStickToBottom && !follow.jumping {
                    Self.note("follow")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .onChange(of: LastTurn(feed: ObjectIdentifier(feed), id: feed.turns.last?.id)) { old, new in
                // A new live turn (the user just asked): follow it. A restore inserts at the front and keeps the last
                // id; a session switch swaps the feed, and onChange(of: ShownChat) restores that chat's position.
                if old.feed == new.feed, feed.isRunning {
                    follow.rowJump = nil
                    tracker.endRestore("newTurn")
                    follow.state.followAgain()
                    publish()
                    Self.note("newTurn")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            // The reader taking hold of the scroll view ends a restore in progress: it never pulls them back.
            .onScrollPhaseChange { _, phase in
                #if DEBUG
                PerfProbe.count("phase.\(phase)")
                #endif
                tracker.readerScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
                if tracker.readerScrolling { tracker.endRestore("reader") }
            }
            .onAppear {
                // When a restore ends (for any reason), a reader who is at the bottom follows again.
                tracker.onRestoreEnd = { [follow] in
                    follow.state.released()
                    follow.publish()
                }
                #if DEBUG
                PerfProbe.jumpToLatest = { animated in jumpToLatest(proxy, animated ? Design.Motion.standard : nil) }
                #endif
                if let restore { scroll(to: restore, proxy) }
            }
            .onChange(of: ShownChat(session: sessionKey, feed: ObjectIdentifier(feed))) { _, new in
                // Another session's chat in the same scroll view: its saved line, or its bottom. Keyed on the session
                // and its feed together, so the action runs once the view holds that session's feed (a rapid
                // switch-through can change the key before the feed).
                let r = model.scrollMemory.position(for: new.session)
                follow.state = ScrollFollow(following: r == nil)
                follow.session = new.session
                follow.rowJump = nil
                follow.jumpCheck?.cancel()
                publish()
                if let r {
                    scroll(to: r, proxy)
                } else {
                    Self.note("switch")
                    proxy.scrollTo(Self.bottomID, anchor: .bottom)
                }
            }
            .onDisappear {
                follow.jumpCheck?.cancel()
                if tracker.isFresh && !tracker.isRestoring && follow.session == sessionKey {
                    model.scrollMemory.save(session: sessionKey, anchor: tracker.firstVisible,
                                            following: follow.state.following)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                JumpToLatest(follow: follow) { animated in jumpToLatest(proxy, animated) }
            }
        }
    }

    /// Jump to latest (the button or ⌘↓): follow again and go to the bottom, animated unless Reduce Motion.
    ///
    /// It scrolls to the last turn's row, not to the bottom marker. The marker after the lazy stack marks only the
    /// content's estimated end. From far above (the top of a long chat), the rows near the end are unmeasured, and
    /// their estimate can run more than a viewport over their real height: a scroll to the marker then stopped past
    /// the last row with nothing laid out, and no row was ever measured to correct it. That was a blank chat, for an
    /// instant jump from the top of perf-table in 15 of 24 runs. A row-anchored scroll makes the stack lay that row
    /// out and place it exactly. The row's bottom sits at least Space.l + 1 pt above the content's (estimated) end
    /// (the stack's bottom padding and the marker), so until the jump ends (RowJump) the chat follows from the row,
    /// and every re-stick goes to the row, never to the marker. Following a stream, a new question, the first open
    /// and a switch keep the marker.
    private func jumpToLatest(_ proxy: ScrollViewProxy, _ animated: Animation?) {
        tracker.endRestore("jump")
        follow.state.followAgain()
        publish()
        if animated != nil { follow.jumpUntil = .now + .milliseconds(400) }
        Self.note("jump")
        guard let last = feed.turns.last?.id else {
            withAnimation(animated) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            return
        }
        follow.rowJump = RowJump(turn: last, at: .now)
        withAnimation(animated) { proxy.scrollTo(last, anchor: .bottom) }
        // The safety net (RowJump.takeRetry): if no turn is in the reading area once the jump has run, scroll to the
        // row again, at most twice. It often fires on a chat that is already drawn (the tracker misses rows an instant
        // scroll left on screen): the retry then scrolls to where the chat already is, which is harmless.
        follow.jumpCheck?.cancel()
        // A bound, not a frame count: at least two frames at 60 Hz (four at 120 Hz). SwiftUI offers no frame clock here.
        let settle = Duration.milliseconds(34)
        let delay: Duration = animated == nil ? .zero : .milliseconds(400)
        follow.jumpCheck = Task { @MainActor in
            try? await Task.sleep(for: delay + settle)
            while !Task.isCancelled, var j = follow.rowJump, j.turn == last,
                  j.takeRetry(following: follow.state.following, readerScrolling: tracker.readerScrolling,
                              restoring: tracker.isRestoring, noTurnVisible: tracker.showsNoTurn) {
                follow.rowJump = j
                Self.note("jumpRetry") // counts scroll.jumpRetry (DEBUG)
                proxy.scrollTo(last, anchor: .bottom)
                try? await Task.sleep(for: settle)
            }
        }
    }

    /// After a Jump to latest, the row counts as at the bottom while its bottom is within this above the reading
    /// area's bottom: the stack's bottom padding and the 1 pt marker below it, plus 1 pt.
    private static let rowJumpSlack = Double(Design.Space.l) + 2

    private static let bottomID = "chat.bottom"

    private struct LastTurn: Equatable { let feed: ObjectIdentifier; let id: UUID? }
    private struct ShownChat: Equatable { let session: String; let feed: ObjectIdentifier }

    private func publish() { follow.publish() }

    /// Back to where the reader was: the saved turn, as far into it as before, in one scroll (see below).
    private func scroll(to anchor: ChatScrollAnchor, _ proxy: ScrollViewProxy) {
        guard feed.turns.contains(where: { $0.id == anchor.turn }) else { return }
        Self.note("restore")
        // One scroll, anchored inside the turn (ChatScrollAnchor.unitY). A second scroll (to the turn's top, then to
        // a marker `inset` points into it) put the chat in the right place, but SwiftUI did not report that second
        // scroll as a geometry change, so the tracker kept the turn top as the reading position and saved it on the
        // next switch (the position driver's same=false on every build).
        // y from the heights now: the reading area's current height, the turn's current height when it is laid out
        // (else the saved one), clamped so a height error moves the line by at most that error.
        let h = tracker.turnHeight(anchor.turn) ?? anchor.turnHeight
        let H = tracker.viewportHeight ?? anchor.viewportHeight
        let y = anchor.unitY(turnHeight: h, viewportHeight: H)
        proxy.scrollTo(anchor.turn, anchor: UnitPoint(x: 0, y: y))
        tracker.restore(anchor, expectedInset: ChatScrollAnchor.landedInset(unitY: y, turnHeight: h, viewportHeight: H))
    }
}

/// ScrollFollow in a reference (see ChatScroll.follow): `state` is not observed; `showsJump` is, by the Jump button.
@MainActor @Observable final class FollowBox {
    @ObservationIgnored var state: ScrollFollow
    /// The chat `state` belongs to.
    @ObservationIgnored var session: String
    /// An animated Jump to latest is scrolling until then; sticking to the bottom would cut it short.
    @ObservationIgnored var jumpUntil: ContinuousClock.Instant?
    var jumping: Bool { jumpUntil.map { ContinuousClock.now < $0 } ?? false }
    /// The Jump to latest that scrolled to the last turn's row (not the marker), until it ends (RowJump.update) or
    /// the chat switches.
    @ObservationIgnored var rowJump: RowJump?
    /// The Jump to latest safety net in flight.
    @ObservationIgnored var jumpCheck: Task<Void, Never>?
    private(set) var showsJump = false
    init(_ state: ScrollFollow, session: String) {
        self.state = state
        self.session = session
    }

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
    private var restoring: RestoreProgress?
    /// The feed shown, so a late frame report from a row of the previous chat is ignored.
    private weak var feed: ChatFeed?

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
    func bind(session new: String, feed: ChatFeed, save: (String, ChatScrollAnchor?) -> Void) {
        self.feed = feed
        defer { session = new }
        guard let old = session, old != new else { return }
        // While a restore of `old` is still under way, the geometry shows where the chat was before it scrolled (a
        // rapid switch-through): its stored position is the one being restored, so it is kept.
        if isFresh(old) && restoring == nil { save(old, anchor(for: old)) }
        restoring = nil
    }

    func viewport(top: Double, height: Double) {
        self.top = top
        self.height = height
        viewportSession = session
        report()
    }

    func set(_ id: UUID, frame: CGRect) {
        // A late report from a row of the chat shown before (a switch is under way): not this chat's turn.
        if let feed, feed.model(id) == nil {
            #if DEBUG
            PerfProbe.count("tracker.ignoredFrame")
            #endif
            return
        }
        frames[session ?? "", default: VisibleTurns()].set(id, minY: frame.minY, maxY: frame.maxY)
        #if DEBUG
        if PerfProbe.enabled { PerfProbe.rowFrames[id] = frame.minY...max(frame.minY, frame.maxY) }
        #endif
        report()
    }

    /// A restore scrolled to `anchor.turn` (ChatScroll.scroll(to:)); it is in progress until RestoreProgress ends.
    func restore(_ anchor: ChatScrollAnchor, expectedInset: Double) {
        restoring = RestoreProgress(anchor: anchor, expectedInset: expectedInset, deadline: .now + .seconds(3))
        restoreToken += 1
        let token = restoreToken
        // The deadline also ends it without a geometry change (a restore that never lands, a chat that is still).
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard let self, self.restoreToken == token else { return }
            self.endRestore("deadline")
        }
    }

    private var restoreToken = 0
    var isRestoring: Bool { restoring != nil }
    /// Called whenever a restore ends: ChatScroll re-checks following (ScrollFollow.released).
    var onRestoreEnd: (() -> Void)?

    /// The reader took over (a scroll phase, Jump to latest, ⌘↓, a new question) or the deadline passed.
    func endRestore(_ reason: String) {
        guard var r = restoring else { return }
        r.end(reason)
        finish(r)
    }

    func restoreStep() {
        guard var r = restoring else { return }
        r.step(firstVisible: firstVisible, now: .now)
        if r.finished { finish(r) } else { restoring = r }
    }

    private func finish(_ r: RestoreProgress) {
        #if DEBUG
        PerfProbe.count("restore.end." + (r.endReason ?? "?"))
        #endif
        restoring = nil
        restoreToken += 1
        onRestoreEnd?()
    }

    /// The reader is scrolling (a tracking, interacting or decelerating scroll phase).
    var readerScrolling = false

    /// The viewport of the chat shown has been reported and no laid-out turn is in it (a blank chat).
    var showsNoTurn: Bool {
        guard let s = session, viewportSession == s, height > 0 else { return false }
        return (frames[s] ?? VisibleTurns()).first(top: top, viewportHeight: height) == nil
    }

    /// Points from the turn's bottom down to the reading area's bottom (negative: the turn ends below it), or nil
    /// when the turn is not laid out in the chat shown.
    func gapBelow(_ id: UUID) -> Double? {
        guard let s = session, viewportSession == s, height > 0, let f = frames[s]?.frame(id) else { return nil }
        return top + height - f.maxY
    }

    /// The reading area's current height (nil before the first geometry).
    var viewportHeight: Double? { height > 0 ? height : nil }
    /// The turn's current height, when it is laid out in the chat shown.
    func turnHeight(_ id: UUID) -> Double? {
        guard let s = session, let f = frames[s]?.frame(id) else { return nil }
        return f.maxY - f.minY
    }

    func remove(_ id: UUID) {
        #if DEBUG
        PerfProbe.rowFrames[id] = nil
        #endif
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
        // The hovered turn's overlaid actions row hangs below its bounds: keep it above the next turn's hit shape.
        .zIndex(hovering ? 1 : 0)
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
