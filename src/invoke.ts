/**
 * The full invocation pipeline for a guarded account, in the order the Stellar
 * host actually requires:
 *
 *  1. simulate with no authorization  → RPC reports which authorizations the
 *     call needs (and the footprint that call touches);
 *  2. sign each reported authorization — a classic keypair for admin calls, or
 *     an agent-signed `SorobanAuthorizationEntry` for the guard contract;
 *  3. simulate again with the signed entries → this second simulation runs the
 *     *real* `__check_auth` against live ledger state, so a policy violation is
 *     reported here, **before** anything is broadcast;
 *  4. only if step 3 succeeds, assemble the real resources, sign the envelope
 *     and broadcast.
 *
 * Steps 1–3 never mutate the ledger. A blocked action therefore costs nothing,
 * which is the property the pre-flight interceptor is built to expose.
 */
import { Account, Address, Keypair, Operation, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  SIG_EXPIRATION_LEDGERS,
  assembleFromSimulation,
  buildGuardAuthEntry,
  buildInitialEnvelope,
  describeSubmissionFailure,
  signAccountAuthEntry,
  submitAndPoll,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";

/** How the guard's authorization is produced for a call that needs it. */
export interface GuardAuthorization {
  guard: string;
  agent: Keypair;
}

export type InvokeOutcome =
  | { kind: "allowed"; submission: SubmissionResult }
  | {
      kind: "blocked";
      /** Reason symbol from the contract's own event/topic vocabulary. */
      reason: string | null;
      detail: string;
      /** Diagnostic events emitted by the contract during enforced simulation. */
      diagnosticEvents: unknown[];
    }
  | { kind: "error"; detail: string };

export interface InvokeParams {
  server: rpc.Server;
  /** Classic account that pays the fee and supplies the sequence number. */
  source: Keypair;
  call: ContractCall;
  networkPassphrase: string;
  /** Present when the call requires the smart account's own authorization. */
  guardAuth?: GuardAuthorization | null;
  /** Extra classic-account authorizers available to sign (e.g. an admin). */
  accountSigners?: Keypair[];
  /** Skip broadcast even if the enforced simulation passes (dry run). */
  dryRun?: boolean;
}

/**
 * Topic symbols of a contract event, tolerating the several shapes RPC and the
 * SDK use for the same event: decoded `xdr.DiagnosticEvent` instances, bare
 * event objects, or base64 XDR strings in a JSON error payload.
 */
function topicSymbols(raw: unknown): string[] {
  const candidate = raw as {
    event?: { body?: unknown };
    body?: unknown;
  };
  const body = (candidate.event?.body ?? candidate.body) as
    | { v0?: { topics?: unknown[] }; value?: { v0?: { topics?: unknown[] } } }
    | undefined;
  const topics = body?.v0?.topics ?? body?.value?.v0?.topics;
  if (!Array.isArray(topics)) return [];
  return topics.flatMap((topic) => {
    try {
      if (typeof topic === "string") {
        return [String(scValToNative(xdr.ScVal.fromXDR(topic, "base64")))];
      }
      return [String(scValToNative(topic as xdr.ScVal))];
    } catch {
      return [];
    }
  });
}

/**
 * Extract the contract's own `auth_checked` reason from a simulation failure.
 *
 * The RPC error string is not the contract's reason vocabulary, but the
 * diagnostic events bundled with the failure are: the guard publishes
 * `topics = [auth_checked, blocked, <reason>]` on every decision, including the
 * decisions taken inside an enforced simulation.
 */
export function reasonFromDiagnosticEvents(events: unknown[]): string | null {
  for (const event of events) {
    const symbols = topicSymbols(event);
    if (symbols[0] === "auth_checked" && symbols[1] === "blocked" && symbols[2]) {
      return symbols[2];
    }
  }
  return null;
}

/**
 * Diagnostic events attached to a failed simulation, if the RPC supplied any.
 * Both the top-level `events` field and the nested error payload are checked:
 * which one carries them varies by failure kind.
 */
function diagnosticEventsOf(response: unknown): unknown[] {
  const candidate = response as {
    events?: unknown;
    error?: { data?: { events?: unknown } };
  };
  for (const value of [candidate.events, candidate.error?.data?.events]) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

/**
 * Run one contract call through simulate → sign → enforce, submitting only on a
 * pass. Returns a discriminated result rather than throwing, so callers can
 * decide whether a block is an expected outcome (agents hitting a guardrail) or
 * a failure worth surfacing.
 */
export async function invoke(params: InvokeParams): Promise<InvokeOutcome> {
  const { server, source, call, networkPassphrase } = params;
  const operation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
  });

  const sourceAccount = await server.getAccount(source.publicKey());
  const latest = await server.getLatestLedger();
  const expiration = latest.sequence + SIG_EXPIRATION_LEDGERS;
  // `TransactionBuilder` advances the sequence of the `Account` it is handed,
  // so every build in this function gets its own instance built from the same
  // base sequence. Sharing one would silently build the second transaction on
  // sequence N+2 and the network would reject it with `tx_bad_seq`.
  const nextSeq = sourceAccount.sequenceNumber();
  const freshAccount = () => new Account(source.publicKey(), nextSeq);

  // ── Step 1: discover required authorizations ──────────────────────────
  const probe = buildInitialEnvelope({
    source: freshAccount(),
    operation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const first = await server.simulateTransaction(probe);
  if (rpc.Api.isSimulationError(first)) {
    const error = first as rpc.Api.SimulateTransactionErrorResponse;
    return { kind: "error", detail: error.error ?? "initial simulation failed" };
  }
  const success = first as rpc.Api.SimulateTransactionSuccessResponse;
  const requiredAuth: xdr.SorobanAuthorizationEntry[] = success.result?.auth ?? [];

  // ── Step 2: sign every authorization the call requires ────────────────
  const signedAuth: xdr.SorobanAuthorizationEntry[] = [];
  for (const entry of requiredAuth) {
    const creds = entry.credentials;
    if (creds.type === "sorobanCredentialsSourceAccount") {
      // Nothing to sign: the transaction source's authorization is carried by
      // the envelope signature. The entry itself is NOT droppable, though — an
      // operation whose auth list is empty is treated as a recording-mode
      // request by the RPC (so `__check_auth` never runs and policy is never
      // enforced), and core then rejects the submitted transaction because no
      // authorization was actually provided.
      signedAuth.push(entry);
      continue;
    }
    if (creds.type !== "sorobanCredentialsAddress") {
      return {
        kind: "error",
        detail: `unsupported credential type in required authorization: ${creds.type}`,
      };
    }
    // Works for both account (G…) and contract (C…) authorizers; the guard's
    // address is a contract, which is exactly why the agent key — not the
    // transaction source — has to produce this signature.
    const address = Address.fromScAddress(creds.address.address).toString();

    if (params.guardAuth && address === params.guardAuth.guard) {
      // The smart account authorizes: sign with the registered agent key over
      // the guard's own preimage (fresh nonce per transaction).
      signedAuth.push(
        buildGuardAuthEntry({
          guard: params.guardAuth.guard,
          call,
          agent: params.guardAuth.agent,
          // The transaction's own sequence number doubles as the nonce: unique
          // per transaction and never reused, so the host can never see a
          // replay for this guard address.
          nonce: BigInt(nextSeq),
          signatureExpirationLedger: expiration,
          networkPassphrase,
        }),
      );
      continue;
    }

    const signer = (params.accountSigners ?? []).find((kp) => kp.publicKey() === address);
    if (!signer) {
      return {
        kind: "error",
        detail:
          `call requires authorization from ${address}, but no matching key was provided ` +
          `(supplied: ${(params.accountSigners ?? []).map((kp) => kp.publicKey()).join(", ") || "none"})`,
      };
    }
    signedAuth.push(
      await signAccountAuthEntry({
        entry,
        signer,
        signatureExpirationLedger: expiration,
        networkPassphrase,
      }),
    );
  }

  // ── Step 3: enforced simulation — this is where policy is applied ─────
  const signedOperation = Operation.invokeContractFunction({
    contract: call.contract,
    function: call.fn,
    args: call.args,
    auth: signedAuth,
  });
  const enforcingTx = buildInitialEnvelope({
    source: freshAccount(),
    operation: signedOperation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });
  const enforced = await server.simulateTransaction(enforcingTx);
  if (rpc.Api.isSimulationError(enforced)) {
    const error = enforced as rpc.Api.SimulateTransactionErrorResponse;
    const events = diagnosticEventsOf(error);
    return {
      kind: "blocked",
      reason: reasonFromDiagnosticEvents(events),
      detail: typeof error.error === "string" ? error.error : JSON.stringify(error.error),
      diagnosticEvents: events,
    };
  }

  if (params.dryRun) {
    return {
      kind: "error",
      detail: "dry run: enforced simulation passed; submission skipped as requested",
    };
  }

  // ── Step 4: assemble real resources, sign the envelope, broadcast ─────
  const assembled = assembleFromSimulation({
    simulation: enforced as rpc.Api.SimulateTransactionSuccessResponse,
    source: freshAccount(),
    operation: signedOperation,
    networkPassphrase,
    guard: params.guardAuth?.guard ?? null,
  });

  const submission = await submitAndPoll(server, assembled.transaction, [source]);
  if (submission.failure) {
    // A post-broadcast rejection is a hard error, not a policy block: the
    // enforced simulation already passed, so anything here is a defect in
    // construction (sequence, fee, footprint) or a contract trap — never a
    // guardrail doing its job.
    return {
      kind: "error",
      detail: `tx ${submission.hash} ${describeSubmissionFailure(submission.failure)}`,
    };
  }
  return { kind: "allowed", submission };
}
