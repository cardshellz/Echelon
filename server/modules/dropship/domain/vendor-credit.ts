/**
 * Dropship vendor credit profile — the per-vendor layer over the wallet policy.
 *
 * Today it holds one thing: an override of the global pending-ACH advance cap
 * (`dropship.dropship_vendor_credit_profiles`, migration 0683), so a vendor
 * who has earned trust can be advanced more than the policy allows by default.
 * The trust tier and credit terms the program will grow into attach here.
 *
 * Pure: no database, no clock. Money is integer cents.
 */

import { DropshipError } from "./errors";

export interface DropshipVendorCreditProfileActor {
  actorType: "admin" | "system";
  actorId: string | null;
}

export interface DropshipVendorCreditProfile {
  vendorId: number;
  /** Overrides the policy's advance cap when set; null means the policy cap applies. */
  advanceCapOverrideCents: number | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  updatedBy: DropshipVendorCreditProfileActor;
}

export type DropshipAdvanceCapSource = "vendor_override" | "policy";

export interface DropshipEffectiveAdvanceCap {
  advanceCapCents: number;
  source: DropshipAdvanceCapSource;
}

/**
 * The advance cap that applies to a vendor: their override when one is set,
 * otherwise the global policy cap. An override of zero is honoured — it means
 * "advance nothing to this vendor", which is exactly the kind of decision the
 * profile exists to record.
 */
export function resolveEffectiveAdvanceCapCents(input: {
  policyAdvanceCapCents: number;
  profile: Pick<DropshipVendorCreditProfile, "advanceCapOverrideCents"> | null;
}): DropshipEffectiveAdvanceCap {
  assertNonNegativeCents(input.policyAdvanceCapCents, "policyAdvanceCapCents");
  const override = input.profile?.advanceCapOverrideCents ?? null;
  if (override === null) {
    return { advanceCapCents: input.policyAdvanceCapCents, source: "policy" };
  }
  assertNonNegativeCents(override, "advanceCapOverrideCents");
  return { advanceCapCents: override, source: "vendor_override" };
}

function assertNonNegativeCents(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE",
      "An advance cap must be a non-negative integer number of cents.",
      { classification: "fatal", field, value },
    );
  }
}
