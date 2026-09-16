# Dual-Stream Telemetry

A critical challenge in smart account telemetry is observing blocked transactions.

## The Ledger Rollback Problem

When a Soroban contract call is blocked by `__check_auth`, the host rolls back the transaction. Events emitted by the contract during failed transactions **never reach the ledger**.

A listener monitoring only committed ledger events will observe a guard that appears to approve 100% of transactions.

## The Solution

`GuardTelemetryListener` combines two distinct sources:
1. **Committed Ledger Stream**: Polls `getEvents` from Soroban RPC for committed transactions.
2. **Diagnostic Event Stream**: Extracts uncommitted `event_auth_checked` diagnostic events from pre-flight simulation responses via `guardEventsFromDiagnostics()`.
