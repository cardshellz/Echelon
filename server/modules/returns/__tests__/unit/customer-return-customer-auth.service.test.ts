import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";
import { CustomerReturnCustomerAuthService, readReturnCustomerAuthConfig, RETURN_HANDOFF_AUDIENCE,
  RETURN_HANDOFF_ISSUER, type ReturnLoginChallengeStore } from "../../application/customer-return-customer-auth.service";

const NOW = new Date("2026-09-28T12:00:00Z");
const SECRET = "test-only-returns-handoff-secret-long-enough";
const SHOP = "returns-test.myshopify.com";
const STATE = "a".repeat(43);
const config = { secret: SECRET, publicOrigin: "https://returns.example.com", loginUrls: { [SHOP]: "https://store.example.com/apps/member-portal/returns" } };
function setup() {
  let now = NOW;
  const pending = new Map<string, { browserHash: string; shopDomain: string; expiresAt: Date; consumed: boolean }>();
  const create = vi.fn<ReturnLoginChallengeStore["create"]>(async input => { pending.set(input.stateHash, { ...input, consumed: false }); });
  const consume = vi.fn<ReturnLoginChallengeStore["consume"]>(async input => {
    const record = pending.get(input.stateHash);
    if (!record || record.consumed || record.browserHash !== input.browserHash || record.shopDomain !== input.shopDomain || record.expiresAt <= input.now) return null;
    record.consumed = true; return record.expiresAt;
  });
  const shops = vi.fn(async () => [{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "Test shop" }]);
  const auth = new CustomerReturnCustomerAuthService({ config, challenges: { create, consume }, shops, now: () => now, randomState: () => STATE });
  return { auth, create, consume, shops, setNow: (value: Date) => { now = value; } };
}
function token(changes: Record<string, unknown> = {}, secret = SECRET, algorithm: jwt.Algorithm = "HS256") {
  return jwt.sign({ iss: RETURN_HANDOFF_ISSUER, aud: RETURN_HANDOFF_AUDIENCE, shop: SHOP, customerId: "12345678901234", state: STATE,
    jti: "00000000-0000-4000-8000-000000000001", iat: NOW.getTime() / 1000, exp: NOW.getTime() / 1000 + 90, ...changes }, secret, { algorithm });
}
describe("Shopify returns handoff authentication", () => {
  it("derives channel from the verified configured shop and consumes the exact browser challenge", async () => {
    const { auth, create } = setup();
    const url = new URL(await auth.start("browser-one"));
    expect(url.origin).toBe("https://store.example.com");
    expect(url.searchParams.get("state")).toBe(STATE);
    expect(JSON.stringify(create.mock.calls)).not.toContain("browser-one");
    const session = await auth.authenticate("browser-one", token());
    expect(session).toMatchObject({ channelId: 36, externalCustomerId: "12345678901234", shopDomain: SHOP });
    await expect(auth.authenticate("browser-one", token())).rejects.toMatchObject({ status: 401 });
    expect(await auth.principal(session)).toEqual(session);
  });
  it("rejects a callback from another browser without consuming the legitimate challenge", async () => {
    const { auth } = setup(); await auth.start("browser-one");
    await expect(auth.authenticate("browser-two", token())).rejects.toMatchObject({ status: 401 });
    await expect(auth.authenticate("browser-one", token())).resolves.toMatchObject({ channelId: 36 });
  });
  it.each([
    ["wrong shop", { shop: "other.myshopify.com" }], ["wrong audience", { aud: "shellz-club-portal" }],
    ["wrong issuer", { iss: "another-app" }], ["future issue time", { iat: NOW.getTime() / 1000 + 1 }],
    ["expired", { exp: NOW.getTime() / 1000 }], ["excess lifetime", { exp: NOW.getTime() / 1000 + 91 }],
    ["missing customer", { customerId: null }], ["unknown fields", { channelId: 36 }],
    ["unsafe customer", { customerId: "gid://shopify/Customer/123" }], ["invalid state", { state: "short" }],
  ])("rejects %s before consuming", async (_label, overrides) => {
    const { auth, consume } = setup(); await auth.start("browser-one");
    await expect(auth.authenticate("browser-one", token(overrides))).rejects.toMatchObject({ status: 401 });
    expect(consume).not.toHaveBeenCalled();
  });
  it("rejects bad signatures and unexpected JWT algorithms", async () => {
    const { auth, consume } = setup(); await auth.start("browser-one");
    await expect(auth.authenticate("browser-one", token({}, "wrong-secret"))).rejects.toMatchObject({ status: 401 });
    await expect(auth.authenticate("browser-one", token({}, SECRET, "HS384"))).rejects.toMatchObject({ status: 401 });
    expect(consume).not.toHaveBeenCalled();
  });
  it("rejects expired login challenges even when a newly minted grant is valid", async () => {
    const { auth, setNow } = setup(); await auth.start("browser-one");
    setNow(new Date(NOW.getTime() + 300_000));
    await expect(auth.authenticate("browser-one", token({ iat: NOW.getTime() / 1000 + 300, exp: NOW.getTime() / 1000 + 390 }))).rejects.toMatchObject({ status: 401 });
  });
  it("invalidates sessions when their lifetime ends or the configured shop moves", async () => {
    const { auth, setNow, shops } = setup(); await auth.start("browser-one");
    const session = await auth.authenticate("browser-one", token());
    shops.mockResolvedValue([{ channelId: 37, connectionId: 5, shopDomain: SHOP, displayName: "Moved" }]);
    await expect(auth.principal(session)).rejects.toMatchObject({ status: 401 });
    shops.mockResolvedValue([{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "Test" }]);
    setNow(new Date(session.expiresAt));
    await expect(auth.principal(session)).rejects.toMatchObject({ status: 401 });
  });
  it("rejects unknown or ambiguous shops without creating a challenge", async () => {
    const { auth, shops, create } = setup();
    await expect(auth.start("browser", "evil.example.com")).rejects.toMatchObject({ status: 400 });
    shops.mockResolvedValue([{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "a" }, { channelId: 37, connectionId: 5, shopDomain: SHOP, displayName: "b" }]);
    await expect(auth.start("browser", SHOP)).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });
  it("invalidates existing sessions if the shop acquires a second channel mapping", async () => {
    const { auth, shops } = setup(); await auth.start("browser");
    const session = await auth.authenticate("browser", token());
    shops.mockResolvedValue([{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "a" },
      { channelId: 37, connectionId: 5, shopDomain: SHOP, displayName: "b" }]);
    await expect(auth.principal(session)).rejects.toMatchObject({ status: 401 });
  });
  it("fails closed on missing or unsafe deployment configuration", () => {
    expect(() => readReturnCustomerAuthConfig({})).toThrow("not configured");
    const env = { CUSTOMER_RETURN_HANDOFF_SECRET: SECRET, CUSTOMER_RETURN_PUBLIC_ORIGIN: config.publicOrigin, CUSTOMER_RETURN_LOGIN_URLS: JSON.stringify(config.loginUrls) };
    expect(readReturnCustomerAuthConfig(env)).toEqual(config);
    expect(() => readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_PUBLIC_ORIGIN: "http://example.com" })).toThrow();
    expect(() => readReturnCustomerAuthConfig({ ...env, CUSTOMER_RETURN_LOGIN_URLS: JSON.stringify({ [SHOP]: "https://evil.example.com/returns?next=other" }) })).toThrow();
  });
  it("rechecks grant expiry after asynchronous shop resolution", async () => {
    const s = setup(); await s.auth.start("browser");
    s.shops.mockImplementation(async () => { s.setNow(new Date(NOW.getTime() + 90_000)); return [{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "Test" }]; });
    await expect(s.auth.authenticate("browser", token())).rejects.toMatchObject({ status: 401 });
    expect(s.consume).not.toHaveBeenCalled();
  });
  it("rejects a redemption when the database wait outlives the grant or challenge", async () => {
    for (const [elapsed, deadline] of [[40_000, 30_000], [90_000, 300_000]]) {
      const s = setup(); await s.auth.start("browser");
      s.consume.mockImplementation(async () => { s.setNow(new Date(NOW.getTime() + elapsed)); return new Date(NOW.getTime() + deadline); });
      await expect(s.auth.authenticate("browser", token())).rejects.toMatchObject({ status: 401 });
    }
  });
  it("rechecks an existing session after asynchronous shop resolution", async () => {
    const s = setup(); await s.auth.start("browser"); const session = await s.auth.authenticate("browser", token());
    s.shops.mockImplementation(async () => { s.setNow(new Date(session.expiresAt)); return [{ channelId: 36, connectionId: 4, shopDomain: SHOP, displayName: "Test" }]; });
    await expect(s.auth.principal(session)).rejects.toMatchObject({ status: 401 });
  });
  it("preserves the pending-command storage partition across logins, but separates customers", async () => {
    const a = setup(); await a.auth.start("one"); const first = await a.auth.authenticate("one", token());
    const b = setup(); await b.auth.start("two"); const second = await b.auth.authenticate("two", token());
    const c = setup(); await c.auth.start("three"); const other = await c.auth.authenticate("three", token({ customerId: "456" }));
    expect(first.sessionKey).toBe(second.sessionKey); expect(first.sessionKey).not.toBe(other.sessionKey);
    expect(first.sessionKey).not.toContain(first.externalCustomerId);
  });
});
