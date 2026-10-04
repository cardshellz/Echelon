import type { DropshipOrderOpsIntakeDetail } from "../../application/dropship-order-ops-service";

/**
 * An accepted order's full ops detail. The debit matches the vendor screen
 * the owner flagged on 2026-10-04: wholesale $6.99, shipping $9.25 (the
 * $0.18 insurance pool fee inside it), total debit $16.24. Every other
 * value is made up for tests, including the rest of the $9.25:
 * base rate 807 + markup 100 + dunnage 0 + pool 18 = 925.
 */
export const ORDER_DETAIL_AMOUNTS = Object.freeze({
  wholesaleSubtotalCents: 699,
  baseRateCents: 807,
  markupCents: 100,
  dunnageCents: 0,
  insurancePoolCents: 18,
  totalShippingCents: 925,
  totalDebitCents: 1624,
});

export function makeDropshipOrderOpsDetail(
  overrides: Partial<DropshipOrderOpsIntakeDetail> = {},
): DropshipOrderOpsIntakeDetail {
  const at = new Date("2026-10-03T15:00:00.000Z");
  const amounts = ORDER_DETAIL_AMOUNTS;
  return {
    intakeId: 42,
    vendor: {
      vendorId: 10,
      memberId: "member-1",
      businessName: "Vendor Co",
      email: "vendor@example.test",
      status: "active",
      entitlementStatus: "active",
    },
    storeConnection: {
      storeConnectionId: 22,
      platform: "ebay",
      status: "connected",
      setupStatus: "ready",
      launchReady: true,
      externalDisplayName: "Vendor eBay",
      shopDomain: null,
    },
    platform: "ebay",
    externalOrderId: "ORDER-42",
    externalOrderNumber: "1001",
    status: "accepted",
    paymentHoldExpiresAt: null,
    paymentHold: null,
    rejectionReason: null,
    cancellationStatus: null,
    omsOrderId: 9001,
    receivedAt: at,
    acceptedAt: at,
    updatedAt: at,
    lineCount: 1,
    totalQuantity: 1,
    shipTo: null,
    latestAuditEvent: {
      eventType: "order_accepted",
      severity: "info",
      createdAt: at,
      payload: { totalDebitCents: amounts.totalDebitCents },
    },
    sourceOrderId: "source-42",
    orderedAt: "2026-10-03T14:30:00.000Z",
    marketplaceStatus: "paid",
    totals: {
      retailSubtotalCents: 1299,
      shippingPaidCents: 599,
      taxCents: 0,
      discountCents: 0,
      grandTotalCents: 1898,
      currency: "USD",
    },
    lines: [{
      lineIndex: 0,
      externalLineItemId: "line-1",
      externalListingId: "listing-1",
      externalOfferId: null,
      sku: "SKU-1",
      productVariantId: 123,
      quantity: 1,
      unitRetailPriceCents: 1299,
      lineRetailTotalCents: 1299,
      title: "Card Shell",
    }],
    economicsSnapshot: {
      economicsSnapshotId: 501,
      shippingQuoteSnapshotId: 301,
      warehouseId: 1,
      currency: "USD",
      retailSubtotalCents: 1299,
      wholesaleSubtotalCents: amounts.wholesaleSubtotalCents,
      shippingCents: amounts.totalShippingCents,
      insurancePoolCents: amounts.insurancePoolCents,
      feesCents: 0,
      totalDebitCents: amounts.totalDebitCents,
      pricingSnapshot: {
        version: 3,
        shipping: {
          quoteSnapshotId: 301,
          packageCount: 1,
          shippingCents: amounts.totalShippingCents,
          insurancePoolCents: amounts.insurancePoolCents,
        },
      },
      createdAt: at,
    },
    shippingQuoteSnapshot: {
      quoteSnapshotId: 301,
      warehouseId: 1,
      currency: "USD",
      destinationCountry: "US",
      destinationPostalCode: "10001",
      packageCount: 1,
      baseRateCents: amounts.baseRateCents,
      markupCents: amounts.markupCents,
      insurancePoolCents: amounts.insurancePoolCents,
      dunnageCents: amounts.dunnageCents,
      totalShippingCents: amounts.totalShippingCents,
      quotePayload: {
        version: 4,
        totals: {
          baseRateCents: amounts.baseRateCents,
          markupCents: amounts.markupCents,
          dunnageCents: amounts.dunnageCents,
          insurancePoolCents: amounts.insurancePoolCents,
          totalShippingCents: amounts.totalShippingCents,
        },
      },
      createdAt: at,
    },
    walletLedgerEntry: {
      walletLedgerEntryId: 801,
      type: "order_debit",
      status: "settled",
      amountCents: -amounts.totalDebitCents,
      currency: "USD",
      availableBalanceAfterCents: 8376,
      pendingBalanceAfterCents: 0,
      createdAt: at,
      settledAt: at,
    },
    walletRewardsEntry: null,
    trackingPushes: [],
    auditEvents: [{
      eventType: "order_accepted",
      actorType: "system",
      actorId: null,
      severity: "info",
      payload: { totalDebitCents: amounts.totalDebitCents },
      createdAt: at,
    }],
    ...overrides,
  };
}
