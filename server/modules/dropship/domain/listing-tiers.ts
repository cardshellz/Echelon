import { isVariantUomType, type VariantUomType } from "../../../../shared/catalog/variant-uom";
import type { DropshipVendorStatus } from "../../../../shared/schema/dropship.schema";
import { DropshipError } from "./errors";

/**
 * Listing tiers (pure rules).
 *
 * A vendor's catalog sells in two tiers, each with an amount set by staff on
 * the wallet policy: the pack tier (eaches, packs and inner packs; the
 * policy's `minimum_floor_cents`) and the case tier (cases and anything
 * larger; `case_tier_minimum_cents`, never below the pack tier). The vendor's
 * reserve is their autopay minimum balance: what autopay keeps in the wallet.
 * One wallet, one balance: the tiers only decide what a vendor may have live.
 *
 * Locked rules (owner decisions, 26 September 2026; they replace the
 * September rule under which a reserve alone kept the pack tier):
 * - One rule for both tiers. A tier turns on when the reserve and the
 *   wallet's money (the balance plus credits still on their way) both reach
 *   the tier's amount. A reserve with no money behind it turns nothing on.
 * - Once on, a tier stays on while the reserve still covers the tier's
 *   amount. A balance that dips after an order, a fee or a return does not
 *   turn it off: autopay tops the wallet back up to the reserve after every
 *   order and on the daily run. It turns off when the reserve stops covering
 *   it (lowered, or autopay off) or when the vendor is paused (a failed
 *   payment pauses the whole store); then it has to be reached again.
 * - "On at the last check" is the tiers this rule recorded as on at its last
 *   check (`tiers_on`, migration 0706). A decision the September rule wrote
 *   has none, because that rule could keep a tier on with a reserve alone.
 * - Raising a tier's amount grandfathers vendors already in the tier for the
 *   grace period of the version that raised it: until `created_at + grace
 *   days` their reserve only has to cover the previous amount. A vendor
 *   joining the tier meets the published amount at once, which is also the
 *   amount every vendor is shown. Lowering takes effect immediately. Every
 *   published version is immutable, so the enforced amount at any instant is
 *   a pure function of the version history and the clock.
 * - Listing is just listing; order acceptance still enforces funds.
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
  /** The amount in force now for a vendor already in the tier. */
  minimumCents: number;
  /** The policy version whose value is in force. */
  version: number;
  /**
   * The amount the latest published version sets: what a vendor joining the
   * tier needs, what the reserve options offer and what vendors are shown.
   * Above `minimumCents` only while a raise is in its grace period.
   */
  policyMinimumCents: number;
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
 * The amounts for each tier at `now`, from the immutable version history. A
 * version that raised a tier over the version before it is enforced at its
 * publish time plus its own grace period; a version that lowered or kept the
 * tier is enforced at publish time. The enforced amount is the highest
 * version already enforced; `upcoming` is the version that will be enforced
 * next, if any; the policy amount is the latest version's. Every version
 * after the enforced one is a raise still in grace (a lowering is enforced at
 * once), so the policy amount is never below the enforced one.
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
  const latest = steps[steps.length - 1]!;
  return {
    tier,
    minimumCents: enforced.minimumCents,
    version: enforced.version,
    policyMinimumCents: latest.minimumCents,
    upcoming,
  };
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
  /** The vendor's reserve: the autopay minimum balance; null when autopay is not configured or is off. */
  minimumBalanceCents: number | null;
  availableBalanceCents: number;
  /** Credits still on their way (an ACH pull in flight). They count toward reaching a tier. */
  pendingBalanceCents: number;
}

/** The last recorded tier decision, as the rule needs it. */
export interface DropshipListingTierLastDecision {
  /**
   * The tiers this rule found on at its last check; null when this rule has
   * not decided the vendor yet (a row the September rule wrote, which a
   * reserve alone could have satisfied).
   */
  tiersOn: readonly DropshipListingTier[] | null;
}

/**
 * The tiers a vendor already has on, from the last recorded decision.
 * Nothing counts as on for a vendor who is not active (paused, onboarding,
 * lapsed, suspended, closed), for a vendor never decided, or when this rule
 * has not decided them yet.
 */
export function listingTiersAlreadyOn(input: {
  vendorStatus: DropshipVendorStatus;
  lastDecision: DropshipListingTierLastDecision | null;
}): DropshipListingTier[] {
  const tiersOn = input.lastDecision?.tiersOn ?? null;
  if (input.vendorStatus !== "active" || tiersOn === null) return [];
  return DROPSHIP_LISTING_TIERS.filter((tier) => tiersOn.includes(tier));
}

