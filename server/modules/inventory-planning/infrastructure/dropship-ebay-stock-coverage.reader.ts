import type { Pool } from "pg";
import { z } from "zod";
import { dropshipEbayStockDestinationSchema, type DropshipEbayStockDestination } from "@shared/types/dropship-ebay-stock-readiness";
import { PublicationMappingPreparationStore, readTargets } from "./publication-mapping-preparation.repository";

const inputSchema = z.object({
  storeConnectionId: z.number().int().positive().max(2_147_483_647),
  accountId: z.string().trim().min(1).max(240),
}).strict();

/**
 * Store-level status of a Dropship eBay store account's Card Shellz stock
 * destination: the same destination choice the stock link makes
 * (dropship-ebay-stock-readiness.read.ts). Read-only (REPEATABLE READ, no locks
 * beyond the snapshot); for operations health and the listing preview.
 *   live              exactly one live Echelon destination, not held, source ready
 *   held              that destination is on hold
 *   source_not_ready  that destination has no sealed, active supply binding
 *   not_live          configured destination(s), none live
 *   duplicated        more than one live destination for the account
 *   missing           no destination for the account
 */
export async function readDropshipEbayStockDestination(pool: Pick<Pool, "connect">,
  raw: { storeConnectionId: number; accountId: string }): Promise<DropshipEbayStockDestination> {
  const input = inputSchema.parse(raw);
  const candidates = (await new PublicationMappingPreparationStore(pool).transaction(false,
    client => readTargets(client, undefined, undefined, undefined, false, input.storeConnectionId)))
    .filter(row => row.destination_kind === "dropship_store_connection" && row.provider_key === "ebay"
      && row.provider_scope_type === "account" && row.external_scope_id === input.accountId);
  const live = candidates.filter(row => row.state === "live" && row.publication_authority === "echelon");
  const base = { storeConnectionId: input.storeConnectionId, accountId: input.accountId, liveTargetCount: live.length };
  if (live.length === 1) {
    const target = live[0]!;
    return dropshipEbayStockDestinationSchema.parse({ ...base, publicationTargetId: target.id, targetRevision: target.revision,
      heldAt: target.held_at, status: target.held_at ? "held" : target.source_ready ? "live" : "source_not_ready" });
  }
  const single = live.length === 0 && candidates.length === 1 ? candidates[0]! : null;
  return dropshipEbayStockDestinationSchema.parse({ ...base, publicationTargetId: single?.id ?? null,
    targetRevision: single?.revision ?? null, heldAt: single?.held_at ?? null,
    status: live.length > 1 ? "duplicated" : candidates.length === 0 ? "missing" : "not_live" });
}
