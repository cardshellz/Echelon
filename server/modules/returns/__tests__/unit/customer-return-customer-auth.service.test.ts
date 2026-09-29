import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnCustomerAuthService, readReturnCustomerAuthConfig, RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH,
  type ReturnCustomerAuthConfig, type ReturnLoginChallengeStore,
} from "../../application/customer-return-customer-auth.service";

const NOW = new Date("2026-09-28T12:00:00Z");
const STORAGE_SECRET = "test-only-returns-handoff-secret-long-enough";
const SHOPIFY_SECRET = "test-only-shopify-proxy-app-secret";
const SHOP = "returns-test.myshopify.com";
const CUSTOMER = "12345678901234";
const STATE = "a".repeat(43);
const PROXY_URL = "https://store.example.com/apps/echelon-returns";
const CONFIG: ReturnCustomerAuthConfig = {
  storageSecret: STORAGE_SECRET, publicOrigin: "https://returns.example.com",
  shops: { [SHOP]: { proxyUrl: PROXY_URL, shopifySecret: SHOPIFY_SECRET } },
};
const SHOP_MAPPING = { channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "Test shop" };

function setup(config = CONFIG) {
  let now = NOW;
  const pending = new Map<string, { browserHash: string; shopDomain: string; expiresAt: Date; consumed: boolean }>();
  const create = vi.fn<ReturnLoginChallengeStore["create"]>(async input => { pending.set(input.stateHash, { ...input, consumed: false }); });
  const consume = vi.fn<ReturnLoginChallengeStore["consume"]>(async input => {
    const record = pending.get(input.stateHash);
    if (!record || record.consumed || record.browserHash !== input.browserHash || record.shopDomain !== input.shopDomain || record.expiresAt <= input.now) return null;
    record.consumed = true; return record.expiresAt;
  });
  const shops = vi.fn(async () => [SHOP_MAPPING]);
  const auth = new CustomerReturnCustomerAuthService({ config, challenges: { create, consume }, shops, now: () => now, randomState: () => STATE });
  return { auth, create, consume, shops, setNow: (value: Date) => { now = value; } };
}

function signedQuery(changes: Record<string, string | undefined> = {}, secret = SHOPIFY_SECRET): string {
  const values = Object.entries({ shop: SHOP, logged_in_customer_id: CUSTOMER, state: STATE,
    timestamp: String(NOW.getTime() / 1000), path_prefix: "/apps/echelon-returns", ...changes })
    .filter((entry): entry is [string, string] => entry[1] !== undefined);
  const message = values.map(([key, value]) => `${key}=${value}`).sort().join("");
  return `${new URLSearchParams(values)}&signature=${createHmac("sha256", secret).update(message).digest("hex")}`;
}
const encoded = (query = signedQuery()) => Buffer.from(query, "utf8").toString("base64url");

