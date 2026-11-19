import { describe, expect, it, vi } from "vitest";
import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import {
  AuthorityAwareInventoryPublicationService,
  type ActiveInventoryPublicationTarget,
  type InventoryAvailabilityRuntimePublicationContext,
} from "../../application/inventory-availability-runtime-publication.service";

// Channels PR2 (PLAN-CH2 v4.1 §4.5 N1, SAF-8, TST-1): a service built with `isolateMissingStockLinks` stays in reject
// mode but withholds exactly the rows fan-out row isolation withholds (rowIsolatedVariantIds): on a row-isolable,
// clean destination, the rows blocked solely by their missing stock link. Everything else refuses as reject mode does.
// Target enable of a channel Shopify destination is its only user.
const HASH = "a".repeat(64);
const MAPPING_MISSING = "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING";
type PlanTarget = InventoryChannelExposureRuntimePlan["targets"][number];
type PlanRow = PlanTarget["rows"][number];
const issue = (code: string) => ({ code, message: `${code} fixture`, context: {} });

function planRow(productVariantId: number, mapped: boolean, extraBlockers: string[] = []): PlanRow {
  return {
    productVariantId, sku: `SKU-${productVariantId}`, unitsPerVariant: 1,
    canonicalAtpUnits: "10", sharedUnits: "10", afterHoldbackUnits: "10", cappedUnits: "10", publishedUnits: String(productVariantId - 100),
    sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "10" }],
    policy: {
      allocationSemantics: "exposure", eligible: true, shareBps: 10_000, holdbackSellableUnits: "0",
      maxPublishSellableUnits: null, minPublishSellableUnits: "0",
      sources: { allocationSemantics: "channel:35", eligible: "channel:35", shareBps: "channel:35",
        holdbackSellableUnits: "channel:35", maxPublishSellableUnits: "channel:35", minPublishSellableUnits: "channel:35" },
    },
    mapping: mapped ? { mappingId: productVariantId, version: 1, definitionHash: HASH,
      externalInventoryItemId: `${productVariantId}000`, externalSku: `SKU-${productVariantId}` } : null,
    hold: null,
    blockers: [...(mapped ? [] : [issue(MAPPING_MISSING)]), ...extraBlockers.map(issue)],
    warnings: [],
  } as PlanRow;
}

function planTarget(input: { id: number; kind?: "channel_connection" | "dropship_store_connection"; provider?: string;
  rows: PlanRow[]; targetBlockers?: string[]; sourceBinding?: boolean }): PlanTarget {
  const blockers = (input.targetBlockers ?? []).map(issue);
  const kind = input.kind ?? "channel_connection";
  return {
    publicationTargetId: input.id, publicationTargetRevision: "3", destinationKind: kind,
    channelId: 35, channelName: `Target ${input.id}`, channelProvider: input.provider ?? "shopify",
    channelConnectionId: kind === "channel_connection" ? 7 : null,
    dropshipStoreConnectionId: kind === "dropship_store_connection" ? 22 : null,
    providerScopeType: "location", externalScopeId: `location-${input.id}`,
    publicationAuthority: "echelon", publicationTargetState: "live",
    sourceBinding: input.sourceBinding === false ? null
      : { bindingId: 7, version: 1, definitionHash: HASH, fulfillmentNodeIds: [1], warehouseIds: [1] },
    selectedPolicies: [{ scopeKey: "channel:35", policyId: 1, version: 1, definitionHash: HASH }],
    rows: input.rows, blockers,
    publishable: input.rows.length > 0 && blockers.length === 0 && input.rows.every(row => row.blockers.length === 0 && row.mapping !== null),
  } as PlanTarget;
}

