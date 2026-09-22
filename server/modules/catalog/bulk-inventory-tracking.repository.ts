import { inArray } from "drizzle-orm";
import { products } from "@shared/schema";
import type { db } from "../../db";
import { inspectProductInventoryTracking } from "./inventory-tracking-policy.repository";
import type { BulkInventoryTrackingSelection } from "./bulk-inventory-tracking.domain";
import { loadInventoryTrackingEvidence } from "./inventory-tracking-evidence.repository";

export type InventoryTrackingTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function loadBulkInventoryTrackingSelection(
  tx: InventoryTrackingTransaction, productIds: readonly number[], next: boolean,
): Promise<BulkInventoryTrackingSelection> {
  // Lock every parent in ID order before acquiring variant/stock locks. Reuse
  // the single-product owner's checks; new variants cannot join during apply.
  const locked = await tx.select({ id: products.id }).from(products)
    .where(inArray(products.id, [...productIds])).orderBy(products.id).for("update");
  const existing = new Set(locked.map(product => product.id));
  const result: BulkInventoryTrackingSelection = [];
  for (const productId of [...productIds].sort((a, b) => a - b)) {
    result.push({ productId, snapshot: existing.has(productId)
      ? await inspectProductInventoryTracking(tx, productId, next) : null });
  }
  const evidence = await loadInventoryTrackingEvidence(tx, result.flatMap(({ snapshot }) =>
    snapshot?.transitions.map(t => ({ variantId: t.variant.id, blockers: t.blockers })) ?? []));
  return result.map(entry => ({ ...entry, snapshot: entry.snapshot ? { ...entry.snapshot,
    transitions: entry.snapshot.transitions.map(t => ({ ...t, evidence: evidence.get(t.variant.id) ?? {} })),
  } : null }));
}
