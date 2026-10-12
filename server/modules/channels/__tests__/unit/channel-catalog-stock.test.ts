import { describe, expect, it, vi } from "vitest";
import { ChannelCatalogService } from "../../channel-catalog.service";
import { WalmartCatalogAdapter } from "../../adapters/walmart/walmart-catalog.adapter";
import { WalmartUsApi } from "../../adapters/walmart/walmart-us-api";

const account = { channelId: 77, connectionId: 9, provider: "walmart" };
function setup() {
  const stock = vi.fn(async (_account: unknown, sku: string): Promise<number> =>
    sku === "ZERO" ? 0 : 100,
  );
  const provider = {
    account: vi.fn(async () => account),
    list: vi.fn(),
    item: vi.fn(),
    stock,
  };
  const repository = {
    candidates: vi.fn(),
    searchVariants: vi.fn(),
    saveMappings: vi.fn(),
  };
  return {
    stock,
    provider,
    repository,
    service: new ChannelCatalogService(
      repository,
      provider,
      () => new Date("2026-10-12T12:00:00Z"),
    ),
  };
}
describe("read-only catalog stock", () => {
  it("returns exact quantities including zero with observation time and no writes", async () => {
    const s = setup();
    expect(
      await s.service.stock(77, { connectionId: 9, skus: ["ZERO", "FULL"] }),
    ).toEqual({
      connectionId: 9,
      items: [
        {
          sku: "ZERO",
          quantity: 0,
          checkedAt: "2026-10-12T12:00:00.000Z",
          error: null,
        },
        {
          sku: "FULL",
          quantity: 100,
          checkedAt: "2026-10-12T12:00:00.000Z",
          error: null,
        },
      ],
    });
    expect(s.stock).toHaveBeenCalledWith(account, "ZERO");
    expect(s.repository.saveMappings).not.toHaveBeenCalled();
  });
  it("keeps healthy results and does not replace failed or invalid reads with zero", async () => {
    const s = setup();
    s.stock
      .mockRejectedValueOnce(new Error("secret response"))
      .mockResolvedValueOnce(-1);
    const result = await s.service.stock(77, {
      connectionId: 9,
      skus: ["FAIL", "INVALID", "FULL"],
    });
    expect(result.items.map((item) => item.quantity)).toEqual([
      null,
      null,
      100,
    ]);
    expect(result.items[0].error).not.toContain("secret");
  });
  it.each([
    [],
    ["A", "A"],
    Array.from({ length: 51 }, (_, i) => String(i)),
    [""],
  ])("rejects invalid batches before any provider call: %j", async (skus) => {
    const s = setup();
    await expect(
      s.service.stock(77, { connectionId: 9, skus }),
    ).rejects.toThrow();
    expect(s.provider.account).not.toHaveBeenCalled();
  });
  it("rejects a reconnected account before stock reads", async () => {
    const s = setup();
    await expect(
      s.service.stock(77, { connectionId: 10, skus: ["FULL"] }),
    ).rejects.toMatchObject({ code: "CHANNEL_CATALOG_ACCOUNT_CHANGED" });
    expect(s.stock).not.toHaveBeenCalled();
  });
  it("limits concurrent provider reads", async () => {
    const s = setup();
    let active = 0,
      peak = 0;
    s.stock.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return 1;
    });
    await s.service.stock(77, {
      connectionId: 9,
      skus: Array.from({ length: 13 }, (_, i) => String(i)),
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(s.stock).toHaveBeenCalledTimes(13);
  });
  it("uses the connected fulfillment center and existing SKU-validated API", async () => {
    const inventory = vi.fn(async () => 42);
    const connection = vi.fn(async () => ({
      connection_id: 9,
      ship_node_id: "NODE-1",
    }));
    const adapter = new WalmartCatalogAdapter({
      connection,
      api: () => ({ inventory }),
    } as never);
    await expect(adapter.stock(account, "A/B")).resolves.toBe(42);
    expect(connection).toHaveBeenCalledWith(77, 9);
    expect(inventory).toHaveBeenCalledWith("A/B", "NODE-1");
  });
});
describe("Walmart catalog prices", () => {
  it.each([
    ["23.99", 2399],
    [0, 0],
    [14.99, 1499],
  ])("converts %s to integer cents", async (amount, cents) => {
    const api = new WalmartUsApi({
      request: vi.fn(async () => ({
        ItemResponse: [{ sku: "A", price: { currency: "USD", amount } }],
      })),
    } as never);
    expect((await api.catalogItem("A")).priceCents).toBe(cents);
  });
  it.each(["1.001", "-1", "NaN"])(
    "preserves the listing identity when an optional price is invalid: %s",
    async (amount) => {
      const api = new WalmartUsApi({
        request: vi.fn(async () => ({
          ItemResponse: [{ sku: "A", price: { currency: "USD", amount } }],
        })),
      } as never);
      await expect(api.catalogItem("A")).resolves.toMatchObject({ sku: "A", priceCents: null, priceError: expect.stringContaining("could not be read") });
    },
  );
  it("isolates wrong-currency prices without hiding healthy catalog rows", async () => {
    const api = new WalmartUsApi({ request: vi.fn(async () => ({ ItemResponse: [
      { sku: "BAD", productName: "Readable title", price: { currency: "CAD", amount: "23.99" } },
      { sku: "GOOD", price: { currency: "USD", amount: "14.99" } },
      { sku: "MISSING" },
    ] })) } as never);
    const page = await api.catalogPage({});
    expect(page.items).toMatchObject([
      { sku: "BAD", title: "Readable title", priceCents: null, priceError: expect.any(String) },
      { sku: "GOOD", priceCents: 1499 }, { sku: "MISSING", priceCents: null },
    ]);
  });
});
