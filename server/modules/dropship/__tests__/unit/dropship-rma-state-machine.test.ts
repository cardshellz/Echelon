import { describe, expect, it } from "vitest";
import {
  DROPSHIP_RMA_DEFAULT_NO_SHIP_TIMEOUT_DAYS,
  DROPSHIP_RMA_STATUSES,
  DROPSHIP_RMA_TRANSITIONS,
  evaluateDropshipRmaTransition,
  isDropshipRmaNoShipTimedOut,
  isDropshipRmaTransitionLegal,
  type DropshipRmaMachineStatus,
} from "../../domain/rma-state-machine";

const ADMIN = { actorType: "admin" as const, actorId: "admin-1" };
const SYSTEM = { actorType: "system" as const, actorId: null };

/**
 * Full D4 transition matrix. Every legal transition must pass; every illegal
 * transition must be rejected. Enumerated exhaustively so a regression in the
 * map fails loudly.
 */
const LEGAL_TRANSITIONS: readonly [DropshipRmaMachineStatus, DropshipRmaMachineStatus][] = [
  ["requested", "in_transit"],
  ["requested", "no_inspection_review"],
  ["requested", "closed"],
  ["in_transit", "received"],
  ["in_transit", "no_inspection_review"],
  ["received", "inspecting"],
  ["inspecting", "approved"],
  ["inspecting", "rejected"],
  ["approved", "credited"],
  ["rejected", "disputed"],
  ["rejected", "closed"],
  ["disputed", "credited"],
  ["disputed", "closed"],
  ["no_inspection_review", "credited"],
  ["no_inspection_review", "closed"],
  ["credited", "closed"],
];

