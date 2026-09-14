import { describe, expect, it } from "vitest";

import {
  inventoryPublicationTargetResumeReadinessHash,
  type InventoryPublicationTargetResumeReadinessMaterial,
} from "../../infrastructure/inventory-publication-target-resume.repository";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

describe("inventory publication target resume readiness hash", () => {
  it("binds exact target, authority, configuration, supply, desired rows, and readback state", () => {
    const baseline = material();
    const baselineHash = inventoryPublicationTargetResumeReadinessHash(baseline);

    const changes: InventoryPublicationTargetResumeReadinessMaterial[] = [
      { ...baseline, publicationTargetRevision: "4" },
      { ...baseline, authorityRevision: "10" },
      { ...baseline, configurationHash: HASH_B },
      {
        ...baseline,
        products: baseline.products.map((product) => ({ ...product, snapshotFingerprint: HASH_B })),
      },
      {
        ...baseline,
        products: baseline.products.map((product) => ({
          ...product,
          desiredRows: product.desiredRows.map((row) => ({ ...row, publishedUnits: "3" })),
        })),
      },
      {
        ...baseline,
        products: baseline.products.map((product) => ({
          ...product,
          readbacks: product.readbacks.map((readback) => ({ ...readback, observedQuantity: "3" })),
        })),
      },
      {
        ...baseline,
        identityCensus: baseline.identityCensus.map((identity) => ({
          ...identity,
          externalInventoryItemId: "inventory-item-102",
        })),
      },
    ];

    expect(baselineHash).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of changes) {
      expect(inventoryPublicationTargetResumeReadinessHash(changed)).not.toBe(baselineHash);
    }
  });

  it("is deterministic and intentionally excludes operator reason and wall-clock metadata", () => {
    const baseline = material();
    expect(inventoryPublicationTargetResumeReadinessHash(structuredClone(baseline)))
      .toBe(inventoryPublicationTargetResumeReadinessHash(baseline));
    expect(Object.keys(baseline)).not.toContain("reason");
    expect(Object.keys(baseline)).not.toContain("capturedAt");
    expect(Object.keys(baseline)).not.toContain("requestedBy");
  });
});

function material(): InventoryPublicationTargetResumeReadinessMaterial {
  return {
    publicationTargetId: 5,
    publicationTargetRevision: "3",
    authorityRevision: "9",
    activationRunId: "44",
    configurationHash: HASH_A,
    identityCensus: [{
      productId: 10,
      productVariantId: 101,
      externalInventoryItemId: "inventory-item-101",
      evidenceSources: ["active_mapping", "outbox", "readback"],
      coveredByCurrentMapping: true,
    }],
    products: [{
      productId: 10,
      snapshotFingerprint: HASH_A,
      desiredRows: [{
        productVariantId: 101,
        externalInventoryItemId: "inventory-item-101",
        publishedUnits: "4",
      }],
      readbacks: [{
        productVariantId: 101,
        externalInventoryItemId: "inventory-item-101",
        observedQuantity: "4",
        observedAt: "2026-09-14T11:55:00.000Z",
        evidenceHash: HASH_A,
      }],
    }],
  };
}
