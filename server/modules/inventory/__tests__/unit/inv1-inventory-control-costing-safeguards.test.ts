import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { legacyTransformationExecutionAuthority } from "../../application/transformation-execution-authority.port";
import { ManualInventoryTransferService } from "../../application/manual-inventory-transfer.service";
import { COGSService } from "../../cogs.service";
import { InventoryUseCases } from "../../application/inventory.use-cases";

vi.mock("../../infrastructure/operational-quantity-posting", () => ({
  openOperationalQuantityPosting: vi.fn(async () => null),
}));

describe("Priority 4 (INV-1): Inventory Control and Costing Safeguards", () => {
  describe("IW-F01: BreakVariant returns resolved targetLocationId for replenishment follow-up", () => {
    it("returns the auto-resolved pickable bin location when targetLocationId is omitted", async () => {
      process.env.DATABASE_URL ||= "postgres://user:pass@localhost:5432/test";
      const { BreakAssemblyUseCases } = await import("../../application/break-assembly.use-cases");

      const sourceVariant = {
        id: 1,
        productId: 100,
        name: "Case of 10",
        sku: "CASE-10",
        unitsPerVariant: 10,
        isActive: true,
        parentVariantId: 2,
      };
      const targetVariant = {
        id: 2,
        productId: 100,
        name: "Single Pack",
        sku: "PACK-1",
        unitsPerVariant: 1,
        isActive: true,
        parentVariantId: null,
      };

      const fetchSequence = [
        [sourceVariant],
        [targetVariant],
        [{ inventoryStrategy: "physical_fungible" }],
        [{ warehouseLocationId: 77 }],
      ];
      let fetchIdx = 0;
      const lockedRows = [
        { inventoryStrategy: "physical_fungible" },
        sourceVariant,
        targetVariant,
      ];
      let lockIdx = 0;

      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            innerJoin: vi.fn().mockReturnThis(),
            where: vi.fn(() => {
              const rows = fetchSequence[fetchIdx++] ?? [];
              return Object.assign(Promise.resolve(rows), {
                limit: vi.fn().mockResolvedValue(rows),
                innerJoin: vi.fn().mockReturnThis(),
              });
            }),
          })),
        })),
        transaction: vi.fn(async (fn: any) =>
          fn({
            select: vi.fn(() => ({
              from: vi.fn(() => ({
                where: vi.fn(() => ({
                  limit: vi.fn().mockResolvedValue([{ variantQty: 10 }]),
                  for: vi.fn(async () => [lockedRows[lockIdx++]]),
                })),
              })),
            })),
            execute: vi.fn(async () => ({ rows: [] })),
          }),
        ),
      };

      const adjustCalls: any[] = [];
      const inventoryUseCases = {
        adjustInventory: vi.fn(async (params: any) => {
          adjustCalls.push(params);
          if (params.qtyDelta < 0) {
            return {
              orphanedQty: 0,
              consumedCostCents: 1000,
              consumedQty: 1,
              consumedLots: [{ lotId: 11, qty: 1 }],
              consumedPoCostMills: "100000",
              consumedPackagingCostMills: "0",
              consumedLandedCostMills: "0",
              consumedCostProvisional: false,
            };
          }
          return { orphanedQty: 0, consumedCostCents: 0, consumedQty: 0 };
        }),
        withTx: vi.fn(function (this: any) {
          return this;
        }),
      };

      const svc = new BreakAssemblyUseCases(
        db,
        inventoryUseCases as any,
        () => new Date(0),
        legacyTransformationExecutionAuthority,
      );

      const result = await svc.breakVariant({
        sourceVariantId: 1,
        targetVariantId: 2,
        warehouseLocationId: 20,
        sourceQty: 1,
        userId: "operator",
      });

      expect(result.targetLocationId).toBe(77);
      expect(adjustCalls[1]?.warehouseLocationId).toBe(77);
    });
  });

  describe("IW-F02: CSV fill-missing cost upload revalidates lot eligibility under canonical cost lock", () => {
    it("skips a lot that was concurrently finalized with a non-zero non-provisional cost before the row lock", async () => {
      const executeCalls: string[] = [];
      const tx = {
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          executeCalls.push(text);
          if (text.includes("FOR UPDATE OF il")) {
            return {
              rows: [
                {
                  id: 42,
                  lot_number: "LOT-42",
                  product_variant_id: 10,
                  sku: "SKU-10",
                  status: "active",
                  qty_on_hand: 25,
                  cost_provisional: 0,
                  cost_precision_version: 1,
                  po_unit_cost_mills: 5000,
                  packaging_cost_mills: 0,
                  landed_cost_mills: 0,
                  total_unit_cost_mills: 5000,
                  unit_cost_mills: 5000,
                  po_unit_cost_cents: 50,
                  packaging_cost_cents: 0,
                  landed_cost_cents: 0,
                  total_unit_cost_cents: 50,
                  unit_cost_cents: 50,
                  cost_source: "po",
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const db = {
        execute: vi.fn(async () => ({
          rows: [
            {
              id: 42,
              lot_number: "LOT-42",
              sku: "SKU-10",
              upv: 1,
              loc: "BIN-A1",
              qty_on_hand: 25,
              old_cents: 0,
            },
          ],
        })),
        transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const cogs = new COGSService(db as any, () => new Date("2026-11-09T00:00:00Z"));
      const uploadResult = await cogs.applyLotCostUpload(
        [{ sku: "SKU-10", cost_per_piece: "0.25" }],
        true,
      );

      expect(uploadResult.summary.lotsAffected).toBe(0);
      expect(uploadResult.results).toEqual([
        expect.objectContaining({
          status: "skipped",
          lotNumber: "LOT-42",
          sku: "SKU-10",
        }),
      ]);
      expect(executeCalls.some((q) => q.includes("UPDATE inventory.inventory_lots"))).toBe(false);
    });

    it("applies CSV cost when locked lot remains provisional or zero-cost", async () => {
      const executeCalls: string[] = [];
      const tx = {
        execute: vi.fn(async (query: any) => {
          const text = JSON.stringify(query);
          executeCalls.push(text);
          if (text.includes("FOR UPDATE OF il")) {
            return {
              rows: [
                {
                  id: 43,
                  lot_number: "LOT-43",
                  product_variant_id: 10,
                  sku: "SKU-10",
                  status: "active",
                  qty_on_hand: 25,
                  cost_provisional: 1,
                  cost_precision_version: 1,
                  po_unit_cost_mills: 0,
                  packaging_cost_mills: 0,
                  landed_cost_mills: 0,
                  total_unit_cost_mills: 0,
                  unit_cost_mills: 0,
                  po_unit_cost_cents: 0,
                  packaging_cost_cents: 0,
                  landed_cost_cents: 0,
                  total_unit_cost_cents: 0,
                  unit_cost_cents: 0,
                  cost_source: "po",
                },
              ],
            };
          }
          return { rows: [] };
        }),
      };

      const db = {
        execute: vi.fn(async () => ({
          rows: [
            {
              id: 43,
              lot_number: "LOT-43",
              sku: "SKU-10",
              upv: 1,
              loc: "BIN-A1",
              qty_on_hand: 25,
              old_cents: 0,
            },
          ],
        })),
        transaction: vi.fn(async (fn: any) => fn(tx)),
      };

      const cogs = new COGSService(db as any, () => new Date("2026-11-09T00:00:00Z"));
      const uploadResult = await cogs.applyLotCostUpload(
        [{ sku: "SKU-10", cost_per_piece: "0.25" }],
        true,
      );

      expect(uploadResult.summary.lotsAffected).toBe(1);
      expect(uploadResult.results).toEqual([
        expect.objectContaining({
          status: "applied",
          lotNumber: "LOT-43",
          newCostMills: 2500,
          newCostCents: 25,
        }),
      ]);
      expect(executeCalls.some((q) => q.includes("UPDATE inventory.inventory_lots"))).toBe(true);
    });
  });

  describe("IW-F03: Inventory mutation route permission gates", () => {
    it("gates POST /api/inventory/receive, /api/inventory/locations, and /api/inventory/items with explicit permissions", () => {
      const source = readFileSync(
        resolve(process.cwd(), "server/modules/inventory/inventory.routes.ts"),
        "utf8",
      );
      expect(source).toContain(
        'app.post("/api/inventory/receive", requirePermission("inventory", "adjust"), validateInventoryCommandKey',
      );
      expect(source).toContain(
        'app.post("/api/inventory/locations", requirePermission("warehouse", "manage")',
      );
      expect(source).toContain(
        'app.post("/api/inventory/items", requirePermission("inventory", "create"), protectEbayPolicyWriteBoundary("create")',
      );
    });
  });

  describe("IW-05: Manual transfer follow-up locks transfer row and refuses undone transfers", () => {
    it("refuses to mark follow-up completed when the transfer was concurrently undone before completion lock", async () => {
      const txExecute = vi.fn(async () => ({
        rows: [{ completed_at: null, voided_at: null, undone: true }],
      }));
      const database = {
        execute: vi
          .fn()
          .mockResolvedValueOnce({
            rows: [
              {
                actor: "operator",
                completed_at: null,
                product_variant_id: 10,
                from_location_id: 1,
                voided_at: null,
                undone: false,
              },
            ],
          })
          .mockResolvedValueOnce({ rows: [] }),
        transaction: vi.fn(async (fn: any) => fn({ execute: txExecute })),
      };
      const effects = { deliver: vi.fn(async () => undefined) };
      const service = new ManualInventoryTransferService(
        database as any,
        {} as any,
        effects,
        () => new Date("2026-11-09T00:00:00Z"),
      );

      const completed = await service.recover(99);
      expect(completed).toBe(false);
      expect(effects.deliver).toHaveBeenCalledOnce();
      expect(txExecute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(txExecute.mock.calls[0])).toContain("FOR UPDATE OF f, t");
    });
  });

  describe("CI-08 / IW-07: receiveInventory defers notification until outer transaction commits when deferUntilCommit is supplied", () => {
    it("queues the receive notification onto deferUntilCommit instead of firing inside caller transaction", async () => {
      const tx = {
        execute: vi.fn(async () => ({ rows: [] })),
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([{ cycleCountFreezeId: null }]),
            })),
          })),
        })),
      };
      const storage = {
        upsertInventoryLevel: vi.fn(async () => ({ id: 1, variantQty: 0 })),
        adjustInventoryLevel: vi.fn(async () => undefined),
        createInventoryTransaction: vi.fn(async () => ({ id: 500 })),
      };
      const db = {
        transaction: vi.fn(async (fn: any) => fn(tx)),
      };
      const uc = new InventoryUseCases(db as any, storage as any, null, null, () => new Date(0));
      const notified: Array<{ variantId: number; trigger: string }> = [];
      uc.onInventoryChange((variantId, trigger) => {
        notified.push({ variantId, trigger });
      });

      const deferredEffects: Array<() => Promise<void>> = [];
      await uc.receiveInventory(
        {
          productVariantId: 77,
          warehouseLocationId: 5,
          qty: 10,
          referenceId: "RCV-1",
          receivingLineId: 123,
          deferUntilCommit: (effect) => deferredEffects.push(effect),
        },
        tx,
      );

      expect(notified).toHaveLength(0);
      expect(deferredEffects).toHaveLength(1);

      await deferredEffects[0]();
      expect(notified).toEqual([{ variantId: 77, trigger: "receive" }]);
    });
  });
});
