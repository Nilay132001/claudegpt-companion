import Foundation
import Testing
@testable import CompanionCore

@Suite struct TableModelTests {
    func table(_ md: String) -> TableModel {
        guard case .table(let t) = ReplyMarkdown.blocks(md, root: nil).first else { fatalError("no table") }
        return t
    }
    let two = "| Package | Seconds |\n|---|---:|\n| parser | 4.2 |\n| csv | 1.9 |"
    let five = "| a | b | c | d | e |\n|---|---|---|---|---|\n| 1 | 2 | 3 | 4 | 5 |"

    @Test func wideColumnsUseAGridWhenTheyFit() {
        #expect(TableLayout.choose(idealWidths: [80, 60], available: 568) == .grid)
        #expect(TableLayout.choose(idealWidths: [200, 200, 200], available: 568) == .scroll)
        #expect(TableLayout.choose(idealWidths: [100, 100, 100], available: 417) == .grid)
    }

    @Test func at360AGridOnlyForThreeColumnsThatFit() {
        #expect(TableLayout.choose(idealWidths: [90, 90, 90], available: 328) == .grid)
        #expect(TableLayout.choose(idealWidths: [60, 60, 60, 60], available: 328) == .scroll)
        #expect(TableLayout.choose(idealWidths: [150, 150, 150], available: 328) == .scroll)
    }

    @Test func at300TwoColumnsGridMoreColumnsStack() {
        #expect(TableLayout.choose(idealWidths: [220, 220], available: 268) == .grid)
        #expect(TableLayout.choose(idealWidths: [40, 40, 40], available: 268) == .stacked)
    }

    @Test func cellsAreCappedWhenMeasuring() {
        #expect(TableLayout.choose(idealWidths: [900, 60], available: 417) == .grid)   // 220 + 60 fits
    }

    @Test func estimatedWidthsUseTheWidestCell() {
        let w = table(two).estimatedColumnWidths(charWidth: 10, padding: 0)
        #expect(w == [70, 70])   // "Package" and "Seconds", 7 characters each
    }

    @Test func copyFormats() {
        let t = table(two)
        #expect(t.tabSeparated == "Package\tSeconds\nparser\t4.2\ncsv\t1.9")
        #expect(t.markdown == "| Package | Seconds |\n| --- | ---: |\n| parser | 4.2 |\n| csv | 1.9 |")
        #expect(table("| a \\| b |\n|---|\n| x |").markdown.contains("a \\| b"))
    }

    @Test func spokenRows() {
        #expect(table(two).spokenRows == ["parser: 4.2.", "csv: 1.9."])
        #expect(table(five).spokenRows == ["1: b 2, c 3, d 4, e 5."])
    }

    func t(_ cells: [[String]]) -> TableModel {
        TableModel(alignments: Array(repeating: .leading, count: cells[0].count),
                   header: cells[0].map { AttributedString($0) }, rows: cells.dropFirst().map { $0.map { AttributedString($0) } })
    }

    @Test func boundaries() {
        #expect(TableLayout.choose(idealWidths: [40, 40, 40], available: 299) == .stacked)
        #expect(TableLayout.choose(idealWidths: [40, 40, 40], available: 300) == .grid)
        #expect(TableLayout.choose(idealWidths: [60, 60, 60, 60], available: 379) == .scroll)
        #expect(TableLayout.choose(idealWidths: [60, 60, 60, 60], available: 380) == .grid)
        #expect(TableLayout.choose(idealWidths: [], available: 400) == .grid)
        #expect(TableLayout.choose(idealWidths: [50], available: 200) == .grid)
    }