function zeroTarget(target: PlanTarget, mappedVariantIds: number[]): ActiveInventoryPublicationTarget {
  return {
    publicationTargetId: target.publicationTargetId, publicationTargetRevision: target.publicationTargetRevision,
    channelId: target.channelId, channelName: target.channelName, providerKey: target.channelProvider.toLowerCase(),
    destinationKind: target.destinationKind, channelConnectionId: target.channelConnectionId,
    dropshipStoreConnectionId: target.dropshipStoreConnectionId, providerScopeType: target.providerScopeType,
    externalScopeId: target.externalScopeId, sourceBindingId: 7, sourceWarehouseIds: [1],
    mappings: mappedVariantIds.map(productVariantId => ({ productVariantId,
      externalInventoryItemId: `${productVariantId}000`, externalSku: `SKU-${productVariantId}` })),
  };
}

function setup(targets: PlanTarget[], options: { isolateMissingStockLinks?: boolean; unmanaged?: number[];
  zeroTargets?: ActiveInventoryPublicationTarget[] } = {}) {
  const context = {
    authority: "canonical", authorityRevision: "9", activationRunId: "44",
    listActivePublicationProductIds: vi.fn(async () => [20]),
    listUnmanagedPublicationVariantIds: vi.fn(async () => options.unmanaged ?? []),
    planProduct: vi.fn(async (): Promise<InventoryChannelExposureRuntimePlan> => ({
      authority: "canonical", authorityRevision: "9", activationRunId: "44", productId: 20,
      snapshotFingerprint: HASH, snapshotCapturedAt: "2026-10-27T12:00:00.000Z", targets,
      providerWriteAttempted: false, outboxEnqueued: false,
    } as InventoryChannelExposureRuntimePlan)),
    loadActivePublicationTargets: vi.fn(async () => options.zeroTargets ?? []),
    enqueueFullPublications: vi.fn(async (_runId: string, intents: readonly unknown[]) => ({
      enqueuedRows: intents.length, coalescedRows: 0, enqueuedPublicationKeys: [], coalescedPublicationKeys: [] })),
  } satisfies InventoryAvailabilityRuntimePublicationContext;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new AuthorityAwareInventoryPublicationService({ execute: work => work(context) }, undefined, logger,
    { isolateMissingStockLinks: options.isolateMissingStockLinks ?? true });
  const publish = async (publicationTargetId = 12) => {
    const routed = await service.publishProduct({ productId: 20, publicationTargetId, dryRun: false, triggeredBy: "stock_updates_enabled" }, vi.fn());
    if (routed.authority !== "canonical") throw new Error("Expected canonical publication");
    return routed.publication;
  };
  return { context, logger, publish };
}

const pairs = (rows: ReadonlyArray<{ publicationTargetId: number; productVariantId: number; desiredQuantity: string }>) =>
  rows.map(row => [row.publicationTargetId, row.productVariantId, row.desiredQuantity]);

