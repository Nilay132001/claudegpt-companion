#if DEBUG
/// Synthetic rich answers for the `rich` scene (every block type). Nothing here is real data.
enum RichContent {
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
    ]
}
#endif
