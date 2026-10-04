import type { ResolvedChannelExposurePolicy } from "../types/inventory-channel-exposure";

const BASIS_POINTS_DENOMINATOR = BigInt(10_000);

/** Arithmetic only; resolving rules and checking publication readiness remain server responsibilities. */
export type ChannelExposureCalculationPolicy = Pick<ResolvedChannelExposurePolicy,
  "eligible" | "shareBps" | "holdbackSellableUnits" | "maxPublishSellableUnits" | "minPublishSellableUnits"
>;

export interface ChannelExposureCalculation {
  canonicalAtpUnits: bigint;
  sharedUnits: bigint;
  afterHoldbackUnits: bigint;
  cappedUnits: bigint;
  publishedUnits: bigint;
}

/** Shared by publication planning and the explicitly hypothetical settings example. */
export function calculateChannelExposure(
  canonicalAtpUnits: bigint,
  policy: ChannelExposureCalculationPolicy,
): ChannelExposureCalculation {
  if (canonicalAtpUnits < BigInt(0)) {
    throw new RangeError("canonicalAtpUnits must be nonnegative");
  }
  const holdback = parseNonnegativeQuantity(policy.holdbackSellableUnits, "holdbackSellableUnits");
  const maximum = policy.maxPublishSellableUnits === null
    ? null
    : parseNonnegativeQuantity(policy.maxPublishSellableUnits, "maxPublishSellableUnits");
  const minimum = parseNonnegativeQuantity(policy.minPublishSellableUnits, "minPublishSellableUnits");
  if (!Number.isInteger(policy.shareBps) || policy.shareBps < 0 || policy.shareBps > 10_000) {
    throw new RangeError("shareBps must be an integer between 0 and 10000");
  }
  if (!policy.eligible) {
    return {
      canonicalAtpUnits,
      sharedUnits: BigInt(0),
      afterHoldbackUnits: BigInt(0),
      cappedUnits: BigInt(0),
      publishedUnits: BigInt(0),
    };
  }
  const sharedUnits = canonicalAtpUnits * BigInt(policy.shareBps) / BASIS_POINTS_DENOMINATOR;
  const afterHoldbackUnits = sharedUnits > holdback ? sharedUnits - holdback : BigInt(0);
  const cappedUnits = maximum === null || afterHoldbackUnits <= maximum
    ? afterHoldbackUnits
    : maximum;
  const publishedUnits = cappedUnits < minimum ? BigInt(0) : cappedUnits;
  if (publishedUnits < BigInt(0) || publishedUnits > canonicalAtpUnits) {
    throw new Error("Channel exposure invariant failed: published quantity is outside canonical ATP");
  }
  return { canonicalAtpUnits, sharedUnits, afterHoldbackUnits, cappedUnits, publishedUnits };
}

function parseNonnegativeQuantity(value: string, field: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < BigInt(0)) throw new Error("negative");
    return parsed;
  } catch {
    throw new RangeError(`${field} must be a nonnegative integer quantity`);
  }
}
