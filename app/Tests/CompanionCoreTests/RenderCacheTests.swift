import Foundation
import Synchronization
import Testing
@testable import CompanionCore

final class RenderLog: Sendable {
    let m = Mutex<[String]>([])
    var all: [String] { m.withLock { $0 } }
    func add(_ s: String) { m.withLock { $0.append(s) } }
}

@Suite struct RenderCacheTests {
    static func cache(_ log: RenderLog, limits: RenderCache.Limits = .standard) -> RenderCache {
        RenderCache(limits: limits) { chunk, _ in
            log.add(chunk.text)
            // Code blocks, so assembly never merges them (paragraph merging is tested on the real renderer).
            return RenderedChunk(blocks: [.code(language: nil, text: chunk.text, isOpen: false)], plainText: chunk.text,
                                 cost: chunk.text.utf8.count)
        }
    }

    @Test func rendersEachChunkOnce() {
        let log = RenderLog(), c = Self.cache(log)
        let a = c.answer(for: "A\n\nB", root: nil, streaming: false)
        let b = c.answer(for: "A\n\nB", root: nil, streaming: false)
        #expect(a == b)
        #expect(log.all == ["A", "B"])
        #expect(c.stats.hits == 2 && c.stats.misses == 2)
    }

    @Test func theRootIsPartOfTheKey() {
        let log = RenderLog(), c = Self.cache(log)
        _ = c.answer(for: "A", root: "/r", streaming: false)
        _ = c.answer(for: "A", root: "/s", streaming: false)
        #expect(log.all == ["A", "A"])
    }

    @Test func aStreamingAnswersLastChunkIsNeverCached() {
        let log = RenderLog(), c = Self.cache(log)
        _ = c.answer(for: "A\n\nB", root: nil, streaming: true)
        #expect(c.count == 1)
        _ = c.answer(for: "A\n\nBC", root: nil, streaming: true)
        #expect(log.all == ["A", "B", "BC"])
        #expect(c.stats.tailRenders == 2)
    }

    @Test func closedBlocksKeepTheirIdentityAsTheAnswerGrows() {
        let c = Self.cache(RenderLog())
        let a = c.answer(for: "A\n\nB", root: nil, streaming: true)
        let b = c.answer(for: "A\n\nB\n\nC", root: nil, streaming: true)
        #expect(a.blocks[0].id == BlockID(chunk: 0, index: 0))
        #expect(b.blocks[0] == a.blocks[0])
    }

    @Test func cachedAnswerIsNilUntilEveryChunkIsCached() {
        let c = Self.cache(RenderLog())
        #expect(c.cachedAnswer(for: "A\n\nB", root: nil) == nil)
        _ = c.answer(for: "A\n\nB", root: nil, streaming: false)
        #expect(c.cachedAnswer(for: "A\n\nB", root: nil) != nil)
    }

    @Test func evictsTheLeastRecentlyUsedByCount() {
        let log = RenderLog(), c = Self.cache(log, limits: .init(entries: 2, cost: 1 << 20))
        _ = c.answer(for: "A", root: nil, streaming: false)
        _ = c.answer(for: "B", root: nil, streaming: false)
        _ = c.answer(for: "A", root: nil, streaming: false)   // A is now newer than B
        _ = c.answer(for: "C", root: nil, streaming: false)   // evicts B
        _ = c.answer(for: "A", root: nil, streaming: false)
        _ = c.answer(for: "B", root: nil, streaming: false)
        #expect(log.all == ["A", "B", "C", "B"])
        #expect(c.count == 2)
    }

    @Test func evictsByCost() {
        let c = Self.cache(RenderLog(), limits: .init(entries: 100, cost: 10))
        _ = c.answer(for: "aaaaaa", root: nil, streaming: false)
        _ = c.answer(for: "bbbbbb", root: nil, streaming: false)
        #expect(c.count == 1)
    }

    @Test func concurrentPrewarmIsSafe() async {
        let c = Self.cache(RenderLog())
        let texts = (0..<20).map { "Answer \($0)" }
        await withTaskGroup(of: Void.self) { g in
            for _ in 0..<8 { g.addTask { c.prewarm(texts, root: nil) } }
        }
        #expect(c.count == 20)
    }

    @Test func adjacentParagraphsMergeAndKeepTheFirstId() {
        let a = ReplyMarkdown.render("One.\n\nTwo.", root: nil)
        #expect(a.blocks.count == 1 && a.blocks[0].id == BlockID(chunk: 0, index: 0))
        guard case .paragraphs(let s) = a.blocks[0].block else { Issue.record("not prose"); return }
        #expect(String(s.characters) == "One.\n\nTwo.")
    }

    @Test func theRealRendererMatchesThePlainText() {
        let c = RenderCache()
        let md = "# Title\n\nSome **bold** text.\n\n```swift\nlet a = 1\n```"
        #expect(c.answer(for: md, root: nil, streaming: false).plainText == ReplyMarkdown.plainText(md))
    }
}
