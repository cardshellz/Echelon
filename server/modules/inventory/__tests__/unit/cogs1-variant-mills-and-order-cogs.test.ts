import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { updateVariantReceiptCostRollupInCatalog } from "../../../catalog/cross-module-product-mutations.api";
vi.mock("../../../catalog/cross-module-product-mutations.api", () => ({
  updateVariantReceiptCostRollupInCatalog: vi.fn().mockResolvedValue(undefined),
}));
import { resolveCost } from "../../application/cost-resolver";
import { buildOrderCOGSReport } from "../../domain/order-cogs-read";
import { InventoryLotService } from "../../application/lots.service";
import { loadArchonSnapshot } from "../../../oms/application/archon-order-delivery";
import { ReceivingService } from "../../../procurement/application/receiving.service";
import { parseReceivingImportCsv } from "../../../../../client/src/lib/receiving-import";

describe("COGS-1 — Sub-cent variant mills waterfall (resolveCost)", () => {
  function buildMockCatalogTx(variantRow: Record<string, unknown> | null) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (variantRow ? [variantRow] : []),
          }),
        }),
      }),
    } as any;
  }

  it("preserves exact sub-half-cent lastCostMills (38 mills = $0.0038) instead of collapsing to 0 / unresolved", async () => {
    const tx = buildMockCatalogTx({
      standardCostCents: 0,
      lastCostCents: 0,
      avgCostCents: 0,
      standardCostMills: null,
      lastCostMills: 38,
      avgCostMills: 38,
    });
    const res = await resolveCost(tx, 101);
    expect(res).toEqual({
      costCents: 0,
      costMills: 38,
      source: "last_paid",
      provisional: true,
    });
  });

  it("prefers explicit hintMills (e.g. 42 mills) over variant rollups", async () => {
    const tx = buildMockCatalogTx({
      standardCostCents: 10,
      lastCostCents: 12,
      avgCostCents: 11,
      standardCostMills: 1000,
      lastCostMills: 1200,
      avgCostMills: 1100,
    });
    const res = await resolveCost(tx, 101, undefined, 42);
    expect(res).toEqual({
      costCents: 0,
      costMills: 42,
      source: "explicit",
      provisional: false,
    });
  });

  it("falls through lastCost -> standardCost -> avgCost using mills first and cents fallback", async () => {
    const standardTx = buildMockCatalogTx({
      standardCostCents: 0,
      lastCostCents: 0,
      avgCostCents: 0,
      standardCostMills: 25,
      lastCostMills: 0,
      avgCostMills: 0,
    });
    expect(await resolveCost(standardTx, 101)).toEqual({
      costCents: 0,
      costMills: 25,
      source: "standard",
      provisional: true,
    });

    const avgTx = buildMockCatalogTx({
      standardCostCents: null,
      lastCostCents: null,
      avgCostCents: 0,
      standardCostMills: null,
      lastCostMills: null,
      avgCostMills: 19,
    });
    expect(await resolveCost(avgTx, 101)).toEqual({
      costCents: 0,
      costMills: 19,
      source: "avg",
      provisional: true,
    });

    const legacyCentsTx = buildMockCatalogTx({
      standardCostCents: null,
      lastCostCents: 7,
      avgCostCents: null,
      standardCostMills: null,
      lastCostMills: null,
      avgCostMills: null,
    });
    expect(await resolveCost(legacyCentsTx, 101)).toEqual({
      costCents: 7,
      costMills: 700,
      source: "last_paid",
      provisional: true,
    });
  });
});

