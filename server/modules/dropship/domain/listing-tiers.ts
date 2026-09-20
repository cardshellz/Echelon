import { isVariantUomType, type VariantUomType } from "../../../../shared/catalog/variant-uom";
import { DropshipError } from "./errors";

/**
 * Listing tiers (pure rules).
 *
 * A vendor's catalog sells in two tiers, each with its own minimum wallet
 * balance set by staff on the wallet policy: the pack tier (eaches, packs and
 * inner packs; the policy's `minimum_floor_cents`) and the case tier (cases
 * and anything larger; `case_tier_minimum_cents`, never below the pack tier).
 * One wallet, one balance: the tiers only decide what a vendor may have on
 * sale.
 *
 * Locked rules (owner decisions, September 2026):
 * - Pack tier: the vendor keeps the pack minimum — by an auto-reload floor at
 *   or above it, or by an actual balance (pending credits count) at or above
 *   it. A vendor who does neither has their pack listings taken off sale.
 * - Case tier: case listings are on sale once the balance, counting credits
 *   still settling, has reached the case minimum, and off sale while it is
 *   below. Listing is just listing; order acceptance still enforces funds.
 * - Raising a tier minimum grandfathers vendors for the policy's grace
 *   period: the previous minimum stays enforced until `created_at + grace
 *   days` of the version that raised it, then the new one applies. Lowering
 *   takes effect immediately. Every published version is immutable, so the
 *   enforced minimum at any instant is a pure function of the version
 *   history and the clock.
 *
 * Nothing here reads the clock or the database: the application service
 * supplies both.
 */

export const DROPSHIP_LISTING_TIERS = ["pack", "case"] as const;
export type DropshipListingTier = (typeof DROPSHIP_LISTING_TIERS)[number];

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Which tier a variant sells in. Cases and skids are the case tier; every
 * smaller unit of measure (piece, each, pack, inner pack) is the pack tier.
 */
export function listingTierForVariantUomType(uomType: VariantUomType): DropshipListingTier {
  return uomType === "case" || uomType === "skid" ? "case" : "pack";
}

/**
 * Reads `catalog.product_variants.uom_type` at the database boundary. The
 * column is constrained, so anything else is corrupt evidence rather than a
 * tier to guess at.
 */
export function parseCatalogVariantUomType(value: unknown, context: { productVariantId: number }): VariantUomType {
  if (isVariantUomType(value)) return value;
  throw new DropshipError(
    "DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID",
    "A catalog variant carries an unknown unit of measure; its listing tier cannot be decided.",
    { productVariantId: context.productVariantId, uomType: value },
  );
}

/** The tier-relevant slice of one published wallet policy version. */
export interface DropshipListingTierPolicyVersion {
  version: number;
  packTierMinimumCents: number;
  caseTierMinimumCents: number;
  tierChangeGraceDays: number;
  createdAt: Date;
}

export interface DropshipUpcomingListingTierMinimum {
  minimumCents: number;
  /** The policy version that raised the minimum. */
  version: number;
  /** When the raised minimum starts being enforced (publish time plus the grace period). */
  enforcesAt: Date;
}

export interface DropshipEnforcedListingTierMinimum {
  tier: DropshipListingTier;
  /** The minimum in force now. */
  minimumCents: number;
  /** The policy version whose value is in force. */
  version: number;
  /** A raise still inside its grace period, or null when nothing is pending. */
  upcoming: DropshipUpcomingListingTierMinimum | null;
}

export type DropshipEnforcedListingTierMinimums = Record<DropshipListingTier, DropshipEnforcedListingTierMinimum>;

interface EnforcementStep {
  version: number;
  minimumCents: number;
  enforcesAt: Date;
}

/**
 * The minimum in force for each tier at `now`, from the immutable version
 * history. A version that raised a tier over the version before it is
 * enforced at its publish time plus its own grace period; a version that
 * lowered or kept the tier is enforced at publish time. The enforced minimum
 * is the highest version already enforced; `upcoming` is the version that
 * will be enforced next, if any.
 */
