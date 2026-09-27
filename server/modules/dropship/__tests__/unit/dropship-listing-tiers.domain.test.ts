import { describe, expect, it } from "vitest";
import {
  evaluateDropshipListingTierEligibility,
  heldListingTiersFor,
  listingTierForVariantUomType,
  listingTierHoldIdempotencyKeyFor,
  listingTierNotificationKeyFor,
  listingTiersAlreadyOn,
  parseCatalogVariantUomType,
  resolveEnforcedListingTierMinimums,
  type DropshipListingTier,
  type DropshipListingTierPolicyVersion,
} from "../../domain/listing-tiers";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-09-01T00:00:00.000Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function version(input: Partial<DropshipListingTierPolicyVersion> & { version: number; createdAt: Date }): DropshipListingTierPolicyVersion {
  return {
    packTierMinimumCents: 5_000,
    caseTierMinimumCents: 5_000,
    tierChangeGraceDays: 14,
    ...input,
  };
}

describe("listingTierForVariantUomType", () => {
  it("puts eaches, packs and inner packs in the pack tier and cases and skids in the case tier", () => {
    expect(listingTierForVariantUomType("piece")).toBe("pack");
    expect(listingTierForVariantUomType("each")).toBe("pack");
    expect(listingTierForVariantUomType("pack")).toBe("pack");
    expect(listingTierForVariantUomType("inner_pack")).toBe("pack");
    expect(listingTierForVariantUomType("case")).toBe("case");
    expect(listingTierForVariantUomType("skid")).toBe("case");
  });

  it("refuses an unknown unit of measure at the database boundary instead of guessing a tier", () => {
    expect(parseCatalogVariantUomType("case", { productVariantId: 7 })).toBe("case");
    for (const bad of ["carton", "", null, undefined, 3]) {
      expect(() => parseCatalogVariantUomType(bad, { productVariantId: 7 })).toThrow(
        expect.objectContaining({ code: "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID", context: { productVariantId: 7, uomType: bad } }),
      );
    }
  });
});

