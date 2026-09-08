import { describe, expect, it } from "vitest";
import type { ActivationDryRunProduct, InventoryActivationDryRun } from "@shared/types/inventory-availability-phase4";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { inventoryCutoverManifestSchema } from "@shared/types/inventory-cutover-commit";
import { buildInventoryCutoverManifest, inventoryCutoverEvidenceHash } from "../../domain/inventory-cutover-manifest";
import { sealSupplySnapshot } from "../../domain/inventory-availability-planner";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const NOW = "2026-09-07T20:00:00.000Z";

function model(productId = 1, modelId = 10): SupplySnapshotDto["transformationModels"][number] {
  return { productId, modelId, version: 1, lifecycleSelection: "draft_head", lifecycleStatus: "draft",
    buildToPromiseEnabled: false, definitionHash: HASH, validationState: "valid", validationErrors: [], paths: [], recipeBindings: [] };
}
function snapshot(productId = 1, modelId = 10): SupplySnapshotDto {
  return sealSupplySnapshot({ schemaVersion: "inventory_availability_snapshot_v1", capturedAt: NOW, productId,
    legacyInventoryStrategy: "physical_only", variants: [{ id: productId, productId, sku: `SKU-${productId}`,
      name: `Product ${productId}`, unitsPerVariant: 1, isActive: true }],
    warehouses: [{ id: 1, code: "MAIN", isActive: true, hubWarehouseId: null }], locations: [], inventoryPositions: [],
    safetyPolicies: [], demandEvidence: [], transformationModels: [model(productId, modelId)], legacyRecipes: [], outputLocations: [],
    claimProjectionSource: "inventory_levels.reserved_qty" });
}
function reseal(supply: SupplySnapshotDto): SupplySnapshotDto {
  const { snapshotFingerprint: _fingerprint, ...content } = supply;
  return sealSupplySnapshot(content);
}
function product(supply: SupplySnapshotDto): ActivationDryRunProduct {
  const root = supply.transformationModels.find((row) => row.productId === supply.productId)!;
  return { productId: supply.productId, queueState: "approved", status: "ready", draftModelId: root.modelId,
    draftModelVersion: root.version, draftDefinitionHash: root.definitionHash, reviewId: "1", shadowRunId: "2",
    shadowSnapshotFingerprint: supply.snapshotFingerprint, channelPreviewHash: HASH, proposedPublications: [], publicationEvidence: [], blockers: [] };
}
function dryRun(products: ActivationDryRunProduct[]): InventoryActivationDryRun {
  return { activationRunId: "1", mode: "dry_run", scope: "full_catalog", state: "ready_for_publication",
    requestHash: HASH, resultHash: HASH, catalogInputHash: HASH, catalogResultHash: HASH, requestedBy: "operator-1",
    reason: "Review all managed physical products", startedAt: NOW, completedAt: NOW,
    summary: { totalProducts: products.length, readyProducts: products.length, blockedProducts: 0,
      publicationRows: products.reduce((count, row) => count + row.proposedPublications.length, 0) },
    products, blockers: [], runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false, alreadyApplied: false };
}
function publication(targetId = 3, variantId = 4): ActivationDryRunProduct["proposedPublications"][number] {
  return { publicationTargetId: targetId, productVariantId: variantId, channelId: 1, destinationKind: "channel_connection",
    channelConnectionId: 2, dropshipStoreConnectionId: null, channelProvider: "shopify", providerScopeType: "location",
    externalScopeId: "location-1", publicationAuthority: "echelon", publicationTargetRevision: "1", disposition: "publish",
    canonicalAtpUnits: "5", legacyCalculatedUnits: "5", desiredUnits: "5", differenceFromLastAcknowledgedUnits: "0",
    sourceBindingId: 40, sourceBindingVersion: 1, sourceBindingDefinitionHash: HASH, sourceWarehouseIds: [1],
    sourceWarehouseBreakdown: [{ warehouseId: 1, canonicalAtpUnits: "5" }], mappingId: variantId + 50,
    mappingVersion: 1, mappingDefinitionHash: HASH, externalInventoryItemId: `item-${variantId}`, externalSku: `SKU-${variantId}`,
    policySelections: [{ scopeKey: "business", policyId: 60, version: 1, definitionHash: HASH, authority: "draft" }] };
}

