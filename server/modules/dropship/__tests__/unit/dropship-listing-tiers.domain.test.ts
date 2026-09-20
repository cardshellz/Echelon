import { describe, expect, it } from "vitest";
import {
  evaluateDropshipListingTierEligibility,
  heldListingTiersFor,
  listingTierForVariantUomType,
  listingTierHoldIdempotencyKeyFor,
  listingTierNotificationKeyFor,
  parseCatalogVariantUomType,
  resolveEnforcedListingTierMinimums,
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
      pack: { tier: "pack", minimumCents: 5_000, version: 1, upcoming: null },
      case: { tier: "case", minimumCents: 5_000, version: 1, upcoming: null },
    });
  });

  it("grandfathers a raise for the grace period of the version that raised it, then enforces it", () => {
    // The launch migration: v1 is the $50 seed, v2 publishes $100 / $500 with 14 days of grace.
    const history = [
      version({ version: 1, createdAt: T0 }),
      version({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
    ];
    const during = resolveEnforcedListingTierMinimums(history, at(20));
    expect(during.pack).toEqual({
      tier: "pack", minimumCents: 5_000, version: 1,
      upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(24) },
    });
    expect(during.case).toEqual({
      tier: "case", minimumCents: 5_000, version: 1,
      upcoming: { minimumCents: 50_000, version: 2, enforcesAt: at(24) },
    });
    const boundary = resolveEnforcedListingTierMinimums(history, at(24));
    expect(boundary.pack).toEqual({ tier: "pack", minimumCents: 10_000, version: 2, upcoming: null });
    expect(boundary.case).toEqual({ tier: "case", minimumCents: 50_000, version: 2, upcoming: null });
  });

  it("applies a lowered minimum immediately and a kept one without grace, per tier", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
      // Pack lowered, case unchanged: both take effect at publish time.
      version({ version: 2, createdAt: at(5), packTierMinimumCents: 8_000, caseTierMinimumCents: 50_000 }),
    ];
    const minimums = resolveEnforcedListingTierMinimums(history, at(5));
    expect(minimums.pack).toEqual({ tier: "pack", minimumCents: 8_000, version: 2, upcoming: null });
    expect(minimums.case).toEqual({ tier: "case", minimumCents: 50_000, version: 2, upcoming: null });
  });

  it("lets a later lowering supersede a raise still in grace", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 4_000 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(6)).pack)
      .toEqual({ tier: "pack", minimumCents: 4_000, version: 3, upcoming: null });
    // v2's deadline passing changes nothing: v3 is the later word.
    expect(resolveEnforcedListingTierMinimums(history, at(30)).pack)
      .toEqual({ tier: "pack", minimumCents: 4_000, version: 3, upcoming: null });
  });

  it("stages two pending raises in the order they land, and reports the next one as upcoming", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000, tierChangeGraceDays: 14 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 15_000, tierChangeGraceDays: 14 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(10)).pack)
      .toEqual({ tier: "pack", minimumCents: 5_000, version: 1, upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(15) } });
    expect(resolveEnforcedListingTierMinimums(history, at(16)).pack)
      .toEqual({ tier: "pack", minimumCents: 10_000, version: 2, upcoming: { minimumCents: 15_000, version: 3, enforcesAt: at(19) } });
    expect(resolveEnforcedListingTierMinimums(history, at(19)).pack)
      .toEqual({ tier: "pack", minimumCents: 15_000, version: 3, upcoming: null });
  });

  it("names the later version as upcoming when a shorter grace makes it land before an earlier raise", () => {
    const history = [
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(1), packTierMinimumCents: 10_000, tierChangeGraceDays: 14 }),
      version({ version: 3, createdAt: at(5), packTierMinimumCents: 15_000, tierChangeGraceDays: 2 }),
    ];
    expect(resolveEnforcedListingTierMinimums(history, at(6)).pack)
      .toEqual({ tier: "pack", minimumCents: 5_000, version: 1, upcoming: { minimumCents: 15_000, version: 3, enforcesAt: at(7) } });
    // Once v3 is enforced, v2's later deadline is moot: v3 is the later word.
    expect(resolveEnforcedListingTierMinimums(history, at(8)).pack)
      .toEqual({ tier: "pack", minimumCents: 15_000, version: 3, upcoming: null });
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