describe("resolveEnforcedListingTierMinimums", () => {
  it("enforces a single version from the moment it exists, with nothing upcoming", () => {
    const minimums = resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: T0 })], at(3));
    expect(minimums).toEqual({
      pack: { tier: "pack", minimumCents: 5_000, version: 1, policyMinimumCents: 5_000, upcoming: null },
      case: { tier: "case", minimumCents: 5_000, version: 1, policyMinimumCents: 5_000, upcoming: null },
    });
  });

  it("grandfathers a raise for the grace period of the version that raised it, then enforces it", () => {
    // The launch migration: v1 is the $50 seed, v2 publishes $100 / $500 with 14 days of grace.
    const history = [
      version({ version: 1, createdAt: T0 }),
      version({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
    ];
    const during = resolveEnforcedListingTierMinimums(history, at(20));
    // The published amount is what vendors are shown from the moment v2 exists.
    expect(during.pack).toEqual({
      tier: "pack", minimumCents: 5_000, version: 1, policyMinimumCents: 10_000,
      upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(24) },
    });
    expect(during.case).toEqual({
      tier: "case", minimumCents: 5_000, version: 1, policyMinimumCents: 50_000,
      upcoming: { minimumCents: 50_000, version: 2, enforcesAt: at(24) },
    });
    const boundary = resolveEnforcedListingTierMinimums(history, at(24));
    expect(boundary.pack).toEqual({ tier: "pack", minimumCents: 10_000, version: 2, policyMinimumCents: 10_000, upcoming: null });
    expect(boundary.case).toEqual({ tier: "case", minimumCents: 50_000, version: 2, policyMinimumCents: 50_000, upcoming: null });
  });

  it("applies a lowered minimum immediately and a kept one without grace, per tier", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
      // Pack lowered, case unchanged: both take effect at publish time.
      version({ version: 2, createdAt: at(5), packTierMinimumCents: 8_000, caseTierMinimumCents: 50_000 }),
    ];
    const minimums = resolveEnforcedListingTierMinimums(history, at(5));
    expect(minimums.pack).toEqual({ tier: "pack", minimumCents: 8_000, version: 2, policyMinimumCents: 8_000, upcoming: null });
    expect(minimums.case).toEqual({ tier: "case", minimumCents: 50_000, version: 2, policyMinimumCents: 50_000, upcoming: null });
  });

  it("lets a later lowering supersede a raise still in grace", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 4_000 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(6)).pack)
      .toEqual({ tier: "pack", minimumCents: 4_000, version: 3, policyMinimumCents: 4_000, upcoming: null });
    // v2's deadline passing changes nothing: v3 is the later word.
    expect(resolveEnforcedListingTierMinimums(history, at(30)).pack)
      .toEqual({ tier: "pack", minimumCents: 4_000, version: 3, policyMinimumCents: 4_000, upcoming: null });
  });

  it("stages two pending raises in the order they land, and reports the next one as upcoming", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000, tierChangeGraceDays: 14 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 15_000, tierChangeGraceDays: 14 }),
    ];
    // The policy amount is the latest version's throughout, never the one in force.
    expect(resolveEnforcedListingTierMinimums(history, at(10)).pack)
      .toEqual({ tier: "pack", minimumCents: 5_000, version: 1, policyMinimumCents: 15_000, upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(15) } });
    expect(resolveEnforcedListingTierMinimums(history, at(16)).pack)
      .toEqual({ tier: "pack", minimumCents: 10_000, version: 2, policyMinimumCents: 15_000, upcoming: { minimumCents: 15_000, version: 3, enforcesAt: at(19) } });
    expect(resolveEnforcedListingTierMinimums(history, at(19)).pack)
      .toEqual({ tier: "pack", minimumCents: 15_000, version: 3, policyMinimumCents: 15_000, upcoming: null });
  });

  it("names the later version as upcoming when a shorter grace makes it land before an earlier raise", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000, tierChangeGraceDays: 14 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 15_000, tierChangeGraceDays: 2 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(6)).pack)
      .toEqual({ tier: "pack", minimumCents: 5_000, version: 1, policyMinimumCents: 15_000, upcoming: { minimumCents: 15_000, version: 3, enforcesAt: at(7) } });
    // Once v3 is enforced, v2's later deadline is moot: v3 is the later word.
    expect(resolveEnforcedListingTierMinimums(history, at(8)).pack)
      .toEqual({ tier: "pack", minimumCents: 15_000, version: 3, policyMinimumCents: 15_000, upcoming: null });
  });

  it("orders versions by number whatever order they arrive in, and treats a clock before the first publish as version one", () => {
    const history = [
      version({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000 }),
      version({ version: 1, createdAt: T0 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(-1)).pack.version).toBe(1);
    expect(resolveEnforcedListingTierMinimums(history, at(24)).pack.version).toBe(2);
  });

  it("refuses an empty history, duplicate versions, non-integer money and an invalid clock", () => {
    expect(() => resolveEnforcedListingTierMinimums([], T0)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_POLICY_HISTORY_EMPTY" }));
    expect(() => resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: T0 }), version({ version: 1, createdAt: at(1) })], T0))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_POLICY_HISTORY_INVALID" }));
    expect(() => resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: T0, packTierMinimumCents: 10.5 })], T0))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_POLICY_HISTORY_INVALID" }));
    expect(() => resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: T0, tierChangeGraceDays: -1 })], T0))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_POLICY_HISTORY_INVALID" }));
    expect(() => resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: new Date("nope") })], T0))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_POLICY_HISTORY_INVALID" }));
    expect(() => resolveEnforcedListingTierMinimums([version({ version: 1, createdAt: T0 })], new Date("nope")))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_CLOCK_INVALID" }));
  });
});

describe("listingTiersAlreadyOn", () => {
  it("reads the tiers this rule left on at its last check, in tier order, for an active vendor", () => {
    expect(listingTiersAlreadyOn({ vendorStatus: "active", lastDecision: { tiersOn: ["case", "pack"] } })).toEqual(["pack", "case"]);
    expect(listingTiersAlreadyOn({ vendorStatus: "active", lastDecision: { tiersOn: ["pack"] } })).toEqual(["pack"]);
    expect(listingTiersAlreadyOn({ vendorStatus: "active", lastDecision: { tiersOn: [] } })).toEqual([]);
  });

  it("counts nothing from a row the September rule wrote, which a reserve alone could satisfy", () => {
    expect(listingTiersAlreadyOn({ vendorStatus: "active", lastDecision: { tiersOn: null } })).toEqual([]);
  });

  it("counts nothing for a vendor never decided, or not active", () => {
    expect(listingTiersAlreadyOn({ vendorStatus: "active", lastDecision: null })).toEqual([]);
    for (const vendorStatus of ["paused", "onboarding", "lapsed", "suspended", "closed"] as const) {
      expect(listingTiersAlreadyOn({ vendorStatus, lastDecision: { tiersOn: ["pack", "case"] } })).toEqual([]);
    }
  });
});

