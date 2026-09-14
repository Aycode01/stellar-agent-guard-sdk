/**
 * stellar-agent-guard-sdk — the public surface.
 *
 * An integration bridge between AI agent frameworks and `stellar-agent-guard`
 * smart accounts: pre-flight policy interception, agent-auth transaction
 * signing, and on-chain event telemetry.
 *
 * **Enforcement scope, stated where the capability is claimed:** full
 * recipient/amount enforcement — spend caps, allowlists, per-transaction limits
 * — is automatic for SAC token transfers (`transfer`/`transfer_from`), because
 * those are the calls whose arguments the Soroban auth context exposes for
 * inspection. For other Soroban contract calls the guarded account makes
 * (arbitrary DEX/lending/protocol calls), the policy engine still enforces
 * window and pause state, but per-call amount/recipient limits are not enforced;
 * extending fine-grained enforcement to arbitrary calls is tracked as a v2 item,
 * not implied as already covered.
 */
export {
  GuardBlockedError,
  ACCOUNT_STATE_REASONS,
  GUARD_REASON_CODES,
  explainReason,
  reasonName,
  reasonNameFromCode,
  type GuardReasonName,
} from "./reasons.ts";

export {
  decodeCheckResult,
  deadManRemaining,
  describePolicy,
  isDeadManFrozen,
  policyToScVal,
  type CheckResult,
  type GuardStatus,
  type PolicyConfig,
  type ProtocolRule,
} from "./policy.ts";

export {
  decodeAuthDecision,
  GUARD_AUTH_RESULTS,
  GUARD_EVENT_TOPICS,
  type GuardAuthDecision,
  type GuardAuthResult,
} from "./events.ts";

export {
  enforceCall,
  invoke,
  topicSymbols,
  type EnforcementOutcome,
  type GuardAuthorization,
  type InvokeOutcome,
  type InvokeParams,
} from "./invoke.ts";

export {
  PreFlightInterceptor,
  PreFlightUndeterminedError,
  preflight,
  type PreFlightConfig,
  type PreFlightDecision,
} from "./preflight.ts";

export {
  GuardTelemetryListener,
  describeGuardEvent,
  guardEventsFromDiagnostics,
  isAllowedDecision,
  telemetryFromDecision,
  type GuardEvent,
  type GuardEventKind,
  type GuardTelemetryConfig,
} from "./telemetry.ts";

export {
  GUARD_STORAGE_KEYS,
  isStaleLedgerResourceFailure,
  type ContractCall,
  type SubmissionResult,
} from "./tx.ts";
