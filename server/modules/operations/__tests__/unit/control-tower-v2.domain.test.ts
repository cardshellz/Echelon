import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  controlTowerFingerprint,
  projectSourceRows,
  type ControlTowerSourceAdapter,
  type ProjectedControlTowerWorkItem,
} from "../../control-tower-v2.domain";
import {
  channelFulfillmentSource,
  inventoryIntegritySource,
} from "../../control-tower-v2.sources";

function projectedItem(sourceKey: string): ProjectedControlTowerWorkItem {
  const base = {
    sourceNamespace: "test.source",
    sourceType: "test_finding",
    sourceKey,
    projectionVersion: 1,
    domain: "inventory" as const,
    code: "test_code",
    entityType: "test_entity",
    entityId: sourceKey,
    entityRef: `Entity ${sourceKey}`,
    correlationId: null,
    rootCauseGroupKey: "test:test_code",
    title: "Test finding",
    summary: "A test finding exists.",
    expectedState: "The invariant holds.",
    actualState: "The invariant does not hold.",
    severity: "high" as const,
    urgency: "normal" as const,
    impactTags: ["inventory"],
    actionability: "investigate" as const,
    sourceStatus: "open" as const,
    ownerTeam: "Warehouse",
    recommendedAction: "Investigate the source evidence.",
    responseDueAt: null,
    firstSeenAt: "2026-07-10T12:00:00.000Z",
    lastSeenAt: "2026-07-10T12:00:00.000Z",
    lastChangedAt: "2026-07-10T12:00:00.000Z",
    occurrenceCount: 1,
    recurrenceCount: 0,
    worsenedCount: 0,
    evidenceSummary: { id: sourceKey },
    detailLocator: {},
    availableActions: [],
    sourceUpdatedAt: "2026-07-10T12:00:00.000Z",
    observedMetric: "1",
  };
  return { ...base, sourceFingerprint: controlTowerFingerprint(base) };
}

describe("Control Tower V2 domain", () => {
  it("canonicalizes object keys before hashing source evidence", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(controlTowerFingerprint({ a: 1, b: 2 })).toBe(controlTowerFingerprint({ b: 2, a: 1 }));
  });

  it("marks a scan incomplete when one source row cannot be projected", () => {
    const adapter: ControlTowerSourceAdapter<{ id: string; valid: boolean }> = {
      name: "test",
      sourceNamespace: "test.source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => [],
      projectRow: (row) => {
        if (!row.valid) throw new Error("invalid source row");
        return projectedItem(row.id);
      },
    };
    const result = projectSourceRows({
      adapter,
      rows: [{ id: "1", valid: true }, { id: "2", valid: false }],
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.completeScan).toBe(false);
    expect(result.rowsScanned).toBe(2);
    expect(result.rowsValid).toBe(1);
    expect(result.rowsFailed).toBe(1);
    expect(result.errors).toEqual([{ sourceKey: "2", message: "invalid source row" }]);
  });

  it("rejects duplicate source identities instead of silently overwriting one", () => {
    const adapter: ControlTowerSourceAdapter<{ id: string }> = {
      name: "test",
      sourceNamespace: "test.source",
      sourceType: "test_finding",
      projectionVersion: 1,
      loadRows: async () => [],
      projectRow: (row) => projectedItem(row.id),
    };
    const result = projectSourceRows({
      adapter,
      rows: [{ id: "1" }, { id: "1" }],
      now: new Date("2026-07-10T12:00:00.000Z"),
    });

    expect(result.completeScan).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("duplicate projected source identity");
  });

  it("projects inventory registry evidence into an atomic operator item", () => {
    const item = inventoryIntegritySource.projectRow({
      id: 901,
      check_id: "level_lot_bucket_drift",
      entity_fingerprint: "a".repeat(64),
      category: "balances",
      severity: "blocker",
      status: "open",
      entity_key: { product_variant_id: 232, warehouse_location_id: 1163 },
      current_evidence: { sku: "SHLZ-TOP-35PT-BLU-P25", location_code: "B-09", drift: 2 },
      current_metric: "2",
      first_seen_at: "2026-07-10T10:00:00.000Z",
      last_seen_at: "2026-07-10T12:00:00.000Z",
      last_changed_at: "2026-07-10T11:00:00.000Z",
      occurrence_count: 3,
      recurrence_count: 1,
      worsened_count: 1,
      updated_at: "2026-07-10T12:00:00.000Z",
    }, new Date("2026-07-10T12:00:00.000Z"));

    expect(item).toMatchObject({
      sourceKey: "901",
      domain: "inventory",
      severity: "blocker",
      entityRef: "SHLZ-TOP-35PT-BLU-P25 at B-09",
      occurrenceCount: 3,
      recurrenceCount: 1,
      worsenedCount: 1,
    });
    expect(item.expectedState).toContain("FIFO lots");
    expect(item.actualState).toContain("Drift: 2");
  });

  it("projects each failed channel push by physical shipment identity", () => {
    const item = channelFulfillmentSource.projectRow({
      id: 77,
      oms_order_id: 226353,
      physical_shipment_id: 9113,
      channel_provider: "shopify",
      channel_fulfillment_id: null,
      push_status: "failed",
      attempt_count: 4,
      last_error: "fulfillment order line unavailable",
      metadata: {},
      created_at: "2026-07-10T11:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      external_order_number: "#59381",
      provider_physical_shipment_id: "shipstation_shipment:441680952",
      tracking_number: "382271769741",
      carrier: "FedEx",
      shipping_provider: "shipstation",
      physical_shipment_status: "shipped",
      wms_order_id: 204464,
    }, new Date("2026-07-10T12:00:00.000Z"));

    expect(item).toMatchObject({
      sourceKey: "77",
      domain: "shipping",
      entityType: "physical_shipment",
      entityId: "9113",
      entityRef: "Order #59381 / 382271769741",
      severity: "high",
      occurrenceCount: 5,
    });
    expect(item.actualState).toContain("fulfillment order line unavailable");
  });
});
