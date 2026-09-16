# Publishing History & Process Reconciliation

## Release 0.1.0 (Manual Publish Deviation)

`stellar-agent-guard-sdk@0.1.0` was published directly to the npm registry by the maintainer to unblock initial package availability. Because it was published directly outside the tag-triggered GitHub Actions workflow (`.github/workflows/publish.yml`), no corresponding release tag or `publish` workflow run exists for `0.1.0`. This is a known, one-time historical deviation, not the intended release process.

## Release 0.1.1+ (Standard Automated Pipeline)

Subsequent releases, starting with `0.1.1`, are produced through the automated pipeline:
1. Version bump in `package.json`.
2. Git release tag (`v*.*.*`) pushed to `main`.
3. Execution of `.github/workflows/publish.yml` on GitHub Actions using the maintainer `NPM_TOKEN`.
