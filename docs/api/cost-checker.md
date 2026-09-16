# CostPreChecker API

`CostPreChecker` evaluates expected transaction fees against an optional ceiling before broadcast.

## Constructor

```ts
constructor(options: CostPreCheckerOptions)
```

### Options

- `interceptor: PreFlightInterceptor` — Configured interceptor instance
- `maxFeeStroops?: bigint` — Maximum allowable total fee in stroops

## Methods

### `check(call: ContractCall): Promise<CostPreCheckResult>`

Returns `{ kind: "within_budget" | "over_budget" | "blocked" | "undetermined", cost, decision }`.
