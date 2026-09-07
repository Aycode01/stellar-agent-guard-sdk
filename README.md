# stellar-agent-guard-sdk

Integration bridge between AI agent frameworks (LangChain / AutoGPT / ElizaOS class) and the
live `stellar-agent-guard-contracts` deployment: pre-flight simulation interception, real
transaction signing/submission, cost pre-checking, and event telemetry.

**Status: Phase 0 scaffold only. No code yet.** Phase 2 (building strictly against the real
Phase 1 testnet deployment — no mock state) has not started.

## Mechanism (settled)

Contracts: [stellar-agent-guard-contracts](../stellar-agent-guard-contracts).
Operator UI: [stellar-agent-guard-dashboard](../stellar-agent-guard-dashboard).
