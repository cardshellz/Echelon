import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_RETURN_PROXY_FUTURE_SKEW_SECONDS,
  CUSTOMER_RETURN_PROXY_MAX_AGE_SECONDS,
  CustomerReturnShopifyProofError,
  verifyCustomerReturnShopifyProof,
} from "../../domain/customer-return-shopify-proof";

const now = new Date("2026-09-28T12:00:00Z");
const timestamp = Math.floor(now.getTime() / 1000);
const shop = "test-store.myshopify.com";
const secret = "test-only-shopify-secret";
const state = "x".repeat(43);
function query(
  overrides: Record<string, string | undefined> = {},
  extra: [string, string][] = [],
): string {
  const fields: Record<string, string | undefined> = {
    shop,
    logged_in_customer_id: "900719925474099312345",
    timestamp: String(timestamp),
    state,
    path_prefix: "/apps/echelon-returns",
    ...overrides,
  };
  const entries: [string, string][] = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .concat(extra);
  const grouped = new Map<string, string[]>();
  for (const [key, value] of entries)
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  const signed = [...grouped]
    .map(([key, values]) => `${key}=${values.join(",")}`)
    .sort()
    .join("");
  return `${new URLSearchParams(entries)}&signature=${createHmac("sha256", secret).update(signed).digest("hex")}`;
}
function verify(rawQuery: string) {
  return verifyCustomerReturnShopifyProof({
    rawQuery,
    shopifySecret: secret,
    expectedShop: shop,
    now,
  });
}
function expectFailure(
  rawQuery: string,
  code = "RETURN_HANDOFF_PROOF_INVALID",
) {
  try {
    verify(rawQuery);
    throw new Error("Expected verification rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(CustomerReturnShopifyProofError);
    expect(error).toMatchObject({ code });
  }
}

describe("returns Shopify proxy proof", () => {
  it("preserves a customer ID larger than the safe integer boundary and the exact state", () => {
    expect(verify(query())).toEqual({
      shop,
      customerId: "900719925474099312345",
      pathPrefix: "/apps/echelon-returns",
      state,
      timestamp,
    });
  });
  it("accepts the receiver's exact 30-digit customer ID boundary without numeric conversion", () => {
    const customerId = "9".repeat(30);
    expect(
      verify(query({ logged_in_customer_id: customerId })).customerId,
    ).toBe(customerId);
  });
  it("rejects repeated unknown parameters even with Shopify's documented comma-aggregated signature", () => {
    const message = `extra=1,2logged_in_customer_id=123path_prefix=/apps/echelon-returnsshop=${shop}state=${state}timestamp=${timestamp}`;
    const signature = createHmac("sha256", secret)
      .update(message)
      .digest("hex");
    expectFailure(
      `extra=1&extra=2&shop=${shop}&logged_in_customer_id=123&path_prefix=%2Fapps%2Fechelon-returns&timestamp=${timestamp}&state=${state}&signature=${signature}`,
    );
  });
  it("accepts standard URL encoding but not a different signing algorithm", () => {
    const valid = query({ path_prefix: "/apps/return items" });
    expect(
      verify(valid.replace("return+items", "return%20items")),
    ).toBeDefined();
    const parameters = new URLSearchParams(valid);
    parameters.delete("signature");
    const nonstandard = [...parameters]
      .map(([key, value]) => `${key}=${value}`)
      .sort()
      .join("&");
    parameters.set(
      "signature",
      createHmac("sha256", secret).update(nonstandard).digest("hex"),
    );
    expectFailure(parameters.toString());
  });
  it("represents an anonymous Shopify request without manufacturing customer identity", () => {
    expect(
      verify(query({ logged_in_customer_id: "", state: undefined })),
    ).toEqual({
      shop,
      customerId: "",
      pathPrefix: "/apps/echelon-returns",
      timestamp,
    });
  });
  it.each([
    "shop",
    "logged_in_customer_id",
    "timestamp",
    "state",
    "path_prefix",
  ])(
    "rejects duplicated authority parameter %s even with a valid signature",
    (key) => {
      expectFailure(query({}, [[key, "second"]]));
    },
  );
  it("rejects duplicate signatures and percent-encoded duplicate authority names", () => {
    expectFailure(`${query()}&signature=${"0".repeat(64)}`);
    expectFailure(`${query()}&%73tate=${state}`);
  });
  it.each([
    { logged_in_customer_id: undefined },
    { logged_in_customer_id: "00123" },
    { logged_in_customer_id: "0" },
    { logged_in_customer_id: "gid://shopify/Customer/123" },
    { logged_in_customer_id: "1e20" },
    { logged_in_customer_id: "1".repeat(31) },
    { timestamp: undefined },
    { timestamp: "1.5" },
    { timestamp: "Infinity" },
    { shop: undefined },
    { shop: "TEST-STORE.myshopify.com" },
    { path_prefix: undefined },
    { path_prefix: "" },
    { state: "" },
    { state: "x".repeat(42) },
    { state: "x".repeat(44) },
    { state: `${"x".repeat(42)}+` },
  ])("rejects malformed required identity/proof values %#", (overrides) =>
    expectFailure(query(overrides)),
  );
  it("rejects a correctly signed request for another shop", () => {
    expectFailure(
      query({ shop: "other-store.myshopify.com" }),
      "RETURN_HANDOFF_SHOP_MISMATCH",
    );
  });
  it("applies inclusive age/skew boundaries and rejects expired or future proof", () => {
    expect(
      verify(
        query({
          timestamp: String(timestamp - CUSTOMER_RETURN_PROXY_MAX_AGE_SECONDS),
        }),
      ),
    ).toBeDefined();
    expect(
      verify(
        query({
          timestamp: String(
            timestamp + CUSTOMER_RETURN_PROXY_FUTURE_SKEW_SECONDS,
          ),
        }),
      ),
    ).toBeDefined();
    expectFailure(
      query({
        timestamp: String(
          timestamp - CUSTOMER_RETURN_PROXY_MAX_AGE_SECONDS - 1,
        ),
      }),
      "RETURN_HANDOFF_PROOF_EXPIRED",
    );
    expectFailure(
      query({
        timestamp: String(
          timestamp + CUSTOMER_RETURN_PROXY_FUTURE_SKEW_SECONDS + 1,
        ),
      }),
      "RETURN_HANDOFF_PROOF_EXPIRED",
    );
  });
  it.each([
    "",
    "signature=short",
    "signature=" + "0".repeat(64),
    "bad=%ZZ",
    "bad=%E0%A4%A",
    "bad",
    "x=" + "a".repeat(8193),
  ])(
    "rejects malformed, missing or oversized signed requests %#",
    expectFailure,
  );
  it("rejects a changed signed customer and a valid signature made with another secret", () => {
    expectFailure(query().replace("900719925474099312345", "123"));
    expect(() =>
      verifyCustomerReturnShopifyProof({
        rawQuery: query(),
        shopifySecret: "wrong-secret",
        expectedShop: shop,
        now,
      }),
    ).toThrow(CustomerReturnShopifyProofError);
  });
  it("bounds parameter count, text controls and clock values", () => {
    expectFailure(
      query(
        {},
        Array.from(
          { length: 41 },
          () => ["extra", "value"] as [string, string],
        ),
      ),
    );
    expectFailure(query({ path_prefix: "/apps/line\nvalue" }));
    expect(() =>
      verifyCustomerReturnShopifyProof({
        rawQuery: query(),
        shopifySecret: secret,
        expectedShop: shop,
        now: new Date(NaN),
      }),
    ).toThrow("temporarily unavailable");
  });

  it("accepts only the six authority fields and rejects additional fields even below the count bound", () => {
    expect(query().split("&")).toHaveLength(6);
    expect(verify(query()).customerId).toBe("900719925474099312345");
    expectFailure(query({}, [["tracking", "value"]]));
    expectFailure(query({ state: undefined }, [["tracking", "value"]]));
  });

  it("applies the raw query byte limit inclusively without truncating signed input", () => {
    const path = "€".repeat(850);
    const pathPrefix =
      path +
      "a".repeat(
        8192 - Buffer.byteLength(query({ path_prefix: path }), "utf8"),
      );
    const exact = query({ path_prefix: pathPrefix });
    expect(Buffer.byteLength(exact, "utf8")).toBe(8192);
    expect(verify(exact)).toBeDefined();
    expectFailure(query({ path_prefix: `${pathPrefix}a` }));
  });

  it("bounds known decoded values and rejects unknown or malformed keys", () => {
    expect(
      verify(query({ path_prefix: "v".repeat(2048) })).pathPrefix,
    ).toHaveLength(2048);
    expectFailure(query({}, [["x".repeat(129), "value"]]));
    expectFailure(query({ path_prefix: "v".repeat(2049) }));
    expectFailure(query({}, [["", "value"]]));
    expectFailure(query({}, [["key\u007f", "value"]]));
    expectFailure(query({ path_prefix: "/apps/value\u0000" }));
  });

  it("requires one exact lowercase hexadecimal signature and the unchanged raw query", () => {
    const valid = query();
    const signature = new URLSearchParams(valid).get("signature")!;
    expectFailure(valid.replace(signature, signature.toUpperCase()));
    expectFailure(valid.replace(signature, `${signature}0`));
    expectFailure(valid.replace(signature, signature.slice(1)));
    expectFailure(valid.replace(signature, "g".repeat(64)));
    expectFailure(`?${valid}`);
    expectFailure(`${valid}&`);
  });

  it("rejects duplicate encoded customer and timestamp authority fields even when equal", () => {
    expectFailure(`${query()}&logged_in_%63ustomer_id=900719925474099312345`);
    expectFailure(`${query()}&%74imestamp=${timestamp}`);
  });

  it("rejects a guest signature recast as customer authority through an encoded equals key", () => {
    const guest = query({ logged_in_customer_id: "" }, [
      ["a", "logged_in_customer_id=123"],
    ]);
    expectFailure(guest);
    // These two queries produce the same separator-free signing message unless
    // decoded keys containing '=' are rejected. The signature is unchanged.
    const forged = new URLSearchParams(guest);
    forged.set("a", "");
    forged.set("logged_in_customer_id", "123");
    forged.delete("path_prefix");
    forged.set("logged_in_customer_id=path_prefix", "/apps/echelon-returns");
    expectFailure(forged.toString());
  });

  it("rejects customer authority absorbed into unknown values despite ordinary parameter names", () => {
    const guest = query({ logged_in_customer_id: "" }, [
      ["a", "foologged_in_customer_id=123m="],
    ]);
    const forged = new URLSearchParams(guest);
    forged.set("a", "foo");
    forged.set("logged_in_customer_id", "123");
    forged.set("m", "logged_in_customer_id=");
    const message = (raw: string) =>
      [...new URLSearchParams(raw)]
        .filter(([key]) => key !== "signature")
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join("");
    expect(message(forged.toString())).toBe(message(guest));
    expect(forged.get("signature")).toBe(
      new URLSearchParams(guest).get("signature"),
    );
    expectFailure(guest);
    expectFailure(forged.toString());
  });

  it("rejects signed ambiguous parameter names even when all required authority fields are present", () => {
    expectFailure(query({}, [["extra=key", "value"]]));
    expectFailure(
      query({}, [
        ["logged_in_customer_id=path_prefix", "/apps/echelon-returns"],
      ]),
    );
  });

  it.each(["a", "m", "extra", "redirect", "utm_source", "SHOP", "state[]"])(
    "rejects the unknown signed query key %s rather than discarding it",
    (key) => expectFailure(query({ state: undefined }, [[key, "value"]])),
  );

  it("returns the exact signed proxy path for the application's configured-path comparison", () => {
    expect(
      verify(query({ path_prefix: "/tools/return-items" })).pathPrefix,
    ).toBe("/tools/return-items");
    expect(
      verify(query({ path_prefix: "/apps/echelon-returns/" })).pathPrefix,
    ).toBe("/apps/echelon-returns/");
  });

  it("returns only validated identity facts and preserves the caller input", () => {
    const input = Object.freeze({
      rawQuery: query(),
      shopifySecret: secret,
      expectedShop: shop,
      now,
    });
    expect(verifyCustomerReturnShopifyProof(input)).toEqual({
      shop,
      customerId: "900719925474099312345",
      pathPrefix: "/apps/echelon-returns",
      state,
      timestamp,
    });
    expect(input.now.toISOString()).toBe("2026-09-28T12:00:00.000Z");
  });

  it("classifies an invalid clock separately and rejects invalid verifier configuration", () => {
    expect(() =>
      verifyCustomerReturnShopifyProof({
        rawQuery: query(),
        shopifySecret: secret,
        expectedShop: shop,
        now: new Date(NaN),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "CustomerReturnShopifyProofError",
        code: "RETURN_HANDOFF_CLOCK_INVALID",
        status: 503,
      }),
    );
    for (const overrides of [
      { shopifySecret: "" },
      { expectedShop: "https://test-store.myshopify.com" },
    ]) {
      expect(() =>
        verifyCustomerReturnShopifyProof({
          rawQuery: query(),
          shopifySecret: secret,
          expectedShop: shop,
          now,
          ...overrides,
        }),
      ).toThrowError(
        expect.objectContaining({
          code: "RETURN_HANDOFF_PROOF_INVALID",
          status: 401,
        }),
      );
    }
  });
});
