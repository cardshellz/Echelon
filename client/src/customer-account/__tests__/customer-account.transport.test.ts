import { afterEach, describe, it, expect, vi } from "vitest";
import { createCustomerAccountTransport, CUSTOMER_ACCOUNT_REQUEST_TIMEOUT_MS } from "../customer-account.transport";

const config = { themeId: "174740308127", customerId: "100", proxyPath: "/apps/echelon-returns" };
const connection = { connectionId: 4, channelId: 2, name: "Shopify", shopDomain: "fixture.myshopify.com", enabled: true, paymentWindowMinutes: 30 };
const key = "a".repeat(43);
const bootstrap = { session: { authenticated: true, privateTesting: true, sessionKey: key }, connection };
describe("storefront transport reuses canonical clients", () => {
  it("binds batch history and inline details to the signed session without creating a financial command key", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request); await api.bootstrap();
    const identity = { externalOrderId: "99", orderReference: "#49180" };
    const summary = { ...identity, omsOrderId: null, currency: "USD", totalCents: 0, cancelled: true, financialStatus: "Refunded" };
    request.mockImplementation(async () => Response.json({ orders: [summary], unavailableExternalOrderIds: [], statusUnavailable: false }));
    expect((await api.orderSummaries({ orders: [identity] })).orders).toEqual([summary]);
    request.mockImplementation(async () => Response.json({ ...identity, currency: "USD", totalCents: 0, lines: [] }));
    expect((await api.orderDetails(identity)).totalCents).toBe(0);
    for (const [, options] of request.mock.calls.slice(1) as unknown as Array<[string, RequestInit]>) {
      const input = JSON.parse(String(options.body));
      expect(input.sessionKey).toBe(key); expect(input.expectedCustomerId).toBe("100");
      expect(input.commandKey).toBeUndefined(); expect(options.cache).toBe("no-store");
    }
  });
  it.each([
    { orders: [], unavailableExternalOrderIds: [], statusUnavailable: false },
    { orders: [], unavailableExternalOrderIds: ["98"], statusUnavailable: false },
    { orders: [{ externalOrderId: "99", orderReference: "#other", omsOrderId: null, currency: "USD", totalCents: 917, cancelled: false, financialStatus: "Paid" }], unavailableExternalOrderIds: [], statusUnavailable: false },
  ])("rejects missing or substituted batch identities before they can replace a displayed total", async response => {
    const api = createCustomerAccountTransport(config, async () => Response.json(response));
    await expect(api.orderSummaries({ orders: [{ externalOrderId: "99", orderReference: "#49180" }] })).rejects.toThrow();
  });
  it("rejects a late detail reply for a different order instead of displaying its money", async () => {
    const api = createCustomerAccountTransport(config, async () => Response.json({ externalOrderId: "98", orderReference: "#other", currency: "USD", totalCents: 917, lines: [] }));
    await expect(api.orderDetails({ externalOrderId: "99", orderReference: "#49180" })).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_ORDER_MISMATCH" });
  });
  it("survives an older backend during a rolling theme deployment with one read-only compatibility retry",async()=>{
    const request=vi.fn(async()=>Response.json({error:{code:"RETURN_CUSTOMER_INPUT_INVALID",message:"The return request is invalid."}},{status:400}));
    request.mockResolvedValueOnce(Response.json({error:{code:"RETURN_CUSTOMER_INPUT_INVALID",message:"The return request is invalid."}},{status:400}))
      .mockResolvedValueOnce(Response.json({orders:[{externalOrderId:"99",orderReference:"#49180",omsOrderId:null,currency:"USD",totalCents:0,cancelled:true,financialStatus:"Refunded"}],unavailableExternalOrderIds:[],statusUnavailable:false}));
    const api=createCustomerAccountTransport(config,request);
    expect((await api.orderSummaries({orders:[{externalOrderId:"99",orderReference:"#49180"}]})).orders[0].totalCents).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
    const calls=request.mock.calls as unknown as [string,RequestInit][];
    expect(JSON.parse(String(calls[0][1].body))).toMatchObject({query:{statusDisplayVersion:"v2"}});
    const second=JSON.parse(String(calls[1][1].body));expect(second.query??{}).toEqual({});expect(second.commandKey).toBeUndefined();
  });
  it.each([401,403,503])("does not downgrade progress negotiation after a %i access/service failure",async status=>{
    const request=vi.fn(async()=>Response.json({error:{code:"RETURN_CUSTOMER_INPUT_INVALID",message:"Failure"}},{status}));
    const api=createCustomerAccountTransport(config,request);
    await expect(api.orderSummaries({orders:[{externalOrderId:"99",orderReference:"#49180"}]})).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
  });
  it("binds rewards issuance to the same signed session and preserves its request identity", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request);
    await api.bootstrap();
    request.mockImplementation(async () => Response.json({ code: "ISSUED", value: "1.00", balance: "900.00", expiresAt: "2030-01-01T00:00:00.000Z" }));
    const command = { requestKey: "22222222-2222-4222-8222-222222222222", points: 100 };
    await api.rewards.issue(4, 9, command);
    const [url, options] = request.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/apps/echelon-returns/account");
    expect(JSON.parse(String(options.body))).toMatchObject({ expectedCustomerId: "100", sessionKey: key,
      path: "/order-edits/orders/9/rewards/issue", commandKey: command.requestKey, body: command });
  });
  it("binds reward cancellation to the signed account and preserves the canonical ledger result", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request);
    await api.bootstrap();
    const result = { points: "366.00", balance: "956.00", ledgerEntryId: "refund-1" };
    request.mockImplementation(async () => Response.json(result));
    const command = { rewardId: "11111111-1111-4111-8111-111111111111", requestKey: "22222222-2222-4222-8222-222222222222" };
    expect(await api.rewards.cancel(4, 9, command)).toEqual(result);
    const [, options] = request.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(String(options.body))).toMatchObject({ expectedCustomerId: "100", sessionKey: key,
      path: "/order-edits/orders/9/rewards/cancel", commandKey: command.requestKey, body: command });
  });
  it("retains classified reward failures so retries preserve uncertain issuance", async () => {
    const api = createCustomerAccountTransport(config, async () => Response.json({ error: { code: "REWARD_ISSUANCE_PENDING", message: "Retry this same reward." } }, { status: 503 }));
    await expect(api.rewards.issue(4, 9, { requestKey: "22222222-2222-4222-8222-222222222222", points: 100 }))
      .rejects.toMatchObject({ code: "REWARD_ISSUANCE_PENDING" });
  });
  it("does not reinterpret an invalid successful bootstrap as proof of a signed-out customer", async () => {
    const api = createCustomerAccountTransport(config, async () => Response.json({ ...bootstrap, session: { ...bootstrap.session, authenticated: false, sessionKey: null } }));
    await expect(api.bootstrap()).rejects.toMatchObject({ code: "CUSTOMER_ACCOUNT_SESSION_INVALID" });
  });
  afterEach(() => vi.useRealTimers());
  it("bounds a stalled account read without retrying it", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>((_target, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const api = createCustomerAccountTransport(config, request);
    const result = expect(api.bootstrap()).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(CUSTOMER_ACCOUNT_REQUEST_TIMEOUT_MS);
    await result;
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("treats a stalled cancellation body as uncertain and preserves its operation without replaying the command", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>(async (_target, options) => new Response(new ReadableStream({ start(controller) {
      options!.signal!.addEventListener("abort", () => controller.error(options!.signal!.reason), { once: true });
    } }), { headers: { "Content-Type": "application/json" } }));
    const api = createCustomerAccountTransport(config, request);
    const operationId = "22222222-2222-4222-8222-222222222222";
    const result = expect(api.edits.abandon(operationId)).rejects.toMatchObject({ code: "ORDER_EDIT_CONNECTION_FAILED", uncertain: true });
    await vi.advanceTimersByTimeAsync(CUSTOMER_ACCOUNT_REQUEST_TIMEOUT_MS);
    await result;
    expect(request).toHaveBeenCalledTimes(1);
    const input = JSON.parse(String(request.mock.calls[0][1]!.body));
    expect(input.path).toBe(`/order-edits/operations/${operationId}/abandon`);
    expect(input.commandKey).toBe(operationId);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors caller cancellation and clears its deadline", async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>((_target, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const controller = new AbortController();
    const api = createCustomerAccountTransport(config, request);
    const result = expect(api.bootstrap(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("sends every call through the dedicated same-origin proxy with JSON inputs and account binding", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request);
    await api.bootstrap();
    request.mockImplementation(async () => Response.json({ omsOrderId: 9, connectionId: 4, externalOrderId: "99" }));
    await api.resolve({ orderReference: "#10", externalOrderId: "99" });
    const [url, options] = request.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe("/apps/echelon-returns/account"); expect(options.credentials).toBe("same-origin");
    expect(JSON.parse(String(options.body))).toEqual({ themeId: config.themeId, expectedCustomerId: "100", method: "POST", path: "/account/resolve", query: {}, body: { orderReference: "#10", externalOrderId: "99" }, sessionKey: key });
  });
  it("preserves catalog context and variant response validation instead of calculating member prices", async () => {
    const request = vi.fn(async () => Response.json(bootstrap)); const api = createCustomerAccountTransport(config, request); await api.bootstrap();
    request.mockImplementation(async () => Response.json({ connectionId: 4, input: { after: null }, categories: ["Toploaders"], pageInfo: { hasNextPage: false, endCursor: null } }));
    expect((await api.edits.catalogCategories(4, { after: null })).categories).toEqual(["Toploaders"]);
    const body = JSON.parse(String((request.mock.calls[1] as unknown as [string, RequestInit])[1].body));
    expect(body.path).toBe("/order-edits/catalog/categories"); expect(body.query).toEqual({ connectionId: "4", pricingDisplayVersion: "v2" });
    expect(body.sessionKey).toBe(key);
  });
  it("rejects external requests and unsupported methods before network calls", async () => {
    const request = vi.fn(); const api = createCustomerAccountTransport(config, request);
    await expect(api.request("https://evil.test/api/returns/customer/returns/1")).rejects.toThrow();
    await expect(api.request("/api/order-edits/admin/settings/4", { method: "PUT" })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("preserves the return client's expected account partition", async () => {
    const request = vi.fn(async () => Response.json(bootstrap));
    const api = createCustomerAccountTransport(config, request); await api.bootstrap();
    await expect(api.returns("b".repeat(43)).order(9, new AbortController().signal)).rejects.toThrow("Your signed-in account changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