describe("isolateMissingStockLinks (N1): reject mode that withholds only unlinked rows", () => {
  it("withholds the unlinked size of a channel Shopify destination, sends the linked ones and reports the withheld rows", async () => {
    const { context, logger, publish } = setup([planTarget({ id: 12, rows: [planRow(101, true), planRow(102, false), planRow(103, true)] })]);
    const publication = await publish();
    expect(pairs(publication.rows)).toEqual([[12, 101, "1"], [12, 103, "3"]]);
    expect(publication.blockedTargets).toEqual([{ publicationTargetId: 12, channelId: 35, channelName: "Target 12",
      errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: [MAPPING_MISSING], productVariantIds: [102], isolation: "rows" }]);
    expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", [
      expect.objectContaining({ productVariantId: 101 }), expect.objectContaining({ productVariantId: 103 })]);
    // A wait for a link is expected: INFO, never the fan-out's ERROR.
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "canonical_inventory_publication_rows_withheld",
      outcome: "rows_withheld", publicationTargetId: 12, productVariantIds: [102] }));
  });

  it("withholds every row when no size is linked, leaving the decision to the caller", async () => {
    const { context, publish } = setup([planTarget({ id: 12, rows: [planRow(101, false), planRow(102, false)] })]);
    const publication = await publish();
    expect(publication.rows).toEqual([]);
    expect(publication.blockedTargets).toEqual([expect.objectContaining({ isolation: "rows", productVariantIds: [101, 102] })]);
    expect(context.enqueueFullPublications).toHaveBeenCalledExactlyOnceWith("44", []);
  });

  it("reports an empty withheld list when every size is linked", async () => {
    const { publish } = setup([planTarget({ id: 12, rows: [planRow(101, true), planRow(102, true)] })]);
    const publication = await publish();
    expect(pairs(publication.rows)).toEqual([[12, 101, "1"], [12, 102, "2"]]);
    expect(publication.blockedTargets).toEqual([]);
  });

  it.each([
    { label: "an unlinked size also has a policy blocker", rows: () => [planRow(101, true), planRow(102, false, ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE"])] },
    { label: "an unlinked size also has a selection blocker", rows: () => [planRow(101, true), planRow(102, false, ["CHANNEL_SELECTION_MAPPING_QUARANTINED"])] },
    { label: "a linked size has a blocker of its own", rows: () => [planRow(101, true, ["PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT"]), planRow(102, false)] },
  ])("still refuses the whole call when $label", async ({ rows }) => {
    const { context, publish } = setup([planTarget({ id: 12, rows: rows() })]);
    await expect(publish()).rejects.toMatchObject({ name: "InventoryAvailabilityRuntimePublicationError" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("still refuses for a destination-level blocker or a missing source binding", async () => {
    for (const target of [
      planTarget({ id: 12, rows: [planRow(101, true), planRow(102, false)], targetBlockers: ["CHANNEL_SOURCE_NODE_NOT_ACTIVE"] }),
      planTarget({ id: 12, rows: [planRow(101, true), planRow(102, false)], sourceBinding: false }),
    ]) {
      const { context, publish } = setup([target]);
      await expect(publish()).rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
      expect(context.enqueueFullPublications).not.toHaveBeenCalled();
    }
  });

  it.each([
    { label: "a channel destination of a provider without row isolation", kind: "channel_connection" as const, provider: "manual" },
    { label: "a Dropship Shopify destination", kind: "dropship_store_connection" as const, provider: "shopify" },
  ])("refuses an unlinked size on $label (precedent runtime-publication-row-isolation.test.ts)", async ({ kind, provider }) => {
    const { context, publish } = setup([planTarget({ id: 12, kind, provider, rows: [planRow(101, true), planRow(102, false)] })]);
    await expect(publish()).rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING", context: { publicationTargetId: 12 } });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("withholds an unlinked retained (zero) size on a row-isolable destination, as fan-out does", async () => {
    const shopify = planTarget({ id: 12, rows: [planRow(101, true)] });
    const { publish } = setup([shopify], { unmanaged: [103, 104], zeroTargets: [zeroTarget(shopify, [101, 103])] });
    const publication = await publish();
    expect(pairs(publication.rows)).toEqual([[12, 101, "1"], [12, 103, "0"]]);
    expect(publication.blockedTargets).toEqual([expect.objectContaining({ isolation: "rows", productVariantIds: [104] })]);
  });

  it("refuses an unlinked retained size on a destination without row isolation", async () => {
    const manual = planTarget({ id: 12, provider: "manual", rows: [planRow(101, true)] });
    const { publish } = setup([manual], { unmanaged: [104], zeroTargets: [zeroTarget(manual, [101])] });
    await expect(publish()).rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
  });

  it("is reject mode without the option: an unlinked size refuses the call (unchanged)", async () => {
    const { context, publish } = setup([planTarget({ id: 12, rows: [planRow(101, true), planRow(102, false)] })],
      { isolateMissingStockLinks: false });
    await expect(publish()).rejects.toMatchObject({ code: "CANONICAL_PUBLICATION_MAPPING_MISSING" });
    expect(context.enqueueFullPublications).not.toHaveBeenCalled();
  });

  it("keeps blockedTargets out of a reject-mode result without the option (unchanged result shape)", async () => {
    const { publish } = setup([planTarget({ id: 12, rows: [planRow(101, true)] })], { isolateMissingStockLinks: false });
    expect(await publish()).not.toHaveProperty("blockedTargets");
  });
});
