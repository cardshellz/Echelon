import { describe, expect, it } from "vitest";
import {
  dropshipVendorOrderDetailResponseSchema,
  dropshipVendorOrderDetailSchema,
  type DropshipVendorOrderDetailResponseInput,
} from "../../../../../shared/dropship/vendor-order-detail";
import type { DropshipOrderOpsIntakeDetail } from "../../application/dropship-order-ops-service";
import { makeDropshipOrderOpsDetail, ORDER_DETAIL_AMOUNTS } from "../fixtures/order-ops-detail.fixture";

/** Field names of shipping's internal parts and the snapshots that repeat them. */
const INTERNAL_SHIPPING_FIELDS = [
  "insurancePoolCents",
  "baseRateCents",
  "markupCents",
  "dunnageCents",
  "quotePayload",
  "pricingSnapshot",
] as const;

function toVendor(detail: DropshipOrderOpsIntakeDetail) {
  // Typed like the route's binding: the internal detail must fit the contract's input.
  const input: DropshipVendorOrderDetailResponseInput = { order: detail };
  return dropshipVendorOrderDetailResponseSchema.parse(input).order;
}

describe("vendor order detail contract", () => {
  it("sends shipping as one amount: the pool and the rate parts are not in it", () => {
    const order = toVendor(makeDropshipOrderOpsDetail());

    expect(Object.keys(order.economicsSnapshot ?? {}).sort()).toEqual([
      "createdAt",
      "currency",
      "economicsSnapshotId",
      "feesCents",
      "retailSubtotalCents",
      "shippingCents",
      "shippingQuoteSnapshotId",
      "totalDebitCents",
      "warehouseId",
      "wholesaleSubtotalCents",
    ]);
    expect(Object.keys(order.shippingQuoteSnapshot ?? {}).sort()).toEqual([
      "createdAt",
      "currency",
      "destinationCountry",
      "destinationPostalCode",
      "packageCount",
      "quoteSnapshotId",
      "totalShippingCents",
      "warehouseId",
    ]);
    const serialized = JSON.stringify(order);
    for (const field of INTERNAL_SHIPPING_FIELDS) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("keeps what the vendor paid: shipping already holds the pool fee, so the debit adds up without it", () => {
    const order = toVendor(makeDropshipOrderOpsDetail());
    const economics = order.economicsSnapshot!;

    expect(economics).toMatchObject({ wholesaleSubtotalCents: 699, shippingCents: 925, feesCents: 0, totalDebitCents: 1624 });
    expect(order.shippingQuoteSnapshot?.totalShippingCents).toBe(925);
    expect(economics.wholesaleSubtotalCents + economics.shippingCents + economics.feesCents).toBe(economics.totalDebitCents);
    // The fixture's internal parts sum to the one amount the vendor sees.
    const { baseRateCents, markupCents, dunnageCents, insurancePoolCents, totalShippingCents } = ORDER_DETAIL_AMOUNTS;
    expect(baseRateCents + markupCents + dunnageCents + insurancePoolCents).toBe(totalShippingCents);
  });

  it("leaves out a zero pool fee too, not only a positive one", () => {
    const detail = makeDropshipOrderOpsDetail();
    const order = toVendor({
      ...detail,
      economicsSnapshot: { ...detail.economicsSnapshot!, insurancePoolCents: 0 },
      shippingQuoteSnapshot: { ...detail.shippingQuoteSnapshot!, insurancePoolCents: 0, markupCents: 0 },
    });

    expect(order.economicsSnapshot).not.toHaveProperty("insurancePoolCents");
    expect(order.shippingQuoteSnapshot).not.toHaveProperty("insurancePoolCents");
    expect(order.shippingQuoteSnapshot).not.toHaveProperty("markupCents");
  });

  it("hides a field added to the internal detail later, at any depth, until the contract lists it", () => {
    const detail = makeDropshipOrderOpsDetail();
    const withNewInternalFields = {
      ...detail,
      internalMarginCents: 300,
      economicsSnapshot: { ...detail.economicsSnapshot!, carrierInvoiceCents: 790 },
      lines: detail.lines.map((line) => ({ ...line, landedCostCents: 410 })),
    } as DropshipOrderOpsIntakeDetail;

    const serialized = JSON.stringify(toVendor(withNewInternalFields));

    for (const field of ["internalMarginCents", "carrierInvoiceCents", "landedCostCents"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("sends only the listed audit payload keys, and only plain values under them", () => {
    const detail = makeDropshipOrderOpsDetail({
      auditEvents: [{
        eventType: "order_accepted",
        actorType: "system",
        actorId: null,
        severity: "info",
        payload: {
          totalDebitCents: 1624,
          omsOrderId: 9001,
          reason: { internal: "nested objects are never reviewed" },
          requestHash: "sha256:abc",
          idempotencyKey: "accept:42",
          omsLineAuthority: { paidLines: 1 },
          insurancePoolCents: 18,
        },
        createdAt: new Date("2026-10-03T15:00:00.000Z"),
      }],
    });

    const order = toVendor(detail);

    expect(order.auditEvents[0].payload).toEqual({ totalDebitCents: 1624, omsOrderId: 9001 });
  });

  it("does not send the latest audit event the list carries, which the page never read", () => {
    const order = toVendor(makeDropshipOrderOpsDetail());

    expect(order).not.toHaveProperty("latestAuditEvent");
  });

  it("passes the vendor's own order data through, with dates as ISO strings", () => {
    const detail = makeDropshipOrderOpsDetail();
    const order = toVendor(detail);

    expect(order).toMatchObject({
      intakeId: 42,
      externalOrderNumber: "1001",
      status: "accepted",
      omsOrderId: 9001,
      receivedAt: "2026-10-03T15:00:00.000Z",
      lines: detail.lines,
      totals: detail.totals,
      storeConnection: detail.storeConnection,
      walletLedgerEntry: {
        walletLedgerEntryId: 801,
        amountCents: -1624,
        createdAt: "2026-10-03T15:00:00.000Z",
        settledAt: "2026-10-03T15:00:00.000Z",
      },
    });
  });

  it("keeps an order without snapshots or ship-to without them", () => {
    const order = toVendor(makeDropshipOrderOpsDetail({
      status: "received",
      economicsSnapshot: null,
      shippingQuoteSnapshot: null,
      walletLedgerEntry: null,
      shipTo: undefined,
    }));

    expect(order.economicsSnapshot).toBeNull();
    expect(order.shippingQuoteSnapshot).toBeNull();
    expect(order.walletLedgerEntry).toBeNull();
    expect(order.shipTo).toBeNull();
  });

  it("accepts the wire form back: an ISO string where the server holds a Date", () => {
    const wire = JSON.parse(JSON.stringify(toVendor(makeDropshipOrderOpsDetail())));

    expect(dropshipVendorOrderDetailSchema.parse(wire)).toEqual(wire);
  });

  it("refuses fractional cents and invalid dates instead of sending them", () => {
    const detail = makeDropshipOrderOpsDetail();

    const fractional = dropshipVendorOrderDetailSchema.safeParse({
      ...detail,
      economicsSnapshot: { ...detail.economicsSnapshot!, shippingCents: 9.25 },
    });
    const invalidDate = dropshipVendorOrderDetailSchema.safeParse({ ...detail, receivedAt: new Date("not a date") });

    expect(fractional.success).toBe(false);
    expect(fractional.error?.issues.map((issue) => issue.path.join("."))).toEqual(["economicsSnapshot.shippingCents"]);
    expect(invalidDate.success).toBe(false);
  });

  it("does not change the detail it reads, so the admin view keeps the parts", () => {
    const detail = makeDropshipOrderOpsDetail();
    const before = structuredClone(detail);

    toVendor(detail);

    expect(detail).toEqual(before);
    expect(detail.economicsSnapshot?.insurancePoolCents).toBe(18);
  });
});
