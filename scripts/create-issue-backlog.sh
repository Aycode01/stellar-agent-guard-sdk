#!/usr/bin/env bash
#
# Creates the org-wide issue backlog for the Phase 2 closeout, with one shared
# label taxonomy applied to all three repos.
#
# Taxonomy (identical in every repo in this org):
#
#   tier:blocker              blocks a phase exit; not fixable by an agent alone
#   tier:maintainer-decision  a human call is required; do not guess
#   tier:enhancement          non-blocking; revisit when its trigger is met
#   scope:sdk | scope:contracts | scope:dashboard
#                             which repo's code/config the issue concerns, so the
#                             whole backlog can be filtered across repos in one query
#
# Wave complexity (Trivial / Medium / High) is deliberately NOT a label here. Per the
# Drips Wave maintainer docs, complexity is assigned when an issue is added to a Wave
# Program in the dashboard, and the Wave bot applies its own program label. Keeping
# this tier taxonomy orthogonal to that means neither scheme has to be renamed later.
#
# Idempotent: labels are created or updated with --force, and an issue is created only
# when no open issue with the same title already exists in that repo. Safe to re-run.
#
# Resilient per repo: a repo whose labels cannot be written is reported and its issues
# are skipped, rather than aborting the run for every repo. An issue is only created
# once its repo carries the full taxonomy, so nothing lands unlabeled.
#
# Usage: ./scripts/create-issue-backlog.sh
set -uo pipefail

ORG="aigbagbobila"
REPOS=(
  "stellar-agent-guard-sdk"
  "stellar-agent-guard-contracts"
  "stellar-agent-guard-dashboard"
)
TAXONOMY=(
  "tier:blocker"
  "tier:maintainer-decision"
  "tier:enhancement"
  "scope:sdk"
  "scope:contracts"
  "scope:dashboard"
)
blocked_repos=()

upsert_labels() {
  local repo="$1"
  gh label create "tier:blocker"             --repo "$ORG/$repo" --color "d73a4a" --description "Blocks a phase exit; not fixable by an agent alone" --force &&
  gh label create "tier:maintainer-decision" --repo "$ORG/$repo" --color "fbca04" --description "Requires a human maintainer call; do not guess" --force &&
  gh label create "tier:enhancement"         --repo "$ORG/$repo" --color "0e8a16" --description "Non-blocking; revisit when its trigger is met" --force &&
  gh label create "scope:sdk"                --repo "$ORG/$repo" --color "5319e7" --description "Concerns the stellar-agent-guard-sdk repo" --force &&
  gh label create "scope:contracts"          --repo "$ORG/$repo" --color "5319e7" --description "Concerns the stellar-agent-guard-contracts repo" --force &&
  gh label create "scope:dashboard"          --repo "$ORG/$repo" --color "5319e7" --description "Concerns the stellar-agent-guard-dashboard repo" --force
}

repo_has_taxonomy() {
  local repo="$1" have need
  have=$(gh label list --repo "$ORG/$repo" --limit 100 --json name --jq '.[].name' 2>/dev/null) || return 1
  for need in "${TAXONOMY[@]}"; do
    grep -Fxq "$need" <<<"$have" || return 1
  done
}

is_blocked() {
  local r
  for r in ${blocked_repos[@]+"${blocked_repos[@]}"}; do
    [[ "$r" == "$1" ]] && return 0
  done
  return 1
}

issue() {
  local repo="$1" title="$2" labels="$3" body="$4" out
  if gh issue list --repo "$ORG/$repo" --state open --limit 200 \
       --json title --jq '.[].title' 2>/dev/null | grep -Fxq "$title"; then
    echo "  skip (already open)  $title"
    return 0
  fi
  if out=$(gh issue create --repo "$ORG/$repo" --title "$title" --label "$labels" --body "$body" 2>&1); then
    echo "  created              $title"
    echo "                       $out"
  else
    echo "  FAILED               $title"
    echo "                       $out"
    return 1
  fi
}

