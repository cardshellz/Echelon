import { describe, expect, it, vi } from "vitest";
import { createOmsService } from "../../oms.service";
import { __test__ as webhook } from "../../oms-webhooks";
import { normalizeShopifyCustomerId, validateShopifyCustomerIdentityCopy } from "../../shopify-customer-identity";

vi.mock("../../../../db", () => ({ db: {} }));

describe("Shopify customer identity copy", () => {
  it.each([3978054467743, "3978054467743", "gid://shopify/Customer/3978054467743", " 3978054467743 "])(
    "preserves exact identity from %j", value => expect(normalizeShopifyCustomerId(value)).toBe("3978054467743"),
  );
  it.each([null, undefined])("accepts a genuinely absent customer %j", value => {
    expect(normalizeShopifyCustomerId(value)).toBeNull();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "0", "wrong", "gid://shopify/Order/123", {}, [], "1".repeat(101)])(
    "rejects invalid customer identity %j", value => {
      expect(() => normalizeShopifyCustomerId(value)).toThrow(expect.objectContaining({ code: "OMS_CUSTOMER_ID_INVALID" }));
    },
  );
  it("keeps large string IDs exact without converting them through floating point", () => {
    expect(normalizeShopifyCustomerId("9007199254740993")).toBe("9007199254740993");
  });
  it.each([
    { sourceTopic: "shopify/bridge", rawPayload: { order: { shopify_customer_id: "3978054467743" } } },
    { sourceTopic: "orders/paid", rawPayload: { customer: { id: 3978054467743 } } },
  ])("rejects a dropped source ID on $sourceTopic before a transaction starts", async source => {
    const transaction = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(createOmsService({ transaction }).ingestOrder(36, "1001", {
        ...source, orderedAt: new Date("2026-10-08T12:00:00Z"), lineItems: [],
      })).rejects.toMatchObject({ code: "OMS_CUSTOMER_ID_MISSING" });
      expect(transaction).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("oms_customer_identity_validation_failed"));
    } finally { log.mockRestore(); }
  });
  it("rejects a customer ID copied from a different Shopify order", () => {
    expect(() => validateShopifyCustomerIdentityCopy({
      sourceTopic: "orders/updated", externalCustomerId: "222",
      rawPayload: { customer: { id: "111" } },
    })).toThrow(expect.objectContaining({ code: "OMS_CUSTOMER_ID_CONFLICT" }));
  });
  it("rejects an invented ID when the source explicitly declares no customer", () => {
    expect(() => validateShopifyCustomerIdentityCopy({ sourceTopic: "orders/updated", externalCustomerId: "111",
      rawPayload: { customer: null } })).toThrow(expect.objectContaining({ code: "OMS_CUSTOMER_ID_CONFLICT" }));
  });
  it("accepts matching numeric and GID representations without modifying the payload", () => {
    const input = { sourceTopic: "shopify/bridge", externalCustomerId: "gid://shopify/Customer/111",
      rawPayload: { order: { shopify_customer_id: "111" } } };
    const before = structuredClone(input);
    expect(() => validateShopifyCustomerIdentityCopy(input)).not.toThrow();
    expect(input).toEqual(before);
  });
  it("leaves non-Shopify channel customer identifiers unchanged", () => {
    expect(() => validateShopifyCustomerIdentityCopy({ sourceTopic: "ebay/order", externalCustomerId: "buyer-username",
      rawPayload: { buyer: { username: "buyer-username" } } })).not.toThrow();
  });
  it.each(["3978054467743", 3978054467743, "gid://shopify/Customer/3978054467743", null])(
    "copies webhook customer identity %j explicitly", customerId => {
      const mapped = webhook.mapShopifyOrderToOrderData({ customer: { id: customerId }, line_items: [] });
      expect(mapped.externalCustomerId).toBe(customerId === null ? null : "3978054467743");
    },
  );
});
