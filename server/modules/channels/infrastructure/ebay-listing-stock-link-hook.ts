import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { EbayListingSyncError } from "../ebay-listing-sync.domain";
import type { ChannelEbayStockLinkInput, ChannelEbayStockLinkResult } from "../../inventory-planning/quantity-publication";

/**
 * The Card Shellz eBay update and rebuild hooks (channels PR4, PLAN-CH-v3 §5 "Edit / rebuild / relist"): before a
 * reviewed in-place update or rebuild sends anything to eBay, every size it would give a positive quantity that has no
 * stock link yet is linked first, through the eBay readiness owner (linkChannelEbayStock, origin listing_update /
 * listing_rebuild). The listing change itself writes offer quantities, so this is the first positive write.
 * - Only unlinked sizes with ATP > 0 are linked; a size on hold, already linked, or at 0 never blocks the change (a
 *   price update with a held size goes through).
 * - It runs before the draft is prepared and before the connector is called, so a refused hook throws before any eBay
 *   call at all (zero eBay mutations, including the rebuild's early return for an already-published replacement).
 * - Its command key is a UUIDv5 of the reviewed change (listing id, review token, linked sizes): a retry of the same
 *   review replays its receipt; a new review is a new command.
 */

export type EbayListingStockLinkKind = "listing_update" | "listing_rebuild";

export interface EbayListingStockLinkHookInput {
  readonly kind: EbayListingStockLinkKind;
  readonly channelId: number;
  readonly connectionId: number;
  readonly accountId: string;
  readonly environment: "production" | "sandbox";
  readonly productId: number;
  readonly listingId: string;
  /** The reviewed change's confirmation token (its preview): binds the command to this review. */
  readonly reviewToken: string;
  /** Every size the change will carry, with the eBay SKU it writes and its current ATP units. */
  readonly variants: readonly { readonly productVariantId: number; readonly sku: string; readonly atpUnits: number }[];
  readonly actor: string;
}

export interface EbayListingStockLinkHookDeps {
  /** IP readEbayStockLinkGaps bound to the pool: the account's live eBay destination and the sizes it has no link for. */
  readonly readGaps: (input: { channelId: number; connectionId: number; accountId: string;
    variants: { productVariantId: number; sku: string }[] }) => Promise<{ publicationTargetId: number | null; productVariantIds: number[] }>;
  /** IP linkChannelEbayStock bound to the pool and the clock. */
  readonly link: (input: ChannelEbayStockLinkInput) => Promise<ChannelEbayStockLinkResult>;
}

/** Resolves when nothing needs a link or every needed link is ready; throws EbayListingSyncError otherwise. */
export async function linkEbayListingStockBeforeChange(input: EbayListingStockLinkHookInput,
  deps: EbayListingStockLinkHookDeps): Promise<void> {
  const positive = input.variants.filter(variant => Number.isSafeInteger(variant.atpUnits) && variant.atpUnits > 0
    && variant.sku.trim().length > 0).map(variant => ({ productVariantId: variant.productVariantId, sku: variant.sku.trim() }));
  if (positive.length === 0) return;
  const gaps = await deps.readGaps({ channelId: input.channelId, connectionId: input.connectionId, accountId: input.accountId,
    variants: positive });
  if (gaps.publicationTargetId === null || gaps.productVariantIds.length === 0) return;
  const members = positive.filter(variant => gaps.productVariantIds.includes(variant.productVariantId))
    .sort((a, b) => a.productVariantId - b.productVariantId);
  if (members.length === 0) return;
  const originKey = createHash("sha256").update(canonicalJson({ listingId: input.listingId, reviewToken: input.reviewToken,
    members })).digest("hex");
  const result = await deps.link({ publicationTargetId: gaps.publicationTargetId, channelId: input.channelId,
    connectionId: input.connectionId, accountId: input.accountId, environment: input.environment, productId: input.productId,
    purpose: "publish", variants: members, origin: { kind: input.kind, key: originKey }, actor: input.actor });
  if (result.status === "blocked") {
    const blocker = result.blockers[0];
    throw new EbayListingSyncError(blocker?.code ?? "EBAY_LISTING_STOCK_LINK_REFUSED",
      `Stock could not be linked for the new eBay sizes before this listing change; nothing was sent to eBay. ${blocker?.message ?? ""}`.trim());
  }
}