sdk_issues() {
  issue "stellar-agent-guard-sdk" \
    "Phase 2 exit blocked: add PHASE2_ENV_FILE, or record the local-evidence exception" \
    "tier:blocker,tier:maintainer-decision,scope:sdk" \
    "$(cat <<'EOF'
Phase 2 cannot exit while the live enforcement suite is unverifiable in CI.

`ci` (the required check) is honest and passes without secrets. But
`integration-live (informational)` reports `skipped` until the `PHASE2_ENV_FILE`
repository secret exists, and the available token returns 403 on the Actions secrets
API, so the secret cannot be added from a working session.

Two options, and only a maintainer can pick one:

1. **Add the secret**, so `integration-live` genuinely runs on every PR from here on.
2. **Accept the documented local-evidence exception** — the required `ci` check plus the
   pasted local live-suite output — and merge on that, with the secret to follow before
   the next PR that touches enforcement logic.

Context: `ci` was split from the live suite precisely so a green required check cannot
hide a skipped security-critical suite. The local run covers 18/18 live tests against
the Phase 2 instance, including the four enforcement scenarios with real contract
diagnostics.
EOF
)"

  issue "stellar-agent-guard-sdk" \
    "Decide the disposition of PR #1 (phase2/sdk-foundation)" \
    "tier:maintainer-decision,scope:sdk" \
    "$(cat <<'EOF'
`phase2/sdk-foundation` (PR #1) is open and unmerged, and sits ~30 commits behind `main`.

Read-only investigation, diffing the branch against `main` and `phase2-completion`:

- **3 of its 4 files already exist on `main` in strictly newer form:** `package.json`,
  `tsconfig.json`, `package-lock.json`. Merging PR #1 as-is would *regress* them — it
  drops the `license` and `engines` fields, the `inspect` and `deploy:phase2` scripts and
  the stricter tsconfig, and re-adds a `./interceptors` export subpath that does not
  exist.
- **`scripts/probe-live.mjs` is the only file not on `main`.** Its two reads are covered
  by `scripts/inspect-deployment.ts` (`npm run inspect`), which also names the same Phase 1
  guard — with one delta: the **agent account's XLM balance and sequence number** are not
  printed anywhere on `main` today.

Finding: PR #1 is superseded in substance, but its branch is not literally contained in
`main`, so closing it is a maintainer decision rather than an assumption.

Decision needed: close PR #1 as superseded (optionally porting the agent-account read into
`scripts/inspect-deployment.ts` as its own one-file change), or land it first.

Ordering matters: PR #1 cannot land *after* PR #2 without reverting `main`'s evolved
config, so any PR #1 work should be reduced to the probe delta before it is considered.
EOF
)"

  issue "stellar-agent-guard-sdk" \
    "Revisit the AutoGPT adapter only if AutoGPT ships a real pre-execution hook" \
    "tier:enhancement,scope:sdk" \
    "$(cat <<'EOF'
AutoGPT exposes no pluggable pre-execution blocking hook for third-party guardrails at the
revision read, so no adapter was built. This is a documented absence, not a task.

Source and reasoning: `docs/integration-hooks.md` §3 (specific blob SHAs pinned).

Revisit only if one of these becomes true:

- AutoGPT's executor gains a middleware/hook/interceptor registry, or
- `is_block_exec_need_review` gains a pluggable, non-human policy check, or
- this project deliberately chooses block-ownership as its AutoGPT integration story.

When revisiting, repeat the three searches documented in §3 and **supersede** the blob SHAs
rather than replacing them silently.
EOF
)"

  issue "stellar-agent-guard-sdk" \
    "Decide whether this repo should carry a changelog / discoverable history record" \
    "tier:maintainer-decision,scope:sdk" \
    "$(cat <<'EOF'
The Phase 2 closeout asked for a one-line pointer to the corrected-history note "in a
`CHANGELOG.md` or equivalent, if the repo has one". This repo does not: there is no
`CHANGELOG.md`, and no `CHANGES` / `HISTORY` / `RELEASES` file.

A changelog was deliberately **not** invented, because this repo already carries an
explicit instruction against building docs speculatively.

