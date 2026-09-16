# PreFlightInterceptor API

`PreFlightInterceptor` evaluates whether a planned contract call will be accepted by the guard contract.

## Constructor

```ts
constructor(options: PreFlightInterceptorOptions)
```

### Options

- `server: rpc.Server` — Soroban RPC server instance
- `networkPassphrase: string` — Stellar network passphrase
- `guard: string` — Custom account contract address (`C...`)
- `agent: Keypair` — Keypair registered as the agent in the guard
- `source: Keypair` — Keypair paying for transaction fees

## Methods

### `check(call: ContractCall): Promise<PreFlightDecision>`

Evaluates a contract call against the guard without throwing or broadcasting.

### `assertAllowed(call: ContractCall): Promise<AdmissibleDecision>`

Evaluates a call and throws `GuardBlockedError` if blocked or undetermined.
