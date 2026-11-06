import Foundation
import Testing
@testable import CompanionCore

@Suite struct ScrollFollowTests {
    @Test func followsAtFirst() {
        let f = ScrollFollow()
        #expect(f.following && !f.showsJumpToLatest)
    }

    @Test func staysFollowingWithin80PointsOfTheBottom() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 960, distanceFromBottom: 40)
        #expect(f.following)
        f.geometry(offset: 920, distanceFromBottom: 80)
        #expect(f.following)
    }

    @Test func scrollingUpPastTheThresholdStopsFollowing() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 900, distanceFromBottom: 100)
        #expect(!f.following)
        #expect(f.showsJumpToLatest)
    }

    @Test func contentGrowingBelowDoesNotStopFollowing() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 1000, distanceFromBottom: 240) // a big delta arrived; the offset did not move up
        #expect(f.following)
        #expect(!f.showsJumpToLatest)
    }

    @Test func comingBackNearTheBottomFollowsAgain() {
        var f = ScrollFollow()
        f.geometry(offset: 1000, distanceFromBottom: 0)
        f.geometry(offset: 500, distanceFromBottom: 500)
        f.geometry(offset: 950, distanceFromBottom: 50)
        #expect(f.following)
    }

    @Test func followAgainAfterSendOrJump() {
        var f = ScrollFollow(following: false)
        f.geometry(offset: 10, distanceFromBottom: 900)
        #expect(f.showsJumpToLatest)
        f.followAgain()
        #expect(f.following && !f.showsJumpToLatest)
    }

    @Test func memoryKeepsOnlyPositionsAwayFromTheBottom() {
        var m = ChatScrollMemory()
        let a = UUID()
        m.save(session: "s1", firstVisible: a, following: false)
        m.save(session: "s2", firstVisible: UUID(), following: true)
        #expect(m.position(for: "s1") == a)
        #expect(m.position(for: "s2") == nil)
        m.save(session: "s1", firstVisible: a, following: true)
        #expect(m.position(for: "s1") == nil)
    }

    @Test func pastChatsAndSessionsKeepSeparatePositions() {
        var m = ChatScrollMemory()
        let live = UUID(), past = UUID()
        m.save(session: "t1", firstVisible: live, following: false)
        m.save(session: "past:" + "t1", firstVisible: past, following: false)
        #expect(m.position(for: "t1") == live)
        #expect(m.position(for: "past:t1") == past)
        #expect(m.position(for: "past:t2") == nil)
    }

    @Test func savingWithoutAVisibleTurnShowsTheBottom() {
        var m = ChatScrollMemory()
        m.save(session: "s1", firstVisible: UUID(), following: false)
        m.save(session: "s1", firstVisible: nil, following: false)
        #expect(m.position(for: "s1") == nil)
    }

    @Test func aRestoredChatStartsNotFollowing() {
        // ChatView starts a chat with a saved position as ScrollFollow(following: false).
        let f = ScrollFollow(following: false)
        #expect(!f.following && !f.showsJumpToLatest) // shown once geometry reports it is above the bottom
    }
}