describe("reviewed cutover selection manifest", () => {
  it("collects all six definition kinds plus non-sellable graph component models", () => {
    let supply = snapshot();
    supply.transformationModels.push(model(99, 99));
    supply.locations.push({ id: 8, warehouseId: 1, code: "RESERVE", locationType: "reserve", isPickable: false,
      isActive: true, isFrozen: false, promisePolicy: { policyId: 20, version: 1, lifecycleSelection: "draft_head",
        eligibilityMode: "eligible", definitionHash: HASH } });
    supply.safetyPolicies.push({ policyId: 30, version: 1, lifecycleSelection: "draft_head", scopeKey: "business", scopeType: "business",
      productVariantId: null, warehouseId: null, policyMode: "off", fixedUnits: null, daysOfCoverMilliDays: null,
      untrustedDemandFallbackUnits: null, demandMethodVersion: null, definitionHash: HASH });
    supply = reseal(supply);
    const row = product(supply);
    row.proposedPublications.push(publication());
    const result = buildInventoryCutoverManifest(dryRun([row]), [supply]);
    expect(result.productIds).toEqual([1]);
    expect(result.publicationTargetIds).toEqual([3]);
    expect(result.selections).toEqual([
      { kind: "channel_policy", key: "business", definitionId: 60, definitionHash: HASH },
      { kind: "location_policy", key: "8", definitionId: 20, definitionHash: HASH },
      { kind: "model", key: "1", definitionId: 10, definitionHash: HASH },
      { kind: "model", key: "99", definitionId: 99, definitionHash: HASH },
      { kind: "safety_policy", key: "business", definitionId: 30, definitionHash: HASH },
      { kind: "source_binding", key: "3", definitionId: 40, definitionHash: HASH },
      { kind: "variant_mapping", key: "3:4", definitionId: 54, definitionHash: HASH },
    ]);
  });

  it("deduplicates shared definitions and makes selection independent of product/snapshot order", () => {
    let first = snapshot(1, 10);
    let second = snapshot(2, 11);
    first.transformationModels.push(model(99, 99));
    second.transformationModels.push(model(99, 99));
    first = reseal(first);
    second = reseal(second);
    const firstProduct = product(first);
    const secondProduct = product(second);
    firstProduct.proposedPublications.push(publication(3, 4));
    secondProduct.proposedPublications.push(publication(3, 5));
    const forward = buildInventoryCutoverManifest(dryRun([firstProduct, secondProduct]), [first, second]);
    const reverse = buildInventoryCutoverManifest(dryRun([secondProduct, firstProduct]), [second, first]);
    expect(forward).toEqual(reverse);
    expect(inventoryCutoverEvidenceHash(forward)).toBe(inventoryCutoverEvidenceHash(reverse));
    expect(forward.selections.filter((row) => row.kind === "source_binding")).toHaveLength(1);
    expect(forward.selections.filter((row) => row.kind === "model" && row.key === "99")).toHaveLength(1);
  });

  it("does not mutate caller dry run or snapshots", () => {
    const supply = snapshot();
    const run = dryRun([product(supply)]);
    const before = JSON.stringify({ supply, run });
    buildInventoryCutoverManifest(run, [supply]);
    expect(JSON.stringify({ supply, run })).toBe(before);
  });

  it.each(["missing", "duplicate", "extra"])("rejects %s snapshot coverage", (kind) => {
    const supply = snapshot();
    const supplies = kind === "missing" ? [] : kind === "duplicate" ? [supply, supply] : [supply, snapshot(2, 11)];
    expect(() => buildInventoryCutoverManifest(dryRun([product(supply)]), supplies)).toThrowError(
      expect.objectContaining({ code: "CUTOVER_SNAPSHOT_COVERAGE_INVALID" }));
  });

  it("rejects a fingerprint that does not describe the actual snapshot content", () => {
    const supply = snapshot();
    const run = dryRun([product(supply)]);
    supply.snapshotFingerprint = OTHER_HASH;
    expect(() => buildInventoryCutoverManifest(run, [supply])).toThrowError(
      expect.objectContaining({ code: "SUPPLY_SNAPSHOT_FINGERPRINT_MISMATCH" }));
  });

  it("rejects a valid snapshot belonging to a different product", () => {
    expect(() => buildInventoryCutoverManifest(dryRun([product(snapshot())]), [snapshot(2, 11)])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_SNAPSHOT_IDENTITY_CHANGED" }));
  });

  it("rejects changed graph contents retaining the original reviewed fingerprint", () => {
    const supply = snapshot();
    const run = dryRun([product(supply)]);
    supply.transformationModels.push(model(99, 99));
    expect(() => buildInventoryCutoverManifest(run, [supply])).toThrowError(
      expect.objectContaining({ code: "SUPPLY_SNAPSHOT_FINGERPRINT_MISMATCH" }));
  });

  it("rejects a valid self-consistent snapshot with an unreviewed fingerprint", () => {
    const supply = snapshot();
    const run = dryRun([product(supply)]);
    supply.transformationModels.push(model(99, 99));
    expect(() => buildInventoryCutoverManifest(run, [reseal(supply)])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_SNAPSHOT_IDENTITY_CHANGED" }));
  });

  it("rejects a root model missing reviewed definition identity", () => {
    const supply = snapshot();
    const row = product(supply);
    row.draftModelId = null;
    expect(() => buildInventoryCutoverManifest(dryRun([row]), [supply])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_DEFINITION_MISSING", context: { kind: "model", key: "1" } }));
  });

  it.each(["model", "channel_policy", "source_binding"])("rejects conflicting shared %s definitions", (kind) => {
    let first = snapshot(1, 10);
    let second = snapshot(2, 11);
    if (kind === "model") {
      first.transformationModels.push(model(99, 99));
      second.transformationModels.push(model(99, 100));
      first = reseal(first);
      second = reseal(second);
    }
    const firstProduct = product(first);
    const secondProduct = product(second);
    if (kind !== "model") {
      firstProduct.proposedPublications.push(publication(3, 4));
      const conflicting = publication(3, 5);
      if (kind === "channel_policy") conflicting.policySelections[0].definitionHash = OTHER_HASH;
      else conflicting.sourceBindingId = 41;
      secondProduct.proposedPublications.push(conflicting);
    }
    expect(() => buildInventoryCutoverManifest(dryRun([firstProduct, secondProduct]), [first, second])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_DEFINITION_AMBIGUOUS" }));
  });

  it.each(["id", "hash", "version", "missing", "multiple"])("rejects a %s root model mismatch", (kind) => {
    let supply = snapshot();
    if (kind === "multiple") supply.transformationModels.push(model(1, 11));
    supply = reseal(supply);
    const row = product(supply);
    if (kind === "id") row.draftModelId = 11;
    if (kind === "hash") row.draftDefinitionHash = OTHER_HASH;
    if (kind === "version") row.draftModelVersion = 2;
    if (kind === "missing") {
      supply.transformationModels = [];
      supply = reseal(supply);
      // This fixture represents a self-consistent stored snapshot that omitted
      // its reviewed root; no invalid hash is used to hide that omission.
      row.shadowSnapshotFingerprint = supply.snapshotFingerprint;
    }
    expect(() => buildInventoryCutoverManifest(dryRun([row]), [supply])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_ROOT_MODEL_CHANGED" }));
  });

  it("rejects invalid graph references even when content has a valid fingerprint", () => {
    const supply = snapshot();
    supply.locations.push({ id: 8, warehouseId: 99, code: "MISSING-WAREHOUSE", locationType: "reserve", isPickable: false,
      isActive: true, isFrozen: false, promisePolicy: null });
    const sealed = reseal(supply);
    expect(() => buildInventoryCutoverManifest(dryRun([product(sealed)]), [sealed])).toThrowError(
      expect.objectContaining({ code: "SUPPLY_SNAPSHOT_REFERENCE_INVALID" }));
  });

  it("refuses a blocked dry run even when its snapshots are complete", () => {
    const supply = snapshot();
    const row = product(supply);
    row.status = "blocked";
    const run = dryRun([row]);
    run.state = "blocked";
    run.summary.readyProducts = 0;
    run.summary.blockedProducts = 1;
    expect(() => buildInventoryCutoverManifest(run, [supply])).toThrowError(
      expect.objectContaining({ code: "CUTOVER_DRY_RUN_BLOCKED" }));
  });

  it("enforces unique definition keys and sorted catalog identities at the manifest boundary", () => {
    const supply = snapshot();
    const result = buildInventoryCutoverManifest(dryRun([product(supply)]), [supply]);
    expect(inventoryCutoverManifestSchema.safeParse({ ...result, selections: [...result.selections, ...result.selections] }).success).toBe(false);
    expect(inventoryCutoverManifestSchema.safeParse({ ...result, productIds: [2, 1] }).success).toBe(false);
    expect(inventoryCutoverManifestSchema.safeParse({ ...result, publicationTargetIds: [3, 3] }).success).toBe(false);
  });

  it("hashes object fields canonically while preserving semantic quantity changes", () => {
    expect(inventoryCutoverEvidenceHash({ a: 1, b: { x: "2", y: "3" } }))
      .toBe(inventoryCutoverEvidenceHash({ b: { y: "3", x: "2" }, a: 1 }));
    expect(inventoryCutoverEvidenceHash({ quantity: "1" })).not.toBe(inventoryCutoverEvidenceHash({ quantity: "2" }));
  });
});