export type DropshipListingTierBlockReason =
  /** Autopay is off, so there is no reserve. */
  | "autopay_off"
  /** The reserve is below the tier's amount. */
  | "reserve_below_tier"
  /** The reserve covers the tier, but the wallet has not reached its amount. */
  | "balance_below_tier";

export interface DropshipListingTierStatus {
  tier: DropshipListingTier;
  eligible: boolean;
  reason: DropshipListingTierBlockReason | null;
  /** The amount vendors are shown and a vendor joining the tier needs (the latest published policy's). */
  policyMinimumCents: number;
  /** The amount enforced now for a vendor already in the tier; below the policy amount only while a raise is in grace. */
  minimumCents: number;
  /** Whether the tier was on at the last check, so a balance below its amount does not turn it off. */
  alreadyOn: boolean;
  /** How far the reserve is below the policy amount; the whole amount when autopay is off; zero when it covers it. */
  reserveShortfallCents: number;
  /** How far the wallet's money (balance plus credits on their way) is below the policy amount; zero when it reaches it. */
  balanceShortfallCents: number;
  upcoming: (DropshipUpcomingListingTierMinimum & {
    /** Whether the raise would turn this tier off as things stand: it is on, and the reserve is below the raised amount. */
    affectsVendor: boolean;
  }) | null;
}

export type DropshipListingTierEligibility = Record<DropshipListingTier, DropshipListingTierStatus>;

/**
 * Which of a vendor's tiers are on, from their funding facts, the tiers they
 * already have on (`listingTiersAlreadyOn`) and the amounts at this instant.
 * Money is integer cents throughout.
 */
export function evaluateDropshipListingTierEligibility(input: {
  funding: DropshipVendorListingTierFunding;
  minimums: DropshipEnforcedListingTierMinimums;
  tiersAlreadyOn: readonly DropshipListingTier[];
}): DropshipListingTierEligibility {
  const funding = normalizeFunding(input.funding);
  const alreadyOn = normalizeTiersAlreadyOn(input.tiersAlreadyOn);
  return {
    pack: evaluateTier(input.minimums.pack, funding, alreadyOn.has("pack")),
    case: evaluateTier(input.minimums.case, funding, alreadyOn.has("case")),
  };
}

function evaluateTier(
  amounts: DropshipEnforcedListingTierMinimum,
  funding: DropshipVendorListingTierFunding,
  alreadyOn: boolean,
): DropshipListingTierStatus {
  const reserveCents = funding.minimumBalanceCents;
  const countedBalanceCents = funding.availableBalanceCents + funding.pendingBalanceCents;
  // Already in the tier: the reserve keeps it, measured against the amount in
  // force now (the previous one while a raise is in grace).
  const keeps = alreadyOn && reserveCents !== null && reserveCents >= amounts.minimumCents;
  // Joining the tier: the reserve and the money both reach the published amount.
  const joins = reserveCents !== null
    && reserveCents >= amounts.policyMinimumCents
    && countedBalanceCents >= amounts.policyMinimumCents;
  const eligible = keeps || joins;
  return {
    tier: amounts.tier,
    eligible,
    reason: eligible ? null : blockReasonFor(reserveCents, amounts.policyMinimumCents),
    policyMinimumCents: amounts.policyMinimumCents,
    minimumCents: amounts.minimumCents,
    alreadyOn,
    reserveShortfallCents: Math.max(0, amounts.policyMinimumCents - (reserveCents ?? 0)),
    balanceShortfallCents: Math.max(0, amounts.policyMinimumCents - countedBalanceCents),
    upcoming: amounts.upcoming
      ? { ...amounts.upcoming, affectsVendor: eligible && (reserveCents ?? 0) < amounts.upcoming.minimumCents }
      : null,
  };
}

/**
 * Why a tier is off. The policy amount is never below the enforced one, so a
 * vendor already on who lost the tier has a reserve below the policy amount
 * too: the reason names the reserve, then the money.
 */
function blockReasonFor(reserveCents: number | null, policyMinimumCents: number): DropshipListingTierBlockReason {
  if (reserveCents === null) return "autopay_off";
  return reserveCents < policyMinimumCents ? "reserve_below_tier" : "balance_below_tier";
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

function normalizeTiersAlreadyOn(tiers: readonly DropshipListingTier[]): ReadonlySet<DropshipListingTier> {
  for (const tier of tiers) {
    if (!(DROPSHIP_LISTING_TIERS as readonly string[]).includes(tier)) {
      throw new DropshipError(
        "DROPSHIP_LISTING_TIER_STANDING_INVALID",
        "The tiers already on must be listing tiers.",
        { tier },
      );
    }
  }
  return new Set(tiers);
}

/** The tiers whose listings must be paused, from the vendor's eligibility. */
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
