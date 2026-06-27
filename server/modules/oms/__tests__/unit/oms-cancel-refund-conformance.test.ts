import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(relativePath, import.meta.url)),
    "utf8",
  );
}

function sourceBlock(source: string, startMarker: string, endMarker?: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);

  const end = endMarker
    ? source.indexOf(endMarker, start + startMarker.length)
    : source.length;
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);

  return source.slice(start, end);
}

const OMS_WEBHOOKS_SRC = readSource("../../oms-webhooks.ts");
const SHIPMENT_ROLLUP_SRC = readSource("../../../orders/shipment-rollup.ts");
const C8_CANCEL_REFUND_GUARDS_TEST_SRC = readSource("c8-cancel-refund-guards.test.ts");
const ORDERS_CANCELLED_CASCADE_TEST_SRC = readSource("orders-cancelled-cascade.test.ts");
const REFUND_RECONCILE_SHIPMENTS_TEST_SRC = readSource("refund-reconcile-shipments.test.ts");
const REFUNDS_CREATE_CASCADE_TEST_SRC = readSource("refunds-create-cascade.test.ts");
const SHIPMENT_ROLLUP_TEST_SRC = readSource(
  "../../../orders/__tests__/unit/shipment-rollup.test.ts",
);

describe("OMS/WMS authority conformance :: Shopify cancel and refund finality", () => {
  it("keeps Shopify cancel signals on the single cancel cascade path", () => {
    const finalityBlock = sourceBlock(
      OMS_WEBHOOKS_SRC,
      "export function deriveOmsUpdateFinality",
      "export const __test__",
    );

    expect(ORDERS_CANCELLED_CASCADE_TEST_SRC).toContain(
      "deriveOmsUpdateFinality",
    );
    expect(ORDERS_CANCELLED_CASCADE_TEST_SRC).toContain(
      "THE LOOP FIX: an already-cancelled but paid+not-cancelled order does NOT re-cancel",
    );
    expect(C8_CANCEL_REFUND_GUARDS_TEST_SRC).toContain(
      'orders/cancelled handler calls cancelOrderCascade',
    );
    expect(C8_CANCEL_REFUND_GUARDS_TEST_SRC).toContain(
      'orders/updated handler calls cancelOrderCascade for final states',
    );
    expect(C8_CANCEL_REFUND_GUARDS_TEST_SRC).toContain(
      "reconcileCancellations calls cancelOrderCascade",
    );
    expect(finalityBlock).toContain("Boolean(payload.cancelled_at)");
    expect(finalityBlock).toContain('payload.financial_status === "refunded"');
    expect(finalityBlock).toContain('payload.financial_status === "voided"');
    expect(finalityBlock).toContain('existingStatus === "cancelled"');
    expect(finalityBlock).toContain('existingStatus === "refunded"');
  });

  it("cancels Shopify orders before pick or before ship without creating hold states", () => {
    const customerCancelBlock = sourceBlock(
      SHIPMENT_ROLLUP_SRC,
      "export async function handleCustomerCancelOnShipment",
      "export async function markShipmentVoided",
    );

    expect(SHIPMENT_ROLLUP_TEST_SRC).toContain(
      "delegates to markShipmentCancelled when shipment is 'planned' (no SS call)",
    );
    expect(SHIPMENT_ROLLUP_TEST_SRC).toContain(
      "delegates to markShipmentCancelled when shipment is 'queued' AND threads SS hook",
    );
    expect(SHIPMENT_ROLLUP_TEST_SRC).toContain(
      "cancels a 'labeled' shipment and cancels the SS order",
    );
    expect(customerCancelBlock).toMatch(/case "planned":[\s\S]*case "queued":[\s\S]*case "labeled":/);
    expect(customerCancelBlock).toContain("markShipmentCancelled");
    expect(customerCancelBlock).toContain('"customer_cancel"');
    expect(customerCancelBlock).toContain("opts.shipstation");
    expect(customerCancelBlock).not.toContain("on_hold");
  });

  it("does not regress already-shipped physical work on late cancel or refund signals", () => {
    const customerCancelBlock = sourceBlock(
      SHIPMENT_ROLLUP_SRC,
      "export async function handleCustomerCancelOnShipment",
      "export async function markShipmentVoided",
    );
    const refundAdjustmentBlock = sourceBlock(
      OMS_WEBHOOKS_SRC,
      "async function applyRefundLineAdjustmentsToWms",
      "export async function applyShopifyRefundCascade",
    );

    expect(SHIPMENT_ROLLUP_TEST_SRC).toContain(
      "does NOT regress status when shipment is 'shipped'",
    );
    expect(REFUNDS_CREATE_CASCADE_TEST_SRC).toContain(
      "wms.returns row inserted with restocked=false",
    );
    expect(customerCancelBlock).toContain('case "shipped":');
    expect(customerCancelBlock).toContain('case "returned":');
    expect(customerCancelBlock).toContain('case "lost":');
    expect(customerCancelBlock).toContain('reason: "already_shipped"');
    expect(refundAdjustmentBlock).toContain("Shipped/terminal shipments are excluded");
    expect(refundAdjustmentBlock).toContain("os.status IN ('planned', 'queued', 'labeled')");
    expect(refundAdjustmentBlock).not.toMatch(/os\.status IN \([^)]*'shipped'/);
  });

  it("reconciles pre-shipment refunds by reducing work, cancelling empty shipments, or repushing queued work", () => {
    const refundAdjustmentBlock = sourceBlock(
      OMS_WEBHOOKS_SRC,
      "async function applyRefundLineAdjustmentsToWms",
      "export async function applyShopifyRefundCascade",
    );

    expect(REFUND_RECONCILE_SHIPMENTS_TEST_SRC).toContain(
      "queued shipment with items remaining -> re-pushes, never holds",
    );
    expect(REFUND_RECONCILE_SHIPMENTS_TEST_SRC).toContain(
      "emptied shipment (all items refunded) -> cancels (+engine) and recomputes the order",
    );
    expect(REFUND_RECONCILE_SHIPMENTS_TEST_SRC).toContain(
      "planned shipment with items remaining -> qty reduced only, no further action",
    );
    expect(REFUND_RECONCILE_SHIPMENTS_TEST_SRC).toContain("expectNoHoldWrites");
    expect(refundAdjustmentBlock).toContain("SET qty = GREATEST(0");
    expect(refundAdjustmentBlock).toContain('row.status === "queued"');
    expect(refundAdjustmentBlock).toContain("args.pushShipment");
    expect(refundAdjustmentBlock).toContain('"refund_fully_cancelled"');
    expect(refundAdjustmentBlock).toContain("markShipmentCancelled");
    expect(refundAdjustmentBlock).not.toMatch(/status\s*=\s*'on_hold'/);
  });

  it("keeps refund-after-label as manual review instead of automatic mutation", () => {
    const refundAdjustmentBlock = sourceBlock(
      OMS_WEBHOOKS_SRC,
      "async function applyRefundLineAdjustmentsToWms",
      "export async function applyShopifyRefundCascade",
    );

    expect(REFUND_RECONCILE_SHIPMENTS_TEST_SRC).toContain(
      "labeled shipment with items remaining -> flags 'refund_after_label', no re-push",
    );
    expect(refundAdjustmentBlock).toContain('row.status === "labeled"');
    expect(refundAdjustmentBlock).toContain('"refund_after_label"');
    expect(refundAdjustmentBlock).toContain("requires_review = true");
    expect(refundAdjustmentBlock).not.toMatch(/row\.status === "labeled"[\s\S]{0,200}args\.pushShipment/);
  });
});
