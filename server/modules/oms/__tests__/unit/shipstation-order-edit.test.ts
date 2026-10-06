import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createShipStationService } from "../../shipstation.service";

const OPERATION = "00000000-0000-4000-8000-000000000001";
const dialect = new PgDialect();
const originalFetch = globalThis.fetch;
function setup() {
  let live: Record<string, unknown> = {
    orderId: 55,
    orderNumber: "#100",
    orderStatus: "awaiting_shipment",
    carrierCode: "ups",
    serviceCode: "ups_ground",
    advancedOptions: { storeId: 4 },
    items: [
      {
        lineItemKey: "wms-item-31",
        quantity: 1,
        imageUrl: "https://example.test/item.png",
        weight: { value: 1, units: "pounds" },
      },
    ],
  };
  let baseline: { provider_order_id: string; was_held: boolean } | undefined;
  let timeoutAfterHold = false;
  let incorrectReadback = false;
  let labels: unknown[] = [];
  let split = false;
  const header = {
    id: 9,
    order_id: 10,
    provider_order_id: 55,
    order_edit_operation_id: OPERATION,
    status: "queued",
    on_hold: 0,
    held: false,
    requires_review: false,
  };
  const calls: Array<{ path: string; body: Record<string, unknown> | null }> =
    [];
  const db: Record<string, unknown> = {};
  db.execute = vi.fn(async (statement: SQL) => {
    const query = dialect.sqlToQuery(statement);
    if (query.sql.includes("SELECT oo.id FROM oms.oms_orders"))
      return { rows: [{ id: 20 }] };
    if (query.sql.includes("SELECT COALESCE(os.shipstation_order_id"))
      return { rows: [{ provider_order_id: 55 }] };
    if (query.sql.includes("SELECT wo.id FROM wms.orders"))
      return { rows: [{ id: 10 }] };
    if (query.sql.includes("SELECT os.id,os.order_id"))
      return { rows: [header] };
    if (query.sql.includes("INSERT INTO oms.order_edit_provider_holds")) {
      baseline ??= {
        provider_order_id: "55",
        was_held: live.orderStatus === "on_hold",
      };
      return { rows: [] };
    }
    if (query.sql.includes("SELECT provider_order_id,was_held"))
      return { rows: baseline ? [baseline] : [] };
    if (query.sql.includes("SELECT osi.id,osi.qty"))
      return {
        rows: [
          {
            id: 31,
            qty: 2,
            sku: "SKU",
            name: "Product",
            unit_price_cents: "150",
          },
        ],
      };
    if (query.sql.includes("SELECT wo.id,wo.order_edit_operation_id"))
      return {
        rows: [
          { id: 10, order_edit_operation_id: header.order_edit_operation_id },
        ],
      };
    throw new Error(`Unexpected test query: ${query.sql}`);
  });
  db.transaction = async (
    callback: (transaction: unknown) => Promise<unknown>,
  ) => callback(db);
  globalThis.fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({ path, body });
      let result: unknown;
      if (path === "/orders/55")
        result = {
          ...live,
          ...(incorrectReadback
            ? { items: [{ lineItemKey: "wms-item-31", quantity: 99 }] }
            : {}),
        };
      else if (path === "/shipments") result = { shipments: labels, pages: 1 };
      else if (path === "/orders")
        result = {
          orders: [
            live,
            ...(split
              ? [
                  {
                    orderId: 99,
                    orderNumber: "#100",
                    orderStatus: "awaiting_shipment",
                  },
                ]
              : []),
          ],
          pages: 1,
        };
      else if (path === "/orders/holduntil") {
        expect(baseline).toBeDefined();
        live = { ...live, orderStatus: "on_hold" };
        if (timeoutAfterHold) {
          timeoutAfterHold = false;
          throw new Error("simulated response lost after hold success");
        }
        result = { success: true };
      } else if (path === "/orders/createorder") {
        live = { ...body };
        result = live;
      } else if (path === "/orders/restorefromhold") {
        live = { ...live, orderStatus: "awaiting_shipment" };
        result = { success: true };
      } else throw new Error(`Unexpected test request: ${path}`);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  ) as typeof fetch;
  const service = createShipStationService(db, undefined, {
    sessionLock: async (_lock, callback) => callback(),
  });
  const run = (mode: "hold" | "verify" | "synchronize" | "release") =>
    service.synchronizeOrderEditShipment({
      shipmentId: 9,
      operationId: OPERATION,
      mode,
    });
  return {
    run,
    service,
    calls,
    header,
    get live() {
      return live;
    },
    get baseline() {
      return baseline;
    },
    loseHoldResponse: () => {
      timeoutAfterHold = true;
    },
    wrongReadback: () => {
      incorrectReadback = true;
    },
    alreadyHeld: () => {
      live.orderStatus = "on_hold";
    },
    setLabels: (value: unknown[]) => {
      labels = value;
    },
    split: () => {
      split = true;
    },
  };
}
beforeEach(() => {
  vi.stubEnv("SHIPSTATION_API_KEY", "test-key");
  vi.stubEnv("SHIPSTATION_API_SECRET", "test-secret");
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ShipStation order-edit ownership and readback", () => {
  it("persists hold ownership before an ambiguous provider response and releases its own hold on retry", async () => {
    const f = setup();
    f.loseHoldResponse();
    await expect(f.run("hold")).rejects.toThrow("simulated response lost");
    expect(f.baseline?.was_held).toBe(false);
    await f.run("hold");
    await f.run("synchronize");
    await f.run("release");
    expect(f.live.orderStatus).toBe("awaiting_shipment");
  });
  it("preserves a provider hold that predates the edit", async () => {
    const f = setup();
    f.alreadyHeld();
    await f.run("hold");
    await f.run("synchronize");
    await f.run("release");
    expect(f.live.orderStatus).toBe("on_hold");
    expect(
      f.calls.some((call) => call.path === "/orders/restorefromhold"),
    ).toBe(false);
  });
  it.each(["on_hold", "held"] as const)(
    "preserves a new manual %s hold",
    async (field) => {
      const f = setup();
      await f.run("hold");
      await f.run("synchronize");
      if (field === "on_hold") f.header.on_hold = 1;
      else f.header.held = true;
      await f.run("release");
      expect(f.live.orderStatus).toBe("on_hold");
    },
  );
  it("preserves provider package settings while updating exact line quantities under hold", async () => {
    const f = setup();
    await f.run("hold");
    await f.run("synchronize");
    expect(f.live).toMatchObject({
      orderStatus: "on_hold",
      carrierCode: "ups",
      serviceCode: "ups_ground",
      advancedOptions: { storeId: 4 },
      items: [
        {
          lineItemKey: "wms-item-31",
          quantity: 2,
          unitPrice: 1.5,
          imageUrl: "https://example.test/item.png",
          weight: { value: 1, units: "pounds" },
        },
      ],
    });
  });
  it("does not release on wrong quantity readback", async () => {
    const f = setup();
    await f.run("hold");
    await f.run("synchronize");
    f.wrongReadback();
    await expect(f.run("release")).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_QUANTITY_MISMATCH",
    });
    expect(
      f.calls.some((call) => call.path === "/orders/restorefromhold"),
    ).toBe(false);
  });
  it("blocks a label on a provider split child with a different order ID", async () => {
    const f = setup();
    f.setLabels([{ orderId: 99, orderNumber: "#100", voided: false }]);
    await expect(f.run("hold")).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_LABEL_EXISTS",
    });
    expect(f.calls.some((call) => call.path === "/orders/holduntil")).toBe(
      false,
    );
  });
  it("rejects a stale generic release before contacting the provider", async () => {
    const f = setup();
    await expect(f.service.releaseOrderFromHold(55)).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_HELD",
    });
    expect(f.calls).toHaveLength(0);
  });
  it("rejects a stale operation owner", async () => {
    const f = setup();
    f.header.order_edit_operation_id = "00000000-0000-4000-8000-000000000002";
    await expect(f.run("hold")).rejects.toMatchObject({
      code: "ORDER_EDIT_SHIPMENT_CHANGED",
    });
    expect(f.calls).toHaveLength(0);
  });
  it("blocks an unlabeled provider split outside the operation", async () => {
    const f = setup();
    f.split();
    await expect(f.run("hold")).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_SPLIT_UNVERIFIED",
    });
    expect(f.calls.some((call) => call.path === "/orders/holduntil")).toBe(
      false,
    );
  });
  it("cannot assume a missing provider identity means a timed-out push created nothing", async () => {
    const f = setup();
    (f.header as { provider_order_id: number | null }).provider_order_id = null;
    await expect(f.run("hold")).rejects.toMatchObject({
      code: "ORDER_EDIT_PROVIDER_IDENTITY_UNVERIFIED",
    });
    expect(f.calls).toHaveLength(0);
  });
});
