import { eq, sql } from "drizzle-orm";
import { products, productVariants, channelFeeds } from "@shared/schema";
import type { InsertProductVariant, ProductVariant } from "@shared/schema";
import { parseInventoryTrackingWrite, resolveInventoryTrackingPolicy } from "@shared/catalog/inventory-tracking-policy";
import { persistAuditEvent } from "../../infrastructure/auditLogger";
import type { db } from "../../db";

type Transaction = Pick<typeof db, "select" | "update" | "insert" | "execute">;

export class InventoryTrackingPolicyError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) {
    super(message);
    this.name = "InventoryTrackingPolicyError";
  }
}

async function lockProduct(tx: Transaction, productId: number) {
  const [product] = await tx.select().from(products).where(eq(products.id, productId)).for("update");
  if (!product) throw new InventoryTrackingPolicyError("CATALOG_PRODUCT_MISSING", "Product does not exist", 404);
  return product;
}

/** Policy changes cannot discard stock, reservations, picks, or pending publication work. */
async function assertTransitionAllowed(tx: Transaction, variant: ProductVariant, next: boolean): Promise<void> {
  if ((variant.trackInventory !== false) === next) return;
  // These locks also serialize changes with existing level and claim mutations.
  await tx.execute(sql`SELECT id FROM inventory.inventory_levels
    WHERE product_variant_id = ${variant.id} ORDER BY id FOR UPDATE`);
  const result = await tx.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM inventory.inventory_levels WHERE product_variant_id = ${variant.id}
        AND (variant_qty <> 0 OR reserved_qty <> 0 OR picked_qty <> 0 OR packed_qty <> 0 OR backorder_qty <> 0)) AS stock,
      EXISTS (SELECT 1 FROM inventory.inventory_lots WHERE product_variant_id = ${variant.id}
        AND (qty_on_hand <> 0 OR qty_reserved <> 0)) AS lots,
      EXISTS (SELECT 1 FROM inventory.availability_claim_lines
        WHERE target_variant_id = ${variant.id} AND planned_qty > released_target_qty + consumed_target_qty) AS claims,
      EXISTS (SELECT 1 FROM inventory.availability_claim_resources
        WHERE source_variant_id = ${variant.id} AND claimed_qty > released_qty + consumed_qty) AS resources,
      EXISTS (SELECT 1 FROM wms.order_items item JOIN wms.orders customer_order ON customer_order.id = item.order_id
        WHERE (item.product_id = ${variant.id} OR (item.product_id IS NULL AND item.sku = ${variant.sku}))
          AND customer_order.warehouse_status NOT IN ('shipped', 'completed', 'cancelled', 'voided')
          AND item.status <> 'cancelled' AND item.fulfilled_quantity < item.quantity) AS open_orders,
      EXISTS (SELECT 1 FROM oms.oms_order_lines line JOIN oms.oms_orders customer_order ON customer_order.id = line.order_id
        WHERE line.product_variant_id = ${variant.id}
          AND customer_order.status NOT IN ('shipped', 'delivered', 'cancelled', 'refunded')) AS oms_orders,
      EXISTS (SELECT 1 FROM inventory.inventory_publication_outbox
        WHERE product_variant_id = ${variant.id}
          AND state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled')) AS publication
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Inventory policy dependency query returned no row");
  const blockers = Object.entries(row).filter(([, present]) => present === true).map(([name]) => name);
  if (blockers.length > 0) throw new InventoryTrackingPolicyError(
    "INVENTORY_POLICY_HAS_DEPENDENCIES",
    `Variant ${variant.id} cannot change inventory tracking while it has: ${blockers.join(", ")}`,
  );
}

async function projectVariant(tx: Transaction, variant: ProductVariant, next: boolean, now: Date): Promise<void> {
  if ((variant.trackInventory !== false) === next) return;
  await assertTransitionAllowed(tx, variant, next);
  await tx.update(productVariants).set({ trackInventory: next, updatedAt: now }).where(eq(productVariants.id, variant.id));
  if (!next) await tx.update(channelFeeds).set({ isActive: 0, updatedAt: now }).where(eq(channelFeeds.productVariantId, variant.id));
}

export async function updateProductInventoryTracking(
  tx: Transaction, productId: number, next: boolean, actor: string, now: Date,
): Promise<void> {
  if (typeof next !== "boolean") throw new InventoryTrackingPolicyError("INVENTORY_POLICY_INVALID", "Product inventory tracking must be a boolean", 400);
  const product = await lockProduct(tx, productId);
  if (product.inventoryTrackingDefault === next) return;
  const variants = await tx.select().from(productVariants).where(eq(productVariants.productId, productId))
    .orderBy(productVariants.id).for("update");
  for (const variant of variants) {
    const effective = resolveInventoryTrackingPolicy({ inventoryTrackingDefault: next,
      inventoryTrackingOverride: variant.inventoryTrackingOverride, requiresShipping: variant.requiresShipping });
    await projectVariant(tx, variant, effective, now);
  }
  await tx.update(products).set({ inventoryTrackingDefault: next, updatedAt: now }).where(eq(products.id, productId));
  await persistAuditEvent(tx, { actor, action: "catalog.inventory_tracking_default.changed", target: `product:${productId}`,
    changes: { before: { inventoryTrackingDefault: product.inventoryTrackingDefault }, after: { inventoryTrackingDefault: next } },
    context: { variantIds: variants.filter(v => v.inventoryTrackingOverride === null).map(v => v.id) },
  }, { timestamp: now });
}

export async function prepareVariantInventoryTracking(
  tx: Transaction, input: Partial<InsertProductVariant> & { productId: number }, existingId?: number,
): Promise<Partial<InsertProductVariant>> {
  const product = await lockProduct(tx, input.productId);
  const [existing] = existingId === undefined ? [] : await tx.select().from(productVariants)
    .where(eq(productVariants.id, existingId)).for("update");
  if (existingId !== undefined && (!existing || existing.productId !== input.productId)) {
    throw new InventoryTrackingPolicyError("CATALOG_VARIANT_IDENTITY_CHANGED", "Variant identity changed during the policy update");
  }
  let policyWrite: ReturnType<typeof parseInventoryTrackingWrite>;
  try { policyWrite = parseInventoryTrackingWrite(input); }
  catch (error) { throw new InventoryTrackingPolicyError("INVENTORY_POLICY_INVALID", error instanceof Error ? error.message : "Invalid inventory tracking policy", 400); }
  const override = policyWrite.inventoryTrackingOverride !== undefined
    ? policyWrite.inventoryTrackingOverride : existing?.inventoryTrackingOverride ?? null;
  const requiresShipping = input.requiresShipping ?? existing?.requiresShipping ?? true;
  const trackInventory = resolveInventoryTrackingPolicy({ inventoryTrackingDefault: product.inventoryTrackingDefault,
    inventoryTrackingOverride: override, requiresShipping });
  if (existing) await assertTransitionAllowed(tx, existing, trackInventory);
  return { inventoryTrackingOverride: override, trackInventory, requiresShipping };
}