export function resolveEnforcedListingTierMinimums(
  versions: readonly DropshipListingTierPolicyVersion[],
  now: Date,
): DropshipEnforcedListingTierMinimums {
  const ordered = normalizeVersions(versions);
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new DropshipError("DROPSHIP_LISTING_TIER_CLOCK_INVALID", "The listing tier clock returned an invalid timestamp.");
  }
  return {
    pack: resolveTier("pack", ordered, (version) => version.packTierMinimumCents, now),
    case: resolveTier("case", ordered, (version) => version.caseTierMinimumCents, now),
  };
}

function resolveTier(
  tier: DropshipListingTier,
  ordered: readonly DropshipListingTierPolicyVersion[],
  read: (version: DropshipListingTierPolicyVersion) => number,
  now: Date,
): DropshipEnforcedListingTierMinimum {
  const steps: EnforcementStep[] = ordered.map((version, index) => {
    const minimumCents = read(version);
    const previous = index === 0 ? null : read(ordered[index - 1]!);
    const raised = previous !== null && minimumCents > previous;
    return {
      version: version.version,
      minimumCents,
      enforcesAt: raised
        ? new Date(version.createdAt.getTime() + version.tierChangeGraceDays * MILLISECONDS_PER_DAY)
        : version.createdAt,
    };
  });
  // The first version is enforced from the moment it exists; a clock behind
  // its publish time is a skew, not a reason to have no policy at all.
  let enforced = steps[0]!;
  for (const step of steps) {
    if (step.enforcesAt.getTime() <= now.getTime()) enforced = step;
  }
  const pending = steps.filter((step) => step.version > enforced.version && step.enforcesAt.getTime() > now.getTime());
  let upcoming: DropshipUpcomingListingTierMinimum | null = null;
  if (pending.length > 0) {
    // The next change lands at the earliest pending enforcement time; if two
    // land together the later version wins, exactly as the loop above decides.
    const soonest = Math.min(...pending.map((step) => step.enforcesAt.getTime()));
    const next = pending
      .filter((step) => step.enforcesAt.getTime() === soonest)
      .sort((left, right) => right.version - left.version)[0]!;
    upcoming = { minimumCents: next.minimumCents, version: next.version, enforcesAt: next.enforcesAt };
  }
  return { tier, minimumCents: enforced.minimumCents, version: enforced.version, upcoming };
}

function normalizeVersions(
  versions: readonly DropshipListingTierPolicyVersion[],
): DropshipListingTierPolicyVersion[] {
  if (versions.length === 0) {
    throw new DropshipError(
      "DROPSHIP_LISTING_TIER_POLICY_HISTORY_EMPTY",
      "At least one wallet policy version is required to resolve listing tier minimums.",
    );
  }
  const ordered = [...versions].sort((left, right) => left.version - right.version);
  for (const [index, version] of ordered.entries()) {
    const invalid =
      !Number.isSafeInteger(version.version) || version.version <= 0
      || !Number.isSafeInteger(version.packTierMinimumCents) || version.packTierMinimumCents < 0
      || !Number.isSafeInteger(version.caseTierMinimumCents) || version.caseTierMinimumCents < 0
      || !Number.isSafeInteger(version.tierChangeGraceDays) || version.tierChangeGraceDays < 0
      || !(version.createdAt instanceof Date) || !Number.isFinite(version.createdAt.getTime())
      || (index > 0 && ordered[index - 1]!.version === version.version);
    if (invalid) {
      throw new DropshipError(
        "DROPSHIP_LISTING_TIER_POLICY_HISTORY_INVALID",
        "A wallet policy version carries values the listing tiers cannot be resolved from.",
        { version: version.version },
      );
    }
  }
  return ordered;
}

/** The funding facts one vendor's tier standing is decided from. */
export interface DropshipVendorListingTierFunding {
  /** The auto-reload minimum the vendor keeps; null when auto-reload is not configured or is off. */
  minimumBalanceCents: number | null;
  availableBalanceCents: number;
  /** Credits still settling (an ACH pull in flight). They count for both tiers. */
  pendingBalanceCents: number;
}

export type DropshipListingTierBlockReason =
  | "pack_tier_minimum_not_kept"
  | "case_tier_balance_below_minimum";

export interface DropshipListingTierStatus {
  tier: DropshipListingTier;
  eligible: boolean;
  reason: DropshipListingTierBlockReason | null;
  /** The minimum enforced now. */
  minimumCents: number;
  /** How far the vendor is from the gate as things stand; zero when eligible. */
  shortfallCents: number;
  upcoming: (DropshipUpcomingListingTierMinimum & {
    /** Whether the vendor would fall below the raised minimum as things stand. */
    affectsVendor: boolean;
  }) | null;
}

