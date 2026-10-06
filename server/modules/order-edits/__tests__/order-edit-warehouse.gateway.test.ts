import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  finalizeOrderEditWarehouseRelease,
  OrderEditWarehouseGateway,
  orderEditWarehouseBlockers,
} from "../infrastructure/order-edit-warehouse.gateway";
import type { OrderEditWarehouseItem } from "../infrastructure/order-edit-warehouse-items";

const OPERATION = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
function ready() {
  return {
    id: 10,
    channel_id: 36,
    warehouse_status: "ready",
    on_hold: 0,
    order_edit_operation_id: null as string | null,
    assigned_picker_id: null as string | null,
    started_at: null as Date | null,
    picked_count: 0,
    combined_group_id: null,
    cancelled: false,
    has_pick_work: false,
    has_label: false,
  };
}
function fixture() {
  const orders = [{ ...ready(), order_edit_operation_id: OPERATION }];
  const items: OrderEditWarehouseItem[] = [
    {
      id: 1,
      order_id: 10,
      oms_order_line_id: "30",
      warehouse_channel_id: 36,
      source_channel_id: 36,
      product_id: 100,
      catalog_product_id: 200,
      sku: "SKU",
      product_variant_id: 100,
      variant_product_id: 200,
      variant_match_count: 1,
      source_variant_id: 100,
      source_external_line_item_id: "101",
      quantity: 1,
      picked_quantity: 0,
      fulfilled_quantity: 0,
      status: "pending",
      on_hold: false,
    },
  ];
  const commands: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    commands.push(text);
    if (text.includes("UPDATE wms.orders SET order_edit_operation_id=NULL")) {
      let count = 0;
      for (const order of orders)
        if (order.order_edit_operation_id === values[1]) {
          order.order_edit_operation_id = null as unknown as string;
          count++;
        }
      return { rows: [], rowCount: count };
    }
    if (text.includes("UPDATE wms.orders SET order_edit_operation_id=$1")) {
      for (const order of orders)
        order.order_edit_operation_id = String(values[0]);
      return { rows: [], rowCount: orders.length };
    }
    if (text.includes("FROM oms.oms_orders"))
      return {
        rows: [
          {
            id: 20,
            channel_id: 36,
            external_order_id: "1",
            status: "paid",
            financial_status: "paid",
            updated_at: "2026-10-05T00:00:00Z",
          },
        ],
      };
    if (text.includes("FROM wms.orders wo"))
      return { rows: structuredClone(orders) };
    if (text.includes("FROM oms.order_edit_operations"))
      return { rows: [{ id: OPERATION }] };
    if (text.includes("FROM wms.outbound_shipments")) return { rows: [] };
    if (text.includes("FROM wms.order_items"))
      return { rows: structuredClone(items) };
    if (text.includes("FROM oms.oms_order_lines"))
      return { rows: [{ id: 30, quantity: 1, paid_quantity: 1 }] };
    if (text.includes("FROM wms.outbound_shipment_items")) return { rows: [] };
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return { rows: [] };
    throw new Error(`Unexpected test SQL: ${text}`);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, "connect">;
  const provider = {
    isConfigured: () => true,
    synchronizeOrderEditShipment: vi.fn(),
  };
  return {
    orders,
    items,
    commands,
    client,
    provider,
    gateway: new OrderEditWarehouseGateway(pool, provider, vi.fn()),
  };
}

describe("order edit warehouse cutoff", () => {
  it("allows an untouched ready order without removing a manual hold", () => {
    expect(orderEditWarehouseBlockers([{ ...ready(), on_hold: 1 }])).toEqual(
      [],
    );
  });
  it.each([
    { started_at: new Date("2026-10-05T00:00:00Z") },
    { assigned_picker_id: "picker" },
    { picked_count: 1 },
    { has_pick_work: true },
    { has_label: true },
    { warehouse_status: "in_progress" },
    { cancelled: true },
    { combined_group_id: 7 },
    { order_edit_operation_id: OTHER },
  ])("blocks unsafe warehouse state %j", (change) => {
    expect(
      orderEditWarehouseBlockers([{ ...ready(), ...change }], OPERATION).length,
    ).toBeGreaterThan(0);
  });
  it("accepts only the same operation's existing hold", () => {
    expect(
      orderEditWarehouseBlockers(
        [{ ...ready(), order_edit_operation_id: OPERATION }],
        OPERATION,
      ),
    ).toEqual([]);
    expect(
      orderEditWarehouseBlockers([
        { ...ready(), order_edit_operation_id: OPERATION },
      ]),
    ).not.toEqual([]);
  });
  it("blocks an absent warehouse projection", () =>
    expect(orderEditWarehouseBlockers([])).not.toEqual([]));
});

describe("atomic warehouse edit release proof", () => {
  it("keeps dedicated and manual holds until the caller's terminal transaction consumes the proof", async () => {
    const f = fixture();
    f.orders[0].on_hold = 1;
    const proof = await f.gateway.releaseUnchanged(20, OPERATION);
    expect(f.orders[0].order_edit_operation_id).toBe(OPERATION);
    expect(
      f.commands.some((text) =>
        text.includes("SET order_edit_operation_id=NULL"),
      ),
    ).toBe(false);
    await finalizeOrderEditWarehouseRelease(f.client, 20, OPERATION, proof);
    expect(f.orders[0].order_edit_operation_id).toBeNull();
    expect(f.orders[0].on_hold).toBe(1);
  });
  it("rejects a new inherited warehouse partition before terminal completion", async () => {
    const f = fixture();
    const proof = await f.gateway.releaseUnchanged(20, OPERATION);
    f.orders.push({ ...f.orders[0], id: 11 });
    await expect(
      finalizeOrderEditWarehouseRelease(f.client, 20, OPERATION, proof),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_CHANGED" });
    expect(
      f.orders.every((row) => row.order_edit_operation_id === OPERATION),
    ).toBe(true);
  });
  it("rejects a concurrent quantity change instead of clearing the edit hold", async () => {
    const f = fixture();
    const proof = await f.gateway.releaseUnchanged(20, OPERATION);
    f.items[0].quantity = 2;
    await expect(
      finalizeOrderEditWarehouseRelease(f.client, 20, OPERATION, proof),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_CHANGED" });
    expect(f.orders[0].order_edit_operation_id).toBe(OPERATION);
  });
  it("cannot clear another operation's hold", async () => {
    const f = fixture();
    const proof = await f.gateway.releaseUnchanged(20, OPERATION);
    f.orders[0].order_edit_operation_id = OTHER;
    await expect(
      finalizeOrderEditWarehouseRelease(f.client, 20, OPERATION, proof),
    ).rejects.toMatchObject({ code: "ORDER_EDIT_RELEASE_OWNER_CHANGED" });
    expect(f.orders[0].order_edit_operation_id).toBe(OTHER);
  });
  it("takes the OMS parent lock before warehouse locks", async () => {
    const f = fixture();
    await f.gateway.acquire(20, OPERATION);
    const sourceIndex = f.commands.findIndex((text) =>
      text.includes("FROM oms.oms_orders"),
    );
    const warehouseIndex = f.commands.findIndex((text) =>
      text.includes("FROM wms.orders wo"),
    );
    expect(sourceIndex).toBeLessThan(warehouseIndex);
  });
});
