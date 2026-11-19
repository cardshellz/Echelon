import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_WINDOW_MS,
  hashShopifyOAuthValue,
  normalizeShopifyShop,
  parseAndVerifyShopifyStaffOAuthCallback,
  parseShopifyStaffOAuthConfig,
} from "../../domain/shopify-staff-oauth";
import { ShopifyStaffOAuthError } from "../../shopify-staff-oauth.types";

const env = { SHOPIFY_API_KEY: "fixture-client", SHOPIFY_API_SECRET: "fixture-secret-only" };
const config = parseShopifyStaffOAuthConfig(env);
const now = new Date("2026-11-03T12:00:00.000Z");
const timestamp = String(now.getTime() / 1000);
const state = `echelon-shopify-${"a".repeat(64)}`;
const fields = { code: "grant", shop: "card-shellz.myshopify.com", state, timestamp };
const sign = (canonical: string) => createHmac("sha256", env.SHOPIFY_API_SECRET).update(canonical, "utf8").digest("hex");

// Helpers for signed schema/freshness cases. Canonicalization edge vectors below
// deliberately provide their message separately from their encoded query.
function signedQuery(overrides: Record<string, string> = {}): string {
  const values = { ...fields, ...overrides };
  const canonical = Object.keys(values).sort().map(key => `${key}=${values[key as keyof typeof values]}`).join("&");
  return new URLSearchParams({ ...values, hmac: sign(canonical) }).toString();
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ShopifyStaffOAuthError);
    expect(error).toMatchObject({ code, message: code });
    expect((error as Error).cause).toBeUndefined();
    return;
  }
  throw new Error(`Expected ${code}`);
}

