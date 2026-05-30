import { describe, expect, it } from "vitest";
import { extractEbayShipByDate } from "../../ebay-shipby";

describe("extractEbayShipByDate", () => {
  it("extracts eBay line-item fulfillment ship-by dates", () => {
    const result = extractEbayShipByDate({
      lineItems: [
        {
          lineItemId: "line-1",
          lineItemFulfillmentInstructions: {
            shipByDate: "2026-06-02T06:59:59.000Z",
            minEstimatedDeliveryDate: "2026-06-02T07:00:00.000Z",
            maxEstimatedDeliveryDate: "2026-06-04T07:00:00.000Z",
          },
        },
      ],
      fulfillmentStartInstructions: [
        {
          shippingStep: {
            shippingServiceCode: "USPSParcel",
          },
        },
      ],
    });

    expect(result?.toISOString()).toBe("2026-06-02T06:59:59.000Z");
  });

  it("uses the earliest valid ship-by date across order and line levels", () => {
    const result = extractEbayShipByDate({
      fulfillmentStartInstructions: [
        { shipByDate: "2026-06-05T07:00:00.000Z" },
        { shippingStep: { shipByDate: "2026-06-04T07:00:00.000Z" } },
      ],
      lineItems: [
        {
          lineItemFulfillmentInstructions: {
            shipByDate: "2026-06-03T07:00:00.000Z",
          },
        },
        {
          lineItemFulfillmentInstructions: {
            shipByDate: "2026-06-02T06:59:59.000Z",
          },
        },
      ],
    });

    expect(result?.toISOString()).toBe("2026-06-02T06:59:59.000Z");
  });

  it("ignores missing and malformed ship-by values", () => {
    const result = extractEbayShipByDate({
      fulfillmentStartInstructions: [
        { shipByDate: "not-a-date" },
        { shippingStep: { shipByDate: "" } },
      ],
      lineItems: [
        { lineItemFulfillmentInstructions: { shipByDate: null } },
        { lineItemFulfillmentInstructions: { shipByDate: "2026-06-04T07:00:00.000Z" } },
      ],
    });

    expect(result?.toISOString()).toBe("2026-06-04T07:00:00.000Z");
  });

  it("returns null when no valid ship-by date exists", () => {
    expect(extractEbayShipByDate({ lineItems: [], fulfillmentStartInstructions: [] })).toBeNull();
    expect(extractEbayShipByDate(null)).toBeNull();
  });
});
