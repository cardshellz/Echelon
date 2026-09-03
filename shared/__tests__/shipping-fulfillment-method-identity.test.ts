import { describe, expect, it } from "vitest";
import {
  shippingFulfillmentMethodGroupKey,
  shippingFulfillmentMethodIdentityKey,
  shippingFulfillmentMethodScopeLabel,
} from "../lib/shipping-fulfillment-method-identity";

const base = {
  providerConnectionId: 11,
  provider: "shipstation_v2",
  providerAccountId: "se-342200",
  serviceCode: "ups_worldwide_saver",
};

describe("shipping fulfillment method identity", () => {
  it("keeps destination scope in executable identity", () => {
    const domestic = { ...base, domestic: true, international: false };
    const international = { ...base, domestic: false, international: true };

    expect(shippingFulfillmentMethodIdentityKey(domestic))
      .not.toBe(shippingFulfillmentMethodIdentityKey(international));
  });

  it("groups scoped variants only for presentation", () => {
    const domestic = { ...base, domestic: true, international: false };
    const international = { ...base, domestic: false, international: true };

    expect(shippingFulfillmentMethodGroupKey(domestic))
      .toBe(shippingFulfillmentMethodGroupKey(international));
    expect(shippingFulfillmentMethodScopeLabel(domestic)).toBe("Domestic");
    expect(shippingFulfillmentMethodScopeLabel(international)).toBe("International");
  });
});
