#!/usr/bin/env bash
# Repository hygiene check: fails if tracked files (or, with --history, any commit) contain
# secrets, personal transcripts, machine-specific paths, or Claude/Codex identifiers.
# Usage: scripts/check-repo.sh [--history]
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"
fail=0
report() { echo "FAIL: $1"; fail=1; }

tracked=$(git ls-files)

# 1. Transcripts and local data files
bad_files=$(echo "$tracked" | grep -E '\.(jsonl|sqlite|db)$' | grep -v '^fixtures/' || true)
[ -n "$bad_files" ] && report "transcript/database files tracked outside fixtures/:"$'\n'"$bad_files"

# 2. Sensitive file names
bad_names=$(echo "$tracked" | grep -E '(^|/)(\.env(\..*)?|.*\.(pem|key|p12|pfx|jks|keystore)|id_(rsa|ed25519|ecdsa|dsa).*|\.npmrc|\.netrc|\.pgpass|auth\.json)$' || true)
[ -n "$bad_names" ] && report "sensitive file names tracked:"$'\n'"$bad_names"

# 3. Fixtures must be marked synthetic
for f in $(echo "$tracked" | grep '^fixtures/' || true); do
  head -c 400 "$f" | grep -q 'SYNTHETIC FIXTURE' || report "fixture without SYNTHETIC FIXTURE marker: $f"
done

# 4. Content patterns (excluding this script and lockfiles)
patterns=(
  '/Users/[A-Za-z0-9._-]+/'                                   # absolute home paths
  'local_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'  # Claude desktop session ids
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}'
  'github_pat_[A-Za-z0-9_]{40,}'
  'sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}'
  'AKIA[0-9A-Z]{16}'
  'xox[abprs]-[A-Za-z0-9-]{10,}'
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.'           # JWTs
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'             # email addresses
)
allow_email='noreply@anthropic\.com|git@github\.com'
files=$(echo "$tracked" | grep -v -E '^scripts/check-repo\.sh$|package-lock\.json$' || true)
for p in "${patterns[@]}"; do
  hits=$(echo "$files" | xargs grep -I -n -E -e "$p" 2>/dev/null | grep -v -E "$allow_email" || true)
  [ -n "$hits" ] && report "pattern /$p/ matched:"$'\n'"$hits"
done

# 5. Optional: gitleaks over the working tree (and history with --history)
if command -v gitleaks >/dev/null 2>&1; then
  if [ "${1:-}" = "--history" ]; then gitleaks git --redact --no-banner . || fail=1
  else gitleaks dir --redact --no-banner . || fail=1; fi
else
  echo "note: gitleaks not installed; CI runs it on every push and PR"
fi

[ $fail -eq 0 ] && echo "check-repo: OK"
exit $fail
