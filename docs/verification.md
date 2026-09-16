# Testnet Verification

The SDK was verified end-to-end against a real deployed instance on Stellar testnet (protocol 28, `Test SDF Network ; September 2015`):

- **Guard (custom account)**: `CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44`
- **SAC Token**: `CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB`
- **WASM bytecode hash**: `f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63` (identical to Phase 1 artifact)

## 5/5 Live Enforcement Scenarios

| Scenario | Condition | Result | Evidence |
|---|---|---|---|
| 1. Within caps | Transfer 100 within caps (cap: 1000, window: 150) | **Allowed** | Tx hash `5e45d989bea859aae954c9a57e08909c1c90bdbfb909071f69709875b52f1bd2` at ledger `4674156` |
| 2. Per-tx cap | Transfer 1001 > 1000 cap | **Blocked** (`per_tx_cap_exceeded`) | Diagnostic event `event_auth_checked, blocked, per_tx_cap_exceeded`, pre-broadcast, 0 fees |
| 3. Rolling window | Transfer 76 + 76 = 152 > 150 window cap | **Blocked** (`window_cap_exceeded`) | Rolling window accumulation refusal, balances untouched |
| 4. Recipient allowlist | Transfer to unlisted recipient | **Blocked** (`recipient_not_allowed`) | Default-deny address check refusal |
| 5. Account paused | Call while `paused = true` | **Blocked** (`paused`) | Account-state refusal cleanly distinguished from policy caps |

Complete run output and assertion logs are preserved in [`tests/fixtures/integration-evidence.md`](../tests/fixtures/integration-evidence.md).
