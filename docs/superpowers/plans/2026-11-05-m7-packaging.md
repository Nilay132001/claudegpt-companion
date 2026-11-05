# M7 — Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command builds a self-contained, signed `ClaudeGPT Companion.app` (Swift app, companiond, the pinned Codex 0.166.0 and a pinned official Node.js), a second packs it into a DMG, a smoke test proves the built bundle starts and passes its own security self-check, and the owner has an install guide, signing notes and a Developer ID / notarization path driven by parameters only they set.

**Architecture:** `scripts/build-app.sh` gains three things: the relay source (missing from the M5/M6 bundle, so chat could not build its relay), a pinned official Node.js 24 fetched by `scripts/fetch-node.sh` and checked against a SHA-256 kept in `app/bundle/node.pin`, and an inside-out signature (Node first, re-signed with only the two JIT entitlements; then the app). Codex keeps OpenAI's own Developer ID signature, which the build checks but never changes. The app prefers the bundled Node. `scripts/smoke-bundle.sh` runs the built bundle's own Node and companiond against a throw-away `HOME` (host must reach `ready`, signed out, so the whole pre-start self-check passed from inside the bundle) and then runs the Seatbelt suites under the bundled Node. `scripts/package-app.sh` makes the DMG; `scripts/notarize.sh` is for the owner only and refuses to run without `COMPANION_SIGN_IDENTITY` and `COMPANION_NOTARY_PROFILE`.

**Tech Stack:** bash, `codesign`, `hdiutil`, `xcrun notarytool` / `stapler` (owner only), Node ≥ 24 TypeScript (`node --test`), Swift 6.2 / Swift Testing on macOS 26, GitHub Actions `macos-26`.

