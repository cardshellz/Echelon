import { describe, expect, it, vi } from "vitest";
import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import {
  AuthorityAwareInventoryPublicationService,
  type ActiveInventoryPublicationTarget,
  type InventoryAvailabilityRuntimePublicationContext,
} from "../../application/inventory-availability-runtime-publication.service";

// C3b (PLAN-F2-v2 section 2.5, owner decision Q6 = Yes): on a Dropship eBay
// destination every row is its own single-variant provider listing, so a row
// whose only problem is a missing stock link is isolated alone and its linked
// siblings keep receiving canonical quantity.
// Channels PR1 (PLAN-CH-v3 section 7, owner decision: one unlinked size must not
// freeze its linked sizes) extends this, on purpose, to channel Shopify, Walmart and
// eBay destinations: each of their outbox rows writes one item absolutely. Every
// other destination and every other blocker keeps whole-destination isolation;
// "reject" mode is unchanged.
const HASH = "a".repeat(64);
type PlanTarget = InventoryChannelExposureRuntimePlan["targets"][number];
type PlanRow = PlanTarget["rows"][number];
const MAPPING_MISSING = "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING";
const issue = (code: string) => ({ code, message: `${code} fixture`, context: {} });

function planRow(productVariantId: number, mapped: boolean, extraBlockers: string[] = []): PlanRow {
  return {
    productVariantId, sku: `SKU-${productVariantId}`, unitsPerVariant: 1,
    canonicalAtpUnits: "10", sharedUnits: "10", afterHoldbackUnits: "10", cappedUnits: "10", publishedUnits: String(productVariantId - 100),
    sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
    policy: {
      allocationSemantics: "exposure", eligible: true, shareBps: 10_000, holdbackSellableUnits: "0",
      maxPublishSellableUnits: null, minPublishSellableUnits: "0",
      sources: { allocationSemantics: "channel:40", eligible: "channel:40", shareBps: "channel:40",
        holdbackSellableUnits: "channel:40", maxPublishSellableUnits: "channel:40", minPublishSellableUnits: "channel:40" },
    },
    mapping: mapped ? { mappingId: productVariantId, version: 1, definitionHash: HASH,
      externalInventoryItemId: `SKU-${productVariantId}`, externalSku: `SKU-${productVariantId}` } : null,
    hold: null,
    blockers: [...(mapped ? [] : [issue(MAPPING_MISSING)]), ...extraBlockers.map(issue)],
    warnings: [],
  } as PlanRow;
}

function planTarget(input: { id: number; kind: "channel_connection" | "dropship_store_connection"; provider: string;
  rows: PlanRow[]; targetBlockers?: string[] }): PlanTarget {
  const blockers = (input.targetBlockers ?? []).map(issue);
  return {
    publicationTargetId: input.id, publicationTargetRevision: "3", destinationKind: input.kind,
    channelId: 40, channelName: `Target ${input.id}`, channelProvider: input.provider,
    channelConnectionId: input.kind === "channel_connection" ? 9 : null,
    dropshipStoreConnectionId: input.kind === "dropship_store_connection" ? 22 : null,
    providerScopeType: "account", externalScopeId: `account-${input.id}`,
    publicationAuthority: "echelon", publicationTargetState: "live",
    sourceBinding: { bindingId: 7, version: 1, definitionHash: HASH, fulfillmentNodeIds: [1], warehouseIds: [1] },
    selectedPolicies: [{ scopeKey: "channel:40", policyId: 1, version: 1, definitionHash: HASH }],
    rows: input.rows, blockers,
    publishable: input.rows.length > 0 && blockers.length === 0 && input.rows.every(row => row.blockers.length === 0 && row.mapping !== null),
  } as PlanTarget;
}

function activeTarget(target: PlanTarget, mappedVariantIds: number[]): ActiveInventoryPublicationTarget {
  return {
    publicationTargetId: target.publicationTargetId, publicationTargetRevision: target.publicationTargetRevision,
    channelId: target.channelId, channelName: target.channelName, providerKey: target.channelProvider.toLowerCase(),
    destinationKind: target.destinationKind, channelConnectionId: target.channelConnectionId,
    dropshipStoreConnectionId: target.dropshipStoreConnectionId, providerScopeType: target.providerScopeType,
    externalScopeId: target.externalScopeId, sourceBindingId: 7, sourceWarehouseIds: [1],
    mappings: mappedVariantIds.map(productVariantId => ({ productVariantId,
      externalInventoryItemId: `SKU-${productVariantId}`, externalSku: `SKU-${productVariantId}` })),
  };
}

