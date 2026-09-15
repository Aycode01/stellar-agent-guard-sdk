# Contributing

## Commit convention

Commits use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <imperative summary>
```

Types in use in this repo: `feat`, `fix`, `docs`, `chore`, `ci`, `test`. The existing
history is the reference — match its shape rather than inventing a new one.

## One commit per logical unit, **per file** — the hard rule

Every commit **and every push** must touch **exactly one file**. Not "on average" —
exactly one, every time.

- Never bundle a source change with its test, and never bundle a doc update with the
  code it describes, even when they are logically one unit of work.
- If a logical change genuinely requires edits to several files, that is several
  sequential commits — **one file each** — pushed in order. Do not squash them
  together afterwards.
- This is stricter than the earlier "one commit per logical unit" rule. It is now
  one commit per logical unit **per file**.
- It applies to every repository in this org: `stellar-agent-guard-sdk`,
  `stellar-agent-guard-contracts`, and `stellar-agent-guard-dashboard`.

Why: each commit stays independently reviewable and revertable, and a code change can
never hide inside a `docs:` commit or vice versa.

Check before you commit — either of these must print exactly one path:

```bash
git diff --cached --name-only
git show --stat HEAD
```

## Branch protection and CI

`main` is protected by the `main-protection` ruleset:

- the required status check is named exactly **`ci`**;
- **one approving review** is required, stale reviews are dismissed on push, and
  GitHub does not permit self-approval;
- allowed merge methods are `merge`, `squash` and `rebase`.

Do not merge through the ruleset bypass, and do not modify the ruleset to work around
a required check that is legitimately blocked.

CI reports **two** checks, deliberately:

- **`ci`** — required. Runs typecheck, lint and the unit tests. It touches no secret,
  so nothing in it can silently mask a skip: every step either really runs or the job
  fails.
- **`integration-live (informational)`** — not required. Runs the live testnet suite
  and reports `passed` / `failed` / `skipped` as its own check. It needs the
  deployment's keys from the `PHASE2_ENV_FILE` secret; until that secret exists the
  job is reported as **skipped**, never as a pass. A green `ci` does not imply the
  live suite ran.

## Branch lifecycle

- All work happens on a feature branch and lands through a pull request. **Never push to
  `main` directly** — not before this rule, and not after it.
- After a PR merges, and **only** then:
  1. confirm the merge actually landed — `git log main` shows the merge/squash/rebase
     commit and the PR reports a populated `mergedAt`;
  2. delete the remote branch (`git push origin --delete <branch>`, or the "Delete branch"
     button GitHub shows on a merged PR);
  3. delete the local branch with `-d`, **not** `-D`. If `-d` refuses, that is a signal the
     merge did not land the way you think — stop and check rather than forcing it.
- Sweep for stray branches (`git branch -a`, `gh api repos/{owner}/{repo}/branches`) and
  delete the ones already merged into `main`. **Never delete an unmerged branch** to hit a
  `main`-only target — that silently discards unmerged work.
- Verify with `git branch -a`: it should show `main` and nothing else.
- The same rule applies to `stellar-agent-guard-contracts` and
  `stellar-agent-guard-dashboard`.

## Local gates before pushing

```bash
npm run typecheck
npm run lint
npm test
npm run test:integration   # live testnet; needs .env.phase2
```

## Secrets

`PHASE2_ENV_FILE` (live testnet signing keys) and `NPM_TOKEN` (publish) are
maintainer-managed repository secrets. `.env.phase2` is gitignored — never commit it,
and never embed keys in a workflow or work around a missing secret with an alternate
name.
