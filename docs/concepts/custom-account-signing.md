# Custom Account Signing

Soroban Custom Accounts implement the `CustomAccountInterface`. The contract itself is the address authorizing transactions.

Standard wallets sign transaction envelopes for public key accounts (`G...`). For a custom account (`C...`), the transaction requires a `SorobanAuthorizationEntry` with `AddressCredentials` containing a signature valid for the contract's registered agent key.

The SDK's `invoke()` pipeline manages:
1. Probe simulation to detect necessary authorization entries.
2. Building `SorobanAuthorizationEntry` credentials.
3. Signing auth entries with the agent's Ed25519 keypair.
4. Second simulation with attached credentials.
5. Final envelope signing with fee-source keypair and submission.
