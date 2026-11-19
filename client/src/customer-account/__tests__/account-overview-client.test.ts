import { describe, expect, it, vi } from "vitest";
import { accountOverviewClient } from "../account-overview-client";
const config = { themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns" };
const input = { orders: [{ externalOrderId: "99", orderReference: "#HISTORY" }] };
const display = { summaries: { orders: [{ ...input.orders[0], omsOrderId: null, currency: "USD", totalCents: 741, cancelled: false, financialStatus: "Paid" }],
  unavailableExternalOrderIds: [], statusUnavailable: false }, actions: { orders: [{ ...input.orders[0], omsOrderId: null, state: "not_managed", snapshot: null, verifiedAt: null, validUntil: null }] } } as const;
const overview = { ...display, bootstrap: { session: { authenticated: true, privateTesting: true, sessionKey: "a".repeat(43) },
  connection: { connectionId: 4, channelId: 2, shopDomain: "fixture.myshopify.com", name: "Synthetic", enabled: true, paymentWindowMinutes: 30 } } };
function fixture() {
  const data = new Map<string, string>();
  const storage: Storage = { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null, getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); }, removeItem: key => { data.delete(key); }, clear: () => data.clear() };
  const state = { now: 10_000 };
  const request = vi.fn<typeof fetch>(async () => Response.json(overview));
  const dependencies = { storage, now: () => state.now, request, origin: "https://shop.test" };
  const client = accountOverviewClient(config, input, dependencies);
  return { client, dependencies, data, state, request };
}
describe("short lived, customer-bound display preload", () => {
  it("keeps prior bound action display separate from a newer failed owner response", async () => {
    const h=fixture();
    const ready={...display.actions.orders[0],omsOrderId:1,state:"ready",verifiedAt:"2026-11-04T12:00:00Z",validUntil:"2026-11-04T12:05:00Z",
      snapshot:{order:null,returnOrder:null,orderFailed:true,returnFailed:false}};
    h.request.mockResolvedValueOnce(Response.json({...overview,actions:{orders:[ready]}}));
    await h.client.read();
    h.request.mockResolvedValueOnce(Response.json({...overview,actions:{orders:[{...ready,state:"failed",snapshot:null,verifiedAt:null,validUntil:null}]}}));
    const latest=await h.client.read();
    expect(latest.actions.orders[0].state).toBe("failed");
    expect(h.client.readCache()?.actions.orders[0]).toEqual(ready);
  });
  it.each([null, {orders:[]}, {orders:[{...display.actions.orders[0],externalOrderId:"101"}]}])(
    "isolates malformed optional actions while retaining strictly verified purchase facts", async actions => {
      const h=fixture();h.request.mockResolvedValueOnce(Response.json({...overview,actions}));
      const result=await h.client.read();
      expect(result.summaries).toEqual(display.summaries);
      expect(result.actions.orders).toEqual([{...input.orders[0],omsOrderId:null,state:"failed",snapshot:null,verifiedAt:null,validUntil:null}]);
    },
  );
  it("loads the single signed overview without a bootstrap or command", async () => {
    const h = fixture(); await h.client.read(); expect(h.request).toHaveBeenCalledTimes(1);
    const [url, options] = h.request.mock.calls[0]; expect(url).toBe("/apps/echelon-returns/account");
    const body = JSON.parse(options!.body as string); expect(body).toEqual({ themeId: config.themeId, expectedCustomerId: "100", method: "POST", path: "/account/overview", query: {}, body: input });
    expect(body).not.toHaveProperty("commandKey"); expect(body).not.toHaveProperty("sessionKey");
  });
  it("stores only display facts, never bootstrap, customer session keys or command authority", async () => {
    const h = fixture(); await h.client.read(); expect(h.client.readCache()).toEqual(display);
    expect(h.data.get(h.client.key)).not.toContain("sessionKey"); expect(h.data.get(h.client.key)).not.toContain("bootstrap");
  });
  it("never reuses another customer, theme, shop or page's facts", async () => {
    const h = fixture(); await h.client.read();
    for (const changed of [{ customerId: "101" }, { themeId: "174740308128" }]) expect(accountOverviewClient({ ...config, ...changed }, input, h.dependencies).readCache()).toBeNull();
    expect(accountOverviewClient(config, input, { ...h.dependencies, origin: "https://other.test" }).readCache()).toBeNull();
    expect(accountOverviewClient(config, { orders: [{ externalOrderId: "100", orderReference: "#OTHER" }] }, h.dependencies).readCache()).toBeNull();
  });
  it("expires cached display facts and rejects a backwards clock", async () => {
    for (const age of [-1, 30_000, 31_000]) { const h = fixture(); await h.client.read(); h.state.now += age; expect(h.client.readCache()).toBeNull(); }
  });
  it("does not accept duplicate, unrequested or mismatched identities", async () => {
    for (const summaries of [{ ...overview.summaries, orders: [...overview.summaries.orders, ...overview.summaries.orders] },
      { ...overview.summaries, orders: [{ ...overview.summaries.orders[0], externalOrderId: "100" }] },
      { ...overview.summaries, orders: [{ ...overview.summaries.orders[0], orderReference: "#OTHER" }] }]) {
      const h = fixture(); h.request.mockResolvedValue(Response.json({ ...overview, summaries }));
      await expect(h.client.read()).rejects.toThrow(); expect(h.data.size).toBe(0);
    }
  });
  it("works without browser storage and preserves precise authentication failures", async () => {
    const h = fixture();
    const client = accountOverviewClient(config, input, { ...h.dependencies, storage: undefined });
    expect(await client.read()).toEqual(overview);
    h.request.mockResolvedValue(Response.json({ error: { code: "CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED", message: "Sign in again" } }, { status: 401 }));
    await expect(client.read()).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_SIGN_IN_REQUIRED" });
  });
});
