import {
  purchaseCostStatusSchema,
  type PurchaseCostStatus,
} from "@shared/procurement/purchase-cost-status";
import {
  CostEvidenceError,
  type CostEvidenceTransaction,
} from "../inventory/infrastructure/cost-evidence.repository";
import {
  normalizePurchaseCostStatusLineIds,
  readPurchaseCostStatus,
} from "./purchase-cost-status.repository";

export interface PurchaseCostStatusSnapshotReader {
  read(tx: CostEvidenceTransaction, purchaseOrderLineIds: readonly number[]): Promise<PurchaseCostStatus>;
}

interface RetainedStatus {
  key: string;
  value: PurchaseCostStatus;
}
interface PendingStatus {
  key: string;
  token: object;
  value: Promise<PurchaseCostStatus>;
}

/** Create only inside one read-only, repeatable-read health page. Retain at most
 * one exact review set, not all sets in a large page or a cross-request cache.
 * No command/write path uses this reader: a write transaction could change its
 * own evidence even while keeping the same executor object. */
export function createPurchaseCostStatusSnapshotReader(
  snapshotTx: CostEvidenceTransaction,
): PurchaseCostStatusSnapshotReader {
  let retained: RetainedStatus | undefined;
  let pending: PendingStatus | undefined;

  return {
    async read(tx: CostEvidenceTransaction, purchaseOrderLineIds: readonly number[]): Promise<PurchaseCostStatus> {
      let ids: number[];
      try {
        if (tx !== snapshotTx) throw new CostEvidenceError(
          "COST_STATUS_SNAPSHOT_MISMATCH",
          "Supplier cost evidence cannot be reused outside its original read snapshot.",
        );
        ids = normalizePurchaseCostStatusLineIds(purchaseOrderLineIds);
      } catch (error) {
        // A rejected boundary cannot leave a pending result eligible for reuse.
        retained = undefined;
        pending = undefined;
        throw error;
      }
      const key = ids.join(",");
      if (retained?.key === key) return structuredClone(retained.value);
      if (pending?.key === key) return structuredClone(await pending.value);

      retained = undefined;
      pending = undefined;
      const token = {};
      const value = Promise.resolve()
        .then(() => readPurchaseCostStatus(snapshotTx, ids))
        .then(result => {
          const validated = purchaseCostStatusSchema.parse(result);
          const resultIds = validated.lines.map(line => line.purchaseOrderLineId).sort((a, b) => a - b);
          if (resultIds.length !== ids.length || resultIds.some((id, index) => id !== ids[index])) {
            throw new CostEvidenceError("COST_STATUS_SCOPE_MISMATCH",
              "Current supplier cost evidence does not match the requested purchase lines.");
          }
          const snapshot = structuredClone(validated);
          // A slower earlier request may finish after a different set. It may
          // serve its caller, but must never replace that newer retained entry.
          if (pending?.token === token) {
            retained = { key, value: snapshot };
            pending = undefined;
          }
          return snapshot;
        })
        .catch(error => {
          if (pending?.token === token) {
            retained = undefined;
            pending = undefined;
          }
          throw error;
        });
      pending = { key, token, value };
      return structuredClone(await value);
    },
  };
}