# stellar-agent-guard-sdk

Integration bridge between AI agent frameworks (LangChain / ElizaOS class) and the
live [`stellar-agent-guard-contracts`](https://github.com/aigbagbobila/stellar-agent-guard-contracts)
deployment: pre-flight policy interception, real agent-auth transaction signing,
in-process cost pre-checking, and on-chain event telemetry.

**Status: Phase 2 complete, publish-ready, not published.** The integration suite runs
against a live testnet instance of the exact Phase 1 artifact (`CAPADGEK…`, hash-verified
byte-for-byte) — no mock state. Publishing is wired up but deliberately not performed;
see [Publishing](#publishing).

## Mechanism

The guard is a Soroban **custom account**: the agent's address *is* the contract, and every
transaction the account authorizes is routed by the host through `__check_auth`. The SDK
builds and signs the `SorobanAuthorizationEntry` for that contract address with the
registered agent key, so it can ask the guard's real `__check_auth` a question through
RPC simulation — **before** anything is signed for broadcast.

That is what makes interception free: enforcement runs in the enforced simulation, so a
refusal happens pre-broadcast, moves no state, and costs no fee. A blocked action therefore
has **no transaction hash by construction** — the evidence for a block is the contract's own
`event_auth_checked, blocked, <reason>` diagnostic event, not a hash.

- Contracts: `stellar-agent-guard-contracts` (Phase 1, artifact `f47919f9…`)
- Phase 2 instance: `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`

## Enforcement scope — read this before relying on the caps

The following paragraph is copied **verbatim** from the contracts repo's
[`docs/enforcement-scope.md`](https://github.com/aigbagbobila/stellar-agent-guard-contracts/blob/main/docs/enforcement-scope.md)
("The confirmed scope"), not paraphrased. The boundary is a property of the platform, and
one shared wording is what keeps the two repos from drifting apart on it:

> Full recipient/amount enforcement — spend caps, allowlists, per-transaction limits — is
> native and automatic for SAC token transfers (`transfer`/`transfer_from`), since these are
> the calls whose arguments the Soroban auth context exposes for inspection. For other
> Soroban contract calls made by the guarded account (arbitrary DEX/lending/protocol calls),
> the policy engine still enforces window and pause state, but per-call amount/recipient
> limits are not yet enforced — extending fine-grained enforcement to arbitrary calls is
> tracked as a v2 item, not implied as already covered.

The same sentence appears in `src/index.ts`, next to the capability claim it qualifies.

## Install

```bash
npm install stellar-agent-guard-sdk
```

Requires Node 24+. The only runtime dependency is `@stellar/stellar-sdk`. The framework
adapters are written **structurally** against their host hooks, so LangChain and ElizaOS are
not dependencies of this package.

## Usage

### Pre-flight interception

```ts
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { PreFlightInterceptor, GuardBlockedError } from "stellar-agent-guard-sdk";

const interceptor = new PreFlightInterceptor({
  server: new rpc.Server("https://soroban-testnet.stellar.org"),
  networkPassphrase: "Test SDF Network ; September 2015",
  guard: "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44",
  agent: Keypair.fromSecret(process.env.AGENT_SECRET!),
  source: Keypair.fromSecret(process.env.SOURCE_SECRET!),
});

const decision = await interceptor.check(call);
```

`check()` never throws for a refusal and never broadcasts. It returns one of three
deliberately distinct outcomes:

| `kind`          | Meaning                                                              |
| --------------- | -------------------------------------------------------------------- |
| `admissible`    | The guard approved, with the network's own `estimatedResourceFee`.   |
| `blocked`       | The guard refused, with the contract's own reason symbol.            |
| `undetermined`  | Enforcement could not reach a decision — **treated as not allowed**. |

`undetermined` is kept separate from `blocked` on purpose: reporting "the guard refused
this" when the guard never ruled would be a false claim about the security boundary.
`assertAllowed()` turns both non-allow outcomes into errors, failing closed.

### Full invocation

`invoke()` runs the whole pipeline — probe simulation, agent-auth signing, enforced
simulation, then broadcast only on a pass — and returns a discriminated result. It includes
one bounded retry for a real, observed failure mode: a stale-ledger resource declaration
(`scecExceededLimit`), diagnosed and documented in `src/tx.ts`.

### Cost pre-checking

```ts
import { CostPreChecker } from "stellar-agent-guard-sdk";

const costs = new CostPreChecker({ interceptor, maxFeeStroops: 50_000n });
const cost = await costs.check(call); // within_budget | over_budget | blocked | undetermined
```

**Decision: in-process, per-call simulation pricing — not `soroban-cost-estimator`.**
`CostPreChecker` reports the network's own `minResourceFee` from the same enforced
simulation the interceptor already runs, split into resource fee, inclusion fee, and total.
`soroban-cost-estimator` was considered and rejected: it profiles a locally compiled WASM
artifact through the `stellar` CLI, and this SDK never compiles a contract — it calls one
that is already deployed. Requiring a CLI artifact the SDK does not produce would be
inventing a dependency to answer a question one simulation already answers exactly.

Two properties are deliberate. A missing `maxFeeStroops` means "price it, never object",
never "refuse anything that costs anything". And a guard refusal is reported as `blocked`
with an explicitly **zero** fee — a block is not a cost overrun.

### Framework adapters

Both adapters are built against hooks confirmed by reading each framework's own source
(pinned blob SHAs in [`docs/integration-hooks.md`](docs/integration-hooks.md)):

```ts
import { createLangChainGuardMiddleware, createGuardValidator } from "stellar-agent-guard-sdk";

// LangChain — AgentMiddleware.wrap_tool_call: the handler is the continuation, so a
// middleware that returns without calling handler(request) stops the tool body running.
const middleware = createLangChainGuardMiddleware({ interceptor, toContractCall });

// ElizaOS — Action.validate: a false verdict filters the action out before any handler runs.
const validate = createGuardValidator({ interceptor, toContractCall });
```

**AutoGPT has no adapter, and this is a finding, not an omission.** Its executor exposes no
pluggable pre-execution blocking hook for third-party guardrails at the revision read — only
an internal, non-extensible human-review pause. Rather than build an adapter against a
guessed shape, the gap is recorded in `docs/integration-hooks.md` §3 with the two viable
integration options for when a hook exists or the project chooses the block-ownership route.

### Telemetry

```ts
import { GuardTelemetryListener, guardEventsFromDiagnostics } from "stellar-agent-guard-sdk";

const listener = new GuardTelemetryListener({ server, guard });
for await (const page of listener.watch()) console.log(page);
```

The listener consumes **two** streams, and this is the part that is easy to get wrong: a
blocked decision never reaches the ledger (the guard returns `Err`, which rolls the event
back), so a listener that only tails committed ledger events sees a guard that appears to
approve everything. Blocked decisions are read from enforced-simulation diagnostics via
`guardEventsFromDiagnostics`. Topic names come from the live capture in
[`docs/event-schema.md`](docs/event-schema.md) — notably `event_auth_checked`, not the
documentation's `auth_checked`.

## Verification

| Claim                                   | Evidence                                                             |
| --------------------------------------- | -------------------------------------------------------------------- |
| Live instance is the Phase 1 artifact   | `tests/fixtures/phase2-instance.json`, hash-verified + re-verified   |
| Allowed / per-tx / window / allowlist   | `tests/integration/enforcement.test.ts` (real txs, real diagnostics) |
| Interceptor decides without broadcasting | `tests/integration/interceptor.test.ts`                              |
| Listener against real emitted events    | `tests/integration/telemetry.test.ts`                                |
| Event topics confirmed on-chain         | `docs/event-schema.md`                                               |
| Framework hooks, sourced                | `docs/integration-hooks.md`                                          |

Final on-chain evidence for the suite is recorded in
[`tests/fixtures/integration-evidence.md`](tests/fixtures/integration-evidence.md).

Two fields in `tests/fixtures/phase2-instance.json` must be read carefully: `status`,
`policy` and `guardTokenBalance` are a **snapshot from deploy time, not current state** —
the suite spends funds and the rolling window moves, so query the instance directly
(`npm run inspect`) for present values. `transactions` and `mints` are the opposite: sealed,
append-only records re-verified against the chain on every run.

## Development

```bash
npm run typecheck                    # tsc --noEmit
npm run lint                         # eslint
npm test                             # unit tests, no network
npm run test:integration             # live testnet; needs .env.phase2
npm run inspect                      # read-only live inspection
```

CI (`.github/workflows/ci.yml`) reports **two separate checks**, deliberately:

- **`ci`** — required by the branch-protection ruleset. Runs typecheck, lint and the unit
tests. No secret is involved, so nothing in it can silently mask a skip: every step either
really runs or the job fails.
- **`integration-live (informational)`** — separate and **not required**. Runs the live
testnet suite and reports passed / failed / skipped as its own line. The suite signs real
transactions, so it needs the deployment's keys from the `PHASE2_ENV_FILE` secret; until
that secret exists the job is **skipped as its own check, never reported as a pass**, and a
green `ci` never implies the live suite ran.

They are split because a single required job containing the live suite could go green on a
missing secret — a required check that can pass without the security-critical suite running
does not mean what a required check is supposed to mean.

## Publishing

**Publish-ready, not published.** `npm pack` and `npm publish --dry-run` have been run and
the package contents verified. `.github/workflows/publish.yml` publishes on version tags
using the `NPM_TOKEN` repository secret — which only a maintainer can add, and which has
not been added, so **no release has been made and none should be made until the maintainer
either adds the token and runs the workflow or explicitly authorizes a manual publish**.

## License

MIT. This is unaudited security tooling that gates real fund access — see the contracts
repo's `SECURITY.md` before considering mainnet use.
