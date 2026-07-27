import { describe, expect, it, vi } from "vitest";

import {
  buildCandidateQuery,
  parseFlags,
  runIdFromIdempotencyKey,
  runRepair,
  toCandidate,
  type RepairCandidate,
} from "../repair-persisted-shopify-refund-authority";

function candidate(overrides: Partial<RepairCandidate> = {}): RepairCandidate {
  return {
    omsOrderId: 239512,
    wmsOrderId: 205000,
    externalOrderNumber: "#59855",
    refundExternalId: "refund-1",
    adjustments: [{
      externalLineItemId: "line-1",
      quantity: 5,
      restockPolicy: "no_restock",
      raw: {},
    }],
    legacyShipmentIds: [6605],
    requiresPhysicalRestoration: true,
    ...overrides,
  };
}

describe("repair-persisted-shopify-refund-authority", () => {
  it("defaults to bounded dry-run and requires explicit execute confirmation", () => {
    expect(parseFlags([])).toMatchObject({
      mode: "dry-run",
      limit: 100,
      confirmCount: null,
      operator: null,
      reason: null,
      idempotencyKey: null,
    });
    expect(() => parseFlags(["--execute"])).toThrow(/--confirm-count is required/);
    expect(() => parseFlags(["--dry-run", "--execute"])).toThrow(/Choose either/);
    expect(() => parseFlags(["--unknown"])).toThrow(/Unknown flag/);

    expect(parseFlags([
      "--execute",
      "--limit=all",
      "--confirm-count=24",
      "--operator=owner@cardshellz.com",
      "--reason=historical-refund-authority-repair",
      "--idempotency-key=refund-authority-repair-2026-07-26-batch-1",
    ])).toMatchObject({
      mode: "execute",
      limit: null,
      confirmCount: 24,
      operator: "owner@cardshellz.com",
    });
  });

  it("selects exact persisted refund policies with policy-specific terminal safeguards", () => {
    const flags = parseFlags([
      "--dry-run",
      "--order-number=#59855",
      "--limit=25",
    ]);
    const query = buildCandidateQuery(flags);

    expect(query.values).toEqual(["#59855", 25]);
    expect(query.text).toContain("adjustment.source = 'shopify_webhook'");
    expect(query.text).toContain("adjustment.adjustment_type = 'refund'");
    expect(query.text).toContain("COUNT(*) = 1");
    expect(query.text).toContain(
      "MIN(adjustment.restock_policy) IN ('no_restock', 'cancel')",
    );
    expect(query.text).toContain("refund.refund_quantity = oms_line.paid_quantity");
    expect(query.text).toContain("lineage.wms_order_count = 1");
    expect(query.text).toContain("lineage.wms_item_count = 1");
    expect(query.text).toContain("oms_order.status = 'cancelled'");
    expect(query.text).toContain("oms_order.financial_status = 'refunded'");
    expect(query.text).toContain("oms_order.fulfillment_status = 'unfulfilled'");
    expect(query.text).toContain("refund.restock_policy IN ('no_restock', 'cancel')");
    expect(query.text).toContain("lineage.wms_item_status = 'cancelled'");
    expect(query.text).toContain("lineage.picked_quantity = 0");
    expect(query.text).toContain("lineage.fulfilled_quantity = 0");
    expect(query.text).toContain("refund.restock_policy = 'no_restock'");
    expect(query.text).toContain("oms_order.fulfillment_status = 'fulfilled'");
    expect(query.text).toContain("COALESCE(legacy.shipped_quantity, 0) = oms_line.paid_quantity");
    expect(query.text).toContain("lineage.wms_item_status = 'completed'");
    expect(query.text).toContain("lineage.fulfilled_quantity = oms_line.paid_quantity");
    expect(query.text).toContain(
      "COALESCE(canonical.shipped_quantity, 0) = oms_line.paid_quantity",
    );
    expect(query.text).toContain("nested.requires_physical_restoration = true");
  });

  it("normalizes database rows without losing exact line or shipment identity", () => {
    expect(toCandidate({
      oms_order_id: "239512",
      wms_order_id: 205000,
      external_order_number: "#59855",
      refund_external_id: "refund-1",
      requires_physical_restoration: true,
      legacy_shipment_ids: [6605],
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    })).toEqual(candidate({
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    }));
  });

  it("normalizes an already-restored candidate without scheduling duplicate projection", () => {
    expect(toCandidate({
      oms_order_id: "239512",
      wms_order_id: 205000,
      external_order_number: "#59855",
      refund_external_id: "refund-1",
      requires_physical_restoration: false,
      legacy_shipment_ids: [],
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    })).toEqual(candidate({
      legacyShipmentIds: [],
      requiresPhysicalRestoration: false,
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "no_restock",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    }));
  });

  it("normalizes a cancelled refund without scheduling physical restoration", () => {
    expect(toCandidate({
      oms_order_id: "239512",
      wms_order_id: 205000,
      external_order_number: "#59855",
      refund_external_id: "refund-1",
      requires_physical_restoration: false,
      legacy_shipment_ids: [],
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "cancel",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    })).toEqual(candidate({
      legacyShipmentIds: [],
      requiresPhysicalRestoration: false,
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "cancel",
        raw: { source: "persisted_shopify_refund_adjustment" },
      }],
    }));
  });

  it("rejects refund policies outside the proven historical repair cohort", () => {
    expect(() => toCandidate({
      oms_order_id: "239512",
      wms_order_id: 205000,
      external_order_number: "#59855",
      refund_external_id: "refund-1",
      requires_physical_restoration: false,
      legacy_shipment_ids: [],
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "return",
        raw: {},
      }],
    })).toThrow(/only accepts no_restock or cancel/);
  });

  it("rejects physical shipment restoration for cancel adjustments", () => {
    expect(() => toCandidate({
      oms_order_id: "239512",
      wms_order_id: 205000,
      external_order_number: "#59855",
      refund_external_id: "refund-1",
      requires_physical_restoration: true,
      legacy_shipment_ids: [6605],
      adjustments: [{
        externalLineItemId: "line-1",
        quantity: 5,
        restockPolicy: "cancel",
        raw: {},
      }],
    })).toThrow(/cancel adjustments cannot restore physical shipment lineage/);
  });

  it("validates lineage during dry-run without mutating canonical or authority state", async () => {
    const resolveLegacyShipment = vi.fn().mockResolvedValue({});
    const materializeAndProjectLegacyShipment = vi.fn();
    const reconcilePersistedRefund = vi.fn();

    const summary = await runRepair(parseFlags(["--dry-run"]), {
      loadCandidates: vi.fn().mockResolvedValue([candidate()]),
      resolveLegacyShipment,
      materializeAndProjectLegacyShipment,
      reconcilePersistedRefund,
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      log: vi.fn(),
    });

    expect(summary).toMatchObject({
      mode: "dry-run",
      candidates: 1,
      lines: 1,
      lineageValidated: 1,
      repaired: 0,
      reviewRequired: 0,
    });
    expect(resolveLegacyShipment).toHaveBeenCalledWith(6605);
    expect(materializeAndProjectLegacyShipment).not.toHaveBeenCalled();
    expect(reconcilePersistedRefund).not.toHaveBeenCalled();
  });

  it("restores physical lineage before applying persisted refund authority", async () => {
    const calls: string[] = [];
    const flags = parseFlags([
      "--execute",
      "--confirm-count=1",
      "--operator=owner@cardshellz.com",
      "--reason=historical-refund-authority-repair",
      "--idempotency-key=batch-1",
    ]);

    const summary = await runRepair(flags, {
      loadCandidates: vi.fn().mockResolvedValue([candidate()]),
      resolveLegacyShipment: vi.fn(async () => {
        calls.push("resolve");
      }),
      materializeAndProjectLegacyShipment: vi.fn(async () => {
        calls.push("project");
      }),
      reconcilePersistedRefund: vi.fn(async () => {
        calls.push("authority");
        return { authorityChanges: 1, wmsLineChanges: 0 };
      }),
      now: () => new Date("2026-07-26T12:00:00.000Z"),
      log: vi.fn(),
    });

    expect(calls).toEqual(["resolve", "project", "authority"]);
    expect(summary).toMatchObject({
      candidates: 1,
      physicalPackagesProjected: 1,
      authorityChanges: 1,
      repaired: 1,
      reviewRequired: 0,
    });
  });

  it("rejects an execute count that no longer matches the selected cohort", async () => {
    const flags = parseFlags([
      "--execute",
      "--confirm-count=2",
      "--operator=owner@cardshellz.com",
      "--reason=historical-refund-authority-repair",
      "--idempotency-key=batch-1",
    ]);

    await expect(runRepair(flags, {
      loadCandidates: vi.fn().mockResolvedValue([candidate()]),
      resolveLegacyShipment: vi.fn(),
      materializeAndProjectLegacyShipment: vi.fn(),
      reconcilePersistedRefund: vi.fn(),
      now: () => new Date(),
    })).rejects.toThrow(/does not match selected dry-run count 1/);
  });

  it("derives a stable UUID audit run id from the operator idempotency key", () => {
    const first = runIdFromIdempotencyKey("batch-1");
    const second = runIdFromIdempotencyKey("batch-1");

    expect(first).toBe(second);
    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