describe("evaluateDropshipListingTierEligibility", () => {
  // Pack tier $100, case tier $500, no raise pending.
  const minimums = resolveEnforcedListingTierMinimums(
    [version({ version: 1, createdAt: T0, packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 })],
    at(1),
  );
  const NONE: readonly DropshipListingTier[] = [];
  const BOTH: readonly DropshipListingTier[] = ["pack", "case"];

  function evaluate(
    funding: { minimumBalanceCents: number | null; availableBalanceCents: number; pendingBalanceCents: number },
    tiersAlreadyOn: readonly DropshipListingTier[] = NONE,
    at = minimums,
  ) {
    return evaluateDropshipListingTierEligibility({ funding, minimums: at, tiersAlreadyOn });
  }

  it("turns nothing on with a reserve and no money behind it", () => {
    // The dogfood wallet of 2026-09-26: a $100 reserve, $0 in the wallet, nothing on its way.
    const result = evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 0, pendingBalanceCents: 0 });
    expect(result.pack).toEqual({
      tier: "pack", eligible: false, reason: "balance_below_tier", policyMinimumCents: 10_000, minimumCents: 10_000,
      alreadyOn: false, reserveShortfallCents: 0, balanceShortfallCents: 10_000, upcoming: null,
    });
    expect(result.case).toEqual({
      tier: "case", eligible: false, reason: "reserve_below_tier", policyMinimumCents: 50_000, minimumCents: 50_000,
      alreadyOn: false, reserveShortfallCents: 40_000, balanceShortfallCents: 50_000, upcoming: null,
    });
    expect(heldListingTiersFor(result)).toEqual(["pack", "case"]);
  });

  it("turns a tier on once the reserve and the money both reach its amount, the same rule for both tiers", () => {
    const pack = evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 10_000, pendingBalanceCents: 0 });
    expect(pack.pack).toMatchObject({ eligible: true, reason: null, reserveShortfallCents: 0, balanceShortfallCents: 0 });
    expect(pack.case).toMatchObject({ eligible: false, reason: "reserve_below_tier" });
    const both = evaluate({ minimumBalanceCents: 50_000, availableBalanceCents: 50_000, pendingBalanceCents: 0 });
    expect(both.pack).toMatchObject({ eligible: true });
    expect(both.case).toMatchObject({ eligible: true, reserveShortfallCents: 0, balanceShortfallCents: 0 });
    expect(heldListingTiersFor(both)).toEqual([]);
  });

  it("never opens the case tier on a pack reserve, whatever the balance or top-up amount", () => {
    // Owner decision 2026-09-26: the case tier needs its own amount as the reserve.
    const result = evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 1_000_000, pendingBalanceCents: 0 });
    expect(result.case).toMatchObject({ eligible: false, reason: "reserve_below_tier", reserveShortfallCents: 40_000, balanceShortfallCents: 0 });
    // Even a case tier that was on closes once the reserve is lowered to the pack amount.
    expect(evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 1_000_000, pendingBalanceCents: 0 }, BOTH).case)
      .toMatchObject({ eligible: false, reason: "reserve_below_tier", alreadyOn: true });
  });

  it("counts credits still on their way toward reaching a tier", () => {
    const pending = evaluate({ minimumBalanceCents: 50_000, availableBalanceCents: 12_000, pendingBalanceCents: 38_000 });
    expect(pending.case).toMatchObject({ eligible: true, balanceShortfallCents: 0 });
    const almost = evaluate({ minimumBalanceCents: 50_000, availableBalanceCents: 12_000, pendingBalanceCents: 37_999 });
    expect(almost.case).toMatchObject({ eligible: false, reason: "balance_below_tier", balanceShortfallCents: 1 });
  });

  it("keeps a tier that was on while the reserve covers it, however far the balance dips", () => {
    const dipped = { minimumBalanceCents: 50_000, availableBalanceCents: 1_200, pendingBalanceCents: 0 };
    const kept = evaluate(dipped, BOTH);
    expect(kept.pack).toMatchObject({ eligible: true, reason: null, alreadyOn: true, balanceShortfallCents: 8_800 });
    expect(kept.case).toMatchObject({ eligible: true, reason: null, alreadyOn: true, balanceShortfallCents: 48_800 });
    expect(heldListingTiersFor(kept)).toEqual([]);
    // The same wallet joining has to reach each amount first.
    const joining = evaluate(dipped, NONE);
    expect(joining.pack).toMatchObject({ eligible: false, reason: "balance_below_tier" });
    expect(joining.case).toMatchObject({ eligible: false, reason: "balance_below_tier" });
    // A negative balance is a deeper dip, not a different rule.
    expect(evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: -2_500, pendingBalanceCents: 0 }, ["pack"]).pack)
      .toMatchObject({ eligible: true, balanceShortfallCents: 12_500 });
    expect(evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: -2_500, pendingBalanceCents: 0 }).pack)
      .toMatchObject({ eligible: false, reason: "balance_below_tier", balanceShortfallCents: 12_500 });
  });

  it("turns every tier off with autopay off, since there is no reserve", () => {
    const result = evaluate({ minimumBalanceCents: null, availableBalanceCents: 60_000, pendingBalanceCents: 0 }, BOTH);
    expect(result.pack).toMatchObject({ eligible: false, reason: "autopay_off", reserveShortfallCents: 10_000, balanceShortfallCents: 0 });
    expect(result.case).toMatchObject({ eligible: false, reason: "autopay_off", reserveShortfallCents: 50_000, balanceShortfallCents: 0 });
  });

  it("grandfathers a vendor already in a tier through a raise's grace period, and holds a joining vendor to the published amount", () => {
    // v2 raises pack $50 -> $100 and case $50 -> $500 at day 10, enforced from day 24.
    const raised = resolveEnforcedListingTierMinimums([
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000, caseTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
    ], at(20));
    const oldReserve = { minimumBalanceCents: 5_000, availableBalanceCents: 5_000, pendingBalanceCents: 0 };
    const member = evaluate(oldReserve, BOTH, raised);
    expect(member.pack).toMatchObject({
      eligible: true, policyMinimumCents: 10_000, minimumCents: 5_000, reserveShortfallCents: 5_000,
      upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(24), affectsVendor: true },
    });
    expect(member.case).toMatchObject({
      eligible: true, policyMinimumCents: 50_000, minimumCents: 5_000,
      upcoming: { minimumCents: 50_000, affectsVendor: true },
    });
    const joiner = evaluate(oldReserve, NONE, raised);
    expect(joiner.pack).toMatchObject({ eligible: false, reason: "reserve_below_tier", upcoming: { affectsVendor: false } });
    expect(joiner.case).toMatchObject({ eligible: false, reason: "reserve_below_tier", upcoming: { affectsVendor: false } });
    // A joiner who meets the published amount is on, and the raise does not touch them.
    const ready = evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 10_000, pendingBalanceCents: 0 }, NONE, raised);
    expect(ready.pack).toMatchObject({ eligible: true, upcoming: { affectsVendor: false } });
    // A member whose reserve already covers the raise is not caught by it, even below it in money: autopay tops up to the reserve.
    const covered = evaluate({ minimumBalanceCents: 50_000, availableBalanceCents: 3_000, pendingBalanceCents: 0 }, BOTH, raised);
    expect(covered.pack.upcoming).toMatchObject({ affectsVendor: false });
    expect(covered.case.upcoming).toMatchObject({ affectsVendor: false });
  });

  it("refuses non-integer or negative funding facts and unknown tiers", () => {
    for (const funding of [
      { minimumBalanceCents: 10_000, availableBalanceCents: 10.5, pendingBalanceCents: 0 },
      { minimumBalanceCents: 10_000, availableBalanceCents: 10_000, pendingBalanceCents: -1 },
      { minimumBalanceCents: -1, availableBalanceCents: 10_000, pendingBalanceCents: 0 },
    ]) {
      expect(() => evaluate(funding)).toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_FUNDING_INVALID" }));
    }
    expect(() => evaluate({ minimumBalanceCents: 10_000, availableBalanceCents: 10_000, pendingBalanceCents: 0 }, ["crate" as DropshipListingTier]))
      .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_STANDING_INVALID" }));
  });
});

describe("listing tier keys", () => {
  it("keys hold commands by vendor, revision, tier, command, store and SKU set, and notices by vendor, tier, event and revision", () => {
    expect(listingTierHoldIdempotencyKeyFor({
      vendorId: 10, tierHoldRevision: 3, tier: "case", command: "hold", storeConnectionId: 77, variantSetHash: "abcd1234",
    })).toBe("dropship-listing-tier:10:3:case:hold:77:abcd1234");
    expect(listingTierNotificationKeyFor({ vendorId: 10, tier: "case", event: "grace_notice", revision: 2 }))
      .toBe("dropship-listing-tier:10:case:grace_notice:2");
  });
});
