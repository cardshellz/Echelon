import { createHash } from "node:crypto";

import {
  publicationScopeTypeFor,
  type ChannelDestinationSkipReason,
  type ChannelExposurePolicyScope,
  type ChannelExposurePolicyValue,
  type ResolvedChannelExposurePolicy,
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

export function calculatePublicationVariantMappingDefinitionHash(input: {
  publicationTargetId: number;
  productVariantId: number;
  externalInventoryItemId: string;
  externalSku: string | null;
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
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

// ---------------------------------------------------------------------------
// Destination derivation
// ---------------------------------------------------------------------------

/**
 * A channel connection as the derivation needs to see it. Deliberately plain
 * data so the rule is testable without a database or an HTTP client.
 */
export interface DerivableChannelConnection {
  id: number;
  provider: string;
  /** Primary location this connection already writes inventory to, if stored. */
  shopifyLocationId: string | null;
  /** Provider-verified account id; null when the credential does not carry one. */
  verifiedAccountId: string | null;
  label: string;
}

/** A dropship storefront as the derivation needs to see it. */
export interface DerivableDropshipStore {
  id: number;
  platform: string;
  verifiedExternalAccountId: string | null;
  label: string;
}

/** An exact destination that already has a publication target. */
export interface RegisteredDestinationIdentity {
  destinationKind: "channel_connection" | "dropship_store_connection";
  connectionId: number;
  providerScopeType: "account" | "location";
  externalScopeId: string;
}

export interface DerivedDestination {
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  label: string;
}

export interface SkippedDestination {
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
  providerScopeType?: "account" | "location";
  externalScopeId?: string;
  reason: ChannelDestinationSkipReason;
  label: string;
}

export interface DestinationDerivation {
  create: DerivedDestination[];
  skipped: SkippedDestination[];
}

function identityKey(identity: RegisteredDestinationIdentity): string {
  return [
    identity.destinationKind,
    identity.connectionId,
    identity.providerScopeType,
    identity.externalScopeId,
  ].join(":");
}

/**
 * Works out which destinations a channel's existing connections already imply.
 *
 * The rule is intentionally conservative: a destination is only derived when
 * the provider has a publishing adapter AND the exact scope id is already
 * recorded against the connection. Nothing is guessed. A Shopify connection
 * with no stored location and an eBay credential with no verified account are
 * both reported as skipped, never defaulted, because writing a quantity to the
 * wrong location or account is a financial error.
 *
 * Dropship storefronts are passed in only for the one internal dropship
 * channel; callers must not offer them for a marketplace channel.
 */
export function deriveChannelDestinations(input: {
  connections: readonly DerivableChannelConnection[];
  dropshipStores: readonly DerivableDropshipStore[];
  registered: readonly RegisteredDestinationIdentity[];
}): DestinationDerivation {
  const taken = new Set(input.registered.map(identityKey));
  const create: DerivedDestination[] = [];
  const skipped: SkippedDestination[] = [];

  const consider = (
    destinationKind: DerivedDestination["destinationKind"],
    connectionId: number,
    provider: string,
    scopeId: string | null,
    label: string,
  ): void => {
    const base = {
      destinationKind,
      channelConnectionId: destinationKind === "channel_connection" ? connectionId : null,
      dropshipStoreConnectionId: destinationKind === "dropship_store_connection" ? connectionId : null,
      label,
    };
    const providerScopeType = publicationScopeTypeFor(provider);
    if (providerScopeType === null) {
      skipped.push({ ...base, reason: "no_publishing_adapter" });
      return;
    }
    if (scopeId === null || scopeId.trim().length === 0) {
      skipped.push({
        ...base,
        providerScopeType,
        reason: providerScopeType === "location" ? "no_shopify_location" : "no_verified_account",
      });
      return;
    }
    const externalScopeId = scopeId.trim();
    const entry = { ...base, providerScopeType, externalScopeId };
    if (taken.has(identityKey({ destinationKind, connectionId, providerScopeType, externalScopeId }))) {
      skipped.push({ ...entry, reason: "already_registered" });
      return;
    }
    create.push(entry);
  };

  for (const connection of input.connections) {
    const scopeType = publicationScopeTypeFor(connection.provider);
    consider(
      "channel_connection",
      connection.id,
      connection.provider,
      scopeType === "location" ? connection.shopifyLocationId : connection.verifiedAccountId,
      connection.label,
    );
  }
  for (const store of input.dropshipStores) {
    consider(
      "dropship_store_connection",
      store.id,
      store.platform,
      store.verifiedExternalAccountId,
      store.label,
    );
  }
  return { create, skipped };
}

// ---------------------------------------------------------------------------
// Cutover divergence
// ---------------------------------------------------------------------------

/** One readiness row's legacy and canonical quantities, as whole sellable units. */
export interface PublicationQuantityComparison {
  legacyCalculatedUnits: string;
  desiredUnits: string;
}

export interface CutoverDivergenceSummary {
  /** Rows where canonical would publish exactly what legacy publishes today. */
  rowsMatchingLegacy: number;
  rowsAboveLegacy: number;
  rowsBelowLegacy: number;
  /** Largest single increase and decrease, as non-negative unit counts. */
  largestIncreaseUnits: string;
  largestDecreaseUnits: string;
}

/**
 * Compares, row by row, what the canonical configuration would publish against
 * what the legacy allocator publishes today.
 *
 * This exists because readiness otherwise only refuses a quantity that exceeds
 * canonical ATP. A rule entered with the wrong unit basis — the legacy caps and
 * floors are base pieces while the canonical fields are whole sellable units —
 * produces a number that is wrong but still under ATP, so nothing refuses it.
 * The same is true of a legacy days-of-cover floor, which has no canonical
 * equivalent at all and simply stops being applied.
 *
 * Divergence is reported, never treated as a failure: publishing different
 * numbers is the point of the new planner, and only an operator can say which
 * differences are intended. What this removes is the need to read every row of
 * a full-catalog report by hand to notice that some are not.
 */
export function summarizeCutoverDivergence(
  rows: readonly PublicationQuantityComparison[],
): CutoverDivergenceSummary {
  let rowsMatchingLegacy = 0;
  let rowsAboveLegacy = 0;
  let rowsBelowLegacy = 0;
  const zero = BigInt(0);
  let largestIncrease = zero;
  let largestDecrease = zero;

  for (const row of rows) {
    // BigInt throughout: these are Postgres bigints carried as strings, and a
    // Number conversion would silently lose precision on a large catalog.
    const difference = BigInt(row.desiredUnits) - BigInt(row.legacyCalculatedUnits);
    if (difference === zero) {
      rowsMatchingLegacy += 1;
      continue;
    }
    if (difference > zero) {
      rowsAboveLegacy += 1;
      if (difference > largestIncrease) largestIncrease = difference;
      continue;
    }
    rowsBelowLegacy += 1;
    const magnitude = difference * BigInt(-1);
    if (magnitude > largestDecrease) largestDecrease = magnitude;
  }

  return {
    rowsMatchingLegacy,
    rowsAboveLegacy,
    rowsBelowLegacy,
    largestIncreaseUnits: largestIncrease.toString(),
    largestDecreaseUnits: largestDecrease.toString(),
  };
}
