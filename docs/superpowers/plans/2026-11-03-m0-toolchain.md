# M0 — Toolchain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript service package and a Swift package that both build and run real tests locally and in CI, each with one small unit the product needs.

**Architecture:** `companiond/` is a Node package that runs TypeScript directly through Node's built-in type stripping (no build step); `tsc --noEmit` checks types. `app/` is a SwiftPM package with a `CompanionCore` library (testable logic) and a `CompanionApp` SwiftUI executable. The first units are `LineBuffer` (partial-line buffering, used later by the stdio codec and transcript tail) and `SpeechText` (markdown → speakable text, used by Read Aloud).

**Tech Stack:** Node ≥ 24 (`node --test`, type stripping), TypeScript 5.9 (type-check only), Swift 6.2+, Swift Testing, SwiftUI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (§2, §6.4, §8, §9, §13, §14)

## Global Constraints

- Minimum macOS: 26 (spec §9).
- No OpenAI API keys, no network calls in tests.
- Fixtures are synthetic and contain the marker `SYNTHETIC FIXTURE` (spec §13).
- No license file until the owner approves one (spec §15 D3).
- Work on a feature branch; never push to `main`; open a PR.
- Commit messages: Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `scripts/check-repo.sh` must pass before every commit.

---

### Task 1: Full Xcode is installed and selected (owner action)

**Files:** none.

- [ ] **Step 1: Owner installs Xcode** from the Mac App Store (search "Xcode", ~15 GB). Opening it once installs extra components.

- [ ] **Step 2: Owner selects it and accepts the license** (needs the owner's password, so the owner runs these):

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
```
```bash
sudo xcodebuild -license accept
```
```bash
xcodebuild -runFirstLaunch
```

- [ ] **Step 3: Verify**

Run: `xcodebuild -version && xcrun --show-sdk-version`
Expected: `Xcode 26.x` or later and an SDK version ≥ 26.

### Task 2: `companiond` package with `LineBuffer`

**Files:**
- Create: `companiond/package.json`
- Create: `companiond/tsconfig.json`
- Create: `companiond/src/lineBuffer.ts`
- Test: `companiond/test/lineBuffer.test.ts`

**Interfaces:**
- Produces: `class LineBuffer { push(chunk: Buffer): string[]; get pendingBytes(): number; reset(): void }` — splits on `\n`, strips a trailing `\r`, drops empty lines, keeps the unfinished tail (as bytes, so a UTF-8 character split across chunks is preserved).

- [ ] **Step 1: Create the package files**

`companiond/package.json`:
```json
{
  "name": "companiond",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "test": "node --test \"test/**/*.test.ts\"",
    "typecheck": "tsc --noEmit"
  }
}
```

`companiond/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "strict": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["src", "test"]
}
```

Run: `cd companiond && npm install -D typescript@5.9 @types/node@24`
Expected: `package-lock.json` created, `devDependencies` added.

- [ ] **Step 2: Write the failing test** — `companiond/test/lineBuffer.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { LineBuffer } from "../src/lineBuffer.ts";

const b = (s: string) => Buffer.from(s, "utf8");

test("returns complete lines and keeps the partial tail", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b('{"a":1}\n{"b":')), ['{"a":1}']);
  assert.equal(lb.pendingBytes, 5);
  assert.deepEqual(lb.push(b('2}\n')), ['{"b":2}']);
  assert.equal(lb.pendingBytes, 0);
});

test("keeps a UTF-8 character split across chunks intact", () => {
  const lb = new LineBuffer();
  const bytes = b("café\n");
  assert.deepEqual(lb.push(bytes.subarray(0, 4)), []);
  assert.deepEqual(lb.push(bytes.subarray(4)), ["café"]);
});

test("strips CR and drops empty lines", () => {
  const lb = new LineBuffer();
  assert.deepEqual(lb.push(b("one\r\n\n\ntwo\n")), ["one", "two"]);
});

