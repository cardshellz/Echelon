import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { InsertWmsOrder } from "@shared/schema";

const calls = vi.hoisted(() => ({
  execute: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  select: vi.fn(),
  insertOrder: vi.fn(),
}));
vi.mock("../../../../db", () => ({ db: calls }));
vi.mock("../../../wms/insert-order", () => ({
  insertWmsOrder: calls.insertOrder,
}));
import { orderMethods } from "../../orders.storage";

const order = {
  orderNumber: "MANUAL-1",
  customerName: "Test",
  source: "manual",
  channelId: 36,
  omsFulfillmentOrderId: "4",
  shippingCountry: "United States",
} as InsertWmsOrder;
const repair = {
  customerName: "Test",
  customerEmail: null,
  shippingName: null,
  shippingAddress1: null,
  shippingAddress2: null,
  shippingCity: null,
  shippingState: null,
  shippingPostalCode: null,
  shippingCountry: "United States",
};
const repairScope = {
  shopDomain: "fixture.myshopify.com",
  externalOrderId: "gid://shopify/Order/123",
};
const dialect = new PgDialect();

beforeEach(() => {
  vi.resetAllMocks();
  calls.transaction.mockImplementation(async (operation) => operation(calls));
  calls.execute.mockResolvedValue({ rows: [], rowCount: 1 });
  calls.insertOrder.mockResolvedValue({ id: 4 });
  calls.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: async () => [{ id: 4 }] }) }),
  });
  calls.update.mockReturnValue({ set: calls.set });
  calls.set.mockReturnValue({
    where: () => ({ returning: async () => [{ id: 4 }] }),
  });
});

