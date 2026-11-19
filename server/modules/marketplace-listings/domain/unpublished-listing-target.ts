import { z } from "zod";
import { compareCanonicalText } from "./canonical-hash";

const key = z.string().trim().min(1).max(255);
const memberSchema = z.object({
  sku: key,
  inventoryItemExists: z.boolean(),
  groupKeys: z.array(key).max(1_000),
  offers: z.array(z.object({
    id: key, sku: key.nullable(), state: z.enum(["published", "unpublished"]), hasListing: z.boolean(),
  }).strict()).max(10_000),
}).strict();
const inputSchema = z.object({
  members: z.array(memberSchema).min(1).max(10_000),
  requiresGroup: z.boolean(),
  plannedGroupKey: key.nullable().optional(),
}).strict();

export class UnpublishedListingTargetError extends Error {
  constructor(readonly code: "GROUP_REQUIRED" | "GROUP_CHANGED" | "GROUP_MEMBERSHIP_MISMATCH" | "MEMBER_IDENTITY_DUPLICATE",
    message: string, readonly groupKey: string | null = null) { super(message); this.name = "UnpublishedListingTargetError"; }
}

export interface UnpublishedListingTarget {
  readonly groupKey: string | null;
  readonly skus: readonly string[];
  readonly allowMissingGroup: boolean;
}

/** Shared publication policy over validated provider facts. A planned key is a
 * candidate resource to check, never proof that the channel owns that group.
 * The execution owner must persist the target and check canonical ownership
 * before writes; only published readback can establish a completed listing. */
export function planUnpublishedListingTarget(input: z.input<typeof inputSchema>): UnpublishedListingTarget | null {
  const { members, requiresGroup, plannedGroupKey } = inputSchema.parse(input);
  const preparing = plannedGroupKey !== undefined;
  const skus = members.map(member => member.sku).sort(compareCanonicalText);
  const offerIds = members.flatMap(member => member.offers.map(offer => offer.id));
  if (new Set(skus).size !== skus.length || new Set(offerIds).size !== offerIds.length)
    throw new UnpublishedListingTargetError("MEMBER_IDENTITY_DUPLICATE", "The channel returned the same SKU or offer for more than one selected variant.");
  if (!members.every(member => (preparing || member.inventoryItemExists)
    && (member.offers.length === 0 ? preparing : member.offers.length === 1
      && member.offers[0].state === "unpublished" && member.offers[0].sku === member.sku && !member.offers[0].hasListing))) return null;

  const groups = [...new Set(members.flatMap(member => member.groupKeys))];
  // Grouping is a provider capability, not a shared assumption that every
  // channel needs eBay's explicit inventory-item group for several variants.
  if (!requiresGroup && groups.length === 0) {
    if (plannedGroupKey) throw new UnpublishedListingTargetError("GROUP_CHANGED", "The saved listing group is no longer attached to its variant.");
    return { groupKey: null, skus, allowMissingGroup: false };
  }
  if (groups.length > 1 || (!preparing && (groups.length !== 1 || members.some(member => member.groupKeys.length !== 1)))
    || (groups.length === 0 && !plannedGroupKey))
    throw new UnpublishedListingTargetError("GROUP_REQUIRED", "The selected unpublished variants do not identify one complete listing group.");
  const groupKey = groups[0] ?? plannedGroupKey!;
  if (preparing && groupKey !== plannedGroupKey)
    throw new UnpublishedListingTargetError("GROUP_CHANGED", "The variants belong to a different group than the saved publication target.", groupKey);
  return { groupKey, skus, allowMissingGroup: preparing && groups.length === 0 };
}

/** A missing group may be created only after an authoritative absence read.
 * An existing group must contain exactly these variants, including on retry. */
export function assertUnpublishedListingGroup(target: UnpublishedListingTarget, observedSkus: readonly string[] | null): void {
  if (observedSkus === null && target.allowMissingGroup) return;
  const actual = observedSkus === null ? [] : z.array(key).min(1).max(10_000).parse(observedSkus).sort(compareCanonicalText);
  if (actual.length !== target.skus.length || target.skus.some((sku, index) => sku !== actual[index]))
    throw new UnpublishedListingTargetError("GROUP_MEMBERSHIP_MISMATCH", "The channel group contains different variants. Review its complete SKU membership before publishing.");
}
