/**
 * Shared harness for the live-testnet integration suite.
 *
 * These tests run against the real Phase 2 instance, not a mock: every
 * assertion is about a transaction the network either accepted or refused. The
 * harness exists so each test can get a *deterministic* starting point without
 * pretending state is clean when it is not.
 *
 * Two facts about the contract shape the design:
 *
 *  - `set_policy` resets the rolling window to empty and re-arms the heartbeat
 *    (`src/lib.rs`: `save_ledger(&env, &Ledger::empty(&env))`). Re-installing the
 *    same policy is therefore the documented way to obtain a clean window, which
 *    is what makes a rolling-window test repeatable instead of dependent on how
 *    recently the previous run spent.
 *  - The live policy is read, not assumed, and the tests skip with an explicit
 *    reason if the deployed instance does not match the shape they need.
 */
import { readFile } from "node:fs/promises";
import {
  Address,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { invoke, type InvokeOutcome } from "../../src/invoke.ts";
import { policyToScVal, type PolicyConfig } from "../../src/policy.ts";
import { readPersistentEntry } from "../../scripts/inspect-deployment.ts";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export interface Phase2Keys {
  admin: Keypair;
  agent: Keypair;
  recipient: Keypair;
  outsider: Keypair;
}

export interface Phase2Config {
  rpcUrl: string;
  guard: string;
  token: string;
  keys: Phase2Keys;
  /** The policy the instance is expected to run for these tests. */
  policy: PolicyConfig;
}

async function readEnvFile(path = ".env.phase2"): Promise<Record<string, string>> {
  const raw = await readFile(path, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index > 0) out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return out;
}

export async function loadPhase2Config(): Promise<Phase2Config> {
  const env = await readEnvFile();
  const need = (key: string): string => {
    const value = env[key];
    if (!value) {
      throw new Error(
        `${key} missing from .env.phase2 — run scripts/deploy-phase2-instance.ts first`,
      );
    }
    return value;
  };

  const guard = need("PHASE2_GUARD");
  const token = need("PHASE2_TOKEN");
  const keys: Phase2Keys = {
    admin: Keypair.fromSecret(need("PHASE2_ADMIN_SECRET")),
    agent: Keypair.fromSecret(need("PHASE2_AGENT_SECRET")),
    recipient: Keypair.fromSecret(need("PHASE2_RECIPIENT_SECRET")),
    outsider: Keypair.fromSecret(need("PHASE2_OUTSIDER_SECRET")),
  };

  // Bounds the suite depends on. Chosen so the rolling-window scenario can be
  // proven with two individually-admissible transfers (each below `window_cap`)
  // whose sum exceeds it — a single oversized transfer would only prove a cap,
  // not the accumulation.
  const policy: PolicyConfig = {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [token],
    protocols: [],
    recipients: [keys.recipient.publicKey()],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
  };

  return {
    rpcUrl: env["PHASE2_RPC_URL"] ?? "https://soroban-testnet.stellar.org",
    guard,
    token,
    keys,
    policy,
  };
}

/** Read a contract view function, mutating nothing. */
export async function readContract(
  server: rpc.Server,
  contract: string,
  fn: string,
  args: xdr.ScVal[],
  sourceAddress: string,
): Promise<unknown> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract, function: fn, args }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`read ${fn} failed: ${sim.error}`);
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return retval === undefined ? null : (scValToNative(retval) as unknown);
}

/**
 * Install the suite's policy via the admin, which also clears the rolling window
 * and re-arms the dead-man switch. Every window-sensitive test starts here so its
 * result does not depend on how much a previous run spent.
 */
export async function installPolicy(
  server: rpc.Server,
  config: Phase2Config,
  policy: PolicyConfig = config.policy,
): Promise<void> {
  const outcome = await invoke({
    server,
    source: config.keys.admin,
    call: {
      contract: config.guard,
      fn: "set_policy",
      args: [policyToScVal(policy)],
    },
    networkPassphrase: TESTNET_PASSPHRASE,
    accountSigners: [config.keys.admin],
  });
  if (outcome.kind !== "allowed") {
    throw new Error(`set_policy did not succeed: ${JSON.stringify(outcome)}`);
  }
}

/** Move SAC tokens out of the guarded account, authorized by the agent key. */
export async function transfer(
  server: rpc.Server,
  config: Phase2Config,
  amount: bigint,
  to: string,
): Promise<InvokeOutcome> {
  return invoke({
    server,
    source: config.keys.agent,
    call: {
      contract: config.token,
      fn: "transfer",
      args: [
        new Address(config.guard).toScVal(),
        new Address(to).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
      ],
    },
    networkPassphrase: TESTNET_PASSPHRASE,
    guardAuth: { guard: config.guard, agent: config.keys.agent },
  });
}

/**
 * The committed rolling-window total.
 *
 * The window is internal spend accounting with no read function, so it is read
 * from persistent storage at `DataKey::Window` — the same entry the contract
 * mutates when it commits a transfer. That makes it the only honest check that
 * a "blocked" transfer really did move nothing.
 */
export async function readWindowTotal(
  server: rpc.Server,
  config: Phase2Config,
): Promise<{ total: bigint; entries: unknown[] }> {
  const entry = await readPersistentEntry(server, config.guard, "Window");
  const value = entry?.value as { total?: bigint | number; entries?: unknown[] } | null | undefined;
  return {
    total: BigInt(value?.total ?? 0),
    entries: value?.entries ?? [],
  };
}

/** The guarded account's SAC balance, as recorded on the token contract. */
export async function guardTokenBalance(
  server: rpc.Server,
  config: Phase2Config,
): Promise<bigint> {
  const raw = await readContract(
    server,
    config.token,
    "balance",
    [new Address(config.guard).toScVal()],
    config.keys.admin.publicKey(),
  );
  return BigInt((raw as bigint | number | null) ?? 0);
}

/** Read the live policy exactly as the contract stores it. */
export async function readPolicy(
  server: rpc.Server,
  config: Phase2Config,
): Promise<PolicyConfig | null> {
  const raw = await readContract(
    server,
    config.guard,
    "policy",
    [],
    config.keys.admin.publicKey(),
  );
  return raw === null ? null : (raw as PolicyConfig);
}

/** Read live status (has_policy / admin_frozen / heartbeat_expired). */
export async function readStatus(
  server: rpc.Server,
  config: Phase2Config,
): Promise<{ has_policy: boolean; admin_frozen: boolean; heartbeat_expired: boolean }> {
  const raw = await readContract(
    server,
    config.guard,
    "status",
    [],
    config.keys.admin.publicKey(),
  );
  return raw as { has_policy: boolean; admin_frozen: boolean; heartbeat_expired: boolean };
}
