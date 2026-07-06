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
  // P0.1c: the sync cancel path now delegates to the single cancel
  // entrypoint (cancelWmsOrderAndRelease), which performs the guarded
  // cancel transition FIRST and then the order-scoped, idempotent release.
  // Cancel-first is deliberate: a shipped order must never be released
  // (its reservations were consumed by picks), and the release is
  // idempotent so a failure can be retried by the reconciler.
  const CANCEL_HELPER_SRC = readFileSync(
    fileURLToPath(new URL("../../../orders/cancel-wms-order.ts", import.meta.url)),
    "utf8",
  );

  it("routes through the single cancel entrypoint", () => {
    const fnBlock = extractSyncCancelFn();
    expect(fnBlock).toContain("cancelWmsOrderAndRelease(");
  });

  it("the entrypoint releases reservations after a successful transition", () => {
    const cancelPos = CANCEL_HELPER_SRC.indexOf("await cancelOrder(db, orderId, reason)");
    const releasePos = CANCEL_HELPER_SRC.indexOf("releaseOrderReservation(orderId, reason");
    expect(cancelPos).toBeGreaterThan(-1);
    expect(releasePos).toBeGreaterThan(cancelPos);
    // no release without a transition:
    expect(CANCEL_HELPER_SRC).toContain("if (!trans.transitioned)");
  });

  it("persists cancel_release_failed event on release failure", () => {
    const fnBlock = extractSyncCancelFn();
    expect(fnBlock).toContain("cancel_release_failed");
    expect(fnBlock).toContain("requiresReview: true");
  });

  it("does not undo the cancel transition on release failure", () => {
    // the helper catches release errors and reports releaseFailed instead
    // of throwing — the cancel stands.
    expect(CANCEL_HELPER_SRC).toContain("releaseFailed = true");
    expect(CANCEL_HELPER_SRC).toMatch(/catch \(err: any\) \{\s*\n\s*releaseFailed = true/);
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

// ─── P0.5: refund atomicity + cancel-retry effectiveness ──────────

describe("P0.5: refund financial update is atomic and serialized", () => {
  function extractRefundHandler(): string {
    const start = OMS_WEBHOOKS_SRC.indexOf('"/api/oms/webhooks/refunds/create"');
    expect(start).toBeGreaterThanOrEqual(0);
    const next = OMS_WEBHOOKS_SRC.indexOf("app.post(", start + 1);
    return OMS_WEBHOOKS_SRC.substring(start, next === -1 ? OMS_WEBHOOKS_SRC.length : next);
  }

  it("serializes refunds per order with an advisory xact lock", () => {
    const handler = extractRefundHandler();
    expect(handler).toContain("pg_advisory_xact_lock(918411");
  });

  it("increments refund_amount_cents atomically in SQL (no JS read-modify-write)", () => {
    const handler = extractRefundHandler();
    expect(handler).toContain(
      "refund_amount_cents = COALESCE(refund_amount_cents, 0) + ${thisRefundCents}",
    );
    // the old lost-update pattern must not return:
    expect(handler).not.toMatch(/priorRefundCents\s*\+\s*thisRefundCents/);
  });

  it("derives financial_status from the CUMULATIVE amount vs order total", () => {
    const handler = extractRefundHandler();
    expect(handler).toMatch(
      /COALESCE\(refund_amount_cents, 0\) \+ \$\{thisRefundCents\} >= COALESCE\(NULLIF\(total_cents, 0\)/,
    );
  });

  it("checks the replay marker INSIDE the locked transaction", () => {
    const handler = extractRefundHandler();
    const lockPos = handler.indexOf("pg_advisory_xact_lock(918411");
    const markerPos = handler.indexOf("details->>'refundId'");
    expect(lockPos).toBeGreaterThan(-1);
    expect(markerPos).toBeGreaterThan(lockPos);
  });
});

describe("P0.5: cancelled-order retries re-run an incomplete cascade", () => {
  function extractCancelledHandler(): string {
    const start = OMS_WEBHOOKS_SRC.indexOf('"/api/oms/webhooks/orders/cancelled"');
    const end = OMS_WEBHOOKS_SRC.indexOf('"/api/oms/webhooks/orders/fulfilled"');
    return OMS_WEBHOOKS_SRC.substring(start, end);
  }

  it("the already-cancelled guard consults the cascade-completion marker", () => {
    const handler = extractCancelledHandler();
    const guardPos = handler.indexOf('existing.status === "cancelled"');
    const markerPos = handler.indexOf("event_type = 'cancelled'");
    const retryCascadePos = handler.indexOf("shopify_cancel_webhook_retry");
    expect(guardPos).toBeGreaterThan(-1);
    expect(markerPos).toBeGreaterThan(guardPos);
    expect(retryCascadePos).toBeGreaterThan(markerPos);
  });

  it("the cascade-completion marker premise holds: cancelOrderCascade writes the 'cancelled' event last and is its only writer", () => {
    const cascade = extractCancelOrderCascade();
    expect(cascade).toContain('eventType: "cancelled"');
    const writers = OMS_WEBHOOKS_SRC.match(/eventType: "cancelled"/g) ?? [];
    expect(writers).toHaveLength(1);
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
