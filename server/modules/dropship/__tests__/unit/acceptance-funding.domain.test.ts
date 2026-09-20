import { describe, expect, it } from "vitest";
import {
  DROPSHIP_ACCEPTANCE_FUNDING_INVALID,
  assessAdvanceStanding,
  calculateAdvanceFeeCents,
  decideAcceptanceFunding,
  decideCardBackstopCharge,
  type DropshipAdvanceContext,
  type DropshipAdvancePolicy,
  type DropshipAdvanceSource,
} from "../../domain/acceptance-funding";
import { DropshipError } from "../../domain/errors";

const POLICY: DropshipAdvancePolicy = { feeBps: 100, capCents: 50_000, capSource: "policy" };

function source(overrides: Partial<DropshipAdvanceSource> = {}): DropshipAdvanceSource {
  return {
    fundingMethodId: 7,
    pendingCents: 40_000,
    accountHolderType: "company",
    balanceVerified: true,
    priorPullSettled: true,
    ...overrides,
  };
}

function context(sources: DropshipAdvanceSource[] = [source()], policy: DropshipAdvancePolicy = POLICY): DropshipAdvanceContext {
  return { policy, sources };
}

describe("calculateAdvanceFeeCents", () => {
  it("rounds half up at the sub-cent boundary and is zero at a zero rate", () => {
    expect(calculateAdvanceFeeCents(30_000, 100)).toBe(300);
    expect(calculateAdvanceFeeCents(1_234, 100)).toBe(12); // 12.34
    expect(calculateAdvanceFeeCents(1_250, 100)).toBe(13); // 12.50 rounds up
    expect(calculateAdvanceFeeCents(30_000, 0)).toBe(0);
    expect(calculateAdvanceFeeCents(0, 100)).toBe(0);
  });

  it("refuses non-integer money and rates outside 0..10000 bps", () => {
    for (const [amount, bps] of [[12.5, 100], [-1, 100], [100, -1], [100, 10_001], [100, 1.5]] as const) {
      expect(() => calculateAdvanceFeeCents(amount, bps)).toThrowError(DropshipError);
    }
  });
});

describe("assessAdvanceStanding", () => {
  it("counts only eligible accounts and caps the allowance by the policy", () => {
    const standing = assessAdvanceStanding({
      availableBalanceCents: 1_000,
      context: context([
        source({ fundingMethodId: 1, pendingCents: 40_000 }),
        source({ fundingMethodId: 2, pendingCents: 30_000, accountHolderType: "individual" }),
        source({ fundingMethodId: 3, pendingCents: 20_000 }),
      ]),
    });
    expect(standing.eligiblePendingCents).toBe(60_000);
    expect(standing.allowanceCents).toBe(50_000);
    expect(standing.exposureCents).toBe(0);
    expect(standing.headroomCents).toBe(50_000);
    expect(standing.reasons).toEqual([]);
    expect(standing.sources.map((entry) => [entry.fundingMethodId, entry.eligible, entry.reasons])).toEqual([
      [1, true, []],
      [2, false, ["account_holder_not_company"]],
      [3, true, []],
    ]);
  });

  it("reports exposure and remaining headroom when the balance is already negative", () => {
    const standing = assessAdvanceStanding({ availableBalanceCents: -30_300, context: context() });
    expect(standing.exposureCents).toBe(30_300);
    expect(standing.allowanceCents).toBe(40_000);
    expect(standing.headroomCents).toBe(9_700);
  });

  it("names every missing fact when no account qualifies, in a fixed order", () => {
    const standing = assessAdvanceStanding({
      availableBalanceCents: 0,
      context: context([
        source({ fundingMethodId: 1, pendingCents: 0, balanceVerified: false }),
        source({ fundingMethodId: 2, accountHolderType: null, priorPullSettled: false }),
      ]),
    });
    expect(standing.eligiblePendingCents).toBe(0);
    expect(standing.reasons).toEqual([
      "no_pending_credit",
      "account_holder_not_company",
      "bank_balance_not_verified",
      "first_pull_not_settled",
    ]);
  });

  it("says when there is no bank account at all, and when the cap is zero", () => {
    expect(assessAdvanceStanding({ availableBalanceCents: 0, context: context([]) }).reasons).toEqual(["no_bank_account"]);
    const capped = assessAdvanceStanding({
      availableBalanceCents: 0,
      context: context([source()], { feeBps: 100, capCents: 0, capSource: "vendor_override" }),
    });
    expect(capped.allowanceCents).toBe(0);
    expect(capped.reasons).toEqual(["advance_cap_zero"]);
    expect(capped.policy.capSource).toBe("vendor_override");
  });

  it("fails closed on malformed stored values", () => {
    const bad = [
      () => assessAdvanceStanding({ availableBalanceCents: 1.5, context: context() }),
      () => assessAdvanceStanding({ availableBalanceCents: 0, context: context([source({ pendingCents: -1 })]) }),
      () => assessAdvanceStanding({ availableBalanceCents: 0, context: context([source({ fundingMethodId: 0 })]) }),
      () => assessAdvanceStanding({ availableBalanceCents: 0, context: context([source()], { ...POLICY, feeBps: 10_001 }) }),
      () => assessAdvanceStanding({ availableBalanceCents: 0, context: context([source()], { ...POLICY, capCents: -5 }) }),
      () => assessAdvanceStanding({ availableBalanceCents: 0, context: context([source()], { ...POLICY, capSource: "other" as never }) }),
    ];
    for (const run of bad) {
      expect(run).toThrowError(expect.objectContaining({ code: DROPSHIP_ACCEPTANCE_FUNDING_INVALID }));
    }
  });
});