function setup(targets: PlanTarget[], options: { unmanaged?: number[]; zeroTargets?: ActiveInventoryPublicationTarget[] } = {}) {
  const context = {
    authority: "canonical", authorityRevision: "9", activationRunId: "44",
    listActivePublicationProductIds: vi.fn(async () => [10]),
    listUnmanagedPublicationVariantIds: vi.fn(async () => options.unmanaged ?? []),
    planProduct: vi.fn(async (): Promise<InventoryChannelExposureRuntimePlan> => ({
      authority: "canonical", authorityRevision: "9", activationRunId: "44", productId: 10,
      snapshotFingerprint: HASH, snapshotCapturedAt: "2026-10-21T12:00:00.000Z", targets,
      providerWriteAttempted: false, outboxEnqueued: false,
    } as InventoryChannelExposureRuntimePlan)),
    loadActivePublicationTargets: vi.fn(async () => options.zeroTargets ?? []),
    enqueueFullPublications: vi.fn(async (_runId: string, intents: readonly unknown[]) => ({
      enqueuedRows: intents.length, coalescedRows: 0, enqueuedPublicationKeys: [], coalescedPublicationKeys: [] })),
  } satisfies InventoryAvailabilityRuntimePublicationContext;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new AuthorityAwareInventoryPublicationService({ execute: work => work(context) }, undefined, logger);
  const isolate = async () => {
    const routed = await service.publishProduct({ productId: 10, dryRun: false, triggeredBy: "test_fan_out", blockedTargets: "isolate" }, vi.fn());
    if (routed.authority !== "canonical") throw new Error("Expected canonical publication");
    return routed.publication;
  };
  return { context, logger, service, isolate };
}

const pairs = (rows: ReadonlyArray<{ publicationTargetId: number; productVariantId: number; desiredQuantity: string }>) =>
  rows.map(row => [row.publicationTargetId, row.productVariantId, row.desiredQuantity]);

