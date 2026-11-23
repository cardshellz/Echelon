/**
 * Finding a shipment's ShipStation order by Echelon's own key (#65805).
 *
 * Covers: saved id short-circuits (no provider call), lookup by key + proof +
 * link, positive "not in ShipStation", identity mismatches refused, a
 * conflicting saved id refused, lookup errors propagated (never read as "not
 * found"), and that resolution runs under the per-shipment push lock.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createShipStationShipmentOrderResolution,
  proveShipStationOrderBelongsToShipment,
  SS_ORDER_IDENTITY_UNPROVEN,
  SS_ORDER_LINK_CONFLICT,
} from "../../shipstation/shipstation-shipment-order-resolution";

const NOW = new Date("2026-11-23T12:00:00Z");

function sqlText(query: any): string {
  return (query?.queryChunks ?? [])
    .map((c: any) => (typeof c === "string" ? c : Array.isArray(c?.value) ? c.value.join("") : ""))
    .join("");
}

function shipmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 21186,
    order_id: 211418,
    status: "cancelled",
    shipstation_order_id: null,
    shipstation_order_key: null,
    engine_order_ref: null,
    order_number: "#65805",
    external_order_id: "12360048345247",
    channel_id: 36,
    ...overrides,
  };
}

function providerOrder(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 818595428,
    orderKey: "echelon-wms-shp-21186",
    orderNumber: "#65805",
    orderStatus: "awaiting_shipment",
    advancedOptions: { customField2: "wms_order_id:211418|shipment_id:21186" },
    ...overrides,
  };
}

function harness(opts: {
  row?: Record<string, unknown> | null;
  linkRows?: unknown[];
  currentAfterFailedLink?: Record<string, unknown>;
  lookup?: () => Promise<unknown>;
}) {
  const execute = vi.fn(async (query: any) => {
    const text = sqlText(query);
    if (/FROM wms\.outbound_shipments os/.test(text)) {
      return { rows: opts.row === null ? [] : [opts.row ?? shipmentRow()] };
    }
    if (/shipstation_order_id IS NULL OR shipstation_order_id =/.test(text)) {
      return { rows: opts.linkRows ?? [{ status: "cancelled" }] };
    }
    if (/SELECT shipstation_order_id, status/.test(text)) {
      return { rows: [opts.currentAfterFailedLink ?? {}] };
    }
    return { rows: [] };
  });
  const lockCalls: number[] = [];
  const withShipmentPushLock = async <T>(shipmentId: number, fn: () => Promise<T>) => {
    lockCalls.push(shipmentId);
    return fn();
  };
  const getOrderByKey = vi.fn(opts.lookup ?? (async () => providerOrder()));
  const resolution = createShipStationShipmentOrderResolution(
    { db: { execute }, withShipmentPushLock, getOrderByKey },
    { now: () => NOW },
  );
  return { resolution, execute, getOrderByKey, lockCalls };
}

describe("proveShipStationOrderBelongsToShipment", () => {
  const expected = { shipmentId: 21186, wmsOrderId: 211418, orderNumber: "#65805" };

  it("accepts the shipment's own order", () => {
    expect(proveShipStationOrderBelongsToShipment(expected, providerOrder())).toEqual({
      proven: true,
      providerOrderId: 818595428,
    });
  });

  it.each([
    ["invalid_provider_order_id", { orderId: 0 }],
    ["invalid_provider_order_id", { orderId: 2147483648 }],
    ["order_key_mismatch", { orderKey: "echelon-wms-shp-99" }],
    ["order_number_mismatch", { orderNumber: "#65806" }],
    ["wms_metadata_mismatch", { advancedOptions: { customField2: "wms_order_id:1|shipment_id:21186" } }],
    ["wms_metadata_mismatch", { advancedOptions: null }],
  ])("rejects %s", (reason, override) => {
    expect(proveShipStationOrderBelongsToShipment(expected, providerOrder(override))).toEqual({
      proven: false,
      reason,
    });
  });
});

describe("resolveOrderForShipment", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("returns a saved id without calling ShipStation", async () => {
    const h = harness({ row: shipmentRow({ shipstation_order_id: 7777, shipstation_order_key: "echelon-wms-shp-21186" }) });
    await expect(h.resolution.resolveOrderForShipment(21186)).resolves.toEqual({
      state: "linked",
      shipstationOrderId: 7777,
      orderKey: "echelon-wms-shp-21186",
      source: "saved",
    });
    expect(h.getOrderByKey).not.toHaveBeenCalled();
  });

  it("finds an unsaved order by key, proves it, and saves the id without touching status", async () => {
    const h = harness({});
    await expect(h.resolution.resolveOrderForShipment(21186)).resolves.toEqual({
      state: "linked",
      shipstationOrderId: 818595428,
      orderKey: "echelon-wms-shp-21186",
      source: "looked_up",
    });
    expect(h.getOrderByKey).toHaveBeenCalledWith("echelon-wms-shp-21186", "#65805");
    const link = h.execute.mock.calls.map(([q]) => sqlText(q)).find((t) => /shipstation_order_id IS NULL/.test(t))!;
    expect(link).toMatch(/UPDATE wms\.outbound_shipments/);
    expect(link).not.toMatch(/status =/);
    expect(h.lockCalls).toEqual([21186]);
  });

  it("searches eBay orders by the EB- prefixed number the push used", async () => {
    const h = harness({
      row: shipmentRow({ channel_id: 67, order_number: "12-34" }),
      lookup: async () => null,
    });
    await h.resolution.resolveOrderForShipment(21186);
    expect(h.getOrderByKey).toHaveBeenCalledWith("echelon-wms-shp-21186", "EB-12-34");
  });

  it("reports not_in_shipstation only when ShipStation has no order with the key", async () => {
    const h = harness({ lookup: async () => null });
    await expect(h.resolution.resolveOrderForShipment(21186)).resolves.toEqual({
      state: "not_in_shipstation",
      orderKey: "echelon-wms-shp-21186",
    });
  });

  it("propagates lookup failures instead of reporting not found", async () => {
    const h = harness({ lookup: async () => { throw new Error("ShipStation 503"); } });
    await expect(h.resolution.resolveOrderForShipment(21186)).rejects.toThrow("ShipStation 503");
  });

  it("refuses an order whose identity cannot be proven", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = harness({ lookup: async () => providerOrder({ advancedOptions: { customField2: "edited" } }) });
    await expect(h.resolution.resolveOrderForShipment(21186)).rejects.toMatchObject({
      context: { code: SS_ORDER_IDENTITY_UNPROVEN },
    });
    expect(h.execute.mock.calls.some(([q]) => /UPDATE/.test(sqlText(q)))).toBe(false);
    errorSpy.mockRestore();
  });

  it("refuses to re-point a shipment already linked to a different order", async () => {
    const h = harness({
      linkRows: [],
      currentAfterFailedLink: { shipstation_order_id: 700000001, status: "queued" },
    });
    await expect(h.resolution.resolveOrderForShipment(21186)).rejects.toMatchObject({
      context: { code: SS_ORDER_LINK_CONFLICT },
    });
  });

  it("rejects a missing shipment and a non-positive id", async () => {
    await expect(harness({ row: null }).resolution.resolveOrderForShipment(21186)).rejects.toThrow("not found");
    await expect(harness({}).resolution.resolveOrderForShipment(0)).rejects.toThrow("positive integer");
  });
});