describe("decideAcceptanceFunding", () => {
  it("pays from the available balance when it covers the debit exactly, without touching the advance", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 4_000,
      totalDebitCents: 4_000,
      standingHold: false,
      advance: null,
    });
    expect(decision).toEqual({ outcome: "accepted", source: "available", advance: null });
  });

  it("holds a vendor paused for funding whatever the balance", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 100_000,
      totalDebitCents: 4_000,
      standingHold: true,
      advance: context(),
    });
    expect(decision).toEqual({ outcome: "payment_hold", reason: "vendor_paused", advance: null, shortfall: null });
  });

  it("advances the gap against eligible pending credit and posts the fee on the amount used", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 10_000,
      totalDebitCents: 40_000,
      standingHold: false,
      advance: context([source({ fundingMethodId: 9, pendingCents: 50_000 }), source({ fundingMethodId: 4, pendingCents: 5_000 })]),
    });
    expect(decision).toEqual({
      outcome: "accepted",
      source: "advance",
      advance: {
        advanceCents: 30_000,
        feeCents: 300,
        feeBps: 100,
        capCents: 50_000,
        capSource: "policy",
        eligiblePendingCents: 55_000,
        exposureBeforeCents: 0,
        exposureAfterCents: 30_300,
        fundingMethodIds: [4, 9],
      },
    });
  });

  it("advances the whole debit when the balance is already negative, within the allowance", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: -5_000,
      totalDebitCents: 20_000,
      standingHold: false,
      advance: context([source({ pendingCents: 60_000 })]),
    });
    expect(decision.outcome).toBe("accepted");
    if (decision.outcome !== "accepted" || decision.source !== "advance") throw new Error("expected an advance");
    expect(decision.advance.advanceCents).toBe(20_000);
    expect(decision.advance.feeCents).toBe(200);
    expect(decision.advance.exposureBeforeCents).toBe(5_000);
    expect(decision.advance.exposureAfterCents).toBe(25_200);
  });

  it("holds when the gap plus its fee would exceed the allowance, and says by how much", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 0,
      totalDebitCents: 50_000,
      standingHold: false,
      advance: context([source({ pendingCents: 50_000 })]),
    });
    expect(decision).toEqual({
      outcome: "payment_hold",
      reason: "insufficient_balance",
      advance: null,
      shortfall: {
        gapCents: 50_000,
        advanceRefusal: {
          code: "exceeds_allowance",
          requiredExposureCents: 50_500,
          allowanceCents: 50_000,
          eligiblePendingCents: 50_000,
          capCents: 50_000,
        },
      },
    });
  });

  it("holds under the vendor's own cap when one is set, even with more pending", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 0,
      totalDebitCents: 30_000,
      standingHold: false,
      advance: context([source({ pendingCents: 90_000 })], { feeBps: 100, capCents: 20_000, capSource: "vendor_override" }),
    });
    expect(decision.outcome).toBe("payment_hold");
    if (decision.outcome !== "payment_hold") throw new Error("expected a hold");
    expect(decision.shortfall?.advanceRefusal).toMatchObject({ code: "exceeds_allowance", capCents: 20_000, allowanceCents: 20_000 });
  });

  it("holds with the reasons when no account qualifies, and when the facts could not be read", () => {
    const noSource = decideAcceptanceFunding({
      availableBalanceCents: 0,
      totalDebitCents: 1_000,
      standingHold: false,
      advance: context([source({ priorPullSettled: false })]),
    });
    expect(noSource).toMatchObject({
      outcome: "payment_hold",
      reason: "insufficient_balance",
      shortfall: { gapCents: 1_000, advanceRefusal: { code: "no_eligible_source", reasons: ["first_pull_not_settled"] } },
    });
    const unreadable = decideAcceptanceFunding({
      availableBalanceCents: 0,
      totalDebitCents: 1_000,
      standingHold: false,
      advance: null,
    });
    expect(unreadable).toMatchObject({ outcome: "payment_hold", shortfall: { advanceRefusal: { code: "advance_unavailable" } } });
  });

  it("charges no fee at a zero rate but still records the advance", () => {
    const decision = decideAcceptanceFunding({
      availableBalanceCents: 0,
      totalDebitCents: 1_000,
      standingHold: false,
      advance: context([source()], { ...POLICY, feeBps: 0 }),
    });
    expect(decision).toMatchObject({ outcome: "accepted", source: "advance", advance: { advanceCents: 1_000, feeCents: 0, exposureAfterCents: 1_000 } });
  });

  it("refuses a non-positive or non-integer debit", () => {
    for (const totalDebitCents of [0, -1, 10.5]) {
      expect(() => decideAcceptanceFunding({ availableBalanceCents: 0, totalDebitCents, standingHold: false, advance: null }))
        .toThrowError(expect.objectContaining({ code: DROPSHIP_ACCEPTANCE_FUNDING_INVALID }));
    }
  });
});

