import type { Pool } from "pg";
import { z } from "zod";
import { stockLinkCommandKey } from "../domain/stock-link";
import { InventoryPublicationMembershipError } from "../application/inventory-publication-membership.service";
import { InventoryPublicationSelectionError } from "./inventory-publication-selection.reader";
import { ensureEbayPublicationReady } from "./ebay-publication-readiness.repository";

/**
 * The Card Shellz eBay stock link (channels PR4, PLAN-CH-v3 §2 policy table `channel_connection:ebay`, §5): the eBay
 * link is the SKU, written by the existing eBay publication readiness owner (ensureEbayPublicationReady: its review,
 * receipt, fence, exact-SKU draft writer and sealer, audit), never by a new writer. Two callers:
 * - the stock-link engine's background pass for already-live listings (origin `background`, purpose `sync`, so a
 *   removed size links at 0);
 * - the listing update and rebuild hooks before their first eBay mutation (origin `listing_update` /
 *   `listing_rebuild`, purpose `publish`; ebay-listing-stock-link-hook.ts).
 * Its command key is a UUIDv5 under the engine's `channel_connection:ebay` namespace (stockLinkCommandKey), so a replay
 * of the same evidence reuses its receipt and new evidence is a new command. A refusal the readiness owner classifies
 * (membership / selection errors) is returned `blocked` with its code; anything else is thrown for the caller to
 * classify. No provider I/O.
 */

const id = z.number().int().positive().max(2_147_483_647);
const linkInputSchema = z.object({
  publicationTargetId: id, channelId: id, connectionId: id, accountId: z.string().trim().min(1).max(255),
  environment: z.enum(["production", "sandbox"]), productId: id, purpose: z.enum(["publish", "sync"]),
  variants: z.array(z.object({ productVariantId: id, sku: z.string().trim().min(1).max(100) }).strict()).min(1).max(500),
  origin: z.object({ kind: z.enum(["background", "listing_update", "listing_rebuild"]), key: z.string().min(1).max(500) }).strict(),
  actor: z.string().trim().min(1).max(100),
}).strict();

export type ChannelEbayStockLinkInput = z.input<typeof linkInputSchema>;

export type ChannelEbayStockLinkResult =
  | { status: "ready"; commandKey: string; alreadyLinked: boolean; fenceHoldMs: number | null }
  | { status: "blocked"; commandKey: string; blockers: { code: string; message: string }[] };

export function channelEbayStockLinkCommandKey(input: { publicationTargetId: number; originKind: string; originKey: string }): string {
  return stockLinkCommandKey({ destinationKind: "channel_connection", providerKey: "ebay", publicationTargetId: input.publicationTargetId,
    originKind: input.originKind, originKey: input.originKey });
}

export async function linkChannelEbayStock(pool: Pick<Pool, "connect">, raw: ChannelEbayStockLinkInput,
  deps: { now: Date; monotonicNow: () => number }): Promise<ChannelEbayStockLinkResult> {
  const input = linkInputSchema.parse(raw);
  const commandKey = channelEbayStockLinkCommandKey({ publicationTargetId: input.publicationTargetId,
    originKind: input.origin.kind, originKey: input.origin.key });
  const startedAt = deps.monotonicNow();
  try {
    const ready = await ensureEbayPublicationReady(pool, { channelId: input.channelId, connectionId: input.connectionId,
      accountId: input.accountId, environment: input.environment, productId: input.productId, purpose: input.purpose,
      variants: input.variants }, { commandKey, actor: input.actor, now: deps.now });
    // The readiness owner reports no fence hold; its whole duration bounds it (the engine's fence budget counts it).
    return { status: "ready", commandKey, alreadyLinked: ready.alreadyReady,
      fenceHoldMs: ready.alreadyReady ? null : Math.max(0, Math.round(deps.monotonicNow() - startedAt)) };
  } catch (error) {
    if (error instanceof InventoryPublicationMembershipError || error instanceof InventoryPublicationSelectionError)
      return { status: "blocked", commandKey, blockers: [{ code: error.code, message: error.message }] };
    throw error;
  }
}
