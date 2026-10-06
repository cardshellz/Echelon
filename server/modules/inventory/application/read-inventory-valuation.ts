import { sql, type SQL } from "drizzle-orm";
import { readInventoryCostDisplay } from "../../catalog/inventory-cost-display.reader";
import { valueInventory, type ValuationLot } from "../domain/inventory-valuation";
import { costInteger, CostEvidenceError } from "../infrastructure/cost-evidence-values";

const MAX_VALUATION_LOTS = 200_000;

/** One exact valuation read and policy for every Inventory/COGS report shape. */
export async function readInventoryValuation(db: { execute(query: SQL): Promise<unknown> }) {
  const result = await db.execute(sql`SELECT * FROM inventory.inventory_lots
    WHERE status='active' AND qty_on_hand>0 ORDER BY id LIMIT ${MAX_VALUATION_LOTS+1}`);
  const rows = result && typeof result === "object" ? (result as { rows?: unknown }).rows : undefined;
  if (!Array.isArray(rows)) throw new CostEvidenceError("COST_VALUATION_READ_INVALID", "Inventory valuation returned no row contract.");
  if (rows.length > MAX_VALUATION_LOTS) throw new CostEvidenceError("COST_VALUATION_LIMIT", "Inventory valuation exceeds its supported complete-read limit.");
  const lots: ValuationLot[] = rows.map((row: Record<string, unknown>) => ({ ...row,
    id: costInteger(row.id,"lot.id",1), productVariantId: costInteger(row.product_variant_id,"lot.variantId",1),
    quantity: costInteger(row.qty_on_hand,"lot.quantity",1),
    inboundShipmentId: row.inbound_shipment_id == null ? null : costInteger(row.inbound_shipment_id,"lot.inboundShipmentId",1) }));
  const variants = await readInventoryCostDisplay(db,[...new Set(lots.map((lot) => lot.productVariantId))]);
  return valueInventory(lots,variants.map((variant) => ({ variantId: variant.variant_id, productId: variant.product_id,
    sku: variant.sku, productName: variant.product_name, baseSku: variant.base_sku })));
}
