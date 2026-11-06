import Foundation
import Synchronization

/// Rendered chunks by (chunk, root): a bounded LRU shared by the main thread and background prewarm (M9 §5.3).
/// Renders run outside the lock, so two threads may render the same chunk once each; the second insert wins.
public final class RenderCache: Sendable {
    public typealias Render = @Sendable (MarkdownChunk, String?) -> RenderedChunk
    public struct Limits: Sendable {
        public var entries: Int
        public var cost: Int
        public init(entries: Int, cost: Int) { self.entries = entries; self.cost = cost }
        public static let standard = Limits(entries: 400, cost: 16 << 20)
    }
    public struct Stats: Equatable, Sendable { public var hits = 0, misses = 0, tailRenders = 0 }

    private struct Key: Hashable { let chunk: MarkdownChunk; let root: String? }
    private struct Entry { let value: RenderedChunk; var tick: UInt64 }
    private struct State {
        var entries: [Key: Entry] = [:]
        var tick: UInt64 = 0
        var cost = 0
        var stats = Stats()
    }

    private let state = Mutex(State())
    private let limits: Limits
    private let style: ReplyMarkdown.Styler
    private let render: Render

    public init(limits: Limits = .standard, style: @escaping ReplyMarkdown.Styler = ReplyMarkdown.noStyle, render: Render? = nil) {
        self.limits = limits
        self.style = style
        self.render = render ?? { chunk, root in ReplyMarkdown.renderChunk(chunk, root: root, style: style) }
    }

    /// A custom renderer as a trailing closure (`RenderCache(limits:) { chunk, root in … }`): with the designated init,
    /// Swift's forward scan would bind an unlabelled trailing closure to `style`.
    public convenience init(limits: Limits = .standard, render: @escaping Render) {
        self.init(limits: limits, style: ReplyMarkdown.noStyle, render: render)
    }

    public var count: Int { state.withLock { $0.entries.count } }
    public var stats: Stats { state.withLock { $0.stats } }

    public func answer(for markdown: String, root: String?, streaming: Bool) -> RenderedAnswer {
        let chunks = ReplyMarkdown.chunks(markdown)
        let rendered = chunks.enumerated().map { i, c in
            if streaming && i == chunks.count - 1 {
                state.withLock { $0.stats.tailRenders += 1 }
                return render(c, root)
            }
            return chunk(c, root: root)
        }
        return ReplyMarkdown.assemble(rendered, style: style)
    }

    /// The answer only if every chunk is already cached (no rendering).
    public func cachedAnswer(for markdown: String, root: String?) -> RenderedAnswer? {
        var rendered: [RenderedChunk] = []
        for c in ReplyMarkdown.chunks(markdown) {
            guard let hit = lookup(Key(chunk: c, root: root)) else { return nil }
            rendered.append(hit)
        }
        return ReplyMarkdown.assemble(rendered, style: style)
    }

    public func prewarm(_ markdowns: [String], root: String?) {
        for m in markdowns where !Task.isCancelled { _ = answer(for: m, root: root, streaming: false) }
    }

    private func lookup(_ key: Key) -> RenderedChunk? {
        state.withLock { s in
            guard var e = s.entries[key] else { return nil }
            s.tick += 1
            e.tick = s.tick
            s.entries[key] = e
            return e.value
        }
    }

    private func chunk(_ c: MarkdownChunk, root: String?) -> RenderedChunk {
        let key = Key(chunk: c, root: root)
        if let hit = lookup(key) {
            state.withLock { $0.stats.hits += 1 }
            return hit
        }
        let value = render(c, root)
        state.withLock { s in
            s.stats.misses += 1
            if let old = s.entries[key] { s.cost -= old.value.cost }
            s.tick += 1
            s.entries[key] = Entry(value: value, tick: s.tick)
            s.cost += value.cost
            while s.entries.count > limits.entries || (s.cost > limits.cost && s.entries.count > 1) {
                guard let oldest = s.entries.min(by: { $0.value.tick < $1.value.tick }) else { break }
                s.entries[oldest.key] = nil
                s.cost -= oldest.value.value.cost
            }
        }
        return value
    }
}