export type DropshipListingTierEligibility = Record<DropshipListingTier, DropshipListingTierStatus>;

/**
 * Whether each tier is on sale for a vendor, from their funding facts and the
 * minimums enforced now. Money is integer cents throughout.
 */
export function evaluateDropshipListingTierEligibility(input: {
  funding: DropshipVendorListingTierFunding;
  minimums: DropshipEnforcedListingTierMinimums;
}): DropshipListingTierEligibility {
  const funding = normalizeFunding(input.funding);
  const countedBalanceCents = funding.availableBalanceCents + funding.pendingBalanceCents;
  const keptCents = Math.max(funding.minimumBalanceCents ?? 0, countedBalanceCents);

  const pack = input.minimums.pack;
  const packShortfall = Math.max(0, pack.minimumCents - keptCents);
  const casePolicy = input.minimums.case;
  const caseShortfall = Math.max(0, casePolicy.minimumCents - countedBalanceCents);

  return {
    pack: {
      tier: "pack",
      eligible: packShortfall === 0,
      reason: packShortfall === 0 ? null : "pack_tier_minimum_not_kept",
      minimumCents: pack.minimumCents,
      shortfallCents: packShortfall,
      upcoming: pack.upcoming
        ? { ...pack.upcoming, affectsVendor: keptCents < pack.upcoming.minimumCents }
        : null,
    },
    case: {
      tier: "case",
      eligible: caseShortfall === 0,
      reason: caseShortfall === 0 ? null : "case_tier_balance_below_minimum",
      minimumCents: casePolicy.minimumCents,
      shortfallCents: caseShortfall,
      upcoming: casePolicy.upcoming
        ? { ...casePolicy.upcoming, affectsVendor: countedBalanceCents < casePolicy.upcoming.minimumCents }
        : null,
    },
  };
}

function normalizeFunding(funding: DropshipVendorListingTierFunding): DropshipVendorListingTierFunding {
  const invalid =
    !Number.isSafeInteger(funding.availableBalanceCents)
    || !Number.isSafeInteger(funding.pendingBalanceCents) || funding.pendingBalanceCents < 0
    || (funding.minimumBalanceCents !== null
      && (!Number.isSafeInteger(funding.minimumBalanceCents) || funding.minimumBalanceCents < 0));
  if (invalid) {
    throw new DropshipError(
      "DROPSHIP_LISTING_TIER_FUNDING_INVALID",
      "Listing tier funding facts must be integer cents.",
      {
        minimumBalanceCents: funding.minimumBalanceCents,
        availableBalanceCents: funding.availableBalanceCents,
        pendingBalanceCents: funding.pendingBalanceCents,
      },
    );
  }
  return funding;
}

/** The tiers a vendor must have taken off sale, from their eligibility. */
export function heldListingTiersFor(eligibility: DropshipListingTierEligibility): DropshipListingTier[] {
  return DROPSHIP_LISTING_TIERS.filter((tier) => !eligibility[tier].eligible);
}

/**
 * Hold and release commands are keyed by the vendor's tier-hold revision and
 * the exact SKU set, so a retried command after a deferral replays the same
 * receipt, while a changed SKU set is a new command rather than a conflict.
 */
export function listingTierHoldIdempotencyKeyFor(input: {
  vendorId: number;
  tierHoldRevision: number;
  tier: DropshipListingTier;
  command: "hold" | "release";
  storeConnectionId: number;
  variantSetHash: string;
}): string {
  return `dropship-listing-tier:${input.vendorId}:${input.tierHoldRevision}:${input.tier}:${input.command}:${input.storeConnectionId}:${input.variantSetHash}`;
}

export function listingTierNotificationKeyFor(input: {
  vendorId: number;
  tier: DropshipListingTier;
  event: "grace_notice" | "held" | "released";
  /** The policy version for a grace notice; the tier-hold revision for a hold or release. */
  revision: number;
}): string {
  return `dropship-listing-tier:${input.vendorId}:${input.tier}:${input.event}:${input.revision}`;
}
