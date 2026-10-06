import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { omsOrderLines, omsOrders } from "@shared/schema";

const ports = vi.hoisted(() => ({ recordAuthority: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../oms-line-authority-ledger", () => ({ recordOmsLineAuthorityEvent: ports.recordAuthority }));
vi.mock("../../order-line-catalog-identity.service", () => ({
  resolveOrderLineCatalogIdentity: async () => null,
  orderLineInventoryIdentitySnapshot: () => ({}),
  recordOrderLineCatalogIdentity: async () => undefined,
}));
import { createOmsService } from "../../oms.service";
import { __test__ } from "../../oms-webhooks";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("Shopify webhook mapping through the public OMS ingestion service", () => {
  it.each([
    [3, 1, 3], [1, 1, 1], [0, 0, 0], [3, 0, 0], [undefined, 1, 1],
  ])("keeps current=%s and remaining=%s evidence through the transaction (authority=%s)", async (current, remaining, authority) => {
    const lines: Record<string, unknown>[] = [];
    const tx = {
      insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
        if (table === omsOrderLines) lines.push(values);
        const builder = {
          onConflictDoNothing: () => builder,
          returning: async () => [{ id: table === omsOrders ? 55 : 101 }],
        };
        return builder;
      } }),
    };
    const transaction = vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx));
    const data = __test__.mapShopifyOrderToOrderData({
      id: 640001, order_number: 63662, created_at: "2026-10-06T12:00:00Z", financial_status: "paid",
      line_items: [{ id: 640002, quantity: 3, current_quantity: current, fulfillable_quantity: remaining,
        price: "10.00", sku: "QUAD-BOX-TOP-P5", requires_shipping: true }],
    });
    await createOmsService({ transaction }).ingestOrder(36, "640001", { ...data,
      sourceTopic: "orders/paid", sourceEventId: "shopify-paid:640001" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 3, paidQuantity: 3,
      authorityFulfillableQuantity: authority, fulfillableQuantity: remaining });
    expect(ports.recordAuthority).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      db: tx, orderLineId: 101, sourceEventId: "shopify-paid:640001",
      authority: expect.objectContaining({ authorityFulfillableQuantity: authority }),
    }));
  });
});
