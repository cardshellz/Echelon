/**
 * C8 Phase 3 tests: Cancel/refund core hardening.
 *
 * Tests for:
 * - D-SYNCANCEL: OMS→WMS sync cancel path releases inventory
 * - D-CANCELREL: cancelOrderCascade persists dead-letter on release failure
 * - D-CANCELEVENT: Cancel event includes cascade outcome details
 * - D-REFUNDREL: Refund restock failure persists dead-letter event
 * - Single-path: all cancel callers use cancelOrderCascade
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WMS_SYNC_SRC = readFileSync(
  fileURLToPath(new URL("../../wms-sync.service.ts", import.meta.url)),
  "utf8",
);

const OMS_WEBHOOKS_SRC = readFileSync(
  fileURLToPath(
    new URL("../../oms-webhooks.ts", import.meta.url),
  ),
  "utf8",
);

// ─── D-SYNCANCEL structural checks ────────────────────────────────

function extractSyncCancelFn(): string {
  const start = WMS_SYNC_SRC.indexOf("cancelExistingWmsOrderForFinalOmsOrder(omsOrderId: number)");
  const end = WMS_SYNC_SRC.indexOf("private async refreshExistingWmsOrderHeaderFromOms");
  return WMS_SYNC_SRC.substring(start, end);
}

describe("D-SYNCANCEL: OMS sync cancel releases inventory", () => {
  it("calls releaseOrderReservation before cancelWmsOrder", () => {
    const fnBlock = extractSyncCancelFn();
    const releasePos = fnBlock.indexOf("releaseOrderReservation");
    const cancelPos = fnBlock.indexOf("cancelWmsOrder(db");
    expect(releasePos).toBeGreaterThan(-1);
    expect(cancelPos).toBeGreaterThan(-1);
    expect(releasePos).toBeLessThan(cancelPos);
  });

  it("persists cancel_release_failed event on release failure", () => {
    const fnBlock = extractSyncCancelFn();
    expect(fnBlock).toContain("cancel_release_failed");
    expect(fnBlock).toContain("requiresReview: true");
  });

  it("does not skip cancel transition on release failure", () => {
    const fnBlock = extractSyncCancelFn();
    const catchPos = fnBlock.indexOf("catch (releaseErr");
    const cancelPos = fnBlock.indexOf("cancelWmsOrder(db");
    expect(catchPos).toBeGreaterThan(-1);
    expect(cancelPos).toBeGreaterThan(catchPos);
  });
});

// ─── cancelOrderCascade: shared cancel path ──────────────────────

function extractCancelOrderCascade(): string {
  const start = OMS_WEBHOOKS_SRC.indexOf("export async function cancelOrderCascade(");
  const nextExport = OMS_WEBHOOKS_SRC.indexOf("Apply a Shopify `refunds/create`", start);
  return OMS_WEBHOOKS_SRC.substring(start, nextExport);
}

describe("D-CANCELREL: cancelOrderCascade dead-letter on release failure", () => {
  it("persists cancel_release_failed event when releaseOrderReservation throws", () => {
    const fn = extractCancelOrderCascade();
    expect(fn).toContain("cancel_release_failed");
    expect(fn).toContain("requiresReview: true");
  });

  it("includes wmsOrderId and error in the dead-letter details", () => {
    const fn = extractCancelOrderCascade();
    expect(fn).toContain("wmsOrderId: wmsRow.id");
    expect(fn).toContain("error:");
  });
});

describe("D-CANCELEVENT: cancelOrderCascade logs cascade details in event", () => {
  it("records cancelled event with cascade details", () => {
    const fn = extractCancelOrderCascade();
    expect(fn).toContain('eventType: "cancelled"');
    expect(fn).toContain("cascadeDetails");
  });

  it("includes shipment outcomes in cascade details", () => {
    const fn = extractCancelOrderCascade();
    expect(fn).toContain("shipmentOutcomes");
    expect(fn).toContain("cascade.cascadeResults");
  });
});

describe("Single cancel path: all handlers use cancelOrderCascade", () => {
  it("orders/cancelled handler calls cancelOrderCascade", () => {
    const start = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/cancelled"');
    const end = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/fulfilled"');
    const handler = OMS_WEBHOOKS_SRC.substring(start, end);
    expect(handler).toContain("cancelOrderCascade(db, existing.id");
  });

  it("orders/updated handler calls cancelOrderCascade for final states", () => {
    const start = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/updated"');
    const end = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/cancelled"');
    const handler = OMS_WEBHOOKS_SRC.substring(start, end);
    expect(handler).toContain("cancelOrderCascade(db, existing.id");
  });

  it("reconcileCancellations calls cancelOrderCascade", () => {
    expect(WMS_SYNC_SRC).toContain("cancelOrderCascade(db, row.oms_id");
  });
});

// ─── D-REFUNDREL structural checks ────────────────────────────────

describe("D-REFUNDREL: Refund restock failure dead-letter", () => {
  it("persists refund_restock_failed event when restock helper throws", () => {
    const refundBlock = OMS_WEBHOOKS_SRC.substring(
      OMS_WEBHOOKS_SRC.indexOf("D-REFUNDREL"),
      OMS_WEBHOOKS_SRC.indexOf("return {", OMS_WEBHOOKS_SRC.indexOf("D-REFUNDREL")),
    );
    expect(refundBlock).toContain("refund_restock_failed");
    expect(refundBlock).toContain("requiresReview: true");
  });

  it("includes refundExternalId in the dead-letter details", () => {
    const refundBlock = OMS_WEBHOOKS_SRC.substring(
      OMS_WEBHOOKS_SRC.indexOf("D-REFUNDREL"),
      OMS_WEBHOOKS_SRC.indexOf("return {", OMS_WEBHOOKS_SRC.indexOf("D-REFUNDREL")),
    );
    expect(refundBlock).toContain("refundExternalId");
    expect(refundBlock).toContain("wmsOrderId");
    expect(refundBlock).toContain("error:");
  });
});
