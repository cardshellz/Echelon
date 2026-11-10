import { beforeEach, describe, expect, it, vi } from "vitest";

// 2026-11-10, GLV-GRD-SGC-JRSY (product 324): the case variant was changed
// from 1000 to 2000 units after its rule "1 case = 50 packs of 20" was
// approved. Evaluating the CURRENT rule then throws
// SUPPLY_SNAPSHOT_REFERENCE_INVALID, which used to abort the review of the
// draft that fixes it. The current side must degrade to "unavailable"; the
// proposed side must still be fully validated.

const { preview, projectCanonicalAtp } = vi.hoisted(() => ({ preview: vi.fn(), projectCanonicalAtp: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {} }));
vi.mock("../../infrastructure/inventory-availability-shadow.repository", () => ({
  captureActiveSupplySnapshotInsideTransaction: vi.fn(async () => CURRENT),
  captureProductDraftReviewSnapshotInsideTransaction: vi.fn(),
}));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  previewProductDefinitionPublicationInsideTransaction: preview,
  createTransactionScopedInventoryPublicationService: () => ({ publishProduct: vi.fn() }),
}));
vi.mock("../../domain/inventory-availability-planner", async importOriginal => ({
  ...(await importOriginal<typeof import("../../domain/inventory-availability-planner")>()),
  projectCanonicalAtp,
}));

import { InventoryAvailabilityPlannerError } from "../../domain/inventory-availability-planner";
import { captureDefinitionImpact, STALE_ACTIVE_RULE_NOTICE } from "../../infrastructure/inventory-product-definition.repository";

const variant = { id: 774, productId: 324, sku: "GLV-GRD-SGC-JRSY-C2000", isActive: true, salesEligibility: "sellable" };
const warehouse = { id: 1, code: "MAIN", isActive: true };
const CURRENT = { snapshotFingerprint: "a".repeat(64), variants: [variant], warehouses: [warehouse], marker: "current" };
const PROPOSED = { snapshotFingerprint: "b".repeat(64), variants: [variant], warehouses: [warehouse], marker: "proposed" };
const stale = () => new InventoryAvailabilityPlannerError("SUPPLY_SNAPSHOT_REFERENCE_INVALID",
  "A path source unit snapshot does not match its captured variant.", { field: "transformationPaths.sourceUnitsPerVariant", value: 1000 });
const row = { publicationTargetId: 1, productVariantId: 774, channelName: "Shopify", sku: variant.sku, desiredQuantity: "25", blockerCodes: [] };

describe("product definition review when the approved rule is stale", () => {
  beforeEach(() => { preview.mockReset(); projectCanonicalAtp.mockReset(); });

  it("reports current figures as unavailable with a notice, and still reviews the draft", async () => {
    projectCanonicalAtp.mockImplementation((snapshot: { marker: string }) => {
      if (snapshot.marker === "current") throw stale();
      return { atpUnits: "25", blockers: [] };
    });
    preview.mockImplementation(async (_client: unknown, _id: number, snapshot: { marker: string }) => {
      if (snapshot.marker === "current") throw stale();
      return { rows: [row], blockedTargets: [] };
    });
    const impact = await captureDefinitionImpact({} as never, [324], async () => PROPOSED as never);
    expect(impact.blockers).toEqual([]);
    expect(impact.notices).toEqual([STALE_ACTIVE_RULE_NOTICE]);
    expect(impact.atp).toEqual([expect.objectContaining({ variantId: 774, current: null, proposed: "25" })]);
    expect(impact.channels).toEqual([expect.objectContaining({ variantId: 774, current: null, proposed: "25" })]);
  });

  it("still blocks when the PROPOSED draft is invalid", async () => {
    projectCanonicalAtp.mockImplementation(() => { throw stale(); });
    preview.mockResolvedValue({ rows: [row], blockedTargets: [] });
    await expect(captureDefinitionImpact({} as never, [324], async () => PROPOSED as never))
      .rejects.toMatchObject({ code: "SUPPLY_SNAPSHOT_REFERENCE_INVALID" });
  });

  it("does not swallow any other error on the current side", async () => {
    projectCanonicalAtp.mockImplementation((snapshot: { marker: string }) => {
      if (snapshot.marker === "current") throw new InventoryAvailabilityPlannerError("SUPPLY_SNAPSHOT_INVALID", "other", {});
      return { atpUnits: "25", blockers: [] };
    });
    preview.mockResolvedValue({ rows: [row], blockedTargets: [] });
    await expect(captureDefinitionImpact({} as never, [324], async () => PROPOSED as never))
      .rejects.toMatchObject({ code: "SUPPLY_SNAPSHOT_INVALID" });
    projectCanonicalAtp.mockReturnValue({ atpUnits: "25", blockers: [] });
    preview.mockImplementation(async (_c: unknown, _i: number, snapshot: { marker: string }) => {
      if (snapshot.marker === "current") throw new Error("database down");
      return { rows: [row], blockedTargets: [] };
    });
    await expect(captureDefinitionImpact({} as never, [324], async () => PROPOSED as never)).rejects.toThrow("database down");
  });

  it("gives a stale and a healthy current rule different review fingerprints", async () => {
    projectCanonicalAtp.mockReturnValue({ atpUnits: "25", blockers: [] });
    preview.mockResolvedValue({ rows: [row], blockedTargets: [] });
    const healthy = await captureDefinitionImpact({} as never, [324], async () => PROPOSED as never);
    preview.mockImplementation(async (_c: unknown, _i: number, snapshot: { marker: string }) => {
      if (snapshot.marker === "current") throw stale();
      return { rows: [row], blockedTargets: [] };
    });
    const staleImpact = await captureDefinitionImpact({} as never, [324], async () => PROPOSED as never);
    expect(staleImpact.fingerprints).not.toEqual(healthy.fingerprints);
    expect(healthy.notices).toEqual([]);
  });
});