describe("legacy order country write boundaries", () => {
  it.each(["United States", " us "])(
    "normalizes %s on creation without mutating the caller",
    async (country) => {
      const input = { ...order, shippingCountry: country };
      await orderMethods.createOrderWithItems(input, []);
      expect(calls.insertOrder).toHaveBeenCalledWith(
        calls,
        expect.objectContaining({ shippingCountry: "US" }),
      );
      expect(input.shippingCountry).toBe(country);
    },
  );
  it.each([null, undefined, " "])(
    "preserves missing country as NULL on creation: %s",
    async (country) => {
      await orderMethods.createOrderWithItems(
        { ...order, shippingCountry: country },
        [],
      );
      expect(calls.insertOrder).toHaveBeenCalledWith(
        calls,
        expect.objectContaining({ shippingCountry: null }),
      );
    },
  );
  it("rejects an unknown country before starting creation or any related writes", async () => {
    await expect(
      orderMethods.createOrderWithItems(
        { ...order, shippingCountry: "Atlantis" },
        [],
      ),
    ).rejects.toMatchObject({ code: "ORDER_COUNTRY_INVALID" });
    expect(calls.transaction).not.toHaveBeenCalled();
    expect(calls.insertOrder).not.toHaveBeenCalled();
    expect(calls.execute).not.toHaveBeenCalled();
  });
  it("normalizes updates, permits explicit NULL, and preserves an omitted country", async () => {
    const input = { shippingCountry: "Canada", notes: "Keep" };
    await orderMethods.updateOrderFields(4, input);
    expect(calls.set).toHaveBeenLastCalledWith({
      shippingCountry: "CA",
      notes: "Keep",
    });
    expect(input.shippingCountry).toBe("Canada");
    await orderMethods.updateOrderFields(4, { shippingCountry: null });
    expect(calls.set).toHaveBeenLastCalledWith({ shippingCountry: null });
    await orderMethods.updateOrderFields(4, { notes: "Only notes" });
    expect(calls.set).toHaveBeenLastCalledWith({ notes: "Only notes" });
  });
  it("rejects invalid country updates before any fields can be written", async () => {
    await expect(
      orderMethods.updateOrderFields(4, {
        shippingCountry: "ZZ",
        notes: "Keep",
      }),
    ).rejects.toMatchObject({ code: "ORDER_COUNTRY_INVALID" });
    expect(calls.update).not.toHaveBeenCalled();
  });
  it("normalizes direct OMS customer repair and rejects invalid input before SQL", async () => {
    calls.execute
      .mockResolvedValueOnce({ rows: [{ channel_id: 36 }] })
      .mockResolvedValueOnce({ rows: [{ id: 4 }] });
    await orderMethods.updateOmsRawOrderCustomer(repairScope, repair);
    const write = dialect.sqlToQuery(calls.execute.mock.calls[2][0]);
    expect(write.params).toContain("US");
    expect(write.params).not.toContain("United States");
    expect(write.sql).toContain("UPDATE oms.oms_orders");
    expect(write.params.slice(-4)).toEqual([
      4,
      36,
      "123",
      repairScope.externalOrderId,
    ]);
    calls.execute.mockClear();
    calls.transaction.mockClear();
    await expect(
      orderMethods.updateOmsRawOrderCustomer(repairScope, {
        ...repair,
        shippingCountry: "unknown",
      }),
    ).rejects.toMatchObject({ code: "ORDER_COUNTRY_INVALID" });
    expect(calls.execute).not.toHaveBeenCalled();
    expect(calls.transaction).not.toHaveBeenCalled();
  });
  it("resolves and locks one configured Shopify channel before matching an external order id", async () => {
    calls.execute
      .mockResolvedValueOnce({ rows: [{ channel_id: 37 }] })
      .mockResolvedValueOnce({ rows: [{ id: 91 }] });
    await orderMethods.updateOmsRawOrderCustomer(
      { shopDomain: " FIXTURE ", externalOrderId: "9007199254740993" },
      repair,
    );
    const connection = dialect.sqlToQuery(calls.execute.mock.calls[0][0]);
    expect(connection.params).toEqual(["fixture.myshopify.com"]);
    expect(connection.sql).toContain(
      "c.provider = 'shopify' AND c.status = 'active'",
    );
    expect(connection.sql).toContain("FOR SHARE OF c, cc");
    const match = dialect.sqlToQuery(calls.execute.mock.calls[1][0]);
    expect(match.params).toEqual([
      37,
      "9007199254740993",
      "gid://shopify/Order/9007199254740993",
    ]);
    expect(match.sql).toContain("channel_id =");
    expect(match.sql).toContain("external_order_id IN");
    expect(match.sql).toContain("FOR UPDATE");
    expect(match.sql).not.toContain("external_order_number");
  });
  it.each([
    { rows: [] },
    { rows: [{ channel_id: 36 }, { channel_id: 37 }] },
    { rows: [{ channel_id: 36 }, { channel_id: 36 }] },
  ])(
    "rejects absent or ambiguous shop connections without resolving or writing an order",
    async ({ rows }) => {
      calls.execute.mockResolvedValueOnce({ rows });
      await expect(
        orderMethods.updateOmsRawOrderCustomer(repairScope, repair),
      ).rejects.toMatchObject({ code: "DATA_INTEGRITY_VIOLATION" });
      expect(calls.execute).toHaveBeenCalledOnce();
    },
  );
  it("skips an external order absent from the verified channel", async () => {
    calls.execute
      .mockResolvedValueOnce({ rows: [{ channel_id: 36 }] })
      .mockResolvedValueOnce({ rows: [] });
    expect(
      await orderMethods.updateOmsRawOrderCustomer(repairScope, repair),
    ).toBe(0);
    expect(calls.execute).toHaveBeenCalledTimes(2);
  });
  it("rejects duplicate numeric/GID order aliases before writing either order", async () => {
    calls.execute
      .mockResolvedValueOnce({ rows: [{ channel_id: 36 }] })
      .mockResolvedValueOnce({ rows: [{ id: 4 }, { id: 5 }] });
    await expect(
      orderMethods.updateOmsRawOrderCustomer(repairScope, repair),
    ).rejects.toMatchObject({ code: "DATA_INTEGRITY_VIOLATION" });
    expect(calls.execute).toHaveBeenCalledTimes(2);
  });
  it.each([
    { shopDomain: "evil.test", externalOrderId: "123" },
    { shopDomain: "fixture.myshopify.com/path", externalOrderId: "123" },
    { ...repairScope, externalOrderId: "#123" },
    { ...repairScope, externalOrderId: "gid://shopify/Customer/123" },
    { ...repairScope, externalOrderId: "0" },
  ])("rejects malformed repair scope before transaction: %j", async (scope) => {
    await expect(
      orderMethods.updateOmsRawOrderCustomer(scope, repair),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(calls.transaction).not.toHaveBeenCalled();
    expect(calls.execute).not.toHaveBeenCalled();
  });
  it("validates every locked repair row before the first write", async () => {
    calls.execute.mockResolvedValueOnce({
      rows: [
        { id: 1, oms_order_id: 11, shipping_country: "United States" },
        { id: 2, oms_order_id: 12, shipping_country: "Atlantis" },
      ],
    });
    await expect(orderMethods.backfillOrdersFromOms()).rejects.toMatchObject({
      code: "ORDER_COUNTRY_INVALID",
    });
    expect(calls.transaction).toHaveBeenCalledOnce();
    expect(calls.execute).toHaveBeenCalledOnce();
    expect(dialect.sqlToQuery(calls.execute.mock.calls[0][0]).sql).toContain(
      "FOR UPDATE OF o, oms",
    );
  });
  it("writes canonical country values and NULL within the repair transaction", async () => {
    calls.execute
      .mockResolvedValueOnce({
        rows: [
          { id: 1, oms_order_id: 11, shipping_country: "United States" },
          { id: 2, oms_order_id: 12, shipping_country: " " },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 2 });
    expect(await orderMethods.backfillOrdersFromOms()).toEqual({ updated: 2 });
    const query = dialect.sqlToQuery(calls.execute.mock.calls[1][0]);
    expect(query.params).toEqual([1, 11, "US", 2, 12, null]);
    expect(query.sql).toContain("shipping_country = normalized.country");
    const candidate = dialect.sqlToQuery(calls.execute.mock.calls[0][0]);
    expect(candidate.sql).toContain("o.oms_fulfillment_order_id");
    expect(candidate.sql).toContain("o.source_table_id");
    expect(candidate.sql).toContain("o.channel_id = oms.channel_id");
    expect(candidate.sql).not.toContain("external_order_number");
    expect(calls.transaction).toHaveBeenCalledOnce();
  });
  it("does not write anything when there are no linked same-channel backfill candidates", async () => {
    calls.execute.mockResolvedValueOnce({ rows: [] });
    expect(await orderMethods.backfillOrdersFromOms()).toEqual({ updated: 0 });
    expect(calls.execute).toHaveBeenCalledOnce();
  });
  it("refuses ambiguous repair matches before changing either address", async () => {
    calls.execute.mockResolvedValueOnce({
      rows: [
        { id: 1, oms_order_id: 11, shipping_country: "US" },
        { id: 1, oms_order_id: 12, shipping_country: "CA" },
      ],
    });
    await expect(orderMethods.backfillOrdersFromOms()).rejects.toMatchObject({
      code: "DATA_INTEGRITY_VIOLATION",
    });
    expect(calls.execute).toHaveBeenCalledOnce();
  });
});
