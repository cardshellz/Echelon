import { createHash } from "node:crypto";

import type {
  ChannelExposurePolicyScope,
  ChannelExposurePolicyValue,
  ResolvedChannelExposurePolicy,
} from "@shared/types/inventory-channel-exposure";
import { canonicalJson } from "@shared/utils/canonical-json";

const BASIS_POINTS_DENOMINATOR = BigInt(10_000);

export interface ChannelExposurePolicyCandidate {
  scopeKey: string;
  scopeType: "channel" | "product" | "variant";
  value: ChannelExposurePolicyValue;
}

export interface ChannelExposureResolutionInput {
  channelId: number;
  productId: number;
  productVariantId: number;
  policies: readonly ChannelExposurePolicyCandidate[];
}

export interface ChannelExposureResolutionResult {
  policy: ResolvedChannelExposurePolicy | null;
  missingFields: Array<keyof ChannelExposurePolicyValue>;
}

export interface ChannelExposureCalculation {
  canonicalAtpUnits: bigint;
  sharedUnits: bigint;
  afterHoldbackUnits: bigint;
  cappedUnits: bigint;
  publishedUnits: bigint;
}

const policyFields = [
  "allocationSemantics",
  "eligible",
  "shareBps",
  "holdbackSellableUnits",
  "maxPublish",
  "minPublishSellableUnits",
] as const satisfies ReadonlyArray<keyof ChannelExposurePolicyValue>;

export function channelExposurePolicyScopeKey(scope: ChannelExposurePolicyScope): string {
  switch (scope.scopeType) {
    case "channel":
      return `channel:${scope.channelId}`;
    case "product":
      return `channel:${scope.channelId}:product:${scope.productId}`;
    case "variant":
      return `channel:${scope.channelId}:variant:${scope.productVariantId}`;
  }
}

export function calculateChannelExposureDefinitionHash(input: {
  scope: ChannelExposurePolicyScope;
  value: ChannelExposurePolicyValue;
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

export function calculatePublicationSourceBindingDefinitionHash(input: {
  publicationTargetId: number;
  fulfillmentNodeIds: readonly number[];
}): string {
  return createHash("sha256").update(canonicalJson({
    publicationTargetId: input.publicationTargetId,
    fulfillmentNodeIds: [...input.fulfillmentNodeIds].sort((left, right) => left - right),
  }), "utf8").digest("hex");
}

export function resolveChannelExposurePolicy(
  input: ChannelExposureResolutionInput,
): ChannelExposureResolutionResult {
  const expectedKeys = [
    channelExposurePolicyScopeKey({
      scopeType: "variant",
      channelId: input.channelId,
      productId: input.productId,
      productVariantId: input.productVariantId,
    }),
    channelExposurePolicyScopeKey({
      scopeType: "product",
      channelId: input.channelId,
      productId: input.productId,
    }),
    channelExposurePolicyScopeKey({ scopeType: "channel", channelId: input.channelId }),
  ];
  const byKey = new Map(input.policies.map((policy) => [policy.scopeKey, policy] as const));
  const ordered = expectedKeys.flatMap((key) => {
    const policy = byKey.get(key);
    return policy ? [policy] : [];
  });
  const values: Partial<Record<keyof ChannelExposurePolicyValue, unknown>> = {};
  const sources: Partial<Record<keyof ChannelExposurePolicyValue, string>> = {};
  for (const field of policyFields) {
    const winner = ordered.find((candidate) => candidate.value[field] !== null);
    if (winner) {
      values[field] = winner.value[field];
      sources[field] = winner.scopeKey;
    }
  }
  const missingFields = policyFields.filter((field) => !(field in values));
  if (missingFields.length > 0) return { policy: null, missingFields };

  const policy: ResolvedChannelExposurePolicy = {
    allocationSemantics: values.allocationSemantics as "exposure" | "partitioned",
    eligible: values.eligible as boolean,
    shareBps: values.shareBps as number,
    holdbackSellableUnits: String(values.holdbackSellableUnits),
    maxPublishSellableUnits: (values.maxPublish as ChannelExposurePolicyValue["maxPublish"])?.mode === "units"
      ? String((values.maxPublish as { mode: "units"; units: string }).units)
      : null,
    minPublishSellableUnits: String(values.minPublishSellableUnits),
    sources: {
      allocationSemantics: sources.allocationSemantics!,
      eligible: sources.eligible!,
      shareBps: sources.shareBps!,
      holdbackSellableUnits: sources.holdbackSellableUnits!,
      maxPublishSellableUnits: sources.maxPublish!,
      minPublishSellableUnits: sources.minPublishSellableUnits!,
    },
  };
  return { policy, missingFields: [] };
}

export function calculateChannelExposure(
  canonicalAtpUnits: bigint,
  policy: ResolvedChannelExposurePolicy,
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

export function findPartitionedShareOverages(
  rows: readonly {
    productVariantId: number;
    sourceWarehouseIds: readonly number[];
    policy: ResolvedChannelExposurePolicy;
  }[],
): Array<{ productVariantId: number; warehouseId: number; totalShareBps: number }> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.policy.allocationSemantics !== "partitioned" || !row.policy.eligible) continue;
    for (const warehouseId of new Set(row.sourceWarehouseIds)) {
      const key = `${row.productVariantId}:${warehouseId}`;
      totals.set(key, (totals.get(key) ?? 0) + row.policy.shareBps);
    }
  }
  return [...totals.entries()].flatMap(([key, totalShareBps]) => {
    if (totalShareBps <= 10_000) return [];
    const [productVariantId, warehouseId] = key.split(":").map(Number);
    return [{ productVariantId: productVariantId!, warehouseId: warehouseId!, totalShareBps }];
  }).sort((left, right) => left.productVariantId - right.productVariantId
    || left.warehouseId - right.warehouseId);
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
