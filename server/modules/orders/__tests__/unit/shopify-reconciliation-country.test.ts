import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const ports = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), bridge: vi.fn(), readiness: vi.fn(), sync: vi.fn() }));
vi.mock("../../../../db", () => ({ db: ports }));
vi.mock("../../../oms/shopify-bridge", () => ({ bridgeShopifyOrderToOms: ports.bridge }));
vi.mock("../../../oms/shopify-line-readiness.service", () => ({ reconcileShopifyLineReadiness: ports.readiness }));
import { initReconciliation, runReconciliationNow } from "../../shopify-order-reconciliation";

const dialect = new PgDialect();
const queries = () => ports.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
function provider(shipping_address: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, headers: { get: () => null }, json: async () => ({ orders: [
    { id: 1001, name: "#1001", shipping_address, line_items: [], customer: null, cancelled_at: null,
      created_at: "2026-09-01T12:00:00.000Z", source_name: "web", currency: "USD" },
  ] }) })));
}
beforeEach(() => {
  vi.clearAllMocks();
  ports.execute.mockResolvedValue({ rows: [], rowCount: 1 });
  ports.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ shopDomain: "fixture.myshopify.com", accessToken: "fixture-token" }] }) }) });
  ports.readiness.mockResolvedValue({ advancedLines: 0, advancedQuantity: 0, wmsSyncRequired: false });
  initReconciliation({} as never, { syncOmsOrderToWms: ports.sync } as never);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { initReconciliation(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Shopify reconciliation country boundary", () => {
  it.each([[{ country_code: " us ", country: "United States" }, "US"], [{ country: "Canada" }, "CA"], [null, null]])(
    "persists a canonical raw country for %j", async (address, expected) => {
      provider(address);
      expect(await runReconciliationNow()).toMatchObject({ reconciled: 1, failed: 0 });
      const insert = queries().find(query => query.sql.includes("INSERT INTO shopify_orders"));
      expect(insert).toBeDefined();
      expect(insert!.params[9]).toBe(expected);
      expect(ports.bridge).toHaveBeenCalledOnce();
    },
  );
  it("rejects invalid source country before raw order/line writes and keeps the retry checkpoint", async () => {
    provider({ country_code: "ZZ", country: "United States" });
    expect(await runReconciliationNow()).toMatchObject({ reconciled: 0, failed: 1 });
    expect(queries().filter(query => /INSERT|UPDATE/.test(query.sql))).toEqual([]);
    expect(ports.bridge).not.toHaveBeenCalled();
  });
  it("does not advance existing order readiness or WMS state from malformed country evidence", async () => {
    provider({ country: "Atlantis" });
    ports.execute.mockImplementation(async query => ({ rows: dialect.sqlToQuery(query).sql.includes("SELECT DISTINCT")
      ? [{ shopify_order_id: "gid://shopify/Order/1001", oms_order_id: 42 }] : [] }));
    expect(await runReconciliationNow()).toMatchObject({ failed: 1 });
    expect(ports.readiness).not.toHaveBeenCalled();
    expect(ports.sync).not.toHaveBeenCalled();
    expect(queries().filter(query => /INSERT|UPDATE/.test(query.sql))).toEqual([]);
  });
});
