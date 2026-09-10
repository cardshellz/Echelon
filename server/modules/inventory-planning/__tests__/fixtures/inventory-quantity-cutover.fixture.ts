import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { InventoryCutoverOpeningService } from "../../application/inventory-cutover-opening.service";
import { PostgresInventoryCutoverOpeningRepository } from "../../infrastructure/inventory-cutover-opening.repository";

/** Only for a fresh disposable composition fixture after real migrations236/240. */
export async function installQuantityCutoverFixture(pool: Pool): Promise<void> {
  const existing = (await pool.query("SELECT to_regclass('inventory.quantity_ledger_opening')::text AS relation")).rows[0].relation;
  if (existing) {
    if ((await pool.query("SELECT count(*)::integer AS count FROM inventory.quantity_ledger_opening")).rows[0].count !== 0) throw new Error("Cannot replace a fixture with an established opening");
    await pool.query("DROP TABLE inventory.quantity_ledger_opening");
  }
  // Admission fixture helper materializes current columns; test actual additive
  // migration242 against the prior lot schema, not a pre-created future column.
  await pool.query("ALTER TABLE inventory.inventory_lots DROP COLUMN IF EXISTS qty_packed");
  await pool.query(readFileSync(resolve(process.cwd(), "migrations/242_inventory_quantity_ledger.sql"), "utf8"));
}

/** Test-only observations of this suite's controlled single-SKU fixture.
 * Seed data gives owner11 all existing custody; any additional test order is
 * unstarted. This is not an operational auto-verification API or count inference.
 */
export async function saveCompositionQuantityOpening(pool: Pool, key = "composition-quantity-opening") {
  const occurredAt = new Date("2026-09-09T16:00:00.000Z");
  const service = new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository(pool), { now: () => occurredAt });
  const source = await service.capture("operator");
  const custody = source.evidence.lots.filter(lot => BigInt(lot.reservedQty) > BigInt(0) || BigInt(lot.pickedQty) > BigInt(0));
  const levels = new Map(source.evidence.levels.map(level => [`${level.productVariantId}:${level.warehouseLocationId}`,level]));
  const owners: OpeningVerification["owners"] = source.evidence.items.map(item => {
    const assigned = item.id === 11 ? custody : [];
    const allocations = new Map<number, OpeningVerification["owners"][number]["allocations"][number]>();
    for (const lot of assigned) {
      const level = levels.get(`${lot.productVariantId}:${lot.warehouseLocationId}`);
      if (!level) throw new Error("Test custody lot requires its seeded position");
      const allocation = allocations.get(level.id) ?? { inventoryLevelId: level.id, lots: [] };
      allocation.lots.push({ inventoryLotId: lot.id, reservedQty: lot.reservedQty, pickedQty: lot.pickedQty,
        originalCostIds: source.evidence.costs.filter(cost => cost.inventoryLotId === lot.id && cost.orderItemId === item.id).map(cost => cost.id) });
      allocations.set(level.id,allocation);
    }
    return { orderId: item.orderId, orderItemId: item.id, remainingQty: String(item.quantity-item.fulfilledQuantity),
      reservedQty: assigned.reduce((sum,lot) => sum+BigInt(lot.reservedQty),BigInt(0)).toString(),
      pickedQty: assigned.reduce((sum,lot) => sum+BigInt(lot.pickedQty),BigInt(0)).toString(), allocations: [...allocations.values()] };
  });
  return service.save({ idempotencyKey: key, reason: "Independent observations of controlled test stock",
    verification: { contractVersion: "inventory_cutover_opening_v2", expectedEvidenceHash: source.evidenceHash,
      expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
      verificationReference: "Seeded test stock, custody and original exact costs", verificationEvidenceHash: "e".repeat(64),
      verifiedAt: occurredAt.toISOString(), historicalDisposition: "preserve_unresolved",
      levels: source.evidence.levels, lots: source.evidence.lots, owners } }, "operator");
}
