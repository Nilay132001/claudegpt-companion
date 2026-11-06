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
}