    @Test func hysteresisKeepsTheDecisionNearAThreshold() {
        let w = [60.0, 60, 60, 60]
        let at380 = TableLayout.decide(idealWidths: w, available: 380, previous: nil)
        #expect(at380.choice == .grid && at380.tier == 2)
        // 15 pt narrower (a scroll bar appeared): stays in the tier and a grid
        #expect(TableLayout.decide(idealWidths: w, available: 372, previous: at380).choice == .grid)
        #expect(TableLayout.decide(idealWidths: w, available: 371, previous: at380).tier == 1)
        let at379 = TableLayout.decide(idealWidths: w, available: 379, previous: nil)
        #expect(at379.tier == 1)
        #expect(TableLayout.decide(idealWidths: w, available: 387, previous: at379).tier == 1)
        #expect(TableLayout.decide(idealWidths: w, available: 388, previous: at379).tier == 2)
        let s = TableLayout.decide(idealWidths: [40, 40, 40], available: 295, previous: nil)
        #expect(s.choice == .stacked)
        #expect(TableLayout.decide(idealWidths: [40, 40, 40], available: 305, previous: s).choice == .stacked)
        #expect(TableLayout.decide(idealWidths: [40, 40, 40], available: 308, previous: s).choice == .grid)
    }

    @Test func tsvNeutralisesFormulasTabsAndNewlines() {
        let m = t([["a", "b"], ["=1+1", "@x"], ["-cmd", "+0.1"], ["-0.3", "0"], ["a\tb", "x\ny"], ["12%", "−0.3"]])
        let rows = m.tabSeparated.split(separator: "\n", omittingEmptySubsequences: false).map { $0.split(separator: "\t", omittingEmptySubsequences: false).map(String.init) }
        #expect(rows[1] == ["'=1+1", "'@x"])
        #expect(rows[2] == ["'-cmd", "+0.1"])
        #expect(rows[3] == ["-0.3", "0"])
        #expect(rows[4] == ["a b", "x y"])
        #expect(rows[5] == ["12%", "−0.3"])
        #expect(rows.count == 6)
    }

    @Test func markdownEscapesSpecialsAndBreaks() {
        let m = t([["h"], ["a*b_c [x] <y> `z` \\ ~"], ["l1\nl2"]])
        #expect(m.markdown.contains("a\\*b\\_c \\[x\\] \\<y\\> \\`z\\` \\\\ \\~"))
        #expect(m.markdown.contains("l1<br>l2"))
        #expect(!m.markdown.contains("l1\nl2"))
    }

    @Test func accessibilityRowsNameEveryColumn() {
        #expect(table(two).accessibilityRows == ["Package: parser, Seconds: 4.2", "Package: csv, Seconds: 1.9"])
        #expect(table(five).accessibilityRows == ["a: 1, b: 2, c: 3, d: 4, e: 5"])
    }

    @Test func stackedRowTitles() {
        let m = t([["Name", "N", "Note"], ["alpha", "1", ""], ["", "2", "x"], ["42", "3", "y"], ["-0.3", "", ""]])
        #expect(m.stackedRow(0) == .init(titleColumn: 0, number: 1, detailColumns: [1]))
        #expect(m.stackedRow(1) == .init(titleColumn: nil, number: 2, detailColumns: [1, 2]))
        #expect(m.stackedRow(2) == .init(titleColumn: nil, number: 3, detailColumns: [0, 1, 2]))
        #expect(m.stackedRow(3) == .init(titleColumn: nil, number: 4, detailColumns: [0]))
    }

    @Test func twoTierJumpsNeedEveryMargin() {
        let w = [40.0, 40, 40]
        let wide = TableLayout.decide(idealWidths: w, available: 500, previous: nil)
        #expect(wide.tier == 2)
        #expect(TableLayout.decide(idealWidths: w, available: 295, previous: wide).tier == 1)   // 380 crossed, 300 not by 8
        #expect(TableLayout.decide(idealWidths: w, available: 291, previous: wide).tier == 0)
        let narrow = TableLayout.decide(idealWidths: w, available: 100, previous: nil)
        #expect(TableLayout.decide(idealWidths: w, available: 385, previous: narrow).tier == 1)
        #expect(TableLayout.decide(idealWidths: w, available: 390, previous: narrow).tier == 2)
    }

    @Test func widthEstimateFollowsAGrowingTable() {
        let est = TableWidthEstimate()
        let a = table("| a |\n|---|\n| x |")
        let b = table("| a |\n|---|\n| a much longer cell |")
        let wa = est.widths(for: a, scale: 1)
        #expect(est.widths(for: b, scale: 1)[0] > wa[0])
        #expect(est.widths(for: b, scale: 2)[0] > est.widths(for: b, scale: 1)[0])
    }
}
