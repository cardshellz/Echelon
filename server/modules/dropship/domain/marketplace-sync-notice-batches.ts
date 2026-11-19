import type { MarketplaceSyncNoticeKind } from "./marketplace-sync-decision";
import { marketplaceNoticeBatchKey } from "./marketplace-sync-keys";

/**
 * How written notices become notifications (plan v4 §6.6): every row is sent
 * on the tick that claims it, grouped per store and kind (there is no digest,
 * owner rule 7). A batch's key carries its id range, so a row that commits
 * after a batch was claimed gets a batch of its own and is never folded into
 * one already sent under the same key.
 */

export interface UnclaimedMarketplaceSyncNotice {
  id: number;
  storeConnectionId: number;
  kind: MarketplaceSyncNoticeKind;
}

export interface MarketplaceSyncNoticeBatchPlan {
  batchKey: string;
  storeConnectionId: number;
  kind: MarketplaceSyncNoticeKind;
  noticeIds: number[];
}

/** Groups unclaimed rows into one batch per store and kind, oldest batch first. */
export function planMarketplaceSyncNoticeBatches(rows: readonly UnclaimedMarketplaceSyncNotice[]): MarketplaceSyncNoticeBatchPlan[] {
  const groups = new Map<string, { storeConnectionId: number; kind: MarketplaceSyncNoticeKind; ids: number[] }>();
  for (const row of rows) {
    const group = `${row.storeConnectionId}|${row.kind}`;
    const entry = groups.get(group) ?? { storeConnectionId: row.storeConnectionId, kind: row.kind, ids: [] };
    entry.ids.push(row.id);
    groups.set(group, entry);
  }
  return [...groups.values()].map((group) => {
    const ids = [...group.ids].sort((left, right) => left - right);
    return {
      batchKey: marketplaceNoticeBatchKey({ kind: group.kind, storeConnectionId: group.storeConnectionId,
        minNoticeId: ids[0]!, maxNoticeId: ids[ids.length - 1]! }),
      storeConnectionId: group.storeConnectionId, kind: group.kind, noticeIds: ids,
    };
  }).sort((left, right) => left.noticeIds[0]! - right.noticeIds[0]!);
}
