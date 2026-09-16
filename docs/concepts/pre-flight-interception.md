# Pre-Flight Interception

## How Pre-Flight Works

In traditional architectures, transaction policy checks occur either after broadcast (risking gas loss or failed tx fees) or via centralized off-chain policy proxies.

Stellar Agent Guard provides zero-cost pre-flight interception:

1. The SDK builds an unsigned Soroban authorization entry for the target contract call.
2. The agent's Ed25519 key signs the auth payload.
3. The SDK submits an RPC simulation to Soroban.
4. The Soroban host routes authorization through the guard's `__check_auth`.
5. If the policy is satisfied, the call returns `admissible` with the estimated resource fee.
6. If the policy is violated, the contract traps or returns `Blocked(reason)`, and Soroban returns the failure in simulation diagnostics. No transaction is broadcast.

## Decision Outcomes

| Verdict | Description | Action |
|---|---|---|
| `admissible` | Approved by guard policy | Proceed to broadcast |
| `blocked` | Explicitly denied by policy | Reject tool call; 0 network fees charged |
| `undetermined` | Simulation failed or network unreachable | Fail closed (treated as not allowed) |
