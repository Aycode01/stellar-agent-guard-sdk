/**
 * Unit tests for the guard event vocabulary.
 *
 * These pin the schema verified against the live chain in `docs/event-schema.md`
 * — in particular the `event_` prefix that the documentation omits, and the
 * empty-symbol reason on an allowed decision. Both were real defects, so they get
 * a regression test rather than a comment.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GUARD_AUTH_RESULTS, GUARD_EVENT_TOPICS, decodeAuthDecision } from "../../src/events.ts";

describe("guard event topics", () => {
  it("carries the event_ prefix the #[contractevent] macro adds", () => {
    assert.deepEqual(GUARD_EVENT_TOPICS, {
      authChecked: "event_auth_checked",
      heartbeat: "event_heartbeat",
      initialized: "event_initialized",
      frozen: "event_frozen",
      unfrozen: "event_unfrozen",
      policySet: "event_policy_set",
      policyRevoked: "event_policy_revoked",
    });
  });

  it("does not use the un-prefixed name the contracts SPEC documents", () => {
    assert.notEqual(GUARD_EVENT_TOPICS.authChecked, "auth_checked");
  });
});

describe("decodeAuthDecision", () => {
  it("decodes the captured allowed event", () => {
    // Verbatim from the live capture: allowed carries an empty reason symbol.
    const decision = decodeAuthDecision(["event_auth_checked", "allowed", ""], "ledger");
    assert.deepEqual(decision, { result: "allowed", reason: null, source: "ledger" });
  });

  it("decodes the captured blocked event", () => {
    const decision = decodeAuthDecision(
      ["event_auth_checked", "blocked", "per_tx_cap_exceeded"],
      "diagnostic",
    );
    assert.deepEqual(decision, {
      result: "blocked",
      reason: "per_tx_cap_exceeded",
      source: "diagnostic",
    });
  });

  it("normalises the empty reason symbol to null, never an empty string", () => {
    const decision = decodeAuthDecision(["event_auth_checked", "allowed", ""], "ledger");
    assert.equal(decision?.reason, null);
  });

  it("rejects the un-prefixed topic so docs drift cannot pass silently", () => {
    assert.equal(decodeAuthDecision(["auth_checked", "blocked", "paused"], "diagnostic"), null);
  });

  it("ignores a heartbeat, which is a separate event", () => {
    assert.equal(decodeAuthDecision(["event_heartbeat"], "ledger"), null);
  });

  it("ignores an empty topic list", () => {
    assert.equal(decodeAuthDecision([], "ledger"), null);
  });

  it("rejects an unknown result symbol", () => {
    assert.equal(decodeAuthDecision(["event_auth_checked", "maybe", "x"], "ledger"), null);
  });

  it("exposes the result vocabulary it matches on", () => {
    assert.deepEqual(GUARD_AUTH_RESULTS, { allowed: "allowed", blocked: "blocked" });
  });
});