describe("evaluateDropshipListingTierEligibility", () => {
  const minimums = resolveEnforcedListingTierMinimums(
    [version({ version: 1, createdAt: T0, packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 })],
    at(1),
  );

  it("keeps the pack tier by an auto-reload floor at the minimum, whatever the balance", () => {
    const result = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 10_000, availableBalanceCents: 1_200, pendingBalanceCents: 0 },
      minimums,
    });
    expect(result.pack).toEqual({ tier: "pack", eligible: true, reason: null, minimumCents: 10_000, shortfallCents: 0, upcoming: null });
    expect(result.case).toEqual({
      tier: "case", eligible: false, reason: "case_tier_balance_below_minimum", minimumCents: 50_000, shortfallCents: 48_800, upcoming: null,
    });
    expect(heldListingTiersFor(result)).toEqual(["case"]);
  });

  it("keeps the pack tier by an actual balance when the floor is below the minimum or auto-reload is off", () => {
    const grandfathered = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 5_000, availableBalanceCents: 9_000, pendingBalanceCents: 1_000 },
      minimums,
    });
    expect(grandfathered.pack).toMatchObject({ eligible: true, shortfallCents: 0 });
    const manual = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: null, availableBalanceCents: 10_000, pendingBalanceCents: 0 },
      minimums,
    });
    expect(manual.pack).toMatchObject({ eligible: true, shortfallCents: 0 });
    const short = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 5_000, availableBalanceCents: 9_000, pendingBalanceCents: 0 },
      minimums,
    });
    expect(short.pack).toMatchObject({ eligible: false, reason: "pack_tier_minimum_not_kept", shortfallCents: 1_000 });
    expect(heldListingTiersFor(short)).toEqual(["pack", "case"]);
  });

  it("opens the case tier once the balance counting pending credits reaches the case minimum", () => {
    const pending = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 50_000, availableBalanceCents: 12_000, pendingBalanceCents: 38_000 },
      minimums,
    });
    expect(pending.case).toMatchObject({ eligible: true, shortfallCents: 0 });
    const almost = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 50_000, availableBalanceCents: 12_000, pendingBalanceCents: 37_999 },
      minimums,
    });
    expect(almost.case).toMatchObject({ eligible: false, reason: "case_tier_balance_below_minimum", shortfallCents: 1 });
  });

  it("counts a negative balance against both tiers", () => {
    const result = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 5_000, availableBalanceCents: -2_500, pendingBalanceCents: 0 },
      minimums,
    });
    expect(result.pack).toMatchObject({ eligible: false, shortfallCents: 5_000 });
    expect(result.case).toMatchObject({ eligible: false, shortfallCents: 52_500 });
  });

  it("says whether an upcoming raise would catch the vendor as things stand", () => {
    const raised = resolveEnforcedListingTierMinimums([
      version({ version: 1, createdAt: T0, packTierMinimumCents: 5_000, caseTierMinimumCents: 5_000 }),
      version({ version: 2, createdAt: at(10), packTierMinimumCents: 10_000, caseTierMinimumCents: 50_000 }),
    ], at(20));
    const result = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 5_000, availableBalanceCents: 5_000, pendingBalanceCents: 0 },
      minimums: raised,
    });
    expect(result.pack).toMatchObject({
      eligible: true,
      upcoming: { minimumCents: 10_000, version: 2, enforcesAt: at(24), affectsVendor: true },
    });
    expect(result.case).toMatchObject({
      eligible: true,
      upcoming: { minimumCents: 50_000, version: 2, enforcesAt: at(24), affectsVendor: true },
    });
    const safe = evaluateDropshipListingTierEligibility({
      funding: { minimumBalanceCents: 10_000, availableBalanceCents: 60_000, pendingBalanceCents: 0 },
      minimums: raised,
    });
    expect(safe.pack.upcoming).toMatchObject({ affectsVendor: false });
    expect(safe.case.upcoming).toMatchObject({ affectsVendor: false });
  });

  it("refuses non-integer or negative funding facts", () => {
    for (const funding of [
      { minimumBalanceCents: 10_000, availableBalanceCents: 10.5, pendingBalanceCents: 0 },
      { minimumBalanceCents: 10_000, availableBalanceCents: 10_000, pendingBalanceCents: -1 },
      { minimumBalanceCents: -1, availableBalanceCents: 10_000, pendingBalanceCents: 0 },
    ]) {
      expect(() => evaluateDropshipListingTierEligibility({ funding, minimums }))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_LISTING_TIER_FUNDING_INVALID" }));
    }
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