test("reset discards the partial tail", () => {
  const lb = new LineBuffer();
  lb.push(b("half"));
  lb.reset();
  assert.equal(lb.pendingBytes, 0);
  assert.deepEqual(lb.push(b("whole\n")), ["whole"]);
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd companiond && npm test`
Expected: FAIL — `Cannot find module '../src/lineBuffer.ts'`.

- [ ] **Step 4: Implement** — `companiond/src/lineBuffer.ts`:

```ts
export class LineBuffer {
  #rest: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): string[] {
    const buf = this.#rest.length ? Buffer.concat([this.#rest, chunk]) : chunk;
    const lines: string[] = [];
    let start = 0;
    let nl = buf.indexOf(0x0a, start);
    while (nl !== -1) {
      let line = buf.subarray(start, nl).toString("utf8");
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) lines.push(line);
      start = nl + 1;
      nl = buf.indexOf(0x0a, start);
    }
    this.#rest = Buffer.from(buf.subarray(start));
    return lines;
  }

  get pendingBytes(): number {
    return this.#rest.length;
  }

  reset(): void {
    this.#rest = Buffer.alloc(0);
  }
}
```

- [ ] **Step 5: Run tests and type-check**

Run: `cd companiond && npm test && npm run typecheck`
Expected: 4 tests pass; `tsc` prints nothing and exits 0.

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/package.json companiond/package-lock.json companiond/tsconfig.json companiond/src/lineBuffer.ts companiond/test/lineBuffer.test.ts
git commit -m "feat(companiond): add package skeleton and LineBuffer"
```

### Task 3: Swift package with `SpeechText`

**Files:**
- Create: `app/Package.swift`
- Create: `app/Sources/CompanionCore/SpeechText.swift`
- Create: `app/Sources/CompanionApp/CompanionApp.swift`
- Test: `app/Tests/CompanionCoreTests/SpeechTextTests.swift`

**Interfaces:**
- Consumes: Task 1 (Xcode selected).
- Produces: `public enum SpeechText { public static func plainText(fromMarkdown: String, readCode: Bool = false) -> String }` — removes markdown syntax, replaces each fenced code block with `Code block omitted.` unless `readCode`, keeps link text, drops images, turns table rows into comma-separated cells, keeps `snake_case` words intact.

- [ ] **Step 1: Create `app/Package.swift`**

```swift
// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "ClaudeGPTCompanion",
    platforms: [.macOS(.v26)],
    products: [.executable(name: "CompanionApp", targets: ["CompanionApp"])],
    targets: [
        .target(name: "CompanionCore"),
        .executableTarget(name: "CompanionApp", dependencies: ["CompanionCore"]),
        .testTarget(name: "CompanionCoreTests", dependencies: ["CompanionCore"]),
    ]
)
```

- [ ] **Step 2: Write the failing tests** — `app/Tests/CompanionCoreTests/SpeechTextTests.swift`:

```swift
import Testing
@testable import CompanionCore

@Suite struct SpeechTextTests {
    @Test func stripsHeadingsAndEmphasis() {
        #expect(SpeechText.plainText(fromMarkdown: "# Title\nThis is **bold** and *it*.") == "Title\nThis is bold and it.")
    }
    @Test func omitsFencedCode() {
        #expect(SpeechText.plainText(fromMarkdown: "Before\n```python\nprint(1)\n```\nAfter") == "Before\nCode block omitted.\nAfter")
    }
    @Test func readsCodeWhenAsked() {
        #expect(SpeechText.plainText(fromMarkdown: "Before\n```\nprint(1)\n```\nAfter", readCode: true) == "Before\nprint(1)\nAfter")
    }
    @Test func unterminatedFenceIsOmitted() {
        #expect(SpeechText.plainText(fromMarkdown: "Look\n```\nx = 1") == "Look\nCode block omitted.")
    }
    @Test func keepsLinkTextAndDropsImages() {
        #expect(SpeechText.plainText(fromMarkdown: "See [docs](https://example.com) ![img](a.png)") == "See docs")
    }
    @Test func unwrapsInlineCode() {
        #expect(SpeechText.plainText(fromMarkdown: "Run `npm test` now") == "Run npm test now")
    }
    @Test func stripsListAndQuoteMarkers() {
        #expect(SpeechText.plainText(fromMarkdown: "- one\n2. two\n> quoted") == "one\ntwo\nquoted")
    }
    @Test func keepsSnakeCase() {
        #expect(SpeechText.plainText(fromMarkdown: "use file_name_here") == "use file_name_here")
    }
    @Test func flattensTables() {
        #expect(SpeechText.plainText(fromMarkdown: "| a | b |\n|---|---|\n| 1 | 2 |") == "a, b\n1, 2")
    }
}
```

Create a placeholder-free stub so the package compiles and the tests fail on behaviour — `app/Sources/CompanionCore/SpeechText.swift`:

```swift
public enum SpeechText {
    public static func plainText(fromMarkdown markdown: String, readCode: Bool = false) -> String {
        markdown
    }
}
```

And `app/Sources/CompanionApp/CompanionApp.swift`:

```swift
import SwiftUI
import CompanionCore

