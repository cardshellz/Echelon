/**
 * C8 Phase 3 tests: Cancel/refund core hardening.
 *
 * Tests for:
 * - D-SYNCANCEL: OMS→WMS sync cancel path releases inventory
 * - D-CANCELREL: Shopify cancel webhook persists dead-letter on release failure
 * - D-CANCELEVENT: Cancel event includes cascade outcome details
 * - D-REFUNDREL: Refund restock failure persists dead-letter event
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

// ─── D-CANCELREL structural checks ────────────────────────────────

describe("D-CANCELREL: Shopify cancel dead-letter on release failure", () => {
  it("persists cancel_release_failed event when releaseOrderReservation throws", () => {
    const cancelBlock = OMS_WEBHOOKS_SRC.substring(
      OMS_WEBHOOKS_SRC.indexOf("Release inventory reservation via WMS"),
      OMS_WEBHOOKS_SRC.indexOf("Per Plan §6 Commit 28"),
    );
    expect(cancelBlock).toContain("cancel_release_failed");
    expect(cancelBlock).toContain("requiresReview: true");
  });

  it("includes wmsOrderId and error in the dead-letter details", () => {
    const cancelBlock = OMS_WEBHOOKS_SRC.substring(
      OMS_WEBHOOKS_SRC.indexOf("D-CANCELREL"),
      OMS_WEBHOOKS_SRC.indexOf("Per Plan §6 Commit 28"),
    );
    expect(cancelBlock).toContain("wmsOrderId");
    expect(cancelBlock).toContain("error:");
  });
});

// ─── D-CANCELEVENT structural checks ──────────────────────────────

describe("D-CANCELEVENT: Cancel event includes cascade details", () => {
  function extractCancelHandler(): string {
    const start = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/cancelled"');
    const end = OMS_WEBHOOKS_SRC.indexOf('app.post("/api/oms/webhooks/orders/fulfilled"');
    return OMS_WEBHOOKS_SRC.substring(start, end);
  }

  it("declares cancelCascadeDetails variable before cascade", () => {
    const handlerBlock = extractCancelHandler();
    expect(handlerBlock).toContain("cancelCascadeDetails");
  });

  it("includes shipment outcomes in cascade details", () => {
    const handlerBlock = extractCancelHandler();
    expect(handlerBlock).toContain("shipmentOutcomes");
    expect(handlerBlock).toContain("cascade.cascadeResults");
  });

  it("spreads cascade details into the cancelled event", () => {
    const handlerBlock = extractCancelHandler();
    expect(handlerBlock).toContain("...cancelCascadeDetails");
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