describe("Shopify staff OAuth configuration", () => {
  it("preserves the existing default shop, redirect and ten scopes", () => {
    expect(config).toMatchObject({
      shopDomain: "card-shellz.myshopify.com", clientId: env.SHOPIFY_API_KEY, clientSecret: env.SHOPIFY_API_SECRET,
      redirectUri: "https://cardshellz-echelon-f21ea7da3008.herokuapp.com/api/shopify/oauth/callback",
      scopes: ["read_products", "write_products", "read_inventory", "write_inventory", "read_orders", "write_orders",
        "read_fulfillments", "write_fulfillments", "read_shipping", "read_locations"],
    });
    expect(AUTHORIZATION_WINDOW_MS).toBe(600_000);
  });

  it("uses normalized shop identity but preserves an explicitly configured HTTPS redirect exactly", () => {
    const redirectUri = "https://staff.example.test:8443/oauth/callback?source=shopify";
    const custom = parseShopifyStaffOAuthConfig({ ...env, SHOPIFY_SHOP_DOMAIN: "My-Shop", SHOPIFY_OAUTH_REDIRECT_URI: redirectUri });
    expect(custom.shopDomain).toBe("my-shop.myshopify.com");
    expect(custom.redirectUri).toBe(redirectUri);
    expect(custom.scopes).toEqual(config.scopes);
  });

  it("binds fingerprint identity to credentials, shop, redirect and the fixed scope contract", () => {
    expect(config.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(parseShopifyStaffOAuthConfig({ ...env, SHOPIFY_SHOP_DOMAIN: "CARD-SHELLZ.MYSHOPIFY.COM" }).fingerprint)
      .toBe(config.fingerprint);
    for (const changed of [
      { SHOPIFY_API_KEY: "different-client" }, { SHOPIFY_API_SECRET: "different-secret" },
      { SHOPIFY_SHOP_DOMAIN: "different-shop" }, { SHOPIFY_OAUTH_REDIRECT_URI: "https://staff.example.test/oauth/callback" },
    ]) expect(parseShopifyStaffOAuthConfig({ ...env, ...changed }).fingerprint).not.toBe(config.fingerprint);
    expect(config.fingerprint).not.toContain(env.SHOPIFY_API_SECRET);
    expect(Object.isFrozen(config.scopes)).toBe(true);
  });

  it.each([
    {}, { SHOPIFY_API_KEY: "fixture-client" }, { SHOPIFY_API_SECRET: "fixture-secret-only" },
    { ...env, SHOPIFY_API_KEY: " " }, { ...env, SHOPIFY_API_KEY: "client\n" },
    { ...env, SHOPIFY_API_SECRET: "secret\n" }, { ...env, SHOPIFY_API_SECRET: "secret\0" },
    { ...env, SHOPIFY_API_SECRET: "s".repeat(2049) },
    { ...env, SHOPIFY_SHOP_DOMAIN: "shop.myshopify.com.evil.test" },
  ])("rejects incomplete or malformed configuration without exposing values", (input) => {
    expectCode(() => parseShopifyStaffOAuthConfig(input), "SHOPIFY_OAUTH_CONFIG_INVALID");
  });

  it.each([
    "http://staff.example.test/callback", "//staff.example.test/callback", "/callback", "not a URL",
    "https://user:password@staff.example.test/callback", "https://staff.example.test/callback#token",
    "https://staff.example.test/callback\n", "https://staff.example.test\\@evil.test/callback",
    "https://", `https://staff.example.test/${"x".repeat(2048)}`,
  ])("rejects an unsafe redirect configuration: %s", (redirect) => {
    expectCode(() => parseShopifyStaffOAuthConfig({ ...env, SHOPIFY_OAUTH_REDIRECT_URI: redirect }), "SHOPIFY_OAUTH_CONFIG_INVALID");
  });
});

describe("Shopify exchange host normalization", () => {
  it("accepts only a single ASCII shop label under the exact Shopify suffix", () => {
    expect(normalizeShopifyShop("Card-Shellz.MyShopify.Com")).toBe("card-shellz.myshopify.com");
    expect(normalizeShopifyShop("a.myshopify.com")).toBe("a.myshopify.com");
    expect(normalizeShopifyShop(`${"x".repeat(63)}.myshopify.com`)).toBe(`${"x".repeat(63)}.myshopify.com`);
    expect(normalizeShopifyShop("Card-Shellz", true)).toBe("card-shellz.myshopify.com");
    expectCode(() => normalizeShopifyShop("card-shellz"), "SHOPIFY_OAUTH_SHOP_INVALID");
  });

  it.each([
    undefined, null, [], {}, "", "shop.myshopify.com.evil.test", "shop.myshopify.com.", "shop.myshopify.com:443",
    "https://shop.myshopify.com", "shop.myshopify.com/path", "shop.myshopify.com?x=1", "shop.myshopify.com#x",
    "user@shop.myshopify.com", "shop@evil.test", "a.b.myshopify.com", "shop..myshopify.com",
    "-shop.myshopify.com", "shop-.myshopify.com", "shop_name.myshopify.com", "shop.myshopify.com\\evil.test",
    " shop.myshopify.com", "shop.myshopify.com ", "shop.myshopify.com\n", "shop.myshopify.com\r",
    "shop.myshopify.com\t", "shop.myshopify.com\0", "shöp.myshopify.com", "shop.myshopify.com\u2028",
    "shop。myshopify.com", `${"x".repeat(64)}.myshopify.com`, "shop%2emyshopify.com",
  ])("rejects malformed or non-Shopify destinations in either mode", (shop) => {
    expectCode(() => normalizeShopifyShop(shop), "SHOPIFY_OAUTH_SHOP_INVALID");
    expectCode(() => normalizeShopifyShop(shop, true), "SHOPIFY_OAUTH_SHOP_INVALID");
  });
});

describe("Shopify staff OAuth signed callback", () => {
  it("accepts independently signed reordered fields and returns only the validated command input", () => {
    const canonical = `code=grant&shop=card-shellz.myshopify.com&state=${state}&timestamp=${timestamp}`;
    const query = `timestamp=${timestamp}&state=${state}&hmac=${sign(canonical)}&shop=card-shellz.myshopify.com&code=grant`;
    expect(parseAndVerifyShopifyStaffOAuthCallback(query, config, now)).toEqual({
      code: "grant", shopDomain: "card-shellz.myshopify.com", state,
      stateHash: createHash("sha256").update(state).digest("hex"),
    });
    expect(parseAndVerifyShopifyStaffOAuthCallback(`?${query}`, config, now).state).toBe(state);
  });

  it("signs original shop casing before normalization and includes every unknown scalar field", () => {
    const canonical = `code=grant&host=YWRtaW4=&shop=Card-Shellz.MyShopify.Com&signature=also-signed&state=${state}&timestamp=${timestamp}`;
    const query = `shop=Card-Shellz.MyShopify.Com&code=grant&host=YWRtaW4%3D&signature=also-signed&state=${state}&timestamp=${timestamp}&hmac=${sign(canonical)}`;
    expect(parseAndVerifyShopifyStaffOAuthCallback(query, config, now).shopDomain).toBe(config.shopDomain);
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.replace("also-signed", "tampered"), config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.replace("Card-Shellz.MyShopify.Com", "card-shellz.myshopify.com"), config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });

  it("decodes percent escapes and form plus signs once, without re-encoding or double decoding the signed values", () => {
    const canonical = `code=grant+%2B&note=space + literal&shop=card-shellz.myshopify.com&state=${state}&timestamp=${timestamp}`;
    const query = `note=space+%2B+literal&code=grant%2B%252B&timestamp=${timestamp}&shop=card-shellz.myshopify.com&state=${state}&hmac=${sign(canonical)}`;
    expect(parseAndVerifyShopifyStaffOAuthCallback(query, config, now).code).toBe("grant+%2B");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.replace("grant%2B%252B", "grant+%252B"), config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });

  it("includes an empty unknown field in the signature and accepts hexadecimal HMAC casing", () => {
    const canonical = `code=grant&extra=&shop=card-shellz.myshopify.com&state=${state}&timestamp=${timestamp}`;
    const query = `code=grant&extra=&shop=card-shellz.myshopify.com&state=${state}&timestamp=${timestamp}&hmac=${sign(canonical).toUpperCase()}`;
    expect(parseAndVerifyShopifyStaffOAuthCallback(query, config, now).code).toBe("grant");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.replace("extra=&", ""), config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });

  it.each(["code", "shop", "state", "hmac", "timestamp"])("requires a nonempty %s field", (key) => {
    const query = new URLSearchParams(signedQuery());
    query.delete(key);
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.toString(), config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
    query.set(key, "");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.toString(), config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
  });

  it.each(["g".repeat(64), "0".repeat(63), "0".repeat(65), "0".repeat(64)])("rejects malformed or incorrect HMAC values", (hmac) => {
    const query = new URLSearchParams(signedQuery()); query.set("hmac", hmac);
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query.toString(), config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });

  it.each(["code=second", "co%64e=grant", "hmac=duplicate", "%68mac=duplicate", "shop=card-shellz.myshopify.com", "state=duplicate"])(
    "rejects duplicate decoded query keys: %s", (duplicate) => {
      expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(`${signedQuery()}&${duplicate}`, config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
    },
  );

  it.each(["extra=%", "extra=%2", "extra=%GG", "extra=%ff", "extra=%C0%AF", "extra=%E0%A4", "extra=%ED%A0%80", "extra=%00", "ex%0Atra=value"])(
    "rejects malformed encoding or decoded control characters: %s", (extra) => {
      expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(`${signedQuery()}&${extra}`, config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
    },
  );

  it.each(["", "?", "&&", "code", "=value", "code=grant&", "code=grant\n"])("rejects malformed query structure", (query) => {
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query, config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
  });

  it("bounds raw input, field counts, key/value lengths and authorization code length", () => {
    const invalidQueries = [
      "x".repeat(8193), `${signedQuery()}&${"k".repeat(129)}=value`, `${signedQuery()}&extra=${"v".repeat(2049)}`,
      `${signedQuery()}&${Array.from({ length: 28 }, (_, index) => `extra${index}=v`).join("&")}`,
      signedQuery({ code: "c".repeat(513) }), signedQuery({ code: "   " }),
    ];
    for (const query of invalidQueries) expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query, config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(null as unknown as string, config, now), "SHOPIFY_OAUTH_CALLBACK_INVALID");
  });

  it.each(["echelon-shopify-short", `echelon-shopify-${"g".repeat(64)}`, `echelon-other-${"a".repeat(64)}`, "[object Object]"])(
    "rejects signed states outside this staff flow's nonce format", (invalidState) => {
      expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery({ state: invalidState }), config, now), "SHOPIFY_OAUTH_STATE_INVALID");
    },
  );

  it("requires the signed shop to match configured identity and never accepts a bare callback host", () => {
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery({ shop: "different.myshopify.com" }), config, now), "SHOPIFY_OAUTH_SHOP_MISMATCH");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery({ shop: "card-shellz" }), config, now), "SHOPIFY_OAUTH_SHOP_INVALID");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery({ shop: "card-shellz.myshopify.com.evil.test" }), config, now), "SHOPIFY_OAUTH_SHOP_INVALID");
  });

  it("rejects a signature for different credentials", () => {
    const changed = parseShopifyStaffOAuthConfig({ ...env, SHOPIFY_API_SECRET: "new-fixture-secret" });
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery(), changed, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });

  it("accepts exactly the ten-minute past and two-minute future limits", () => {
    for (const delta of [-600, 120]) {
      const query = signedQuery({ timestamp: String(Number(timestamp) + delta) });
      expect(parseAndVerifyShopifyStaffOAuthCallback(query, config, now).code).toBe("grant");
    }
  });

  it.each([String(Number(timestamp) - 601), String(Number(timestamp) + 121), "Infinity", "NaN", "1e9", "-1", "1.2", "9999999999999", " 1"])(
    "rejects stale, future, nonintegral or malformed signed timestamps", (invalidTimestamp) => {
      expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery({ timestamp: invalidTimestamp }), config, now), "SHOPIFY_OAUTH_TIMESTAMP_INVALID");
    },
  );

  it("rejects an invalid injected clock and preserves safe errors", () => {
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(signedQuery(), config, new Date(Number.NaN)), "SHOPIFY_OAUTH_TIMESTAMP_INVALID");
    const query = signedQuery({ code: "secret-untrusted-code" }).replace("secret-untrusted-code", "tampered-untrusted-code");
    expectCode(() => parseAndVerifyShopifyStaffOAuthCallback(query, config, now), "SHOPIFY_OAUTH_HMAC_INVALID");
  });
});

describe("OAuth value hashing", () => {
  it("uses the standard SHA-256 digest without retaining the raw value", () => {
    expect(hashShopifyOAuthValue("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashShopifyOAuthValue(state)).not.toContain(state);
  });
});
