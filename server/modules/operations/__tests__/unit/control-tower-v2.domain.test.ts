import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  controlTowerFingerprint,
  projectSourceRows,
  type ControlTowerSourceAdapter,
  type ProjectedControlTowerWorkItem,
} from "../../control-tower-v2.domain";
import {
  carrierTrackingSource,
  channelFulfillmentSource,
  inventoryIntegritySource,
  resolveCarrierAcceptanceGraceMinutes,
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

  it("classifies structural inventory safeguards as system controls", () => {
    const item = inventoryIntegritySource.projectRow({
      id: 903,
      check_id: "inventory_level_constraint_gap",
      entity_fingerprint: "c".repeat(64),
      category: "balances",
      severity: "blocker",
      status: "open",
      entity_key: { constraint_name: "chk_reserved_qty_non_negative" },
      current_evidence: { constraint_name: "chk_reserved_qty_non_negative" },
      current_metric: "1",
      first_seen_at: "2026-07-10T10:00:00.000Z",
      last_seen_at: "2026-07-10T12:00:00.000Z",
      last_changed_at: "2026-07-10T11:00:00.000Z",
      occurrence_count: 1,
      recurrence_count: 0,
      worsened_count: 0,
      updated_at: "2026-07-10T12:00:00.000Z",
    }, new Date("2026-07-10T12:00:00.000Z"));

    expect(item.projectionVersion).toBe(3);
    expect(item.impactTags).toEqual(["inventory_accuracy", "system_control"]);
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
      projectionVersion: 3,
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

  it("loads carrier authority gaps from labels, links, and immutable tracking evidence", async () => {
    let queryText = "";
    let queryValues: unknown[] | undefined;
    const rows = await carrierTrackingSource.loadRows({
      query: async (text, values) => {
        queryText = text;
        queryValues = values;
        return { rows: [] };
      },
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(rows).toEqual([]);
    expect(queryText).toContain("wms.shipping_provider_labels");
    expect(queryText).toContain("wms.shipping_provider_label_links");
    expect(queryText).toContain("wms.carrier_tracking_events");
    expect(queryText).toContain("wms.carrier_tracking_webhook_receipts");
    expect(queryText).toContain("wms.carrier_tracking_webhook_receipt_parses");
    expect(queryText).toContain("wms.carrier_tracking_webhook_hydrations");
    expect(queryText).toContain("wms.carrier_tracking_subscriptions");
    expect(queryText).toContain("wms.carrier_tracking_subscription_labels");
    expect(queryText).toContain("carrier_tracking_carrier_missing");
    expect(queryText).toContain("carrier_tracking_subscription_not_active");
    expect(queryText).toContain("carrier_tracking_subscription_review");
    expect(queryText).toContain("voided_label_carrier_movement");
    expect(queryText).toContain("carrier_acceptance_overdue");
    expect(queryText).toContain("carrier_tracking_receipt_missing");
    expect(queryText).toContain("carrier_tracking_payload_rejected");
    expect(queryText).toContain("carrier_tracking_receipt_unparsed");
    expect(queryText).toContain("carrier_tracking_hydration_not_complete");
    expect(queryText).toContain("carrier_tracking_hydration_review");
    expect(queryText).toContain("acceptance_subscription.activated_at");
    expect(queryText).toContain("latest_confirmed_label_event");
    expect(queryText).toContain("JOIN latest_confirmed_label_event AS confirmed");
    expect(queryText).toContain(
      "GREATEST(label.first_observed_at, acceptance_subscription.activated_at)",
    );
    expect(queryValues).toEqual(["2026-07-20T12:00:00.000Z", 15, 1080]);
  });

  it("validates the configurable carrier-acceptance window", () => {
    expect(resolveCarrierAcceptanceGraceMinutes(undefined)).toBe(1080);
    expect(resolveCarrierAcceptanceGraceMinutes("240")).toBe(240);
    expect(() => resolveCarrierAcceptanceGraceMinutes("59")).toThrow(
      "CARRIER_ACCEPTANCE_GRACE_MINUTES",
    );
    expect(() => resolveCarrierAcceptanceGraceMinutes("10081")).toThrow(
      "CARRIER_ACCEPTANCE_GRACE_MINUTES",
    );
    expect(() => resolveCarrierAcceptanceGraceMinutes("1.5")).toThrow(
      "CARRIER_ACCEPTANCE_GRACE_MINUTES",
    );
  });

  it("projects an exhausted webhook hydration as an actionable review issue", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "receipt:301:hydration_review",
      issue_code: "carrier_tracking_hydration_review",
      label_id: null,
      event_id: null,
      receipt_id: 301,
      provider: "shipstation",
      provider_label_id: null,
      tracking_number: "1Z999AA10123456784",
      label_status: null,
      link_count: 0,
      wms_order_id: null,
      order_number: null,
      order_numbers: [],
      provider_status_code: null,
      canonical_status: null,
      dispatch_evidence: null,
      match_status: "review",
      reason_code: "SHIPSTATION_TRACKING_HYDRATION_INVALID_RESPONSE",
      first_seen_at: "2026-07-20T11:00:00.000Z",
      last_seen_at: "2026-07-20T11:05:00.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      code: "carrier_tracking_hydration_review",
      entityType: "carrier_tracking_webhook_receipt",
      entityId: "301",
      entityRef: "Tracking 1Z999AA10123456784",
      severity: "high",
    });
    expect(item.actualState).toContain("SHIPSTATION_TRACKING_HYDRATION_INVALID_RESPONSE");
  });

  it("projects a permanently rejected tracking subscription with its provider error", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "label:12:subscription_review",
      issue_code: "carrier_tracking_subscription_review",
      label_id: 12,
      event_id: null,
      receipt_id: null,
      provider: "shipstation",
      provider_label_id: "442000003",
      tracking_number: "1Z999AA10123456785",
      label_status: "active",
      link_count: 1,
      wms_order_id: 204_901,
      order_number: "#60002",
      order_numbers: ["#60002"],
      provider_status_code: null,
      canonical_status: null,
      dispatch_evidence: null,
      match_status: "review",
      reason_code: "SHIPSTATION_TRACKING_HTTP",
      first_seen_at: "2026-07-20T11:00:00.000Z",
      last_seen_at: "2026-07-20T11:05:00.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      code: "carrier_tracking_subscription_review",
      entityType: "shipping_provider_label",
      entityId: "12",
      entityRef: "Order #60002 / 1Z999AA10123456785",
      severity: "high",
    });
    expect(item.actualState).toContain("match review");
    expect(item.actualState).toContain("SHIPSTATION_TRACKING_HTTP");
  });

  it("projects an overdue carrier acceptance scan as a shipping exception", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "label:10:acceptance_overdue",
      issue_code: "carrier_acceptance_overdue",
      label_id: 10,
      event_id: null,
      provider: "shipstation",
      provider_label_id: "442000001",
      tracking_number: "1Z999AA10123456784",
      label_status: "active",
      link_count: 2,
      wms_order_id: 204_900,
      order_number: "#60001",
      order_numbers: ["#60001"],
      provider_status_code: "NY",
      canonical_status: "pre_transit",
      dispatch_evidence: "not_confirmed",
      match_status: "matched",
      reason_code: "single_active_label_candidate",
      first_seen_at: "2026-07-19T12:00:00.000Z",
      last_seen_at: "2026-07-19T12:05:00.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      domain: "shipping",
      code: "carrier_acceptance_overdue",
      entityType: "shipping_provider_label",
      entityId: "10",
      entityRef: "Order #60001 / 1Z999AA10123456784",
      severity: "medium",
      urgency: "overdue",
      detailLocator: {
        wmsOrderId: 204_900,
        links: [{ label: "Open #60001", href: "/orders?orderId=204900" }],
      },
    });
    expect(item.actualState).toContain("dispatch evidence not_confirmed");
  });

  it("projects confirmed movement on a voided label as a blocker", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "label:11:voided_movement",
      issue_code: "voided_label_carrier_movement",
      label_id: 11,
      event_id: 91,
      provider: "shipstation",
      provider_label_id: "442000002",
      tracking_number: "9400111899560000000000",
      label_status: "voided",
      link_count: 1,
      wms_order_id: null,
      order_number: null,
      order_numbers: [],
      provider_status_code: "IT",
      canonical_status: "in_transit",
      dispatch_evidence: "confirmed",
      match_status: "voided_label",
      reason_code: "tracking_matches_voided_label",
      first_seen_at: "2026-07-19T12:00:00.000Z",
      last_seen_at: "2026-07-20T11:00:00.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      code: "voided_label_carrier_movement",
      severity: "blocker",
      urgency: "overdue",
    });
  });

  it("projects missing authenticated webhook evidence as an ingestion blocker", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "event:92:receipt_missing",
      issue_code: "carrier_tracking_receipt_missing",
      label_id: null,
      event_id: 92,
      receipt_id: null,
      provider: "shipstation",
      provider_label_id: null,
      tracking_number: "1Z999AA10123456784",
      label_status: null,
      link_count: 0,
      wms_order_id: null,
      order_number: null,
      order_numbers: [],
      provider_status_code: "AC",
      canonical_status: "accepted",
      dispatch_evidence: "confirmed",
      match_status: null,
      reason_code: "verified_webhook_receipt_missing",
      first_seen_at: "2026-07-20T11:00:00.000Z",
      last_seen_at: "2026-07-20T11:00:00.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      code: "carrier_tracking_receipt_missing",
      entityType: "carrier_tracking_event",
      entityId: "92",
      severity: "blocker",
      urgency: "overdue",
    });
  });

  it("projects a retained but rejected authenticated payload as an actionable shipping issue", () => {
    const item = carrierTrackingSource.projectRow({
      source_key: "receipt:93:payload_rejected",
      issue_code: "carrier_tracking_payload_rejected",
      label_id: null,
      event_id: null,
      receipt_id: 93,
      provider: "shipstation",
      provider_label_id: null,
      tracking_number: null,
      label_status: null,
      link_count: 0,
      wms_order_id: null,
      order_number: null,
      order_numbers: [],
      provider_status_code: null,
      canonical_status: null,
      dispatch_evidence: null,
      match_status: null,
      reason_code: "INVALID_CARRIER_TRACKING_PAYLOAD",
      first_seen_at: "2026-07-20T11:00:00.000Z",
      last_seen_at: "2026-07-20T11:00:01.000Z",
    }, new Date("2026-07-20T12:00:00.000Z"));

    expect(item).toMatchObject({
      code: "carrier_tracking_payload_rejected",
      entityType: "carrier_tracking_webhook_receipt",
      entityId: "93",
      entityRef: "Webhook receipt 93",
      severity: "high",
      urgency: "overdue",
      detailLocator: {
        sourceTable: "wms.carrier_tracking_webhook_receipts",
        sourceId: 93,
      },
    });
    expect(item.actualState).toContain("INVALID_CARRIER_TRACKING_PAYLOAD");
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

  it("does not describe an unmapped provider record as a physical reship without carrier evidence", () => {
    const item = wmsReconciliationSource.projectRow({
      id: 59,
      source: "shipstation_notify",
      classification: "manual_review",
      rule: "shipstation_unmapped_physical_shipment",
      status: "open",
      severity: "review",
      wms_order_id: 204826,
      wms_shipment_id: 6096,
      resolved_wms_order_id: 204826,
      resolved_wms_shipment_id: 6096,
      oms_order_id: 231695,
      channel_order_number: "24-14838-80207",
      wms_order_number: "24-14838-80207",
      channel_provider: "ebay",
      external_system: "shipstation",
      external_order_ref: "763385590",
      external_shipment_ref: "446104678",
      external_order_key: "echelon-wms-shp-6096",
      idempotency_key:
        "shipstation_notify:shipstation_unmapped_physical_shipment:shipment:446104678",
      summary: "legacy internal summary",
      details: {
        orderNumber: "EB-24-14838-80207",
        trackingNumber: "1Z8X330WYN43653055",
      },
      first_seen_at: "2026-07-16T15:45:38.018Z",
      last_seen_at: "2026-07-16T15:45:38.018Z",
      occurrence_count: 1,
      updated_at: "2026-07-16T15:45:38.018Z",
      tracking_number: "1Z16D13WYW17318954",
      shipping_engine: "shipstation",
      engine_order_ref: "757838606",
    }, new Date("2026-07-17T14:00:00.000Z"));

    expect(item.summary).toBe(
      "ShipStation reported an unmapped shipment or label record for order " +
      "24-14838-80207 with tracking 1Z8X330WYN43653055. Echelon did not change " +
      "fulfillment or inventory because carrier possession and merchant intent " +
      "are not yet confirmed.",
    );
    expect(item.summary).not.toMatch(/authority|mutation|WMS lines|another package|reship/i);
    expect(item.recommendedAction).toContain(
      "Classify a replacement only after physical carrier movement is confirmed",
    );
    expect(item.evidenceSummary).toMatchObject({
      trackingNumber: "1Z8X330WYN43653055",
      externalOrderRef: "763385590",
      externalShipmentRef: "446104678",
    });
  });

  it("gives eBay tracking conflicts a package-classification action", () => {
    const item = wmsReconciliationSource.projectRow({
      id: 60,
      source: "channel_writeback",
      classification: "manual_review",
      rule: "ebay_tracking_changed_after_fulfillment",
      status: "open",
      severity: "review",
      wms_order_id: 205216,
      wms_shipment_id: 8802,
      resolved_wms_order_id: 205216,
      resolved_wms_shipment_id: 8802,
      oms_order_id: 244780,
      channel_order_number: "07-14878-86923",
      wms_order_number: "07-14878-86923",
      channel_provider: "ebay",
      external_system: "ebay",
      external_order_ref: "07-14878-86923",
      external_shipment_ref: "9400150206217770309995",
      idempotency_key:
        "channel_writeback:ebay_tracking_changed_after_fulfillment:shipment:8802",
      summary: "eBay already has a different tracking fulfillment.",
      details: {
        priorTrackingNumber: "9400150206217770309995",
        currentTrackingNumber: "9400150206217777402897",
      },
      first_seen_at: "2026-07-20T12:00:00.000Z",
      last_seen_at: "2026-07-20T12:00:00.000Z",
      occurrence_count: 1,
      updated_at: "2026-07-20T12:00:00.000Z",
      tracking_number: "9400150206217777402897",
      shipping_engine: "shipstation",
      engine_order_ref: "762526158",
    }, new Date("2026-07-20T14:00:00.000Z"));

    expect(item).toMatchObject({
      title: "eBay tracking changed after fulfillment",
      entityRef: "Order 07-14878-86923",
      recommendedAction: expect.stringContaining(
        "Classify the later package as a replacement or duplicate",
      ),
      evidenceSummary: expect.objectContaining({
        trackingNumber: "9400150206217777402897",
      }),
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
