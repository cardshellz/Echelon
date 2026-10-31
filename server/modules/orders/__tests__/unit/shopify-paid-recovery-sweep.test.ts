import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { paidReplayFixture } from "../../../oms/__tests__/fixtures/shopify-paid-replay.fixture";

const ports = vi.hoisted(() => ({ execute: vi.fn(), select: vi.fn(), readiness: vi.fn(), replay: vi.fn(), sync: vi.fn() }));
vi.mock("../../../../db", () => ({ db: ports }));
vi.mock("../../../oms/shopify-bridge", () => ({ bridgeShopifyOrderToOms: vi.fn() }));
vi.mock("../../../oms/shopify-line-readiness.service", () => ({ reconcileShopifyLineReadiness: ports.readiness }));
vi.mock("../../../oms/shopify-paid-event-replay", () => ({ queueOmsPaidEventReplay: ports.replay }));
import { initReconciliation, runReconciliationNow } from "../../shopify-order-reconciliation";

const dialect = new PgDialect();
let providerOrder: Record<string, unknown>;
let needsReplay: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  needsReplay = true;
  providerOrder = { ...paidReplayFixture().evidence.order, name: "#1001", shipping_address: { country_code: "US" } };
  ports.execute.mockImplementation(async statement => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes("GROUP BY oo.id")) return {
      rows: [
        { oms_order_id: "10", shopify_order_id: "1001", needs_paid_replay: needsReplay },
      ]
    };
    return { rows: [] };
  });
  ports.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: async () => [
          { shopDomain: "fixture.myshopify.com", accessToken: "test-token" },
        ]
      })
    })
  });
  ports.readiness.mockResolvedValue({ advancedQuantity: 0, wmsSyncRequired: false });
  ports.replay.mockResolvedValue({ changed: true, action: "queued_orders_paid_replay" });
  vi.stubGlobal("fetch", vi.fn(async url => ({
    ok: true, headers: { get: () => null },
    json: async () => String(url).includes("/orders.json") ? { orders: [] } : { order: providerOrder },
  })));
  initReconciliation({} as never, { syncOmsOrderToWms: ports.sync } as never);
  vi.spyOn(console, "log").mockImplementation(() => { });
  vi.spyOn(console, "warn").mockImplementation(() => { });
  vi.spyOn(console, "error").mockImplementation(() => { });
});
afterEach(() => { initReconciliation(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded Shopify paid recovery sweep", () => {
  it("fetches current provider truth, calls the shared replay writer, and saves its existing cursor", async () => {
    expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 1, failed: 0 });
    expect(ports.replay).toHaveBeenCalledWith(ports,
      { omsOrderId: 10, operator: "scheduled_shopify_reconciliation" },
      paidReplayFixture().evidence);
    expect(ports.readiness).toHaveBeenCalledOnce();
    const queries = ports.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query));
    expect(queries.find(query => query.sql.includes("GROUP BY oo.id"))?.sql).toContain("ol.paid_quantity = 0");
    expect(queries.find(query => query.sql.includes("INSERT INTO warehouse.echelon_settings")
      && query.params.includes("shopify_reconciliation_readiness_cursor"))?.params).toContain("10");
  });
  it("does not run payment recovery for ordinary authorized readiness candidates", async () => {
    needsReplay = false;
    expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 0, failed: 0 });
    expect(ports.replay).not.toHaveBeenCalled();
    expect(ports.readiness).toHaveBeenCalledOnce();
  });
  it("requests canonical WMS sync when readiness reports incomplete materialization", async () => {
    needsReplay = false;
    ports.readiness.mockResolvedValueOnce({ advancedQuantity: 0, wmsSyncRequired: true });

    expect(await runReconciliationNow()).toMatchObject({
      paidReplaysQueued: 0, wmsSyncRequested: 1, failed: 0,
    });
    expect(ports.sync).toHaveBeenCalledExactlyOnceWith(10);
    expect(ports.replay).not.toHaveBeenCalled();
  });
  it("does not replay a cancelled live Shopify order", async () => {
    providerOrder.cancelled_at = "2026-10-30T12:00:45Z";
    expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 0, skipped: 1 });
    expect(ports.replay).not.toHaveBeenCalled();
    expect(ports.readiness).not.toHaveBeenCalled();
  });
  it.each([{ id: "1002" }, { refunds: undefined }, { updated_at: "invalid" }, { shipping_address: { country_code: "ZZ" } }])(
    "rejects mismatched or incomplete provider evidence %j and preserves the poll checkpoint", async change => {
      Object.assign(providerOrder, change);
      expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 0, failed: 1 });
      expect(ports.replay).not.toHaveBeenCalled();
      const writes = ports.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query))
        .filter(query => query.sql.includes("INSERT INTO warehouse.echelon_settings"));
      expect(writes.some(query => query.params.includes("shopify_reconciliation_last_check"))).toBe(false);
      // The rotating cursor still moves so this review/failure cannot starve the backlog.
      expect(writes.some(query => query.params.includes("shopify_reconciliation_readiness_cursor"))).toBe(true);
    },
  );
  it("isolates replay failures and keeps the recovery checkpoint unchanged", async () => {
    ports.replay.mockRejectedValueOnce(new Error("database temporarily unavailable"));
    expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 0, failed: 1 });
    expect(ports.readiness).not.toHaveBeenCalled();
  });
  it("reports review cases without granting synthetic payment authority", async () => {
    ports.replay.mockResolvedValueOnce({ changed: false, reason: "line_identity_mismatch" });
    expect(await runReconciliationNow()).toMatchObject({ paidReplaysQueued: 0, failed: 0 });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("line_identity_mismatch"));
  });
});
