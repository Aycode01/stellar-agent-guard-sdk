# GuardTelemetryListener API

`GuardTelemetryListener` monitors on-chain events emitted by a guard contract.

## Constructor

```ts
constructor(options: GuardTelemetryListenerOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server
- `guard: string` — Guard contract address

## Methods

### `watch(signal?: AbortSignal): AsyncIterable<GuardEventPage>`

Yields pages of decoded guard events (`event_auth_checked`, `event_policy_updated`, etc.).