describe("dropship RMA state machine (D4)", () => {
  it("covers all 10 statuses in the transition map", () => {
    expect(Object.keys(DROPSHIP_RMA_TRANSITIONS).sort()).toEqual([...DROPSHIP_RMA_STATUSES].sort());
    expect(DROPSHIP_RMA_STATUSES).toHaveLength(10);
  });

  it.each(LEGAL_TRANSITIONS.map(([from, to]) => ({ from, to })))(
    "allows $from -> $to",
    ({ from, to }) => {
      expect(isDropshipRmaTransitionLegal(from, to)).toBe(true);
    },
  );

  it("rejects every illegal transition in the full matrix", () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([from, to]) => `${from}->${to}`));
    const illegal: string[] = [];
    for (const from of DROPSHIP_RMA_STATUSES) {
      for (const to of DROPSHIP_RMA_STATUSES) {
        if (legal.has(`${from}->${to}`)) continue;
        illegal.push(`${from}->${to}`);
        expect(isDropshipRmaTransitionLegal(from, to)).toBe(false);
        const decision = evaluateDropshipRmaTransition({
          from,
          to,
          actor: ADMIN,
          reason: "attempt",
          systemLedgerCommit: false,
        });
        expect(decision.allowed).toBe(false);
        expect(decision.violation).toBe("illegal_transition");
      }
    }
    // 10x10 matrix minus the 16 legal transitions = 84 illegal ones.
    expect(illegal).toHaveLength(84);
  });

  it("rejects backward transitions explicitly (no corrections via rewind)", () => {
    for (const [from, to] of [
      ["in_transit", "requested"],
      ["received", "in_transit"],
      ["inspecting", "received"],
      ["approved", "inspecting"],
      ["credited", "approved"],
      ["closed", "credited"],
      ["disputed", "rejected"],
    ] as const) {
      expect(isDropshipRmaTransitionLegal(from, to)).toBe(false);
    }
  });

  it("allows admin transitions on the legal non-credited paths", () => {
    for (const [from, to] of LEGAL_TRANSITIONS) {
      if (to === "credited") continue;
      const needsReason =
        (from === "inspecting" && to === "rejected")
        || (from === "no_inspection_review" && to === "closed")
        || (from === "disputed" && to === "closed");
      const decision = evaluateDropshipRmaTransition({
        from,
        to,
        actor: ADMIN,
        reason: needsReason ? "ops decision" : null,
        systemLedgerCommit: false,
      });
      expect(decision.allowed).toBe(true);
      expect(decision.violation).toBeNull();
    }
  });

  it("reserves credited for the system post-ledger path", () => {
    for (const from of ["approved", "disputed", "no_inspection_review"] as const) {
      const adminAttempt = evaluateDropshipRmaTransition({
        from,
        to: "credited",
        actor: ADMIN,
        reason: "manual credit",
        systemLedgerCommit: false,
      });
      expect(adminAttempt.allowed).toBe(false);
      expect(adminAttempt.violation).toBe("credited_requires_system_ledger");

      const systemWithoutLedger = evaluateDropshipRmaTransition({
        from,
        to: "credited",
        actor: SYSTEM,
        reason: null,
        systemLedgerCommit: false,
      });
      expect(systemWithoutLedger.allowed).toBe(false);
      expect(systemWithoutLedger.violation).toBe("credited_requires_system_ledger");

      const systemPostLedger = evaluateDropshipRmaTransition({
        from,
        to: "credited",
        actor: SYSTEM,
        reason: null,
        systemLedgerCommit: true,
      });
      expect(systemPostLedger.allowed).toBe(true);
    }
  });

  it("requires reason + actor for inspecting -> rejected", () => {
    const noReason = evaluateDropshipRmaTransition({
      from: "inspecting",
      to: "rejected",
      actor: ADMIN,
      reason: null,
      systemLedgerCommit: false,
    });
    expect(noReason).toEqual({ allowed: false, violation: "reason_required" });

    const blankReason = evaluateDropshipRmaTransition({
      from: "inspecting",
      to: "rejected",
      actor: ADMIN,
      reason: "   ",
      systemLedgerCommit: false,
    });
    expect(blankReason).toEqual({ allowed: false, violation: "reason_required" });

    const noActor = evaluateDropshipRmaTransition({
      from: "inspecting",
      to: "rejected",
      actor: { actorType: "admin", actorId: null },
      reason: "damaged beyond resale",
      systemLedgerCommit: false,
    });
    expect(noActor).toEqual({ allowed: false, violation: "actor_required" });
  });

  it("requires reason + actor for no_inspection_review -> closed (denial)", () => {
    const noReason = evaluateDropshipRmaTransition({
      from: "no_inspection_review",
      to: "closed",
      actor: ADMIN,
      reason: null,
      systemLedgerCommit: false,
    });
    expect(noReason).toEqual({ allowed: false, violation: "reason_required" });

    const ok = evaluateDropshipRmaTransition({
      from: "no_inspection_review",
      to: "closed",
      actor: ADMIN,
      reason: "claim denied: tracking shows delivered",
      systemLedgerCommit: false,
    });
    expect(ok.allowed).toBe(true);
  });

  it("requires reason + actor for disputed -> closed", () => {
    const noReason = evaluateDropshipRmaTransition({
      from: "disputed",
      to: "closed",
      actor: ADMIN,
      reason: "",
      systemLedgerCommit: false,
    });
    expect(noReason).toEqual({ allowed: false, violation: "reason_required" });

    const ok = evaluateDropshipRmaTransition({
      from: "disputed",
      to: "closed",
      actor: ADMIN,
      reason: "dispute resolved: vendor at fault, item disposed",
      systemLedgerCommit: false,
    });
    expect(ok.allowed).toBe(true);
  });

  it("does not require a reason for rejected -> closed (disposition path)", () => {
    const decision = evaluateDropshipRmaTransition({
      from: "rejected",
      to: "closed",
      actor: ADMIN,
      reason: null,
      systemLedgerCommit: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("computes the no-ship timeout against the policy window", () => {
    const requestedAt = new Date("2026-08-01T00:00:00.000Z");
    const beforeTimeout = new Date("2026-08-14T23:59:59.999Z");
    const atTimeout = new Date("2026-08-15T00:00:00.000Z");
    expect(isDropshipRmaNoShipTimedOut({
      requestedAt,
      now: beforeTimeout,
      noShipTimeoutDays: DROPSHIP_RMA_DEFAULT_NO_SHIP_TIMEOUT_DAYS,
    })).toBe(false);
    expect(isDropshipRmaNoShipTimedOut({
      requestedAt,
      now: atTimeout,
      noShipTimeoutDays: DROPSHIP_RMA_DEFAULT_NO_SHIP_TIMEOUT_DAYS,
    })).toBe(true);
    expect(isDropshipRmaNoShipTimedOut({
      requestedAt,
      now: new Date("2026-08-08T00:00:00.000Z"),
      noShipTimeoutDays: 7,
    })).toBe(true);
    expect(DROPSHIP_RMA_DEFAULT_NO_SHIP_TIMEOUT_DAYS).toBe(14);
  });
});
