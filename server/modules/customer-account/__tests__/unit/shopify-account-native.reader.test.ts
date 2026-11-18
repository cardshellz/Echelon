import { describe, expect, it, vi } from "vitest";
import { ShopifyOrderEditProvider } from "../../../order-edits/infrastructure/shopify-order-edit.provider";
const now = new Date("2026-11-03T12:00:00Z");
const credentials = { connectionId: 4, channelId: 2, shopDomain: "fixture.myshopify.com", accessToken: "synthetic-test-token" };
const bag = { presentmentMoney: { amount: "7.41", currencyCode: "USD" }, shopMoney: { amount: "7.41", currencyCode: "USD" } };
const node = { id: "gid://shopify/Order/99", name: "#HISTORY", customer: { id: "gid://shopify/Customer/100" }, updatedAt: now.toISOString(),
  cancelledAt: null, displayFinancialStatus: "PAID", currentTotalPriceSet: bag };
function fixture() {
  const request = vi.fn<typeof fetch>(async () => Response.json({ data: { nodes: [node] } }));
  const provider = new ShopifyOrderEditProvider({ credentials: { get: async () => credentials }, clock: () => now, fetch: request });
  return { provider, request };
}
describe("native account source adapter", () => {
  it("exhausts opaque cursor ranges across 26,001 adversarially ordered IDs without skips or precision loss", async () => {
    const h = fixture();
    const first = BigInt("90071992547409930000"), total = 26_001;
    // A high ID on the discovery page makes the first range exceed Shopify's
    // connection limit. The range must split and replay, not skip to that ID.
    const ids = Array.from({ length: total }, (_, i) => String(first + BigInt(i)));
    [ids[40], ids[total - 1]] = [ids[total - 1], ids[40]];
    const seen = new Set<string>(), cursors = new Map<string, { search: string | null; offset: number }>();
    let nextCursor = 0, maxOffset = 0, calls = 0, replayed = 0;
    h.request.mockImplementation(async (_url, options) => {
      const request = JSON.parse(options!.body as string);
      if (request.query.includes("EchelonAccountHistoryAccess")) return Response.json({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_all_orders" }, { handle: "read_orders" }] } } });
      expect(request.variables.sort).toBe("ID"); expect(request.query).toContain("hasNextPage endCursor");
      const search = request.variables.search as string | null;
      const lower = BigInt(search?.match(/id:>([0-9]+)/)?.[1] ?? "0"), upper = search?.match(/id:<=([0-9]+)/)?.[1];
      const selected = ids.filter(id => BigInt(id) > lower && (upper === undefined || BigInt(id) <= BigInt(upper)));
      const cursor = request.variables.after ? cursors.get(request.variables.after) : null;
      if (request.variables.after) { expect(cursor).toBeDefined(); expect(cursor!.search).toBe(search); }
      const offset = cursor?.offset ?? 0; maxOffset = Math.max(maxOffset, offset);
      const pageIds = selected.slice(offset, offset + 100), token = `opaque-${++nextCursor}`;
      cursors.set(token, { search, offset: offset + pageIds.length });
      return Response.json({ data: { orders: { nodes: pageIds.map(id => ({ ...node, id: `gid://shopify/Order/${id}` })),
        pageInfo: { hasNextPage: offset + pageIds.length < selected.length, endCursor: pageIds.length ? token : null } } } });
    });
    let after: string | null = null;
    do {
      const page = await h.provider.accountNativePage(4, after, null);
      for (const fact of page.observation.facts) { if (seen.has(fact.externalOrderId)) replayed++; seen.add(fact.externalOrderId); }
      after = page.after; expect(++calls).toBeLessThan(1000);
    } while (after !== null);
    expect(seen).toEqual(new Set(ids)); expect(replayed).toBeGreaterThan(0);
    expect(maxOffset).toBeLessThan(10_000);
  }, 30_000);
  it("reads exact current native cents, source version and owner without an edit calculation", async () => {
    const h = fixture(); const result = await h.provider.accountNativeByIds(4, ["99"]);
    expect(result.facts[0]).toMatchObject({ externalOrderId: "99", externalCustomerId: "100", totalCents: 741, sourceUpdatedAt: now.toISOString(), financialStatus: "Paid" });
    expect(h.request).toHaveBeenCalledOnce();
    const query = JSON.parse(h.request.mock.calls[0][1]!.body as string);
    expect(query.variables).toEqual({ ids: [node.id] }); expect(query.query).toContain("currentTotalPriceSet"); expect(query.query).not.toMatch(/mutation|calculatedOrder|transactions/);
  });
  it("withholds fractional cents, overflow, different currency and inconsistent bags as isolated source errors", async () => {
    for (const currentTotalPriceSet of [
      { ...bag, presentmentMoney: { amount: "1.001", currencyCode: "USD" } },
      { ...bag, presentmentMoney: { amount: "9007199254740992.00", currencyCode: "USD" } },
      { ...bag, presentmentMoney: { amount: "7.41", currencyCode: "CAD" } },
      { ...bag, shopMoney: { amount: "7.42", currencyCode: "USD" } },
    ]) {
      const h = fixture(); h.request.mockResolvedValue(Response.json({ data: { nodes: [{ ...node, currentTotalPriceSet }] } }));
      const result = await h.provider.accountNativeByIds(4, ["99"]);
      expect(result.facts).toEqual([]); expect(result.failures).toHaveLength(1);
    }
  });
  it("isolates one unsupported purchase while preserving valid purchases and the historical seek", async () => {
    const h = fixture();
    h.request.mockResolvedValue(Response.json({ data: { orders: { nodes: [node,
      { ...node, id: "gid://shopify/Order/100", currentTotalPriceSet: { ...bag, presentmentMoney: { amount: "7.41", currencyCode: "CAD" } } },
      { ...node, id: "gid://shopify/Order/101" }], pageInfo: { hasNextPage: false, endCursor: "unused" } } } }));
    const page = await h.provider.accountNativePage(4, null, now);
    expect(page.after).toBeNull(); expect(page.observation.facts.map(fact => fact.externalOrderId)).toEqual(["99", "101"]);
    expect(page.observation.failures).toEqual([{ channelId: 2, connectionId: 4, shopDomain: credentials.shopDomain, externalOrderId: "100", externalCustomerId: "100", sourceUpdatedAt: now.toISOString(), code: "ACCOUNT_NATIVE_SOURCE_INVALID" }]);
  });
  it("rejects substituted identities, duplicate requests and non-advancing page cursors", async () => {
    const h = fixture();
    await expect(h.provider.accountNativeByIds(4, ["99", "99"])).rejects.toThrow(); expect(h.request).not.toHaveBeenCalled();
    h.request.mockResolvedValue(Response.json({ data: { nodes: [{ ...node, id: "gid://shopify/Order/100" }] } }));
    await expect(h.provider.accountNativeByIds(4, ["99"])).rejects.toMatchObject({ code: "ORDER_IDENTITY_MISMATCH" });
    h.request.mockResolvedValue(Response.json({ data: { orders: { nodes: [node], pageInfo: { hasNextPage: true, endCursor: null } } } }));
    await expect(h.provider.accountNativePage(4, null, now)).rejects.toMatchObject({ code: "ACCOUNT_NATIVE_CURSOR_NOT_ADVANCING" });
  });
  it("checks historical access before declaring a complete full-history scan", async () => {
    const h = fixture(); h.request.mockResolvedValue(Response.json({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_orders" }] } } }));
    await expect(h.provider.accountNativePage(4, null, null)).rejects.toMatchObject({ code: "ACCOUNT_HISTORY_SCOPE_MISSING" });
    expect(h.request).toHaveBeenCalledOnce();
  });
  it("paginates all history separately from the update scan and uses matching sort keys", async () => {
    const h = fixture(); h.request.mockResolvedValueOnce(Response.json({ data: { currentAppInstallation: { accessScopes: [{ handle: "read_all_orders" }, { handle: "write_orders" }] } } }))
      .mockImplementation(async () => Response.json({ data: { orders: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: "end" } } } }));
    expect((await h.provider.accountNativePage(4, null, null)).after).toBeNull();
    await h.provider.accountNativePage(4, null, now);
    const calls = h.request.mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(calls[1].variables).toEqual({ after: null, search: null, sort: "ID" });
    expect(calls[2].variables).toEqual({ after: null, search: `updated_at:>="${now.toISOString()}"`, sort: "ID" });
    expect(calls.every(call => !call.query.includes("mutation"))).toBe(true);
  });
});
