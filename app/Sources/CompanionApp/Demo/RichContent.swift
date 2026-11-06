#if DEBUG
/// Synthetic rich answers for the `rich` scene (every block type). Nothing here is real data.
enum RichContent {
    /// Scene `rich-tables`: a narrow (2 columns), a medium (4) and a wide (5) table, nothing else.
    static let tableTurn: (question: String, answer: String) = ("Compare the tables", """
        ## Parts

        | Package | Seconds |
        |---|---:|
        | parser | 4.2 |
        | csv | 1.9 |
        | cli | 0.7 |

        ## Runtime

        | Package | Tests | Seconds | Change |
        |:--------|------:|--------:|:------:|
        | parser | 42 | 4.2 | −0.3 |
        | csv | 17 | 1.9 | +0.1 |
        | cli | 8 | 0.7 | 0 |

        ## Files

        | File | Lines changed | Risk | Reviewer note | Follow-up |
        |---|---|---|---|---|
        | src/parser/tokenize.ts | 14 | low | flush at end of input | none |
        | src/csv/write.ts | 6 | medium | relies on empty-list behaviour of tokenize for blank rows | add a test |
        """)

    /// Scene `rich-charts`: a bar chart with two series, a line chart and a pie chart.
    static let chartTurn: (question: String, answer: String) = ("Chart the test runs", """
        ## Runtime by package

        ```companion-chart
        {"version":1,"type":"bar","title":"Runtime, main vs branch","units":"s","x":{"label":"Package"},"y":{"label":"Seconds"},
         "series":[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9},{"label":"cli","value":0.7}]},
                   {"name":"branch","points":[{"label":"parser","value":3.9},{"label":"csv","value":2.0},{"label":"cli","value":0.7}]}],
         "source":"Synthetic demo numbers"}
        ```

        ```companion-chart
        {"version":1,"type":"line","title":"Suite time over the last runs","units":"s",
         "series":[{"name":"suite","points":[{"label":"Mon","value":7.9},{"label":"Tue","value":7.4},{"label":"Wed","value":6.8},{"label":"Thu","value":6.9},{"label":"Fri","value":6.1}]}],
         "source":"Synthetic demo numbers"}
        ```

        ```companion-chart
        {"version":1,"type":"pie","title":"Where the time goes","units":"%",
         "series":[{"name":"share","points":[{"label":"parser","value":62},{"label":"csv","value":28},{"label":"cli","value":10}]}],
         "source":"Synthetic demo numbers"}
        ```

        ```companion-chart
        {"version":1,"type":"metric","title":"Extremes","units":"requests per min",
         "series":[{"name":"run","points":[{"label":"lowest balance on the ledger account","value":-999999999999.99},{"label":"peak","value":42}]}],
         "source":"Synthetic demo numbers"}
        ```
        """)