**Spec:** `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` v3.5. Read §2 (the *M5* note on Node), §7.1.9 (Codex under Seatbelt, the relay), §7.2 (the jail's Node prefix rules), §7.8, §9 (signing notes), §13 and §14 (M7: "Packaging, install guide, signing notes — clean install on this Mac"). Also read `scripts/build-app.sh`, `app/Sources/CompanionCore/Daemon/DaemonLocator.swift`, `companiond/src/launch/toolchain.ts`, `companiond/src/codex/codexInstall.ts`, `companiond/src/relay/relayBuild.ts`.

**Review status:** written 2026-11-05 against `main` at 9c23dfe (M6 merged, PR #12); self-reviewed. Not yet implemented.

## Measured while planning (2026-11-05, this Mac, macOS 27, arm64)

These facts decide the design; do not re-litigate them without a new measurement.

1. **Codex binaries are already Developer ID signed** by OpenAI with the hardened runtime and a secure timestamp (`bin/codex`, `bin/codex-code-mode-host`, `codex-path/rg`, the voice host and its dylibs). `codex` and `codex-code-mode-host` carry `allow-jit` and `allow-unsigned-executable-memory`. → The build never re-signs Codex; it checks the signature.
2. **Official Node.js 24.22.2 (darwin-arm64)** is self-contained (links only `/System` and `/usr/lib`), Developer ID signed by the Node.js Foundation with the hardened runtime, but its entitlements include `get-task-allow`, `disable-library-validation`, `allow-dyld-environment-variables` and `disable-executable-page-protection`. Notarization rejects `get-task-allow`, and the other three weaken the runtime. → The build re-signs Node with **only** `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`.
3. **Re-signed that way (ad-hoc), at a path with a space** (`…/Test App.app/Contents/Resources/node/bin/node`), Node runs, `node:sqlite` loads, the jail, launch, Jira-profile and relay suites pass (175/175), and the daemon from that layout (sources + `relay/` + `npm ci --omit=dev`) reaches `host ready` signed out in about 1 s with a throw-away `HOME`, i.e. the whole pre-start self-check (version, config, layers, code mode, tool surface) passes. Homebrew's Node is **not** relocatable (it links `/opt/homebrew/opt/*` dylibs), so it cannot be bundled.
4. **The current bundle misses `companiond/relay/relay.c`**: `buildRelay` reads `RELAY_SOURCE = ../../relay/relay.c`, and `build-app.sh` copies only `package.json`, the lockfile and `src/`. A bundle-only install therefore cannot build its relay ("The relay did not build"). With `relay/` copied, it works (fact 3).
5. **`codesign --verify --deep --strict`** accepts the app with Node and the Codex binaries nested under `Contents/Resources` (ad-hoc outer signature). `spctl -a` rejects the ad-hoc app, as expected (Gatekeeper needs Developer ID + notarization: owner steps).
6. **A throw-away `HOME` must be short.** The relay socket is `<HOME>/Library/Application Support/ClaudeGPTCompanion/run/relay.sock` and must fit in 104 bytes; the session scratch folder is too long ("The companion's folder path is too long for its relay socket."). `mktemp -d /tmp/cgc-smoke.XXXXXX` fits.

## Rulings (recorded in the SDD ledger)

- **R1 Node is bundled from the official nodejs.org tarball**, version and SHA-256 pinned in `app/bundle/node.pin` (24.22.2). The build downloads it once into `app/build/cache/` (gitignored by `build/`) or takes a local copy from `COMPANION_NODE_TARBALL`; the checksum is checked before extraction. Only `bin/node` and `LICENSE` are copied, to `Contents/Resources/node/`. So the jail's Node prefix (§7.2: `dirname(dirname(node))`) is `Contents/Resources/node`, which holds nothing else.
- **R2 Apple silicon only.** The owner's Mac and the CI runners are arm64; the bundle carries only `@openai/codex-darwin-arm64`. Every packaging script refuses to run on another architecture, and the build checks `lipo -archs` is `arm64` for the app and Node.
- **R3 Third-party signatures:** Codex binaries keep OpenAI's signature (checked: `codesign --verify --strict`, "Developer ID Application" authority, hardened runtime). Node is re-signed (fact 2). Our relay is still compiled at every daemon start in App Support (§7.1.9, unchanged); nothing about it moves into the bundle. **No team ID of anyone is written into the repo** (the checks name the authority kind, not the team).
- **R4 Signing parameters are the owner's.** `COMPANION_SIGN_IDENTITY` (exists; default `-` = ad-hoc) and new `COMPANION_NOTARY_PROFILE` (the name of a `notarytool store-credentials` keychain profile). With a real identity the build adds `--timestamp`; ad-hoc keeps `--timestamp=none`. The agent never looks for, lists or uses a real identity, Apple ID, password or profile; `notarize.sh` is only run in its refusal paths.
- **R5 Node lookup order in the app:** `COMPANION_NODE` (developer override) → the bundled Node → Settings › Advanced path → `/opt/homebrew/bin/node` → `/usr/local/bin/node`. The bundled Node wins over the setting so an M5-era stored Homebrew path does not shadow it; the setting stays for `swift run` (no bundle). Each candidate still must answer `--version` with major ≥ 24.
- **R6 One version, 0.7.0:** `companiond/package.json` is the source. `companiond/src/version.ts` reads it (daemon `hello`, `companion-jira` `serverInfo`); a unit test and `build-app.sh` both require `Info.plist` `CFBundleShortVersionString` and `CFBundleVersion` to equal it.
- **R7 The bundle smoke runs signed out with a throw-away `HOME`** (fact 6): it never touches the owner's App Support, Codex home, Keychain items or Claude data, never signs in, and sends nothing to a model. It is run locally and in CI.
- **R8 DMG, not zip:** `hdiutil create -format UDZO` with an `/Applications` link; it is the thing the owner notarizes and staples. `hdiutil` gets 3 tries (CI runners sometimes report "Resource busy").
- **R9 The Codex voice resources stay in the bundle untouched.** They are part of the pinned, signed vendor folder (`readVendorDir` reads `resourcesDir`); Codex's profile does not allow exec of the voice host (only `codex`, the code-mode host and the relay), so it cannot run.
- **R10 Clean install, first launch, sign-in, Developer ID signing, notarization and Gatekeeper checks are owner steps** (`docs/manual/m7-checklist.md` in the repo; the short owner-step note goes to the shared notes folder, not into the PR).

## Global Constraints

- **Packaging must not weaken anything:** no change to any Seatbelt profile, the tool allowlist, the pre-start self-check, the runtime guard, the relay's compile-time socket path, or `CODEX_SEATBELT_MEASURED`. No file under `companiond/src/codex/`, `companiond/src/launch/`, `companiond/src/jail/`, `companiond/src/relay/` or `companiond/src/jira/jiraProfile.ts` changes in M7, except `companiond/src/jira/mcpServer.ts`'s version string (Task 1).
- **No OpenAI API keys; no secret or token extraction or logging.** Scripts print status lines only.
- **Never read Claude credentials, `~/.claude/sessions/*.key`, or the messaging socket. Never change the Claude Desktop or Claude Code config.**
- **No real signing material.** No Developer ID certificate, Apple ID, app-specific password, notary profile or team ID is looked up, used or written. Ad-hoc (`-`) everywhere the agent runs.
- **Public repo hygiene:** no personal data, no `/Users/<name>/` paths, no signing identities or team IDs, no license file of our own (Node's `LICENSE` is copied into the build output only). Run `bash scripts/check-repo.sh` before every commit.
- **Live runs:** only the signed-out bundle smoke with a throw-away `HOME`. No sign-in, no model turn.
- **File edits go through the editor tools,** never Bash heredocs, redirects or `tee`.
- **If the aiptf-guard PreToolUse hook blocks a command, STOP** and report the exact command and message. Never retry it in another form.
- **Commit trailer**, copied literally: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Branch** `claude/m7-packaging-9b6bcd`. Never push to `main`, never force-push.
- **Commands:** companiond: `cd companiond && npm test && npm run typecheck`. App: `cd app && swift test`. Bundle: `bash scripts/build-app.sh && bash scripts/smoke-bundle.sh`. Packaging checks: `bash scripts/test-packaging.sh`.

## File structure

New:
- `companiond/src/version.ts` — `COMPANION_VERSION`, read from `companiond/package.json`.
- `companiond/test/version.test.ts` — one version across package.json and both Info.plist keys.
- `app/bundle/node.pin` — `NODE_VERSION`, `NODE_SHA256_DARWIN_ARM64`.
- `app/bundle/node.entitlements` — the two JIT entitlements for the bundled Node.
- `scripts/fetch-node.sh` — download / verify / extract the pinned Node.
- `scripts/smoke-bundle.sh` + `companiond/scripts/bundle-smoke.ts` — the bundle smoke.
- `scripts/package-app.sh` — the DMG.
- `scripts/notarize.sh` — owner-only notarization and stapling.
- `scripts/test-packaging.sh` — offline checks of the packaging scripts' refusal paths.
- `docs/install.md`, `docs/signing.md`, `docs/manual/m7-checklist.md`.

Changed: `companiond/package.json` + `package-lock.json` (version), `companiond/src/daemon/main.ts`, `companiond/src/jira/mcpServer.ts`, `app/bundle/Info.plist`, `scripts/build-app.sh`, `app/Sources/CompanionCore/Daemon/DaemonLocator.swift`, `app/Sources/CompanionApp/Views/SettingsView.swift`, `app/Tests/CompanionCoreTests/DaemonLocatorTests.swift`, `.github/workflows/tests.yml`, `README.md`, the spec (§2, §9, §14), `docs/superpowers/plans/README.md`.

---

### Task 1: One version, 0.7.0

**Files:**
- Create: `companiond/src/version.ts`, `companiond/test/version.test.ts`
- Modify: `companiond/package.json`, `companiond/package-lock.json`, `companiond/src/daemon/main.ts:23`, `companiond/src/jira/mcpServer.ts:25`, `app/bundle/Info.plist:12-13`

**Interfaces:**
- Produces: `COMPANION_VERSION: string` from `companiond/src/version.ts`; `companiond/package.json` `"version": "0.7.0"` (read by Task 4's build check and Task 5's smoke).

- [ ] **Step 1: Write the failing test** — `companiond/test/version.test.ts`:

```ts
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { COMPANION_VERSION } from "../src/version.ts";

test("one version: companiond/package.json and both Info.plist version keys (M7)", () => {
  assert.match(COMPANION_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(COMPANION_VERSION, "0.7.0");
  const plist = fs.readFileSync(new URL("../../app/bundle/Info.plist", import.meta.url), "utf8");
  for (const key of ["CFBundleShortVersionString", "CFBundleVersion"]) {
    const m = new RegExp(`<key>${key}</key><string>([^<]*)</string>`).exec(plist);
    assert.equal(m?.[1], COMPANION_VERSION, key);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd companiond && node --test test/version.test.ts`
Expected: FAIL (cannot find module `../src/version.ts`).

- [ ] **Step 3: Implement**

`companiond/src/version.ts`:

```ts
// The companion's version (M7): one source, companiond/package.json. The app's Info.plist must match it
// (test/version.test.ts and scripts/build-app.sh check this).
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
if (typeof pkg.version !== "string") throw new Error("companiond/package.json has no version.");

export const COMPANION_VERSION: string = pkg.version;
```

Run `cd companiond && npm version 0.7.0 --no-git-tag-version` (updates `package.json` and both version fields in `package-lock.json`, nothing else; check with `git diff --stat`).

In `src/daemon/main.ts` replace `const VERSION = "0.6.0";` with `const VERSION = COMPANION_VERSION;` and add `import { COMPANION_VERSION } from "../version.ts";` to the imports (keep them sorted as the file does).

In `src/jira/mcpServer.ts` replace `version: "0.6.0"` with `version: COMPANION_VERSION` and import it from `"../version.ts"`. If a Jira test asserts `"0.6.0"`, change it to `COMPANION_VERSION`.

In `app/bundle/Info.plist` set both `CFBundleShortVersionString` and `CFBundleVersion` to `0.7.0`.

- [ ] **Step 4: Run the suites**

Run: `cd companiond && npm test && npm run typecheck`
Expected: all pass, including the new test.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add companiond/src/version.ts companiond/test/version.test.ts companiond/package.json companiond/package-lock.json companiond/src/daemon/main.ts companiond/src/jira/mcpServer.ts app/bundle/Info.plist
git commit -m "feat(m7): one version 0.7.0 from companiond/package.json" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Pinned official Node.js and `fetch-node.sh`

**Files:**
- Create: `app/bundle/node.pin`, `app/bundle/node.entitlements`, `scripts/fetch-node.sh`, `scripts/test-packaging.sh`

**Interfaces:**
- Produces: `bash scripts/fetch-node.sh <dest>` → `<dest>/node/bin/node` (mode 0755, the pinned version, still Node's own signature) and `<dest>/node/LICENSE`; exit 2 with `usage:` when `<dest>` is missing; exit 1 with `checksum mismatch` on a bad tarball, leaving nothing in `<dest>`. `COMPANION_NODE_TARBALL` = a local tarball instead of the download. `app/bundle/node.entitlements` is used by Task 4. `scripts/test-packaging.sh` with the helper `expect_fail <name> <text> <command…>` is extended by Task 6.

- [ ] **Step 1: Write the pin and the entitlements**

`app/bundle/node.pin`:

```
# The official Node.js bundled into the app (M7, ruling R1). Only these two lines are read.
# To change it: pick a v24 release on https://nodejs.org/dist/, copy the node-v<version>-darwin-arm64.tar.gz line
# from its SHASUMS256.txt, then run scripts/build-app.sh and scripts/smoke-bundle.sh.
NODE_VERSION=24.22.2
NODE_SHA256_DARWIN_ARM64=aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a
```

`app/bundle/node.entitlements` (measured, plan fact 2/3: V8 needs these two and nothing else):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
</plist>
```

- [ ] **Step 2: Write the failing test** — `scripts/test-packaging.sh`:

```bash
#!/usr/bin/env bash
# Offline checks of the packaging scripts (M7): no network, no build, no credentials. macOS (arm64) only.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# expect_fail <name> <text the output must contain> <command…>: the command must fail and say <text>.
expect_fail() {
  local name="$1" want="$2" out
  shift 2
  if out="$("$@" 2>&1)"; then
    echo "FAIL: $name: it succeeded"; fail=1
  elif ! grep -qF -- "$want" <<<"$out"; then
    echo "FAIL: $name: the output lacks '$want': $out"; fail=1
  else
    echo "ok: $name"
  fi
}

# node.pin holds a Node 24 version and a SHA-256.
grep -qE '^NODE_VERSION=24\.[0-9]+\.[0-9]+$' app/bundle/node.pin || { echo "FAIL: node.pin version"; fail=1; }
grep -qE '^NODE_SHA256_DARWIN_ARM64=[0-9a-f]{64}$' app/bundle/node.pin || { echo "FAIL: node.pin sha256"; fail=1; }

expect_fail "fetch-node needs a destination" "usage:" bash scripts/fetch-node.sh
printf 'SYNTHETIC FIXTURE not a tarball\n' > "$work/fake.tar.gz"
expect_fail "fetch-node rejects a tarball with the wrong checksum" "checksum mismatch" \
  env COMPANION_NODE_TARBALL="$work/fake.tar.gz" bash scripts/fetch-node.sh "$work/out"
[ ! -e "$work/out/node" ] || { echo "FAIL: fetch-node left files after a bad checksum"; fail=1; }

[ $fail -eq 0 ] && echo "test-packaging: OK"
exit $fail
```

- [ ] **Step 3: Run it to see it fail**

Run: `bash scripts/test-packaging.sh`
Expected: FAIL lines for both `fetch-node` checks (the script does not exist yet).

- [ ] **Step 4: Implement** `scripts/fetch-node.sh`:

```bash
#!/usr/bin/env bash
# Installs the pinned official Node.js (app/bundle/node.pin) as <dest>/node/bin/node and <dest>/node/LICENSE (M7, R1).
# The tarball is COMPANION_NODE_TARBALL (a local copy) or a download from nodejs.org, cached in app/build/cache.
# Its SHA-256 is checked against the pin before anything is extracted. Apple silicon only (R2).
set -euo pipefail
dest="${1:-}"
[ -n "$dest" ] || { echo "usage: scripts/fetch-node.sh <dest dir>"; exit 2; }
abs() { case "$1" in /*) printf '%s' "$1" ;; *) printf '%s/%s' "$PWD" "$1" ;; esac; }
dest="$(abs "$dest")"
tarball_override="${COMPANION_NODE_TARBALL:+$(abs "$COMPANION_NODE_TARBALL")}"
cd "$(git rev-parse --show-toplevel)"

pin() { sed -n "s/^$1=\([0-9A-Za-z.]*\)\$/\1/p" app/bundle/node.pin; }
version="$(pin NODE_VERSION)"
sha="$(pin NODE_SHA256_DARWIN_ARM64)"
[[ "$version" =~ ^24\.[0-9]+\.[0-9]+$ ]] || { echo "fetch-node: node.pin has no Node 24 version"; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || { echo "fetch-node: node.pin has no SHA-256"; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "fetch-node: Apple silicon only"; exit 1; }

name="node-v$version-darwin-arm64"
if [ -n "$tarball_override" ]; then
  tarball="$tarball_override"; cached=0
else
  tarball="app/build/cache/$name.tar.gz"; cached=1
  if [ ! -f "$tarball" ]; then
    mkdir -p app/build/cache
    curl -fsSL --proto '=https' --tlsv1.2 -o "$tarball.part" "https://nodejs.org/dist/v$version/$name.tar.gz"
    mv "$tarball.part" "$tarball"
  fi
fi
if ! echo "$sha  $tarball" | shasum -a 256 -c --status; then
  [ "$cached" = 1 ] && rm -f "$tarball"
  echo "fetch-node: checksum mismatch for $name.tar.gz"
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
tar -xzf "$tarball" -C "$work" "$name/bin/node" "$name/LICENSE"
got="$("$work/$name/bin/node" --version)"
[ "$got" = "v$version" ] || { echo "fetch-node: the tarball's Node reports $got"; exit 1; }
mkdir -p "$dest/node/bin"
install -m 0755 "$work/$name/bin/node" "$dest/node/bin/node"
install -m 0644 "$work/$name/LICENSE" "$dest/node/LICENSE"
echo "fetch-node: Node v$version installed"
```

`chmod +x scripts/fetch-node.sh scripts/test-packaging.sh` (git records the mode).

- [ ] **Step 5: Run the checks, then one real fetch**

Run: `bash scripts/test-packaging.sh` → `test-packaging: OK`.
Run: `d="$(mktemp -d)"; bash scripts/fetch-node.sh "$d" && "$d/node/bin/node" --version; rm -rf "$d"` → `v24.22.2` (downloads about 50 MB once into `app/build/cache/`).
Run: `bash scripts/check-repo.sh` → OK.

- [ ] **Step 6: Commit**

```bash
git add app/bundle/node.pin app/bundle/node.entitlements scripts/fetch-node.sh scripts/test-packaging.sh
git commit -m "feat(m7): pin the official Node.js 24 and fetch it with a checked SHA-256" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The app prefers the bundled Node

**Files:**
- Modify: `app/Sources/CompanionCore/Daemon/DaemonLocator.swift`, `app/Sources/CompanionApp/Views/SettingsView.swift:180-182`
- Test: `app/Tests/CompanionCoreTests/DaemonLocatorTests.swift`

**Interfaces:**
- Produces: `DaemonLocator.nodeCandidates(env:bundled:configured:) -> [String]` and `DaemonLocator.bundledNode(resourceURL: URL?) -> String?` (`<Resources>/node/bin/node`, the layout Task 4 builds).

- [ ] **Step 1: Write the failing tests** — replace `nodeCandidatesInOrder` in `DaemonLocatorTests.swift` with:

```swift
    @Test func nodeCandidatesInOrder() {
        // Ruling R5: developer override, then the bundled Node, then the Settings path, then the system paths.
        #expect(DaemonLocator.nodeCandidates(env: ["COMPANION_NODE": "/x/node"], bundled: "/App.app/Contents/Resources/node/bin/node", configured: "/y/node")
            == ["/x/node", "/App.app/Contents/Resources/node/bin/node", "/y/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"])
        #expect(DaemonLocator.nodeCandidates(env: [:], bundled: nil, configured: "") == ["/opt/homebrew/bin/node", "/usr/local/bin/node"])
        #expect(DaemonLocator.nodeCandidates(env: ["COMPANION_NODE": ""], bundled: "", configured: "/y/node")
            == ["/y/node", "/opt/homebrew/bin/node", "/usr/local/bin/node"])
    }

    @Test func bundledNodeSitsInResources() {
        #expect(DaemonLocator.bundledNode(resourceURL: URL(fileURLWithPath: "/Applications/ClaudeGPT Companion.app/Contents/Resources"))
            == "/Applications/ClaudeGPT Companion.app/Contents/Resources/node/bin/node")
        #expect(DaemonLocator.bundledNode(resourceURL: nil) == nil)
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd app && swift test --filter DaemonLocatorTests`
Expected: compile error (no `bundled:` parameter, no `bundledNode`).

- [ ] **Step 3: Implement** in `DaemonLocator.swift`:

Replace `nodeCandidates` with:

```swift
    /// Ruling R5 (M7): `COMPANION_NODE`, the bundled Node, the Settings › Advanced path, then the system paths.
    /// The bundled Node comes before the setting so an older stored path does not shadow it.
    public static func nodeCandidates(env: [String: String], bundled: String?, configured: String?) -> [String] {
        var out: [String] = []
        if let p = env["COMPANION_NODE"], !p.isEmpty { out.append(p) }
        if let p = bundled, !p.isEmpty { out.append(p) }
        if let p = configured, !p.isEmpty { out.append(p) }
        out += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
        return out
    }

    /// The official Node.js that scripts/build-app.sh puts into the bundle.
    public static func bundledNode(resourceURL: URL?) -> String? {
        resourceURL?.appending(path: "node/bin/node").path
    }
```

In `live(…)` change the `findNode` call's candidates to `nodeCandidates(env: env, bundled: bundledNode(resourceURL: resourceURL), configured: configuredNode())`.

Change the `.nodeNotFound` text to: `"Node.js 24 or newer was not found. The app's own Node.js is missing or broken: rebuild it with scripts/build-app.sh, or set a path in Settings › Advanced."`

In `SettingsView.swift` (`AdvancedSettings`) change the caption under the Node path field to: `"The app runs companiond with its own bundled Node.js. This path is used only when the bundle has none (for example swift run); it needs Node.js 24 or newer. Restart companiond after a change."`

- [ ] **Step 4: Run the suite**

Run: `cd app && swift test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add app/Sources/CompanionCore/Daemon/DaemonLocator.swift app/Sources/CompanionApp/Views/SettingsView.swift app/Tests/CompanionCoreTests/DaemonLocatorTests.swift
git commit -m "feat(app): run companiond with the bundled Node first" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `build-app.sh` — relay source, bundled Node, inside-out signing, checks

**Files:**
- Modify: `scripts/build-app.sh` (rewrite)

**Interfaces:**
- Consumes: `scripts/fetch-node.sh <dest>` and `app/bundle/node.entitlements` (Task 2); `companiond/package.json` version (Task 1).
- Produces: `app/build/ClaudeGPT Companion.app` with `Contents/Resources/node/{bin/node,LICENSE}` and `Contents/Resources/companiond/{package.json,package-lock.json,src/,relay/relay.c,node_modules/}`; signed with `COMPANION_SIGN_IDENTITY` (default ad-hoc). Last line `built and verified: …`.

- [ ] **Step 1: Show the gap** (fact 4)

Run: `bash scripts/build-app.sh && test -f "app/build/ClaudeGPT Companion.app/Contents/Resources/companiond/relay/relay.c"; echo $?`
Expected: `1` (the relay source is missing from today's bundle).

- [ ] **Step 2: Rewrite `scripts/build-app.sh`**:

```bash
#!/usr/bin/env bash
# Builds "ClaudeGPT Companion.app" (M7): the Swift app, companiond (sources, the relay source, production dependencies
# with the pinned Codex) and the pinned official Node.js, signed inside out.
# Identity: COMPANION_SIGN_IDENTITY (default "-" = ad-hoc). A real identity also gets a secure timestamp (R4).
# Codex keeps OpenAI's own signature and is only checked; Node is re-signed with app/bundle/node.entitlements (R3).
# No notarization here: scripts/notarize.sh (owner only).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
out="app/build/ClaudeGPT Companion.app"
[ "$(uname -m)" = arm64 ] || { echo "build-app: Apple silicon only"; exit 1; }
if [ "$identity" = "-" ]; then ts=(--timestamp=none); else ts=(--timestamp); fi

# One version (R6): companiond/package.json, and both Info.plist keys must match it.
version="$(plutil -extract version raw companiond/package.json)"
for key in CFBundleShortVersionString CFBundleVersion; do
  v="$(/usr/libexec/PlistBuddy -c "Print :$key" app/bundle/Info.plist)"
  [ "$v" = "$version" ] || { echo "build-app: Info.plist $key is $v, companiond is $version"; exit 1; }
done

(cd app && swift build -c release --product CompanionApp)
bin_dir="$(cd app && swift build -c release --product CompanionApp --show-bin-path)"

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$bin_dir/CompanionApp" "$out/Contents/MacOS/CompanionApp"
cp app/bundle/Info.plist "$out/Contents/Info.plist"
plutil -lint "$out/Contents/Info.plist"

# companiond: sources, the relay source (built at every daemon start, spec §7.1.9) and production dependencies.
res="$out/Contents/Resources/companiond"
mkdir -p "$res"
cp companiond/package.json companiond/package-lock.json "$res/"
cp -R companiond/src "$res/src"
cp -R companiond/relay "$res/relay"
(cd "$res" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)

# Node (R1): the pinned official build, re-signed with only the JIT entitlements (plan fact 2).
bash scripts/fetch-node.sh "$out/Contents/Resources"
node_bin="$out/Contents/Resources/node/bin/node"
codesign --force --options runtime "${ts[@]}" --entitlements app/bundle/node.entitlements --sign "$identity" "$node_bin"

codesign --force --options runtime "${ts[@]}" \
  --entitlements app/bundle/CompanionApp.entitlements --sign "$identity" "$out"

# ---- Verification ----
codesign --verify --deep --strict --verbose=2 "$out"
for f in src/lineBuffer.ts src/daemon/main.ts src/version.ts relay/relay.c package.json; do test -f "$res/$f"; done
for key in NSMicrophoneUsageDescription NSSpeechRecognitionUsageDescription CFBundleIdentifier LSMinimumSystemVersion; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$out/Contents/Info.plist" >/dev/null
done

# Entitlement keys of a signed file, sorted, one line. Capture first, then parse (no pipes into grep -q under pipefail).
ent_keys() {
  local xml="$work/ents.plist"
  codesign -d --entitlements - --xml "$1" >"$xml" 2>/dev/null || true
  [ -s "$xml" ] || { echo ""; return; }
  plutil -convert json -o - "$xml" | node -e 'process.stdout.write(Object.keys(JSON.parse(require("fs").readFileSync(0,"utf8"))).sort().join(" "))'
}
runtime_flag() { local i; i="$(codesign -d --verbose=2 "$1" 2>&1)"; grep -q "flags=.*runtime" <<<"$i"; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The app: hardened runtime, exactly the microphone entitlement, arm64.
runtime_flag "$out"
[ "$(ent_keys "$out")" = "com.apple.security.device.audio-input" ] || { echo "build-app: unexpected app entitlements"; exit 1; }
[ "$(lipo -archs "$out/Contents/MacOS/CompanionApp")" = arm64 ] || { echo "build-app: the app is not arm64-only"; exit 1; }

# Node: the pinned version, hardened runtime, exactly the two JIT entitlements, arm64.
want_node="v$(sed -n 's/^NODE_VERSION=//p' app/bundle/node.pin)"
[ "$("$node_bin" --version)" = "$want_node" ] || { echo "build-app: the bundled Node is not $want_node"; exit 1; }
runtime_flag "$node_bin"
[ "$(ent_keys "$node_bin")" = "com.apple.security.cs.allow-jit com.apple.security.cs.allow-unsigned-executable-memory" ] \
  || { echo "build-app: unexpected Node entitlements"; exit 1; }
[ "$(lipo -archs "$node_bin")" = arm64 ] || { echo "build-app: Node is not arm64-only"; exit 1; }

# Codex (R3): the pinned version, OpenAI's own Developer ID signature with the hardened runtime, untouched.
vendor="$res/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin"
[ "$(plutil -extract version raw "$vendor/codex-package.json")" = "0.166.0" ] || { echo "build-app: Codex is not 0.166.0"; exit 1; }
[ ! -e "$res/node_modules/@openai/codex-darwin-x64" ] || { echo "build-app: an x64 Codex was installed"; exit 1; }
for b in bin/codex bin/codex-code-mode-host codex-path/rg; do
  codesign --verify --strict "$vendor/$b"
  runtime_flag "$vendor/$b"
  auth="$(codesign -d --verbose=2 "$vendor/$b" 2>&1)"
  grep -q "^Authority=Developer ID Application: " <<<"$auth" || { echo "build-app: $b is not Developer ID signed"; exit 1; }
done
echo "built and verified: $out (version $version, identity: $identity)"
```

Notes for the implementer:
- `plutil -extract version raw` reads JSON on macOS (checked while planning).
- `codesign -dvv` prints `Authority=…` on stderr; the script captures `2>&1` into a variable before `grep` (pipefail + `grep -q` SIGPIPE, see the old script's comment).
- Do not add `--deep` to the signing commands (it would re-sign Codex). `--deep` is for `--verify` only.

- [ ] **Step 3: Build and check**

Run: `bash scripts/build-app.sh 2>&1 | tail -3`
Expected: last line `built and verified: app/build/ClaudeGPT Companion.app (version 0.7.0, identity: -)`.
Run: `test -f "app/build/ClaudeGPT Companion.app/Contents/Resources/companiond/relay/relay.c" && echo relay-ok` → `relay-ok`.
Run: `du -sh "app/build/ClaudeGPT Companion.app"` and note the size in the report.

- [ ] **Step 4: Prove the checks bite** (then restore)

Add `<key>com.apple.security.get-task-allow</key><true/>` to `app/bundle/node.entitlements` with the editor, run `bash scripts/build-app.sh 2>&1 | tail -1` → `build-app: unexpected Node entitlements`. Restore it with `git checkout app/bundle/node.entitlements` (committed in Task 2), rebuild → `built and verified`.

- [ ] **Step 5: Commit**

```bash
bash scripts/check-repo.sh
git add scripts/build-app.sh
git commit -m "feat(m7): bundle the relay source and the pinned Node, sign inside out, check every binary" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Bundle smoke test

**Files:**
- Create: `companiond/scripts/bundle-smoke.ts`, `scripts/smoke-bundle.sh`

**Interfaces:**
- Consumes: the built app (Task 4); `COMPANION_VERSION` source (Task 1); daemon methods `daemon.hello` (`{protocolVersion: 1}` → `{protocolVersion, daemonVersion}`), `host.status` (`{state: "stopped"|"starting"|"ready"|"failed", warnings?, detail?}`), `auth.status` (`{state: "signed_out"|…}`), `daemon.shutdown`.
- Produces: `bash scripts/smoke-bundle.sh [app path]` → exit 0 and `smoke-bundle: OK`.

- [ ] **Step 1: Write `companiond/scripts/bundle-smoke.ts`**:

```ts
// Bundle smoke (M7, ruling R7): runs the BUILT app's own Node and companiond, signed out, with a throw-away HOME, and
// requires the Codex host to reach "ready" — so the pre-start self-check passed from inside the bundle (pinned version,
// config, layers, code mode, tool surface, Codex under its Seatbelt profile, the relay built from the bundled source).
// Never touches the owner's App Support, Codex home, Keychain items or Claude data; never signs in; sends nothing.
// Status lines only: no paths, no detail text beyond the host's own fixed messages.
// Usage: node companiond/scripts/bundle-smoke.ts "<path to ClaudeGPT Companion.app>"
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LineBuffer } from "../src/lineBuffer.ts";

const say = (line: string) => process.stdout.write(`bundle-smoke: ${line}\n`);
const app = process.argv[2];
if (!app) {
  say("usage: bundle-smoke.ts <app path>");
  process.exit(2);
}
const res = path.join(path.resolve(app), "Contents", "Resources");
const node = path.join(res, "node", "bin", "node");
const daemonDir = path.join(res, "companiond");
const main = path.join(daemonDir, "src", "daemon", "main.ts");
const plistVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(path.resolve(app), "Contents", "Info.plist")], { encoding: "utf8" }).trim();

// Short on purpose: the relay socket under it must fit in 104 bytes (plan fact 6).
const home = fs.mkdtempSync("/tmp/cgc-smoke.");
fs.chmodSync(home, 0o700);
// The app's own minimal environment (spec §7.8), with the throw-away HOME.
const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USER: process.env.USER ?? "smoke", LOGNAME: process.env.USER ?? "smoke", TMPDIR: process.env.TMPDIR ?? "/tmp" };
const child = spawn(node, ["--disable-warning=ExperimentalWarning", main], { cwd: daemonDir, env, stdio: ["pipe", "pipe", "ignore"] });

const lb = new LineBuffer();
const waiters = new Map<number, (m: any) => void>();
let nextId = 0;
let exited = false;
const exitedP = new Promise<void>((r) => {
  child.on("exit", () => { exited = true; for (const w of waiters.values()) w({ error: { message: "exited" } }); r(); });
  child.on("error", () => { exited = true; r(); });
});
child.stdout.on("data", (d: Buffer) => {
  for (const line of lb.push(d)) {
    let m: any;
    try { m = JSON.parse(line); } catch { continue; }
    if (typeof m.id === "number" && waiters.has(m.id)) { waiters.get(m.id)!(m); waiters.delete(m.id); }
  }
});
const call = (method: string, params: object = {}, ms = 15_000): Promise<any> => new Promise((resolve, reject) => {
  if (exited) return reject(new Error(`${method}: the daemon exited`));
  const id = ++nextId;
  const t = setTimeout(() => { waiters.delete(id); reject(new Error(`${method}: no answer in ${ms} ms`)); }, ms);
  waiters.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(`${method}: ${m.error.message ?? "error"}`)) : resolve(m.result); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ok = false;
try {
  const hello = await call("daemon.hello", { protocolVersion: 1 });
  if (hello.daemonVersion !== plistVersion) throw new Error(`daemon ${hello.daemonVersion} != Info.plist ${plistVersion}`);
  say(`hello ok (version ${hello.daemonVersion})`);
  const t0 = Date.now();
  let s: any = { state: "starting" };
  while (Date.now() - t0 < 90_000) {
    s = await call("host.status");
    if (s.state === "ready" || s.state === "failed") break;
    await sleep(500);
  }
  if (s.state !== "ready") throw new Error(`host ${s.state}${s.detail ? `: ${s.detail}` : ""}`);
  say(`host ready in ${Date.now() - t0} ms (${s.warnings.length} warning(s))`);
  const a = await call("auth.status");
  if (a.state !== "signed_out") throw new Error(`auth ${a.state} (expected signed_out with a fresh HOME)`);
  say("auth signed_out");
  const support = path.join(home, "Library", "Application Support", "ClaudeGPTCompanion");
  if ((fs.statSync(support).mode & 0o777) !== 0o700) throw new Error("the App Support folder is not 0700");
  say("app support 0700");
  await call("daemon.shutdown").catch(() => undefined);
  const done = await Promise.race([exitedP.then(() => true), sleep(15_000).then(() => false)]);
  if (!done) throw new Error("the daemon did not exit within 15 s");
  say("daemon stopped");
  ok = true;
} catch (e) {
  say(`FAIL ${(e as Error).message}`);
} finally {
  if (!exited) child.kill("SIGTERM");
  await Promise.race([exitedP, sleep(5_000)]);
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
```

Notes: `LineBuffer.push(chunk: Buffer): string[]` is the real API. The script is run by the developer's Node (≥ 24); it only spawns the bundled one. A ready `HostState` always has `warnings: string[]` (`codexHost.ts`).

- [ ] **Step 2: Write `scripts/smoke-bundle.sh`**:

```bash
#!/usr/bin/env bash
# Smoke test of the BUILT bundle (M7): (1) its own Node and companiond start, signed out, with a throw-away HOME, and
# the Codex host passes its self-check; (2) the Seatbelt suites (jail, launch, relay, Jira profile) pass under the
# bundled Node, whose prefix the profiles name. Needs companiond's dev dependencies (npm ci in companiond).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
app="${1:-app/build/ClaudeGPT Companion.app}"
case "$app" in /*) ;; *) app="$PWD/$app" ;; esac
[ -x "$app/Contents/Resources/node/bin/node" ] || { echo "smoke-bundle: no bundled Node; run scripts/build-app.sh"; exit 1; }
node companiond/scripts/bundle-smoke.ts "$app"
(cd companiond && "$app/Contents/Resources/node/bin/node" --test \
  test/jail/*.test.ts test/launch/*.test.ts test/relay/*.test.ts test/jira/jiraProfile.test.ts)
echo "smoke-bundle: OK"
```

`chmod +x scripts/smoke-bundle.sh`.

- [ ] **Step 3: Run it**

Run: `bash scripts/build-app.sh >/dev/null && bash scripts/smoke-bundle.sh 2>&1 | grep -E "bundle-smoke|^ℹ (tests|pass|fail)|smoke-bundle"`
Expected: `hello ok (version 0.7.0)`, `host ready in … ms`, `auth signed_out`, `app support 0700`, `daemon stopped`, the node test summary with `fail 0`, `smoke-bundle: OK`. Check `ls /tmp | grep cgc-smoke` is empty afterwards.

- [ ] **Step 4: Prove it bites**

Run: `mv "app/build/ClaudeGPT Companion.app/Contents/Resources/companiond/relay" "$TMPDIR/relay.moved"; node companiond/scripts/bundle-smoke.ts "app/build/ClaudeGPT Companion.app"; echo exit=$?; mv "$TMPDIR/relay.moved" "app/build/ClaudeGPT Companion.app/Contents/Resources/companiond/relay"`
Expected: `bundle-smoke: FAIL host failed: …relay…` and `exit=1` (the M5/M6 gap, fact 4). (Moving a folder breaks the signature; rebuild before anything else uses the bundle.)

- [ ] **Step 5: Typecheck and commit**

Run: `cd companiond && npm run typecheck` (`tsconfig.json` includes `scripts/`).

```bash
bash scripts/check-repo.sh
git add companiond/scripts/bundle-smoke.ts scripts/smoke-bundle.sh
git commit -m "test(m7): smoke the built bundle signed out and run the Seatbelt suites under its Node" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: DMG, owner-only notarization, packaging checks, CI

**Files:**
- Create: `scripts/package-app.sh`, `scripts/notarize.sh`
- Modify: `scripts/test-packaging.sh`, `.github/workflows/tests.yml`

**Interfaces:**
- Consumes: the built app (Task 4); `expect_fail` (Task 2).
- Produces: `bash scripts/package-app.sh` → `app/build/ClaudeGPT-Companion-<version>.dmg`; `bash scripts/notarize.sh <dmg>` (owner only; exit 2 without `COMPANION_SIGN_IDENTITY` ≠ `-` and `COMPANION_NOTARY_PROFILE`).

- [ ] **Step 1: Add the failing checks** to `scripts/test-packaging.sh`, before the final `[ $fail -eq 0 ]` line:

```bash
# notarize.sh refuses anything but an owner-configured Developer ID run (R4). Never run with real values here.
expect_fail "notarize refuses an ad-hoc identity" "COMPANION_SIGN_IDENTITY" \
  env -u COMPANION_SIGN_IDENTITY -u COMPANION_NOTARY_PROFILE bash scripts/notarize.sh "$work/x.dmg"
expect_fail "notarize needs a notary profile" "COMPANION_NOTARY_PROFILE" \
  env COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" -u COMPANION_NOTARY_PROFILE bash scripts/notarize.sh "$work/x.dmg"
expect_fail "notarize needs a DMG" "usage:" \
  env COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" COMPANION_NOTARY_PROFILE="synthetic-profile" bash scripts/notarize.sh
expect_fail "notarize needs an existing DMG" "no such DMG" \
  env COMPANION_SIGN_IDENTITY="SYNTHETIC FIXTURE identity" COMPANION_NOTARY_PROFILE="synthetic-profile" bash scripts/notarize.sh "$work/missing.dmg"
# package-app.sh needs a built app.
expect_fail "package-app needs a built app" "build the app first" \
  env COMPANION_APP="$work/none.app" bash scripts/package-app.sh
```

Run: `bash scripts/test-packaging.sh` → the five new checks FAIL.

- [ ] **Step 2: Write `scripts/package-app.sh`**:

```bash
#!/usr/bin/env bash
# Packs the built app into a DMG with an /Applications link (M7, R8). A real COMPANION_SIGN_IDENTITY also signs the DMG.
# COMPANION_APP overrides the app path (tests). Notarization: scripts/notarize.sh (owner only).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
app="${COMPANION_APP:-app/build/ClaudeGPT Companion.app}"
[ -d "$app" ] || { echo "package-app: build the app first (scripts/build-app.sh)"; exit 1; }
codesign --verify --deep --strict "$app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")"
dmg="app/build/ClaudeGPT-Companion-$version.dmg"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
ditto "$app" "$stage/ClaudeGPT Companion.app"
ln -s /Applications "$stage/Applications"
rm -f "$dmg"
for try in 1 2 3; do
  if hdiutil create -quiet -volname "ClaudeGPT Companion" -srcfolder "$stage" -fs HFS+ -format UDZO -ov "$dmg"; then break; fi
  [ "$try" = 3 ] && { echo "package-app: hdiutil failed 3 times"; exit 1; }
  sleep 5
done
if [ "$identity" != "-" ]; then codesign --force --timestamp --sign "$identity" "$dmg"; fi
hdiutil verify -quiet "$dmg"
echo "packaged: $dmg"
```

- [ ] **Step 3: Write `scripts/notarize.sh`**:

```bash
#!/usr/bin/env bash
# OWNER ONLY (M7, R4). Notarizes and staples the DMG made by scripts/package-app.sh from a Developer ID build.
# Needs: COMPANION_SIGN_IDENTITY = your "Developer ID Application: …" identity (the same one the build used), and
# COMPANION_NOTARY_PROFILE = a profile you made once with `xcrun notarytool store-credentials`. See docs/signing.md.
# Nothing here reads, prints or stores a credential: notarytool takes them from your keychain profile.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
identity="${COMPANION_SIGN_IDENTITY:--}"
profile="${COMPANION_NOTARY_PROFILE:-}"
[ "$identity" != "-" ] || { echo "notarize: needs a Developer ID build; set COMPANION_SIGN_IDENTITY (see docs/signing.md)"; exit 2; }
[ -n "$profile" ] || { echo "notarize: set COMPANION_NOTARY_PROFILE to your notarytool keychain profile (see docs/signing.md)"; exit 2; }
dmg="${1:-}"
[ -n "$dmg" ] || { echo "usage: scripts/notarize.sh <dmg>"; exit 2; }
[ -f "$dmg" ] || { echo "notarize: no such DMG: $dmg"; exit 2; }
app="app/build/ClaudeGPT Companion.app"
info="$(codesign -d --verbose=2 "$app" 2>&1)"
grep -q "^Authority=Developer ID Application: " <<<"$info" || { echo "notarize: the built app is not Developer ID signed; rebuild with COMPANION_SIGN_IDENTITY"; exit 2; }
xcrun notarytool submit "$dmg" --keychain-profile "$profile" --wait
xcrun stapler staple "$dmg"
xcrun stapler staple "$app"
spctl -a -vv -t open --context context:primary-signature "$dmg"
spctl -a -vv "$app"
echo "notarized and stapled: $dmg"
```

`chmod +x scripts/package-app.sh scripts/notarize.sh`.

- [ ] **Step 4: Run the checks and the packer**

Run: `bash scripts/test-packaging.sh` → every line `ok:`, then `test-packaging: OK`.
Run: `bash scripts/build-app.sh >/dev/null && bash scripts/package-app.sh` → `packaged: app/build/ClaudeGPT-Companion-0.7.0.dmg`. Run `hdiutil imageinfo -format "app/build/ClaudeGPT-Companion-0.7.0.dmg"` → `UDZO`.

- [ ] **Step 5: Wire CI** — in `.github/workflows/tests.yml`, job `app`, add before `- run: swift test` a Node tarball cache:

```yaml
      - name: Cache the pinned Node.js tarball
        uses: actions/cache@v4
        with:
          path: app/build/cache
          key: node-${{ hashFiles('app/bundle/node.pin') }}
```

and after the step `Build and verify the signed bundle (ad-hoc)` add:

```yaml
      - name: Smoke the built bundle (signed out, throw-away HOME)
        working-directory: .
        run: bash scripts/smoke-bundle.sh
      - name: Package the DMG
        working-directory: .
        run: bash scripts/package-app.sh
      - name: Packaging script checks (offline)
        working-directory: .
        run: bash scripts/test-packaging.sh
```

Add `timeout-minutes: 30` to the `app` job (the build now downloads Node once per cache miss).

- [ ] **Step 6: Commit**

```bash
bash scripts/check-repo.sh
git add scripts/package-app.sh scripts/notarize.sh scripts/test-packaging.sh .github/workflows/tests.yml
git commit -m "feat(m7): DMG packaging, owner-only notarization script, CI smoke and packaging checks" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Install guide, signing notes, owner checklist, spec

**Files:**
- Create: `docs/install.md`, `docs/signing.md`, `docs/manual/m7-checklist.md`
- Modify: `README.md`, `docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md` (§2 *M5* note, §9, §14 M7 row, header version line), `docs/superpowers/plans/README.md`

- [ ] **Step 1: `docs/install.md`** — sections, in plain words:
  1. *Requirements:* a Mac with Apple silicon, macOS 26 or newer, the Xcode command-line tools (`xcode-select --install`; companiond compiles its relay with `clang` at every start and runs `git` through `xcrun`), a ChatGPT plan that includes Codex. Building also needs full Xcode (Swift 6.2) and Node 24+ (only to run `npm ci` and the scripts; the app ships its own Node).
  2. *Build:* `(cd companiond && npm ci)`, `bash scripts/build-app.sh`, `bash scripts/smoke-bundle.sh`, `bash scripts/package-app.sh`. What each prints when it worked.
  3. *Install:* quit a running copy; open the DMG; drag the app to Applications (replace the old one); eject. Or copy `app/build/ClaudeGPT Companion.app` with `ditto`.
  4. *First launch:* what to expect (Dock icon, the panel, Settings › Advanced shows companiond running; microphone and speech prompts only on first dictation; Accessibility only if follow-window is turned on; an ad-hoc build is not notarized, so if it was downloaded rather than built here, Gatekeeper blocks it — build it on this Mac or use a Developer ID build, see signing notes).
  5. *Sign in:* the app's "Sign in with ChatGPT" (a browser opens; port 1455 on this Mac only during sign-in).
  6. *What stays where:* `~/Library/Application Support/ClaudeGPTCompanion/` (database, Codex home, relay `run/` and `bin/`), the Keychain items (Codex's ChatGPT sign-in; `ClaudeGPT Companion Jira` if Jira is set up), UserDefaults domain `local.claudegptcompanion.app`.
  7. *Update:* rebuild, replace the app. After an ad-hoc rebuild macOS may ask for the microphone and Keychain again (the signature changed); a stable identity avoids it (`COMPANION_SIGN_IDENTITY`).
  8. *Uninstall:* quit; delete the app; optionally delete the App Support folder above, `defaults delete local.claudegptcompanion.app`, the Keychain items in Keychain Access, and reset permissions with `tccutil reset Microphone local.claudegptcompanion.app` (and `SpeechRecognition`, `Accessibility`). Nothing of Claude Desktop or Claude Code is ever changed, so nothing there to undo.
  9. *Troubleshooting:* "Node.js 24 or newer was not found" → rebuild; "The relay did not build" → install the command-line tools; "Security check failed" → read it, acknowledge in the panel, report; a corporate TLS-intercepting proxy breaks Jira (see m6 known limit).

- [ ] **Step 2: `docs/signing.md`** — signing notes:
  - What is signed with what (table): the app (`COMPANION_SIGN_IDENTITY`, hardened runtime, entitlement `com.apple.security.device.audio-input` only); the bundled Node (same identity, hardened runtime, `allow-jit` + `allow-unsigned-executable-memory` only — and why the official build's `get-task-allow`, `disable-library-validation`, `allow-dyld-environment-variables`, `disable-executable-page-protection` are dropped); Codex 0.166.0 binaries (OpenAI's Developer ID signature, never changed, checked by the build); the relay (built per user at each daemon start, ad-hoc by the linker, never shipped); the DMG (signed only with a real identity).
  - Ad-hoc default and its effects (TCC and Keychain prompts after each rebuild; Gatekeeper blocks downloaded copies).
  - A stable local identity (an Apple Development or self-made code-signing certificate) via `COMPANION_SIGN_IDENTITY="<name>"`: fewer prompts; still not notarizable.
  - Developer ID + notarization, **owner steps**: (1) have a Developer ID Application certificate in the login keychain; (2) once: `xcrun notarytool store-credentials "<profile name>"` (it asks for the Apple ID, team and an app-specific password and keeps them in the keychain; never put them in the repo, env files or a chat); (3) `COMPANION_SIGN_IDENTITY="Developer ID Application: <you>" bash scripts/build-app.sh`; (4) `… bash scripts/smoke-bundle.sh`; (5) `… bash scripts/package-app.sh`; (6) `COMPANION_SIGN_IDENTITY=… COMPANION_NOTARY_PROFILE="<profile name>" bash scripts/notarize.sh app/build/ClaudeGPT-Companion-0.7.0.dmg`; (7) expect `spctl` to say `accepted` / `source=Notarized Developer ID`. If notarization fails: `xcrun notarytool log <id> --keychain-profile …` and what the common causes are (an unsigned or non-runtime Mach-O; `get-task-allow`).
  - Write no identity, team ID or profile name into the repo (public).
  - Not measured by the agent: Developer ID signing, notarization, stapling, Gatekeeper acceptance (no credentials by design).

- [ ] **Step 3: `docs/manual/m7-checklist.md`** — the owner checklist, rows with `Result:` blanks, synthetic data or Context Off only:
  1. `bash scripts/build-app.sh` → `built and verified … version 0.7.0`.
  2. `bash scripts/smoke-bundle.sh` → `smoke-bundle: OK`.
  3. `bash scripts/package-app.sh` → the DMG exists.
  4. Clean install: quit any running copy and remove older copies (`app/build` copies may stay); install from the DMG into /Applications.
  5. First launch from /Applications: the panel opens; Settings › Advanced shows companiond running; no "Node.js … not found".
  6. Activity Monitor (or `ps -o command= -p <pid>`): companiond's Node is `/Applications/ClaudeGPT Companion.app/Contents/Resources/node/bin/node`, not Homebrew's.
  7. Sign-in state: the companion's existing ChatGPT sign-in is still there (same App Support folder) or sign in again.
  8. Ask one question with **Context: Off** in a synthetic repo (a fresh `git init` folder with one made-up file); a reply arrives; the repo tool call is shown.
  9. Primary acceptance re-run (as in `m5-checklist.md`): `scripts/tree-hash.sh` before/after on the synthetic repo → identical.
  10. Dictation once: the microphone prompt names ClaudeGPT Companion (may appear again after an ad-hoc rebuild).
  11. Jira (only if set up in M6): still configured; one Keychain prompt after the rebuild is expected.
  12. Uninstall steps from `docs/install.md` work (optional).
  13. *Optional, Developer ID:* the steps in `docs/signing.md`; `spctl` accepts the app and the DMG.

- [ ] **Step 4: Spec, README, plans README**
  - Spec header: bump to v3.6 with a one-line change note "M7 packaging: bundled Node, relay source in the bundle, signing notes".
  - §2, after the *M5* note: *M7:* the bundle carries the pinned official Node.js 24 (`Contents/Resources/node`, re-signed with only the two JIT entitlements) and the relay source; the app runs companiond with the bundled Node first (`COMPANION_NODE`, then bundled, then Settings, then system paths). The jail's Node prefix is `Contents/Resources/node`. Apple silicon only. The Xcode command-line tools stay a runtime requirement (relay compile, `git`).
  - §9, after the *M5* line: *M7:* Developer ID and notarization are owner steps with `COMPANION_SIGN_IDENTITY` and `COMPANION_NOTARY_PROFILE` (`docs/signing.md`); Codex keeps OpenAI's signature.
  - §14 M7 row: append `*M7: implemented — build, bundle smoke, DMG, install guide (docs/install.md), signing notes (docs/signing.md); clean install: owner checklist docs/manual/m7-checklist.md*`.
  - `README.md`: an "Install" section linking `docs/install.md` and `docs/signing.md`, and add `bash scripts/build-app.sh && bash scripts/smoke-bundle.sh` to Development.
  - `docs/superpowers/plans/README.md`: M7 row → `[Packaging](2026-11-05-m7-packaging.md) | implemented; clean install = owner checklist ([m7-checklist](../../manual/m7-checklist.md))`; spec version in the first line → v3.6.

- [ ] **Step 5: Check and commit**

Run: `bash scripts/check-repo.sh` (no home paths: write `~/Library/…`, never `/Users/<name>/`; no identity, team ID or email).

```bash
git add docs/install.md docs/signing.md docs/manual/m7-checklist.md README.md docs/superpowers/specs/2026-11-03-claudegpt-companion-design.md docs/superpowers/plans/README.md
git commit -m "docs(m7): install guide, signing notes, owner checklist, spec v3.6" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Self-review (2026-11-05)

**Spec coverage (§14 M7: "Packaging, install guide, signing notes — clean install on this Mac"):** packaging = Tasks 2, 4, 5, 6; install guide = Task 7 (`docs/install.md`); signing notes = Task 7 (`docs/signing.md`) + Task 6 (`notarize.sh`); clean install = owner checklist (Task 7), backed by the agent-run bundle smoke (Task 5). Spec §2 and §9 "Bundling Node is M7" / "Developer ID and notarization stay in M7" = Tasks 2–4 and 6–7. §7.2 / §7.1.9 unchanged by construction (Global Constraints list the untouched folders; Task 5 re-runs their suites under the bundled Node).

**Placeholder scan:** every code step has the code; the docs steps list each section's content. Assumptions checked against the code: `LineBuffer.push`, `plutil -extract` on JSON, `tsconfig` including `scripts/`, no test asserting `"0.6.0"`.

**Consistency:** `scripts/fetch-node.sh <dest>` writes `<dest>/node/bin/node` (Task 2) = `bundledNode(resourceURL:)` `node/bin/node` (Task 3) = `node_bin` in Task 4 = the smoke's `Contents/Resources/node/bin/node` (Task 5). `COMPANION_VERSION` / package.json `0.7.0` (Task 1) is what Task 4 checks against Info.plist and Task 5 compares with `hello.daemonVersion`. `expect_fail` (Task 2) is reused in Task 6. Env names: `COMPANION_SIGN_IDENTITY`, `COMPANION_NOTARY_PROFILE`, `COMPANION_NODE_TARBALL`, `COMPANION_APP`, `COMPANION_NODE` — each defined once.

**Risks:** (1) CI `hdiutil` flakiness — 3 tries. (2) CI first run downloads Node (~50 MB) — cached by pin hash. (3) Notarization is not measured (no credentials by design); known causes are listed in the signing notes.