describe("decideCardBackstopCharge", () => {
  it("does nothing when the balance already covers the order", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: 5_000, minimumBalanceCents: 10_000, requiredBalanceCents: 5_000, singleChargeLimitCents: 10_000 }))
      .toEqual({ outcome: "not_needed" });
  });

  it("charges back to the minimum when the limit allows it", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: 2_000, minimumBalanceCents: 10_000, requiredBalanceCents: 5_000, singleChargeLimitCents: 20_000 }))
      .toEqual({ outcome: "charge", amountCents: 8_000, gapCents: 3_000, backToMinimumCents: 8_000 });
  });

  it("charges the limit when it sits between the gap and back-to-minimum, instead of skipping", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: 2_000, minimumBalanceCents: 10_000, requiredBalanceCents: 5_000, singleChargeLimitCents: 4_000 }))
      .toEqual({ outcome: "charge", amountCents: 4_000, gapCents: 3_000, backToMinimumCents: 8_000 });
  });

  it("charges the whole order gap when the order is larger than the minimum", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: 1_000, minimumBalanceCents: 10_000, requiredBalanceCents: 25_000, singleChargeLimitCents: 30_000 }))
      .toEqual({ outcome: "charge", amountCents: 24_000, gapCents: 24_000, backToMinimumCents: 24_000 });
  });

  it("refuses when even the limit cannot cover the gap", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: 1_000, minimumBalanceCents: 10_000, requiredBalanceCents: 25_000, singleChargeLimitCents: 20_000 }))
      .toEqual({ outcome: "limit_below_gap", gapCents: 24_000, limitCents: 20_000 });
  });

  it("counts a negative balance in the gap and charges back to minimum without a limit", () => {
    expect(decideCardBackstopCharge({ availableBalanceCents: -30_300, minimumBalanceCents: 10_000, requiredBalanceCents: 40_000, singleChargeLimitCents: null }))
      .toEqual({ outcome: "charge", amountCents: 70_300, gapCents: 70_300, backToMinimumCents: 70_300 });
  });

  it("refuses negative minimums, requirements or limits", () => {
    expect(() => decideCardBackstopCharge({ availableBalanceCents: 0, minimumBalanceCents: -1, requiredBalanceCents: 1, singleChargeLimitCents: null })).toThrowError(DropshipError);
    expect(() => decideCardBackstopCharge({ availableBalanceCents: 0, minimumBalanceCents: 1, requiredBalanceCents: 1, singleChargeLimitCents: -1 })).toThrowError(DropshipError);
  });
});
