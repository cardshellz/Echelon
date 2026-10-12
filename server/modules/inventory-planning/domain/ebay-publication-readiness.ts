import { z } from "zod";
import type { PublicationMembershipBlocker } from "@shared/types/inventory-publication-membership";
import type { InventoryEbayPublicationReadinessInput } from "@shared/types/ebay-publication-readiness";
import { calculatePublicationVariantMappingDefinitionHash } from "./inventory-channel-exposure";

const id = z.number().int().positive();
export const ebayPublicationMappingRowSchema = z.object({
  id, product_id: id, sku: z.string().min(1), external_sku: z.string().min(1).nullable(), eligible: z.boolean(),
  active_mapping_id: id.nullable(), draft_mapping_id: id.nullable(), head_revision: z.string().regex(/^[1-9][0-9]*$/).nullable(),
  active_inventory_id: z.string().min(1).nullable(), active_sku: z.string().min(1).nullable(),
  mapping_id: id.nullable(), mapping_version: id.nullable(), mapping_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  mapping_inventory_id: z.string().min(1).nullable(), mapping_sku: z.string().min(1).nullable(), mapping_status: z.string().nullable(),
  held_at: z.date().nullable(), conflicts: z.array(id),
}).strict();
export type EbayPublicationMappingRow = z.infer<typeof ebayPublicationMappingRowSchema>;

/** Existing holds/differing drafts are decisions to preserve. A new
 * mapping is a proposed exact SKU identity, never a fabricated provider item. */
export function reviewEbayPublicationMember(source: Pick<InventoryEbayPublicationReadinessInput, "productId">,
  input: InventoryEbayPublicationReadinessInput["variants"][number], targetId: number | null,
  matches: readonly EbayPublicationMappingRow[]) {
  const row = matches.length === 1 ? matches[0] : undefined;
  const blockers: PublicationMembershipBlocker[] = [];
  const block = (code: string, message: string, action: PublicationMembershipBlocker["action"] = "review_mapping") =>
    blockers.push({ code, message, action, productVariantId: input.productVariantId });
  if (!row || row.product_id !== source.productId || (row.external_sku ?? row.sku) !== input.sku || !row.eligible)
    block("STOCK_LISTING_SOURCE_CHANGED", "The catalog variant or its exact eBay SKU changed. Review the product mapping again.", "review_variant");
  if (row?.held_at) block("STOCK_LISTING_HELD", "This SKU's stock is on hold. Review the hold before publishing.", "configure_inventory");
  if (row?.conflicts.length) block("STOCK_LISTING_MAPPING_CONFLICT", `This eBay SKU is already mapped to catalog variant ${row.conflicts.join(", ")}. Review both mappings.`);
  const mappingAction = row?.mapping_id == null ? "create" as const : row.draft_mapping_id !== null ? "promote_draft" as const : "none" as const;
  if (row?.active_mapping_id != null && (row.active_inventory_id !== input.sku || row.active_sku !== input.sku)) {
    block("STOCK_LISTING_MAPPING_REVIEW_REQUIRED", "An active inventory mapping owns a different provider SKU. Resolve that existing stock identity before enrolling a replacement.");
  }
  if (row?.mapping_id != null && (targetId === null || row.mapping_inventory_id !== input.sku || row.mapping_sku !== input.sku
    || row.mapping_status !== (mappingAction === "promote_draft" ? "draft" : "sealed")
    || row.mapping_hash !== calculatePublicationVariantMappingDefinitionHash({ publicationTargetId: targetId,
      productVariantId: input.productVariantId, externalInventoryItemId: input.sku, externalSku: input.sku }))) {
    block("STOCK_LISTING_MAPPING_REVIEW_REQUIRED", "An existing inventory mapping or saved draft differs from this exact eBay SKU. It will not be overwritten.");
  }
  return { blockers, variant: { ...input, mappingAction, desiredQuantity: null as string | null } };
}