describe("direct Shopify returns authentication", () => {
  it("starts on the dedicated Shopify proxy and binds the exact browser challenge", async () => {
    const { auth, create } = setup();
    const url = new URL(await auth.start("browser-one"));
    expect(`${url.origin}${url.pathname}`).toBe(PROXY_URL);
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(JSON.stringify(create.mock.calls)).not.toContain("browser-one");
    const session = await auth.authenticate("browser-one", encoded());
    expect(session).toMatchObject({ channelId: 36, externalCustomerId: CUSTOMER, shopDomain: SHOP });
    expect(await auth.principal(session)).toEqual(session);
    await expect(auth.authenticate("browser-one", encoded())).rejects.toMatchObject({ status: 401 });
  });

  it("transports the original signed proof without consuming the browser challenge", async () => {
    const s = setup();
    const raw = signedQuery();
    await expect(s.auth.proxy(raw)).resolves.toEqual({ kind: "handoff", proof: encoded(raw),
      callbackUrl: "https://returns.example.com/customer-returns/callback" });
    expect(s.create).not.toHaveBeenCalled(); expect(s.consume).not.toHaveBeenCalled();
  });

  it("returns to the Echelon start gate when signed browser state is absent", async () => {
    const s = setup();
    await expect(s.auth.proxy(signedQuery({ state: undefined, logged_in_customer_id: "" })))
      .resolves.toEqual({ kind: "redirect", location: `https://returns.example.com/customer-returns/start?shop=${SHOP}` });
    expect(s.consume).not.toHaveBeenCalled(); expect(s.create).not.toHaveBeenCalled();
  });

  it("sends guests to the configured storefront login with only the fixed proxy path and state", async () => {
    const { auth } = setup();
    const result = await auth.proxy(signedQuery({ logged_in_customer_id: "" }));
    expect(result.kind).toBe("redirect");
    if (result.kind !== "redirect") throw new Error("Expected login redirect");
    const login = new URL(result.location);
    expect(`${login.origin}${login.pathname}`).toBe("https://store.example.com/account/login");
    expect([...login.searchParams.keys()]).toEqual(["return_url"]);
    expect(login.searchParams.get("return_url")).toBe(`/apps/echelon-returns?state=${STATE}`);
  });

  it("rejects another browser without consuming the legitimate challenge", async () => {
    const { auth } = setup(); await auth.start("browser-one");
    await expect(auth.authenticate("browser-two", encoded())).rejects.toMatchObject({ status: 401 });
    await expect(auth.authenticate("browser-one", encoded())).resolves.toMatchObject({ channelId: 36 });
  });

  it("allows only one redemption when the same proof is retried concurrently", async () => {
    const { auth } = setup(); await auth.start("browser");
    const outcomes = await Promise.allSettled([auth.authenticate("browser", encoded()), auth.authenticate("browser", encoded())]);
    expect(outcomes.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(value => value.status === "rejected")).toHaveLength(1);
  });

  it.each([
    ["wrong shop", { shop: "other.myshopify.com" }],
    ["unconfigured signed path", { path_prefix: "/apps/other-returns" }],
    ["legacy Club path", { path_prefix: "/apps/member-portal" }],
    ["missing path", { path_prefix: undefined }],
    ["missing state", { state: undefined }],
    ["guest customer", { logged_in_customer_id: "" }],
    ["missing customer", { logged_in_customer_id: undefined }],
    ["unsafe customer", { logged_in_customer_id: "gid://shopify/Customer/123" }],
    ["invalid state", { state: "short" }],
    ["expired proof", { timestamp: String(NOW.getTime() / 1000 - 301) }],
    ["future proof", { timestamp: String(NOW.getTime() / 1000 + 31) }],
  ] satisfies Array<[string, Record<string, string | undefined>]>)("rejects %s before consuming", async (_label, changes) => {
    const { auth, consume } = setup(); await auth.start("browser");
    await expect(auth.authenticate("browser", encoded(signedQuery(changes)))).rejects.toMatchObject({ status: 401 });
    expect(consume).not.toHaveBeenCalled();
  });

  it.each([-300, 30])("accepts the documented timestamp boundary of %i seconds", async seconds => {
    const { auth } = setup(); await auth.start("browser");
    await expect(auth.authenticate("browser", encoded(signedQuery({ timestamp: String(NOW.getTime() / 1000 + seconds) }))))
      .resolves.toMatchObject({ channelId: 36 });
  });

  it("never falls back to the storage secret or another shop's app secret", async () => {
    const secondShop = "second.myshopify.com";
    const secondSecret = "test-only-second-shop-secret";
    const s = setup({ ...CONFIG, shops: { ...CONFIG.shops,
      [secondShop]: { proxyUrl: "https://second.example.com/apps/echelon-returns", shopifySecret: secondSecret } } });
    s.shops.mockResolvedValue([SHOP_MAPPING, { ...SHOP_MAPPING, shopDomain: secondShop, channelId: 37, connectionId: 5 }]);
    await s.auth.start("browser", SHOP);
    for (const wrongKey of [STORAGE_SECRET, secondSecret, "invalid-secret"]) {
      await expect(s.auth.authenticate("browser", encoded(signedQuery({}, wrongKey)))).rejects.toMatchObject({ status: 401 });
    }
    expect(s.consume).not.toHaveBeenCalled();
    await expect(s.auth.authenticate("browser", encoded())).resolves.toMatchObject({ channelId: 36 });
  });

  it("rejects legacy Club JWTs even when signed with the retained storage key", async () => {
    const { auth, consume } = setup(); await auth.start("browser");
    const token = jwt.sign({ iss: "shellz-club-returns", aud: "echelon-customer-returns", shop: SHOP, customerId: CUSTOMER,
      state: STATE, jti: "00000000-0000-4000-8000-000000000001", iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 90 }, STORAGE_SECRET);
    await expect(auth.authenticate("browser", token)).rejects.toMatchObject({ status: 401 });
    await expect(auth.authenticate("browser", encoded(token))).rejects.toMatchObject({ status: 401 });
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects malformed, padded, noncanonical, oversized and invalid-UTF8 transport encoding", async () => {
    const { auth, consume } = setup(); await auth.start("browser");
    for (const value of [null, {}, "", "a", "Zh", `${encoded()}=`, "a".repeat(RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH + 1),
      Buffer.from([0xff]).toString("base64url"), encoded("a".repeat(8193))]) {
      await expect(auth.authenticate("browser", value)).rejects.toMatchObject({ status: 401 });
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects modified signed bytes, repeated authority fields and malformed raw query decoding", async () => {
    const { auth, consume } = setup(); await auth.start("browser");
    for (const query of [signedQuery().replace(CUSTOMER, "456"), `${signedQuery()}&shop=${SHOP}`, `${signedQuery()}&state=${STATE}`,
      `${signedQuery()}&note=%GG`, "a".repeat(8193)]) {
      await expect(auth.proxy(query)).rejects.toMatchObject({ status: 401 });
      await expect(auth.authenticate("browser", encoded(query))).rejects.toMatchObject({ status: 401 });
    }
    expect(consume).not.toHaveBeenCalled();
  });

  it("rejects expired browser challenges even with fresh Shopify proof", async () => {
    const { auth, setNow } = setup(); await auth.start("browser");
    setNow(new Date(NOW.getTime() + 300_000));
    await expect(auth.authenticate("browser", encoded(signedQuery({ timestamp: String(NOW.getTime() / 1000 + 300) }))))
      .rejects.toMatchObject({ status: 401 });
  });

  it("rejects unknown or ambiguous shop mappings before creating a challenge", async () => {
    const { auth, shops, create } = setup();
    await expect(auth.start("browser", "evil.example.com")).rejects.toMatchObject({ status: 400 });
    shops.mockResolvedValue([SHOP_MAPPING, { ...SHOP_MAPPING, channelId: 37, connectionId: 5 }]);
    await expect(auth.start("browser", SHOP)).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([{ mapping: [] }, { mapping: [SHOP_MAPPING, { ...SHOP_MAPPING, channelId: 37, connectionId: 5 }] }])("requires one approved shop mapping during proxy and redemption", async ({ mapping }) => {
    const s = setup(); await s.auth.start("browser"); s.shops.mockResolvedValue(mapping);
    await expect(s.auth.proxy(signedQuery())).rejects.toMatchObject({ status: 401 });
    await expect(s.auth.authenticate("browser", encoded())).rejects.toMatchObject({ status: 401 });
    expect(s.consume).not.toHaveBeenCalled();
  });

  it("rechecks signed-proof age after asynchronous shop resolution", async () => {
    for (const operation of ["proxy", "authenticate"] as const) {
      const s = setup(); await s.auth.start("browser");
      s.shops.mockImplementation(async () => { s.setNow(new Date(NOW.getTime() + 301_000)); return [SHOP_MAPPING]; });
      const result = operation === "proxy" ? s.auth.proxy(signedQuery()) : s.auth.authenticate("browser", encoded());
      await expect(result).rejects.toMatchObject({ status: 401 }); expect(s.consume).not.toHaveBeenCalled();
    }
  });

  it("rejects a redemption when a database wait outlives proof or challenge", async () => {
    const cases = [
      { elapsed: 2000, deadline: 300_000, timestamp: NOW.getTime() / 1000 - 299 },
      { elapsed: 30_000, deadline: 30_000, timestamp: NOW.getTime() / 1000 },
      { elapsed: -1000, deadline: 300_000, timestamp: NOW.getTime() / 1000 },
    ];
    for (const test of cases) {
      const s = setup(); await s.auth.start("browser");
      s.consume.mockImplementation(async () => { s.setNow(new Date(NOW.getTime() + test.elapsed)); return new Date(NOW.getTime() + test.deadline); });
      await expect(s.auth.authenticate("browser", encoded(signedQuery({ timestamp: String(test.timestamp) })))).rejects.toMatchObject({ status: 401 });
    }
  });

  it("invalidates sessions at expiry, on mapping changes, or when a duplicate mapping appears", async () => {
    const s = setup(); await s.auth.start("browser"); const session = await s.auth.authenticate("browser", encoded());
    s.shops.mockResolvedValue([{ ...SHOP_MAPPING, channelId: 37, connectionId: 5 }]);
    await expect(s.auth.principal(session)).rejects.toMatchObject({ status: 401 });
    s.shops.mockResolvedValue([SHOP_MAPPING, { ...SHOP_MAPPING, channelId: 37, connectionId: 5 }]);
    await expect(s.auth.principal(session)).rejects.toMatchObject({ status: 401 });
    s.shops.mockResolvedValue([SHOP_MAPPING]); s.setNow(new Date(session.expiresAt));
    await expect(s.auth.principal(session)).rejects.toMatchObject({ status: 401 });
  });

  it("rechecks an existing session after asynchronous shop resolution", async () => {
    const s = setup(); await s.auth.start("browser"); const session = await s.auth.authenticate("browser", encoded());
    s.shops.mockImplementation(async () => { s.setNow(new Date(session.expiresAt)); return [SHOP_MAPPING]; });
    await expect(s.auth.principal(session)).rejects.toMatchObject({ status: 401 });
  });

  it("preserves the exact pre-migration recovery partition across logins and separates customers", async () => {
    const a = setup(); await a.auth.start("one"); const first = await a.auth.authenticate("one", encoded());
    const b = setup(); await b.auth.start("two"); const second = await b.auth.authenticate("two", encoded());
    const c = setup(); await c.auth.start("three"); const other = await c.auth.authenticate("three", encoded(signedQuery({ logged_in_customer_id: "456" })));
    expect(first.sessionKey).toBe("KoirL94nFEDBc2gRdPsfiLSZgcxq1WWRuCaqjG10QeA");
    expect(first.sessionKey).toBe(second.sessionKey); expect(first.sessionKey).not.toBe(other.sessionKey);
    expect(first.sessionKey).not.toContain(CUSTOMER);
  });
});

function configurationEnvironment(): NodeJS.ProcessEnv {
  return { CUSTOMER_RETURN_STORAGE_SECRET: STORAGE_SECRET, CUSTOMER_RETURN_PUBLIC_ORIGIN: CONFIG.publicOrigin,
    CUSTOMER_RETURN_SHOPIFY_APPS: JSON.stringify({ [SHOP]: { proxyUrl: PROXY_URL, secretEnv: "RETURNS_TEST_SHOPIFY_SECRET" } }),
    RETURNS_TEST_SHOPIFY_SECRET: SHOPIFY_SECRET };
}

describe("direct Shopify returns configuration", () => {
  it("resolves only explicitly named environment credentials and preserves storage-key fallback", () => {
    const env = configurationEnvironment();
    expect(readReturnCustomerAuthConfig(env)).toEqual(CONFIG);
    expect(readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_STORAGE_SECRET: undefined, CUSTOMER_RETURN_HANDOFF_SECRET: STORAGE_SECRET })).toEqual(CONFIG);
    expect(readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_HANDOFF_SECRET: "different-unused-value" })).toEqual(CONFIG);
    expect(() => readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_STORAGE_SECRET: "", CUSTOMER_RETURN_HANDOFF_SECRET: STORAGE_SECRET })).toThrow();
  });

  it("does not use legacy login URLs, API secrets, webhook secrets, or missing credential references implicitly", () => {
    expect(() => readReturnCustomerAuthConfig({})).toThrow("not configured");
    const env = configurationEnvironment();
    expect(() => readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_SHOPIFY_APPS: undefined,
      CUSTOMER_RETURN_LOGIN_URLS: JSON.stringify({ [SHOP]: "https://store.example.com/apps/member-portal/returns" }) })).toThrow();
    expect(() => readReturnCustomerAuthConfig({ ...env, RETURNS_TEST_SHOPIFY_SECRET: undefined,
      SHOPIFY_API_SECRET: SHOPIFY_SECRET, SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET })).toThrow();
  });

  it("rejects storage or former Club handoff keys reused as a Shopify signing credential", () => {
    const env = configurationEnvironment();
    expect(() => readReturnCustomerAuthConfig({ ...env, RETURNS_TEST_SHOPIFY_SECRET: STORAGE_SECRET })).toThrow();
    expect(() => readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_HANDOFF_SECRET: SHOPIFY_SECRET })).toThrow();
  });

  it.each(["apps", "a", "community", "tools"])("supports an explicitly configured /%s proxy prefix", prefix => {
    const env = configurationEnvironment(); const proxyUrl = `https://store.example.com/${prefix}/echelon-returns`;
    expect(readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_SHOPIFY_APPS: JSON.stringify({ [SHOP]: { proxyUrl, secretEnv: "RETURNS_TEST_SHOPIFY_SECRET" } }) })
      .shops[SHOP].proxyUrl).toBe(proxyUrl);
  });

  it.each([
    "http://store.example.com/apps/returns", "https://name:password@store.example.com/apps/returns", "https://store.example.com:443/apps/returns",
    "https://store.example.com:8443/apps/returns", "https://store.example.com/apps/returns?next=other", "https://store.example.com/apps/returns#other",
    "https://store.example.com/apps/returns/", "https://store.example.com/apps/returns/nested", "https://store.example.com/returns",
    "https://store.example.com/apps/member-portal/returns", "https://store.example.com/apps/member-portal", "https://store.example.com/apps/%72eturns",
  ])("rejects unsafe or legacy proxy URL %s", proxyUrl => {
    expect(() => readReturnCustomerAuthConfig({ ...configurationEnvironment(),
      CUSTOMER_RETURN_SHOPIFY_APPS: JSON.stringify({ [SHOP]: { proxyUrl, secretEnv: "RETURNS_TEST_SHOPIFY_SECRET" } }) })).toThrow("not configured");
  });

  it("rejects empty, excessive, noncanonical or malformed app mappings without leaking configuration", () => {
    const entry = { proxyUrl: PROXY_URL, secretEnv: "RETURNS_TEST_SHOPIFY_SECRET" };
    for (const mapping of [{}, null, { "STORE.myshopify.com": entry }, { "store.example.com": entry },
      { [SHOP]: { ...entry, shopifySecret: "should-not-be-returned" } },
      { [SHOP]: { ...entry, secretEnv: "__proto__" } },
      Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`store-${index}.myshopify.com`, entry]))]) {
      try {
        readReturnCustomerAuthConfig({ ...configurationEnvironment(), CUSTOMER_RETURN_SHOPIFY_APPS: JSON.stringify(mapping) });
        throw new Error("Expected configuration rejection");
      } catch (error) {
        expect(error).toMatchObject({ code: "RETURN_CUSTOMER_CONFIGURATION_REQUIRED", status: 503 });
        expect(String(error)).not.toContain(SHOPIFY_SECRET);
        expect(String(error)).not.toContain("should-not-be-returned");
      }
    }
  });

  it.each(["http://returns.example.com", "https://returns.example.com/nested", "https://user:secret@returns.example.com", "https://returns.example.com?next=other"])
    ("rejects unsafe callback origin %s", publicOrigin => {
      expect(() => readReturnCustomerAuthConfig({ ...configurationEnvironment(), CUSTOMER_RETURN_PUBLIC_ORIGIN: publicOrigin })).toThrow();
    });
});
