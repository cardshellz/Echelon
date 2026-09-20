import { describe, expect, it } from "vitest";
import { resolveEffectiveAdvanceCapCents } from "../../domain/vendor-credit";

describe("resolveEffectiveAdvanceCapCents", () => {
  it("applies the policy cap when the vendor has no profile", () => {
    expect(resolveEffectiveAdvanceCapCents({ policyAdvanceCapCents: 50_000, profile: null }))
      .toEqual({ advanceCapCents: 50_000, source: "policy" });
  });

  it("applies the policy cap when the profile carries no override", () => {
    expect(resolveEffectiveAdvanceCapCents({
      policyAdvanceCapCents: 50_000,
      profile: { advanceCapOverrideCents: null },
    })).toEqual({ advanceCapCents: 50_000, source: "policy" });
  });

  it("applies a vendor override above or below the policy cap", () => {
    expect(resolveEffectiveAdvanceCapCents({
      policyAdvanceCapCents: 50_000,
      profile: { advanceCapOverrideCents: 200_000 },
    })).toEqual({ advanceCapCents: 200_000, source: "vendor_override" });
    expect(resolveEffectiveAdvanceCapCents({
      policyAdvanceCapCents: 50_000,
      profile: { advanceCapOverrideCents: 1_000 },
    })).toEqual({ advanceCapCents: 1_000, source: "vendor_override" });
  });

  it("honours a zero override as 'advance nothing to this vendor'", () => {
    expect(resolveEffectiveAdvanceCapCents({
      policyAdvanceCapCents: 50_000,
      profile: { advanceCapOverrideCents: 0 },
    })).toEqual({ advanceCapCents: 0, source: "vendor_override" });
  });

  it("refuses a cap that is not a non-negative integer number of cents", () => {
    for (const bad of [-1, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveEffectiveAdvanceCapCents({ policyAdvanceCapCents: bad, profile: null }))
        .toThrow(expect.objectContaining({ code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE" }));
      expect(() => resolveEffectiveAdvanceCapCents({
        policyAdvanceCapCents: 50_000,
        profile: { advanceCapOverrideCents: bad },
      })).toThrow(expect.objectContaining({ code: "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE" }));
    }
  });
});
