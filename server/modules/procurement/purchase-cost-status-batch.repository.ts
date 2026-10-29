import { purchaseCostStatusSchema, type PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import { CostEvidenceError, type CostEvidenceTransaction } from "../inventory/infrastructure/cost-evidence.repository";
import { normalizePurchaseCostStatusLineIds, readPurchaseCostStatus } from "./purchase-cost-status.repository";
import type { PurchaseCostStatusSnapshotReader } from "./purchase-cost-status-snapshot.repository";
import { shipmentCostReadPageSchema } from "./shipment-cost-read-scope";

interface Scope { id: number; lineIds: number[] }

/** Reuse the canonical reader inside one caller-owned snapshot. A combined
 * scope may exceed a limit even when its individual shipments are valid. Split
 * only those bounded reads; never relax a limit or return partial evidence.
 * Project each shipment immediately so health scans retain one bounded graph,
 * rather than a full supplier-lot graph for every shipment in the scan. */
export async function visitPurchaseCostStatusScopes(
  tx: CostEvidenceTransaction,
  requested: ReadonlyMap<number, readonly number[]>,
  project: (scopeId: number, status: PurchaseCostStatus) => void,
  snapshot?: PurchaseCostStatusSnapshotReader,
): Promise<void> {
  shipmentCostReadPageSchema.parse([...requested.keys()]);
  // Validate every original scope before any SQL or projection occurs.
  const scopes: Scope[] = [...requested].map(([id, ids]) => ({ id, lineIds: normalizePurchaseCostStatusLineIds(ids) }));
  async function visit(group: Scope[]): Promise<void> {
    if (!group.length) return;
    let combined: PurchaseCostStatus;
    try {
      const ids = normalizePurchaseCostStatusLineIds(group.flatMap(scope => scope.lineIds));
      combined = purchaseCostStatusSchema.parse(snapshot ? await snapshot.read(tx, ids) : await readPurchaseCostStatus(tx, ids));
      const actual = combined.lines.map(line => line.purchaseOrderLineId).sort((a, b) => a - b);
      if (actual.length !== ids.length || actual.some((id, index) => id !== ids[index])) {
        throw new CostEvidenceError("COST_STATUS_SCOPE_MISMATCH", "Current supplier cost evidence does not match the requested purchase lines.");
      }
    } catch (error) {
      const aggregateLimit = error instanceof CostEvidenceError && ["COST_REVIEW_LIMIT", "CREDIT_SOURCE_LIMIT"].includes(error.code);
      if (!aggregateLimit || group.length === 1) throw error;
      const middle = Math.floor(group.length / 2);
      await visit(group.slice(0, middle));
      await visit(group.slice(middle));
      return;
    }
    // Keep projection failures outside the retry catch. A caller's failure must
    // not repeat a projection or be mistaken for an aggregate evidence limit.
    for (const scope of group) {
      const selected = new Set(scope.lineIds);
      project(scope.id, structuredClone({ lines: combined.lines.filter(line => selected.has(line.purchaseOrderLineId)) }));
    }
  }
  await visit(scopes);
}