Decision needed: add a changelog (and if so, what seeds it), or record explicitly that this
repo does not carry one, so the question stops recurring.
EOF
)"

  issue "stellar-agent-guard-sdk" \
    "Give guard events a stable id and a unified stream before a telemetry UI consumes them" \
    "tier:enhancement,scope:sdk" \
    "$(cat <<'EOF'
Two gaps in the event surface need resolving before any telemetry UI can consume guard
events. Neither is started; this is a precondition, not Phase 3 work.

1. **No stable event identity.** `GuardEvent` (`src/telemetry.ts`) carries
   `transactionHash` + `ledger` for committed events, but `ledger: null` and
   `transactionHash: null` for diagnostic (blocked) events — so two blocks in one
   simulation are indistinguishable. A consumer needs a synthetic id to key or dedupe rows.
2. **No unified stream.** `GuardTelemetryListener.watch()` polls committed ledger events
   only; blocked decisions arrive separately via `guardEventsFromDiagnostics` /
   `telemetryFromDecision`. A UI built on `watch()` alone would show a guard that never
   blocks.

Also worth stating once rather than re-deriving in every consumer: the normalisation rules
for the string-typed values (`data.at` is a `u64` delivered as a string; `ledgerClosedAt`
is a string).

Context: `docs/event-schema.md` documents the two streams but not a merged shape, and only
`event_auth_checked` and `event_heartbeat` have been captured on-chain — the other topic
rows are source-derived.
EOF
)"
}

contracts_issues() {
  issue "stellar-agent-guard-contracts" \
    "Rotate the leaked guard_agent secret key in tools/agent-tx unit tests" \
    "tier:blocker,scope:contracts" \
    "$(cat <<'EOF'
A real `guard_agent` secret key is committed in this repo's `tools/agent-tx` unit tests.
"Testnet-only" does not make this a non-issue.

Needs:

- rotation of the exposed key, and
- replacement of the fixture with a throwaway key that is not reused anywhere.

Related but **not** covering this: #4 ("tools/agent-tx hardening ahead of the Phase-2 SDK")
covers the crate's unit tests, nonce/fee edge cases and `--json` output, but says nothing
about the committed key or its rotation.

Reported during the SDK repo's Phase 2 closeout and carried forward as an open maintainer
item. Not verifiable or actionable from the SDK repo, which is why it is filed here.
EOF
)"

  issue "stellar-agent-guard-contracts" \
    "Docs site was built without the docs-freshness check — keep, roll back, or document as an exception" \
    "tier:maintainer-decision,scope:contracts" \
    "$(cat <<'EOF'
A GitBook docs site was built here during Phase 1 with no evidence that the
`docs.drips.network/wave/maintainers/` freshness check was performed first, against the
project's "do not build a docs site speculatively" instruction.

That check has since been run against the live Drips Wave maintainer docs
(`/wave/maintainers/participating-in-a-wave/` and `/wave/terms-and-rules/`, fetched
2026-09-15). They describe org/repo onboarding, adding issues, Wave complexity
(Trivial/Medium/High) and the label workflow — and **specify no docs-site requirement or
format at all**.

Decision needed: keep the docs site, roll it back, or document it as a deliberate
exception. The freshness check does not support "a docs site was required", so if that was
the assumption behind building it, that assumption does not hold.
EOF
)"
}

echo "== labels =="
for repo in "${REPOS[@]}"; do
  if upsert_labels "$repo" >/dev/null 2>&1 && repo_has_taxonomy "$repo"; then
    echo "  ok       $repo"
  else
    echo "  BLOCKED  $repo — cannot write labels, so its issues are skipped"
    blocked_repos+=("$repo")
  fi
done

echo
for repo in "${REPOS[@]}"; do
  if is_blocked "$repo"; then
    echo "== issues: $repo — SKIPPED (no label write access from this environment) =="
    echo
    continue
  fi
  echo "== issues: $repo =="
  case "$repo" in
    stellar-agent-guard-sdk)       sdk_issues ;;
    stellar-agent-guard-contracts) contracts_issues ;;
    stellar-agent-guard-dashboard) echo "  (none yet — Phase 3 has not started)" ;;
  esac
  echo
done

echo "done."
