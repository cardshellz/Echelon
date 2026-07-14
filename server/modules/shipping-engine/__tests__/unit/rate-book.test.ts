import { describe, expect, it } from "vitest";
import {
  selectRateBookAssignment,
  type RateBookAssignmentCandidate,
} from "../../domain/rate-book";

const globalRetail: RateBookAssignmentCandidate = {
  assignmentId: 1,
  rateBookId: 10,
  rateBookCode: "shopify-retail-default",
  zoneSetId: 100,
  pricingChannel: "shopify",
  purpose: "customer_checkout",
  originWarehouseId: null,
};

describe("selectRateBookAssignment", () => {
  it("uses a warehouse assignment before the channel-wide default", () => {
    const warehouseBook: RateBookAssignmentCandidate = {
      ...globalRetail,
      assignmentId: 2,
      rateBookId: 11,
      rateBookCode: "shopify-retail-warehouse-2",
      zoneSetId: 101,
      originWarehouseId: 2,
    };

    expect(selectRateBookAssignment([globalRetail, warehouseBook], {
      pricingChannel: "shopify",
      purpose: "customer_checkout",
      originWarehouseId: 2,
    })).toEqual({ ok: true, assignment: warehouseBook });
  });

  it("falls back to the channel-wide assignment", () => {
    expect(selectRateBookAssignment([globalRetail], {
      pricingChannel: "shopify",
      purpose: "customer_checkout",
      originWarehouseId: 34,
    })).toEqual({ ok: true, assignment: globalRetail });
  });

  it("does not use a retail book for a dropship vendor charge", () => {
    expect(selectRateBookAssignment([globalRetail], {
      pricingChannel: "dropship",
      purpose: "vendor_fulfillment_charge",
      originWarehouseId: 1,
    })).toMatchObject({ ok: false, code: "NO_RATE_BOOK" });
  });

  it("rejects ambiguous assignments at the same specificity", () => {
    expect(selectRateBookAssignment([
      globalRetail,
      { ...globalRetail, assignmentId: 3, rateBookId: 12 },
    ], {
      pricingChannel: "shopify",
      purpose: "customer_checkout",
      originWarehouseId: 1,
    })).toMatchObject({ ok: false, code: "AMBIGUOUS_RATE_BOOK" });
  });
});

