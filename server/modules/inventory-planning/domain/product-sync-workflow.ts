import type { InventoryProductSyncReview } from "@shared/types/inventory-product-sync";
import type { ProductSyncLinkScope } from "@shared/types/inventory-product-sync-workflow";

export const PRODUCT_SYNC_WORKFLOW_LIMITS = Object.freeze({
  // A worker performs at most one bounded stock-link pass per claim. Expired
  // leases recover a killed process without resetting provider retry backoff.
  leaseMs: 5 * 60_000, deadlineMs: 30 * 60_000, pollMs: 5_000, retryMs: 30_000,
});
export function missingProductSyncLinks(review: InventoryProductSyncReview): ProductSyncLinkScope {
  const targets = new Map<number, number[]>();
  for (const row of review.rows) {
    if (!row.blockers.includes("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING")) continue;
    const ids = targets.get(row.publicationTargetId) ?? [];
    ids.push(row.productVariantId); targets.set(row.publicationTargetId, ids);
  }
  return { productId: review.productId, targets: [...targets].map(([publicationTargetId, productVariantIds]) =>
    ({ publicationTargetId, productVariantIds })) };
}

export function explainProductSyncLinks(review: InventoryProductSyncReview, checks: readonly ProductSyncLinkCheck[]): InventoryProductSyncReview {
  const byScope = new Map(checks.map(check => [`${check.publicationTargetId}:${check.productVariantId}`, check]));
  return { ...review, rows: review.rows.map(row => {
    const check = byScope.get(`${row.publicationTargetId}:${row.productVariantId}`);
    if (!check?.reasonCode || check.leaseToken !== null) return row;
    return { ...row, blockers: [...new Set([...row.blockers.filter(reason => !reason.startsWith("Last saved stock-link check:")), check.reasonCode])] };
  }) };
}

export interface ProductSyncLinkCheck {
  publicationTargetId: number;
  productVariantId: number;
  status: string | null;
  reasonCode: string | null;
  errorClass: string | null;
  nextCheckAt: Date | null;
  leaseToken: string | null;
  pausedUntil: Date | null;
  available: boolean;
}

/** A fresh definitive refusal settles that destination; a lease, due check,
 * provider outage or exhausted per-pass budget must be allowed to finish. */
export function productSyncLinksPending(checks: readonly ProductSyncLinkCheck[], skippedTargets: readonly number[], now: Date): boolean {
  return checks.some(check => {
    if (!check.available || skippedTargets.includes(check.publicationTargetId)) return false;
    if (check.status === "error" || check.status === "flagged") return false;
    if (check.pausedUntil !== null && check.pausedUntil > now) return true;
    if (check.leaseToken !== null || check.status === null || check.reasonCode === null) return true;
    if (check.errorClass === "transient") return true;
    if (check.reasonCode === "STOCK_LINK_CALL_BUDGET_USED" || check.reasonCode === "STOCK_LINK_FENCE_BUDGET_USED"
      || check.reasonCode === "STOCK_LINK_BUSY") return true;
    return check.nextCheckAt !== null && check.nextCheckAt <= now;
  });
}