@main
struct CompanionApp: App {
    var body: some Scene {
        WindowGroup("ClaudeGPT Companion") {
            Text(SpeechText.plainText(fromMarkdown: "**ClaudeGPT Companion** — read-only"))
                .padding()
        }
    }
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd app && swift test`
Expected: builds; most `SpeechTextTests` FAIL with expectation mismatches (`keepsSnakeCase` passes).

- [ ] **Step 4: Implement** — replace `app/Sources/CompanionCore/SpeechText.swift`:

```swift
import Foundation

public enum SpeechText {
    public static func plainText(fromMarkdown markdown: String, readCode: Bool = false) -> String {
        var out: [String] = []
        var inFence = false
        var fenced: [String] = []

        func closeFence() {
            out.append(readCode ? fenced.joined(separator: "\n") : "Code block omitted.")
            fenced = []
        }

        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("```") || line.hasPrefix("~~~") {
                if inFence { closeFence() }
                inFence.toggle()
                continue
            }
            if inFence { fenced.append(raw); continue }
            if line.range(of: #"^\|?\s*:?-{3,}"#, options: .regularExpression) != nil { continue }
            out.append(inline(block(line)))
        }
        if inFence { closeFence() }
        return out.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    static func block(_ line: String) -> String {
        if line.hasPrefix("|") {
            return line.split(separator: "|")
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
                .joined(separator: ", ")
        }
        return line.replacingOccurrences(
            of: #"^(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
    }

    static func inline(_ text: String) -> String {
        var t = text
        t = t.replacingOccurrences(of: #"!\[[^\]]*\]\([^)]*\)"#, with: "", options: .regularExpression)
        t = t.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        t = t.replacingOccurrences(of: #"(\*\*|__|~~|\*)(\S(?:.*?\S)?)\1"#, with: "$2", options: .regularExpression)
        return t.trimmingCharacters(in: .whitespaces)
    }
}
```

- [ ] **Step 5: Run tests and build the app**

Run: `cd app && swift test && swift build --product CompanionApp`
Expected: 9 tests pass; build succeeds.

- [ ] **Step 6: Smoke-run the app**

Run: `cd app && swift run CompanionApp` — a window titled "ClaudeGPT Companion" shows "ClaudeGPT Companion — read-only". Quit with ⌘Q.

- [ ] **Step 7: Commit**

```bash
bash scripts/check-repo.sh
git add app/Package.swift app/Sources/CompanionCore/SpeechText.swift app/Sources/CompanionApp/CompanionApp.swift app/Tests/CompanionCoreTests/SpeechTextTests.swift
git commit -m "feat(app): add Swift package skeleton and SpeechText"
```

### Task 4: CI for Node and Swift tests

**Files:**
- Create: `.github/workflows/tests.yml`
- Modify: `README.md` (add a "Development" section)

- [ ] **Step 1: Create `.github/workflows/tests.yml`**

```yaml
name: Tests

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  companiond:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: companiond
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci
      - run: npm test
      - run: npm run typecheck

  app:
    runs-on: macos-26
    defaults:
      run:
        working-directory: app
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild -version
      - run: swift test
```

- [ ] **Step 2: Add to `README.md`** after the "Try the proof of concept" section:

````markdown
## Development

Requires macOS 26+, full Xcode, Node 24+.

```bash
cd companiond && npm ci && npm test && npm run typecheck
cd app && swift test
bash scripts/check-repo.sh
```
````

- [ ] **Step 3: Commit, push the branch, open the PR**

```bash
bash scripts/check-repo.sh
git add .github/workflows/tests.yml README.md
git commit -m "ci: run companiond and Swift tests"
```

- [ ] **Step 4: Verify CI** — `gh pr checks` on the M0 PR.
Expected: `companiond`, `app`, `secrets` all pass. If `app` fails because the `macos-26` runner image does not exist, change `runs-on` to the newest macOS image listed at https://github.com/actions/runner-images whose Xcode has a macOS 26 SDK; if none has, remove the `app` job, note in README "Swift tests run locally only until GitHub has a macOS 26 runner", and commit that as `ci: run Swift tests locally until a macOS 26 runner exists`.