describe("COGS-1 — Canonical unpicks & sellable return credits in buildOrderCOGSReport", () => {
  const baseOrder = { id: 500, orderNumber: "ORD-500", totalCents: 5000, currency: "USD" };
  const baseItem = { id: 90, sku: "SLV-REG", name: "Regular Sleeves", quantity: 5, totalPriceCents: 5000 };

  it("nets partial unpick compensating rows (+5 picked, -2 unpicked => 3 net) without throwing ORDER_COGS_INVALID_DATA", () => {
    const report = buildOrderCOGSReport({
      order: baseOrder,
      items: [baseItem],
      costs: [
        {
          order_id: 500,
          order_item_id: 90,
          lot_id: 77,
          lot_number: "IL-77",
          qty_consumed: 5,
          unit_cost_cents: 100,
          total_cost_cents: 500,
          unit_cost_mills: 10000,
          total_cost_mills: 50000,
        },
        {
          order_id: 500,
          order_item_id: 90,
          lot_id: 77,
          lot_number: "IL-77",
          qty_consumed: -2,
          unit_cost_cents: 100,
          total_cost_cents: -200,
          unit_cost_mills: 10000,
          total_cost_mills: -20000,
        },
      ],
    });

    expect(report.totalCogsCents).toBe(300);
    expect(report.totalCogsMills).toBe("30000");
    expect(report.grossMarginCents).toBe(4700);
    expect(report.lineItems[0].lotBreakdown).toEqual([
      {
        lotId: 77,
        lotNumber: "IL-77",
        qty: 3,
        unitCostCents: 100,
        totalCostCents: 300,
        unitCostMills: "10000",
        totalCostMills: "30000",
      },
    ]);
  });

  it("nets full unpick / full sellable return (+5 / -5 => $0 COGS and empty active lotBreakdown)", () => {
    const report = buildOrderCOGSReport({
      order: baseOrder,
      items: [baseItem],
      costs: [
        {
          order_id: 500,
          order_item_id: 90,
          lot_id: 77,
          lot_number: "IL-77",
          qty_consumed: 5,
          unit_cost_cents: 100,
          total_cost_cents: 500,
          unit_cost_mills: 10000,
          total_cost_mills: 50000,
        },
        {
          order_id: 500,
          order_item_id: 90,
          lot_id: 77,
          lot_number: "IL-77",
          qty_consumed: -5,
          unit_cost_cents: 100,
          total_cost_cents: -500,
          unit_cost_mills: 10000,
          total_cost_mills: -50000,
        },
      ],
    });

    expect(report.totalCogsCents).toBe(0);
    expect(report.totalCogsMills).toBe("0");
    expect(report.lineItems[0].lotBreakdown).toEqual([]);
  });

  it("still rejects corrupted over-unpick (net negative qty) or negative cost on positive qty", () => {
    expect(() =>
      buildOrderCOGSReport({
        order: baseOrder,
        items: [baseItem],
        costs: [
          {
            order_id: 500,
            order_item_id: 90,
            lot_id: 77,
            lot_number: "IL-77",
            qty_consumed: 2,
            unit_cost_cents: 100,
            total_cost_cents: 200,
            unit_cost_mills: 10000,
            total_cost_mills: 20000,
          },
          {
            order_id: 500,
            order_item_id: 90,
            lot_id: 77,
            lot_number: "IL-77",
            qty_consumed: -3,
            unit_cost_cents: 100,
            total_cost_cents: -300,
            unit_cost_mills: 10000,
            total_cost_mills: -30000,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));

    expect(() =>
      buildOrderCOGSReport({
        order: baseOrder,
        items: [baseItem],
        costs: [
          {
            order_id: 500,
            order_item_id: 90,
            lot_id: 77,
            lot_number: "IL-77",
            qty_consumed: 2,
            unit_cost_cents: 100,
            total_cost_cents: -200,
            unit_cost_mills: 10000,
            total_cost_mills: -20000,
          },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: "ORDER_COGS_INVALID_DATA" }));
  });
});

describe("COGS-1 — Direct shipFromLots records oms.order_item_costs & updateVariantCosts preserves last_cost", () => {
  it("writes oms.order_item_costs for direct fromOnHand customer shipments and skips picked-only portions", async () => {
    const insertedOrderItemCosts: any[] = [];
    const lotRow = {
      id: 401,
      qtyOnHand: 100,
      qtyReserved: 0,
      qtyPicked: 20,
      receivedAt: new Date("2026-09-01T00:00:00Z"),
      status: "active",
      unitCostCents: 0,
      unitCostMills: 38,
      totalUnitCostMills: 38,
      poUnitCostMills: 38,
      packagingCostMills: 0,
      landedCostMills: 0,
      poUnitCostCents: 0,
      packagingCostCents: 0,
      landedCostCents: 0,
      costPrecisionVersion: 1,
      costBasisQty: null,
      productTotalCostMills: null,
      packagingTotalCostMills: null,
      landedTotalCostMills: null,
    };

    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: 401 }] }),
      select: vi.fn(() => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({
                for: async () => [lotRow],
              }),
            }),
          }),
        }),
      })),
      update: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(() => ({
        values: async (rows: any[]) => {
          insertedOrderItemCosts.push(...rows);
          return rows;
        },
      })),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(tx, () => new Date("2026-10-15T12:00:00Z"), true);

    // Ship 50 total: 20 already picked (COGS was recorded at pick time) + 30 direct from on-hand!
    await svc.shipFromLots(
      {
        productVariantId: 11,
        warehouseLocationId: 22,
        qty: 50,
        fromPicked: 20,
        fromOnHand: 30,
        reservedToRelease: 0,
      },
      { orderId: 9001, orderItemId: 9002 },
    );

    expect(insertedOrderItemCosts).toHaveLength(1);
    expect(insertedOrderItemCosts[0]).toMatchObject({
      orderId: 9001,
      orderItemId: 9002,
      inventoryLotId: 401,
      productVariantId: 11,
      qty: 30,
      unitCostMills: 38,
      totalCostMills: 1140, // 30 * 38 mills = $0.1140 -> 11 cents
      unitCostCents: 0,
      totalCostCents: 11,
    });
  });

  it("preserves lastCostCents/lastCostMills when refreshing average cost on package break (no new receipt cost)", async () => {
    vi.mocked(updateVariantReceiptCostRollupInCatalog).mockClear();
    const tx = {
      select: vi.fn(() => ({
        from: () => ({
          where: async () => [
            {
              totalQty: 1000,
              totalCost: 0,
              totalCostMills: "38000", // 1000 * 38 mills = 38,000 mills -> avg 38 mills
            },
          ],
        }),
      })),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn(),
    } as any;

    const svc = new InventoryLotService(tx, () => new Date("2026-10-15T12:00:00Z"), true);
    await svc.updateVariantCosts(11);

    expect(updateVariantReceiptCostRollupInCatalog).toHaveBeenCalledWith(tx, {
      productVariantId: 11,
      avgCostCents: 0,
      avgCostMills: 38,
    });
    const callArg = vi.mocked(updateVariantReceiptCostRollupInCatalog).mock.calls[0][1];
    expect("lastCostCents" in callArg).toBe(false);
    expect("lastCostMills" in callArg).toBe(false);
  });
});

