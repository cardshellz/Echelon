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
  wmsReconciliationSource,
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

  it("loads order-scoped inventory identity through indexed WMS and OMS keys", async () => {
    let queryText = "";
    const rows = await inventoryIntegritySource.loadRows({
      query: async (text: string) => {
        queryText = text;
        return { rows: [] };
      },
    });

    expect(rows).toEqual([]);
    expect(queryText).toContain("LEFT JOIN LATERAL");
    expect(queryText).toContain("oms_order.external_order_number AS channel_order_number");
    expect(queryText).toContain("oms_order.id = CASE");
    expect(queryText).not.toContain("oms_order.id::text");
  });

  it("uses the sales-channel order number for order-scoped inventory findings", () => {
    const item = inventoryIntegritySource.projectRow({
      id: 902,
      check_id: "active_pick_ledger_drift",
      entity_fingerprint: "b".repeat(64),
      category: "picking",
      severity: "blocker",
      status: "open",
      entity_key: { order_item_id: 311486 },
      current_evidence: {
        order_id: 204632,
        order_number: "internal-order-copy",
        order_item_id: 311486,
        sku: "SHLZ-TOP-180PT-BLU-P10",
        picked_delta: 1,
      },
      current_metric: "1",
      resolved_wms_order_id: 204632,
      wms_order_number: "#59542",
      oms_order_id: 230684,
      channel_order_number: "#59542",
      channel_provider: "shopify",
      first_seen_at: "2026-07-10T10:00:00.000Z",
      last_seen_at: "2026-07-10T12:00:00.000Z",
      last_changed_at: "2026-07-10T11:00:00.000Z",
      occurrence_count: 1,
      recurrence_count: 0,
      worsened_count: 0,
      updated_at: "2026-07-10T12:00:00.000Z",
    }, new Date("2026-07-10T12:00:00.000Z"));

    expect(item).toMatchObject({
      projectionVersion: 2,
      entityRef: "SHLZ-TOP-180PT-BLU-P10",
      evidenceSummary: {
        channelOrderNumber: "#59542",
        omsOrderId: 230684,
        wmsOrderId: 204632,
      },
      detailLocator: {
        links: [{ label: "Open #59542", href: "/orders?orderId=204632" }],
      },
    });
    expect(item.actualState).toContain("External Order Number: #59542");
    expect(item.actualState).not.toContain("internal-order-copy");
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

  it("uses the sales-channel order number for WMS reconciliation work", () => {
    const item = wmsReconciliationSource.projectRow({
      id: 1,
      source: "shipstation_notify",
      classification: "manual_review",
      rule: "ship_notify_no_match",
      status: "open",
      severity: "review",
      wms_order_id: null,
      wms_shipment_id: null,
      resolved_wms_order_id: 204628,
      resolved_wms_shipment_id: 4813,
      oms_order_id: 231495,
      channel_order_number: "#59539",
      wms_order_number: "#59539",
      channel_provider: "shopify",
      external_system: "shipstation",
      external_order_ref: "755631396",
      external_shipment_ref: "442498656",
      external_order_key: "echelon-wms-shp-4813",
      idempotency_key: "shipstation_notify:ship_notify_no_match:755631396:442498656",
      summary: "Unmatched ShipStation callback for order 755631396",
      details: {
        orderNumber: "#59539",
        trackingNumber: "1Z16D13WYW70563713",
      },
      first_seen_at: "2026-06-30T17:43:55.419Z",
      last_seen_at: "2026-06-30T17:43:55.419Z",
      occurrence_count: 1,
      updated_at: "2026-06-30T17:43:55.419Z",
      tracking_number: null,
      shipping_engine: "shipstation",
      engine_order_ref: "755631396",
    }, new Date("2026-07-11T14:00:00.000Z"));

    expect(item).toMatchObject({
      projectionVersion: 2,
      entityRef: "Order #59539",
      summary: "ShipStation shipment 442498656 did not match a WMS shipment for order #59539.",
      detailLocator: {
        omsOrderId: 231495,
        wmsOrderId: 204628,
        wmsShipmentId: 4813,
        links: [{ label: "Open #59539", href: "/orders?orderId=204628" }],
      },
    });
    expect(item.summary).not.toContain("755631396");
    expect(item.evidenceSummary).toMatchObject({
      channelOrderNumber: "#59539",
      externalOrderRef: "755631396",
      externalShipmentRef: "442498656",
    });
  });

  it("labels provider ids explicitly when no channel order number is known", () => {
    const item = wmsReconciliationSource.projectRow({
      id: 2,
      source: "shipstation_notify",
      classification: "manual_review",
      rule: "ship_notify_no_match",
      status: "open",
      severity: "review",
      external_system: "shipstation",
      external_order_ref: "755631396",
      external_shipment_ref: "442498656",
      external_order_key: "external-order-key",
      idempotency_key: "shipstation_notify:ship_notify_no_match:755631396:442498656",
      details: {},
      first_seen_at: "2026-06-30T17:43:55.419Z",
      last_seen_at: "2026-06-30T17:43:55.419Z",
      occurrence_count: 1,
      updated_at: "2026-06-30T17:43:55.419Z",
    }, new Date("2026-07-11T14:00:00.000Z"));

    expect(item.entityRef).toBe("ShipStation order 755631396");
    expect(item.entityRef).not.toBe("Order 755631396");
  });

  it("does not present an OMS database id as a channel order number", () => {
    const item = channelFulfillmentSource.projectRow({
      id: 78,
      oms_order_id: 226353,
      physical_shipment_id: 9114,
      channel_provider: "shopify",
      channel_fulfillment_id: null,
      push_status: "failed",
      attempt_count: 1,
      last_error: "provider timeout",
      metadata: {},
      created_at: "2026-07-10T11:00:00.000Z",
      updated_at: "2026-07-10T12:00:00.000Z",
      external_order_number: null,
      wms_order_number: null,
      external_order_id: "12133948194975",
      provider_physical_shipment_id: "shipstation_shipment:441680953",
      tracking_number: null,
      carrier: "FedEx",
      shipping_provider: "shipstation",
      physical_shipment_status: "shipped",
      wms_order_id: 204464,
    }, new Date("2026-07-10T12:00:00.000Z"));

    expect(item.entityRef).toBe("OMS order 226353");
    expect(item.summary).toContain("OMS order 226353");
    expect(item.entityRef).not.toBe("Order 226353");
  });
});