    static let turns: [(question: String, answer: String)] = [
        ("Summarise the parser change", """
        # Parser change review

        The fix is **right**, with one edge case left. Claude changed `tokenize` in src/parser/tokenize.ts:42 so the \
        last token is flushed at the end of input.

        ## What changed

        1. The loop now flushes `buf` after the last character.
        2. Empty input returns an empty list.
           - It no longer returns `[""]`.
           - The CSV writer relied on that; see src/csv/write.ts:18.
        3. ~~The old workaround~~ is removed.

        ### Checklist

        - [x] Unit test for `"a b"`
        - [x] Unit test for `""`
        - [ ] Test for a trailing tab

        > Claude's note: the CRLF case is handled by the caller, not here.

        ---

        Inline math: the cost grows as $n^2$ in the worst case, about $5 per run in CI.

        $$
        T(n) = 2T(n/2) + n
        $$
        """),
        ("Compare the test runs", """
        ## Test runtime

        | Package | Tests | Seconds | Change |
        |:--------|------:|--------:|:------:|
        | parser | 42 | 4.2 | −0.3 |
        | csv | 17 | 1.9 | +0.1 |
        | cli | 8 | 0.7 | 0 |

        | File | Lines changed | Risk | Reviewer note | Follow-up |
        |---|---|---|---|---|
        | src/parser/tokenize.ts | 14 | low | flush at end of input | none |
        | src/csv/write.ts | 6 | medium | relies on empty-list behaviour of tokenize for blank rows | add a test |
        """),
        ("Show me the code", """
        Here is the new loop:

        ```ts src/parser/tokenize.ts:40
        export function tokenize(input: string): Token[] {
          const out: Token[] = []; const buf: string[] = []; for (const ch of input) { if (ch === " ") { flush(out, buf); continue } buf.push(ch) }
          flush(out, buf);
          return out;
        }
        ```

        And a long shell line:

        ```sh
        npm test -- --runInBand --coverage --coverageReporters=text-summary --testPathPattern='src/(parser|csv)/.*\\.test\\.ts$'
        ```
        """),
        ("Why is the payload one line", """
        A minified line is wrapped whatever the setting says:

        ```json
        {"rows":[\(String(repeating: "{\"id\":1,\"ok\":true},", count: 110))]}
        ```
        """),
        ("Show the whole matcher", """
        The matcher in full (long, so only the start shows until you expand it):

        ```ts packages/worker/src/reconcile/ledgerMatcher.ts:12
        export const SETTLEMENT_WINDOW_NOTE = "Settlements that arrive more than 72 hours after the ledger entry are matched in the late pass, never the first one, to avoid double counting.";
        const row1 = ledger.rows[1];
        const row2 = ledger.rows[2];
        const row3 = ledger.rows[3];
        const row4 = ledger.rows[4];
        const row5 = ledger.rows[5];
        const row6 = ledger.rows[6];
        // step 7: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row8 = ledger.rows[8];
        const row9 = ledger.rows[9];
        const row10 = ledger.rows[10];
        const row11 = ledger.rows[11];
        const row12 = ledger.rows[12];
        const row13 = ledger.rows[13];
        // step 14: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row15 = ledger.rows[15];
        const row16 = ledger.rows[16];
        const row17 = ledger.rows[17];
        const row18 = ledger.rows[18];
        const row19 = ledger.rows[19];
        const row20 = ledger.rows[20];
        // step 21: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row22 = ledger.rows[22];
        const row23 = ledger.rows[23];
        const row24 = ledger.rows[24];
        const row25 = ledger.rows[25];
        const row26 = ledger.rows[26];
        const row27 = ledger.rows[27];
        // step 28: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row29 = ledger.rows[29];
        const row30 = ledger.rows[30];
        const row31 = ledger.rows[31];
        const row32 = ledger.rows[32];
        const row33 = ledger.rows[33];
        const row34 = ledger.rows[34];
        // step 35: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row36 = ledger.rows[36];
        const row37 = ledger.rows[37];
        const row38 = ledger.rows[38];
        const row39 = ledger.rows[39];
        const row40 = ledger.rows[40];
        const row41 = ledger.rows[41];
        // step 42: keep the ledger rows in order and skip entries that were already matched in an earlier pass
        const row43 = ledger.rows[43];
        const row44 = ledger.rows[44];
        const row45 = ledger.rows[45];
        ```

        ```
        a plain block with no language: short
        ```
        """),
        ("Chart it", """
        The slowest package is the parser:

        ```companion-chart
        {"version":1,"type":"bar","title":"Test runtime by package","units":"s",
         "x":{"label":"Package"},"y":{"label":"Seconds"},
         "series":[{"name":"main","points":[{"label":"parser","value":4.2},{"label":"csv","value":1.9}]}],
         "source":"Read from the npm test output in the session context"}
        ```

        ```companion-chart
        {"version":1,"type":"metric","title":"This run","series":[{"name":"run","points":[{"label":"tests","value":67},{"label":"seconds","value":6.8},{"label":"failures","value":0}]}],"source":"Synthetic demo numbers"}
        ```

        ```companion-chart
        {"version":1,"type":"bar","title":"Broken","series":[{"name":"main","points":[{"label":"parser","value":"4.2"}]}],"source":"Synthetic demo numbers"}
        ```
        """),
    ]
}
#endif
