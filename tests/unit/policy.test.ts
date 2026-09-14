/**
 * Unit tests for the policy model.
 *
 * The encoding tests matter more than they look: an unsorted `ScMap` is rejected
 * by the host at struct-conversion time, so a policy that encodes "successfully"
 * here but is not sorted would fail on-chain with an opaque object error. That is
 * a real bug this suite has already caused once.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  decodeCheckResult,
  deadManRemaining,
  describePolicy,
  isDeadManFrozen,
  policyToScVal,
  type GuardStatus,
  type PolicyConfig,
} from "../../src/policy.ts";

const TOKEN = "CDCYDGBGS5AZ5BZS6XY2SK2PHJHSOEGTN3N4INCK34KF6GU2BGC7Z6MB";
const GUARD = "CAPADGEK457RHKN4RYVUMDJTFHDSG7R5HREQONKLYK7MFKC5WFENPP44";
const RECIPIENT = "GAOBCRXTCO4ZCBNHALJUMJJ5JDXNOUZ7U6VZJX4UBTXAHQEO66IPU6PH";

function samplePolicy(overrides: Partial<PolicyConfig> = {}): PolicyConfig {
  return {
    per_tx_cap: 1000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [TOKEN],
    protocols: [],
    recipients: [RECIPIENT],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    dms_grace_secs: 0n,
    ...overrides,
  };
}

/**
 * Keys of an `ScVal::Map`, decoded to strings, in encoded order.
 *
 * In this SDK's XDR layer the union payloads are plain properties (`map`, `key`,
 * `val`), not the `map()`/`key()` accessors older stellar-base releases used —
 * reading them as methods throws rather than failing an assertion.
 */
function encodedKeys(val: xdr.ScVal): string[] {
  const entries = (val as unknown as { map?: Array<{ key: xdr.ScVal }> }).map ?? [];
  return entries.map((entry) => String(scValToNative(entry.key)));
}

describe("policyToScVal", () => {
  it("emits a map with sorted keys, as the host requires for struct conversion", () => {
    const keys = encodedKeys(policyToScVal(samplePolicy()));
    assert.deepEqual(keys, [...keys].sort());
    assert.deepEqual(keys, [
      "active_from",
      "active_until",
      "allow_any_recipient",
      "assets",
      "dms_grace_secs",
      "paused",
      "per_tx_cap",
      "protocols",
      "recipients",
      "window_cap",
      "window_secs",
    ]);
  });

  it("sorts the nested protocol rule maps too", () => {
    const val = policyToScVal(
      samplePolicy({ protocols: [{ contract: TOKEN, fns: ["transfer", "approve"] }] }),
    ) as unknown as { map: Array<{ key: xdr.ScVal; val: xdr.ScVal }> };
    const protocols = val.map.find((entry) => String(scValToNative(entry.key)) === "protocols")!;
    const ruleVec = (protocols.val as unknown as { vec: xdr.ScVal[] }).vec;
    assert.deepEqual(encodedKeys(ruleVec[0]!), ["contract", "fns"]);
  });

  it("round-trips through scValToNative without losing cap precision", () => {
    const policy = samplePolicy({
      per_tx_cap: 9_007_199_254_740_993n, // beyond Number.MAX_SAFE_INTEGER
      window_cap: 12_345_678_901_234_567_890n,
    });
    const decoded = scValToNative(policyToScVal(policy)) as Record<string, unknown>;
    assert.equal(decoded["per_tx_cap"], 9_007_199_254_740_993n);
    assert.equal(decoded["window_cap"], 12_345_678_901_234_567_890n);
  });

  it("round-trips addresses as strkeys, not raw bytes", () => {
    const decoded = scValToNative(policyToScVal(samplePolicy())) as Record<string, unknown>;
    assert.deepEqual(decoded["assets"], [TOKEN]);
    assert.deepEqual(decoded["recipients"], [RECIPIENT]);
  });

  it("round-trips a null function list as void (any function allowed)", () => {
    const decoded = scValToNative(
      policyToScVal(samplePolicy({ protocols: [{ contract: TOKEN, fns: null }] })),
    ) as { protocols: Array<{ fns: unknown }> };
    assert.equal(decoded.protocols[0]!.fns, null);
  });

  it("rejects a malformed address rather than emitting a broken policy", () => {
    assert.throws(() => policyToScVal(samplePolicy({ recipients: ["not-an-address"] })));
  });
});

describe("decodeCheckResult", () => {
  it("decodes the Allowed unit variant", () => {
    assert.deepEqual(decodeCheckResult("Allowed"), { kind: "allowed" });
  });

  it("decodes a Blocked variant to its reason symbol", () => {
    assert.deepEqual(decodeCheckResult({ Blocked: "recipient_not_allowed" }), {
      kind: "blocked",
      reason: "recipient_not_allowed",
    });
  });

  it("throws on an unexpected payload instead of guessing", () => {
    assert.throws(() => decodeCheckResult({ SomethingElse: 1 }), /unexpected CheckResult/);
  });
});

describe("dead-man switch helpers", () => {
  const status = (overrides: Partial<GuardStatus> = {}): GuardStatus => ({
    has_policy: true,
    admin_frozen: false,
    heartbeat_expired: false,
    last_heartbeat: 1000n,
    now: 1010n,
    ...overrides,
  });

  it("counts a silent freeze as the dead-man switch firing", () => {
    assert.equal(isDeadManFrozen(status({ heartbeat_expired: true })), true);
  });

  it("does not count an admin freeze as the dead-man switch", () => {
    assert.equal(isDeadManFrozen(status({ heartbeat_expired: true, admin_frozen: true })), false);
  });

  it("reports negative remaining time once the switch has fired", () => {
    assert.equal(deadManRemaining(status(), samplePolicy({ dms_grace_secs: 5n })), -5n);
  });

  it("reports positive remaining time while still inside grace", () => {
    assert.equal(deadManRemaining(status({ now: 1002n }), samplePolicy({ dms_grace_secs: 5n })), 3n);
  });

  it("reports null when the switch is disabled", () => {
    assert.equal(deadManRemaining(status(), samplePolicy({ dms_grace_secs: 0n })), null);
  });

  it("reports null when there is no policy to read a grace window from", () => {
    assert.equal(deadManRemaining(status(), null), null);
  });
});

describe("describePolicy", () => {
  it("states default-deny when no policy is installed", () => {
    assert.match(describePolicy(null), /default-deny/);
  });

  it("summarises the caps, recipients and pause state", () => {
    const text = describePolicy(samplePolicy());
    assert.match(text, /per-tx cap 1000/);
    assert.match(text, /rolling window 150 \/ 60s/);
    assert.match(text, /1 allowlisted recipient/);
    assert.match(text, /active/);
  });

  it("does not claim a recipient allowlist when any recipient is allowed", () => {
    const text = describePolicy(samplePolicy({ allow_any_recipient: true }));
    assert.match(text, /any recipient/);
  });

  it("flags a paused policy", () => {
    assert.match(describePolicy(samplePolicy({ paused: true })), /PAUSED/);
  });

  it("keeps the guard address out of the policy it describes", () => {
    // A guard address in `assets` is rejected on-chain (validate_config); this
    // documents that the summary reflects the real policy, not a placeholder.
    assert.ok(!describePolicy(samplePolicy()).includes(GUARD));
  });
});

describe("address decoding", () => {
  it("round-trips a contract address through Address", () => {
    assert.equal(new Address(TOKEN).toString(), TOKEN);
  });
});