describe("row isolation for Dropship eBay destinations during fan-out", () => {
  it("publishes the linked listing and isolates only the unlinked sibling row", async () => {
    const { context, logger, isolate } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay",
      rows: [planRow(101, true), planRow(102, false)] })]);
    const publication = await isolate();
    expect(pairs(publication.rows)).toEqual([[8, 101, "1"]]);
    expect(publication.blockedTargets).toEqual([{ publicationTargetId: 8, channelId: 40, channelName: "Target 8",
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: [MAPPING_MISSING], productVariantIds: [102], isolation: "rows" }]);
    expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", [expect.objectContaining({
      publicationTargetId: 8, productVariantId: 101, externalInventoryItemId: "SKU-101", desiredQuantity: "1" })]);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "canonical_inventory_publication_target_isolated", outcome: "rows_skipped", isolation: "rows",
      error_code: "CANONICAL_PUBLICATION_MAPPING_MISSING", publicationTargetId: 8, productVariantIds: [102] }));
  });

  it("matches the store platform case-insensitively", async () => {
    const { isolate } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "EBAY",
      rows: [planRow(101, true), planRow(102, false)] })]);
    const publication = await isolate();
    expect(pairs(publication.rows)).toEqual([[8, 101, "1"]]);
    expect(publication.blockedTargets?.[0]).toMatchObject({ isolation: "rows", productVariantIds: [102] });
  });

  it("isolates the whole destination when an unlinked row also has another blocker", async () => {
    const { isolate } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay",
      rows: [planRow(101, true), planRow(102, false, ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"])] })]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets).toEqual([expect.objectContaining({ publicationTargetId: 8, isolation: "target",
      blockerCodes: ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE", MAPPING_MISSING], productVariantIds: [102] })]);
  });

  it("isolates the whole destination when a linked row has a blocker of its own", async () => {
    const { isolate } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay",
      rows: [planRow(101, true, ["PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT"]), planRow(102, false)] })]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets?.[0]).toMatchObject({ isolation: "target", productVariantIds: [101, 102] });
  });

  it("isolates the whole destination for a destination-level blocker", async () => {
    const { isolate } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay",
      rows: [planRow(101, true), planRow(102, false)], targetBlockers: ["CHANNEL_SOURCE_NODE_NOT_ACTIVE"] })]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets?.[0]).toMatchObject({ isolation: "target", errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
  });

  it.each([
    { label: "a Dropship Shopify destination", kind: "dropship_store_connection" as const, provider: "shopify" },
    { label: "a Dropship Walmart destination", kind: "dropship_store_connection" as const, provider: "walmart" },
    { label: "a channel destination of another provider", kind: "channel_connection" as const, provider: "manual" },
  ])("keeps whole-destination isolation for $label", async ({ kind, provider }) => {
    const { isolate } = setup([planTarget({ id: 8, kind, provider, rows: [planRow(101, true), planRow(102, false)] })]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets).toEqual([expect.objectContaining({ publicationTargetId: 8, isolation: "target",
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", productVariantIds: [102] })]);
  });

  it("keeps rejecting in the default mode for a Dropship eBay destination", async () => {
    const { context, service } = setup([planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay",
      rows: [planRow(101, true), planRow(102, false)] })]);
    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING", context: { publicationTargetId: 8 } });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("still publishes a rows-isolated destination's other targets and keeps a broken channel destination whole", async () => {
    const { isolate } = setup([
      planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay", rows: [planRow(101, true), planRow(102, false)] }),
      // Unlinked AND a policy problem: never half-published.
      planTarget({ id: 9, kind: "channel_connection", provider: "ebay",
        rows: [planRow(101, true), planRow(102, false, ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"])] }),
      planTarget({ id: 10, kind: "channel_connection", provider: "shopify", rows: [planRow(101, true), planRow(102, true)] }),
    ]);
    const publication = await isolate();
    expect(pairs(publication.rows)).toEqual([[8, 101, "1"], [10, 101, "1"], [10, 102, "2"]]);
    expect(publication.blockedTargets?.map(entry => [entry.publicationTargetId, entry.isolation, entry.productVariantIds]))
      .toEqual([[8, "rows", [102]], [9, "target", [102]]]);
  });

  it("applies the same per-row filter to retained zero obligations", async () => {
    const dropship = planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay", rows: [planRow(101, true), planRow(102, false)] });
    const channel = planTarget({ id: 9, kind: "channel_connection", provider: "ebay", rows: [planRow(101, true)] });
    // 103 is retained on both destinations and linked on both; 104 is retained but unlinked on both.
    const { context, isolate } = setup([dropship, channel], { unmanaged: [103, 104],
      zeroTargets: [activeTarget(dropship, [101, 103]), activeTarget(channel, [101, 103])] });
    const publication = await isolate();
    expect(context.loadActivePublicationTargets).toHaveBeenCalledTimes(2);
    // Channels PR1: the channel eBay destination now withholds only its unlinked retained 104 too.
    expect(pairs(publication.rows)).toEqual([[8, 101, "1"], [9, 101, "1"], [8, 103, "0"], [9, 103, "0"]]);
    expect(publication.blockedTargets?.map(entry => [entry.publicationTargetId, entry.isolation, entry.productVariantIds]))
      .toEqual([[8, "rows", [102, 104]], [9, "rows", [104]]]);
  });

  it("does not let a rows isolation hide a later whole-destination isolation of the same target", async () => {
    const dropship = planTarget({ id: 8, kind: "dropship_store_connection", provider: "ebay", rows: [planRow(101, true), planRow(102, false)] });
    // A Dropship Shopify zero target with the same id would be a whole-target block.
    const shopifyShaped = { ...activeTarget(dropship, [101]), providerKey: "shopify" };
    const { isolate } = setup([dropship], { unmanaged: [104], zeroTargets: [shopifyShaped] });
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets).toEqual([expect.objectContaining({ publicationTargetId: 8, isolation: "target",
      productVariantIds: [102, 104] })]);
  });
});

describe("row isolation for channel Shopify, Walmart and eBay destinations during fan-out (Channels PR1)", () => {
  const channels = [
    { provider: "shopify" }, { provider: "walmart" }, { provider: "ebay" }, { provider: "Shopify" },
  ];

  it.each(channels)("publishes the two linked sizes and withholds only the unlinked one on a channel $provider destination", async ({ provider }) => {
    const { context, logger, isolate } = setup([planTarget({ id: 12, kind: "channel_connection", provider,
      rows: [planRow(101, true), planRow(102, false), planRow(103, true)] })]);
    const publication = await isolate();
    expect(pairs(publication.rows)).toEqual([[12, 101, "1"], [12, 103, "3"]]);
    expect(publication.blockedTargets).toEqual([{ publicationTargetId: 12, channelId: 40, channelName: "Target 12",
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: [MAPPING_MISSING], productVariantIds: [102], isolation: "rows" }]);
    expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", [
      expect.objectContaining({ publicationTargetId: 12, productVariantId: 101, externalInventoryItemId: "SKU-101" }),
      expect.objectContaining({ publicationTargetId: 12, productVariantId: 103, externalInventoryItemId: "SKU-103" })]);
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      event: "canonical_inventory_publication_target_isolated", outcome: "rows_skipped", isolation: "rows",
      error_code: "CANONICAL_PUBLICATION_MAPPING_MISSING", publicationTargetId: 12, productVariantIds: [102] }));
  });

  it.each([
    { label: "an unlinked size also has a policy blocker", rows: () => [planRow(101, true), planRow(102, false, ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"]), planRow(103, true)] },
    { label: "a linked size has a selection blocker", rows: () => [planRow(101, true), planRow(102, false), planRow(103, true, ["CHANNEL_SELECTION_MAPPING_QUARANTINED"])] },
    { label: "a linked size has a partition blocker", rows: () => [planRow(101, true, ["PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT"]), planRow(102, false), planRow(103, true)] },
  ])("still withholds the whole channel destination when $label", async ({ rows }) => {
    for (const provider of ["shopify", "walmart", "ebay"]) {
      const { context, isolate } = setup([planTarget({ id: 12, kind: "channel_connection", provider, rows: rows() })]);
      const publication = await isolate();
      expect(publication.rows).toEqual([]);
      expect(publication.blockedTargets).toEqual([expect.objectContaining({ publicationTargetId: 12, isolation: "target" })]);
      expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", []);
    }
  });

  it.each(["shopify", "walmart", "ebay"])("still withholds the whole channel %s destination for a destination-level blocker", async (provider) => {
    const { isolate } = setup([planTarget({ id: 12, kind: "channel_connection", provider,
      rows: [planRow(101, true), planRow(102, false), planRow(103, true)], targetBlockers: ["CHANNEL_SOURCE_NODE_NOT_ACTIVE"] })]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets?.[0]).toMatchObject({ isolation: "target", productVariantIds: [102] });
  });

  it.each(["shopify", "walmart", "ebay"])("still withholds the whole channel %s destination without a sealed source binding", async (provider) => {
    const target = { ...planTarget({ id: 12, kind: "channel_connection", provider,
      rows: [planRow(101, true), planRow(102, false), planRow(103, true)] }), sourceBinding: null } as unknown as PlanTarget;
    const { isolate } = setup([target]);
    const publication = await isolate();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets?.[0]).toMatchObject({ publicationTargetId: 12, isolation: "target" });
  });

  it.each(["shopify", "walmart", "ebay"])("keeps rejecting in the default mode for a channel %s destination", async (provider) => {
    const { context, service } = setup([planTarget({ id: 12, kind: "channel_connection", provider,
      rows: [planRow(101, true), planRow(102, false)] })]);
    await expect(service.publishProduct({ productId: 10, dryRun: false }, vi.fn()))
      .rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING", context: { publicationTargetId: 12 } });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("withholds only an unlinked retained size's zero on a channel destination", async () => {
    const shopify = planTarget({ id: 12, kind: "channel_connection", provider: "shopify", rows: [planRow(101, true)] });
    const { isolate } = setup([shopify], { unmanaged: [103, 104], zeroTargets: [activeTarget(shopify, [101, 103])] });
    const publication = await isolate();
    expect(pairs(publication.rows)).toEqual([[12, 101, "1"], [12, 103, "0"]]);
    expect(publication.blockedTargets?.map(entry => [entry.publicationTargetId, entry.isolation, entry.productVariantIds]))
      .toEqual([[12, "rows", [104]]]);
  });
});