describe("COGS-1 — Archon order.snapshot COGS & carrier cost enrichment", () => {
  it("attaches cogs_cents, cogs_mills, carrier_cost_cents, and cost_evidence for USD orders with recorded costs", async () => {
    const mockDb = {
      query: async (queryText: string) => {
        if (queryText.includes("FROM oms.oms_orders")) {
          return {
            rows: [
              {
                id: 55,
                channel_id: 2,
                external_order_id: "SHOP-55",
                raw_payload: null,
                total_cents: 2500,
                subtotal_cents: 2000,
                shipping_cents: 500,
                tax_cents: 0,
                discount_cents: 0,
                refund_amount_cents: 0,
                currency: "USD",
                financial_status: "paid",
                fulfillment_status: "fulfilled",
                ordered_at: new Date("2026-10-01T00:00:00Z"),
              },
            ],
          };
        }
        if (queryText.includes("FROM channels.channels")) {
          return { rows: [{ name: "Card Shellz", provider: "shopify", shipping_config: {} }] };
        }
        if (queryText.includes("to_regclass('wms.orders')")) {
          return {
            rows: [
              {
                has_wms: true,
                has_cogs: true,
                has_lots: true,
                has_shipments: true,
                has_returns: true,
                has_tx: true,
              },
            ],
          };
        }
        if (queryText.includes("FROM wms.outbound_shipments")) {
          return {
            rows: [{ has_carrier_records: true, carrier_cost_cents: "489" }],
          };
        }
        if (queryText.includes("FROM oms.order_item_costs")) {
          return {
            rows: [
              {
                row_count: 2,
                total_mills: "42500", // $4.2500 gross picked
                product_mills: "35000",
                packaging_mills: "2500",
                landed_mills: "5000",
                provisional_lots: 1,
              },
            ],
          };
        }
        if (queryText.includes("FROM inventory.return_cost_allocations")) {
          return {
            rows: [
              {
                ret_total_mills: "10000", // $1.0000 sellable restocked return
                ret_po_mills: "8000",
                ret_pkg_mills: "500",
                ret_landed_mills: "1500",
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as PoolClient;

    const snapshot = await loadArchonSnapshot(mockDb, 55, "55");
    expect(snapshot.order.cogs_mills).toBe("32500"); // 42500 - 10000 = 32500 mills ($3.25)
    expect(snapshot.order.cogs_cents).toBe(325);
    expect(snapshot.order.carrier_cost_cents).toBe(489);
    expect(snapshot.order.cost_evidence).toEqual({
      version: 1,
      total_cogs_mills: "32500",
      total_cogs_cents: 325,
      product_cost_mills: "27000",
      packaging_cost_mills: "2000",
      landed_cost_mills: "3500",
      provisional_lot_count: 1,
      carrier_cost_cents: 489,
    });
  });
});

describe("COGS-1 — Blind / CSV receiving unit_cost_basis pack-multiplier normalization", () => {
  it("parses unit_cost_basis from CSV and normalizes per_variant Case price ($25.00 / 1,000-pc Case => 250 mills/pc)", async () => {
    const parsedCsv = parseReceivingImportCsv(
      "sku,qty,location,unit_cost,unit_cost_basis\nCSI-CASE-1000,2,RCV-STAGE,25.00,per_variant",
    );
    expect(parsedCsv.error).toBeUndefined();
    expect(parsedCsv.lines).toEqual([
      {
        sku: "CSI-CASE-1000",
        qty: "2",
        location: "RCV-STAGE",
        damaged_qty: null,
        unit_cost: "25.00",
        unit_cost_basis: "per_variant",
        barcode: null,
        notes: null,
      },
    ]);

    const createdLines: any[] = [];
    const receiptRow = {
      id: 88,
      status: "draft",
      warehouseId: 1,
      receivingLocationId: null,
      purchaseOrderId: null,
    };
    const storage = {
      getSetting: vi.fn().mockResolvedValue("true"),
      getAllProductLocations: vi.fn().mockResolvedValue([]),
      getReceivingLines: vi.fn().mockResolvedValue([]),
      getReceivingOrderById: vi.fn().mockResolvedValue(receiptRow),
      getAllWarehouseLocations: vi.fn().mockResolvedValue([{ id: 10, code: "RCV-STAGE", name: "Receiving Stage", warehouseId: 1, isActive: 1 }]),
      getAllProducts: vi.fn().mockResolvedValue([{ id: 50, sku: "CSI-BASE", name: "Regular Sleeves" }]),
      getAllProductVariants: vi.fn().mockResolvedValue([
        {
          id: 501,
          sku: "CSI-CASE-1000",
          name: "Case of 1000 Sleeves",
          productId: 50,
          unitsPerVariant: 1000,
          isActive: true,
        },
      ]),
      bulkCreateReceivingLines: vi.fn(async (lines: any[]) => {
        createdLines.push(...lines);
        return lines;
      }),
      updateReceivingOrder: vi.fn().mockResolvedValue({}),
    } as any;

    const tx = {
      execute: vi.fn(async (query: any) => {
        const text = JSON.stringify(query);
        if (text.includes("receiving_orders")) return { rows: [receiptRow] };
        if (text.includes("warehouses")) return { rows: [{ isActive: 1 }] };
        if (text.includes("warehouse_locations")) return { rows: [{ id: 10, warehouseId: 1, isActive: 1 }] };
        if (text.includes("product_variants")) return { rows: [{ id: 501, product_id: 50, units_per_variant: 1000, is_active: true }] };
        return { rows: [] };
      }),
    };
    const db = {
      execute: tx.execute,
      transaction: vi.fn(async (fn: any) => fn(tx)),
    } as any;

    const svc = new ReceivingService(db, {} as any, {} as any, storage);
    const result = await svc.bulkImportLines(88, parsedCsv.lines!, "user-1");

    expect(result.errors).toBeUndefined();
    expect(result.created).toBe(1);
    expect(createdLines).toHaveLength(1);
    // $25.00 per 1,000-piece Case = 250,000 mills / 1,000 = 250 mills ($0.0250/pc) -> 3 cents mirror.
    // On receipt close, 250 mills/pc * 1,000 = 250,000 mills ($25.00/Case), NOT $25,000/Case!
    expect(createdLines[0].unitCostMills).toBe(250);
    expect(createdLines[0].unitCost).toBe(3);
  });
});
