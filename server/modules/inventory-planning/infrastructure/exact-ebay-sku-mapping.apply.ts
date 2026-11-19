import type { PoolClient } from "pg";
import type { PublicationMappingPreparationReceipt } from "@shared/types/inventory-publication-mapping-preparation";
import type { EbayPublicationMappingRow } from "../domain/ebay-publication-readiness";
import type { MappingPreparationTarget } from "./publication-mapping-preparation.repository";
import {
  applyExactStockIdentityInsideTransaction, type ExactStockIdentityMember, type MappingPreparationReview,
} from "./exact-stock-identity.apply";

export type { MappingPreparationReview } from "./exact-stock-identity.apply";

export interface ExactEbaySkuMappingApplyInput {
  target: MappingPreparationTarget;
  /** The reviewed members and the action the capture decided for each. */
  variants: ReadonlyArray<{ productVariantId: number; sku: string; mappingAction: "none" | "promote_draft" | "create" }>;
  /** Mapping rows read by the same locked capture (one per member). */
  rows: readonly EbayPublicationMappingRow[];
  productId: number;
  allowRetainedZero: boolean;
  /** Emit publication only for the reviewed members (single-variant listings). */
  exactVariantScope: boolean;
  verifiedListingScopeHash?: string;
  /** Namespaces every draft and preparation idempotency key. */
  idempotencyPrefix: string;
  commandKey: string;
  requestHash: string;
  actor: string;
  now: Date;
  changeReason: string;
  /** Runs after the drafts are sealed and before the canonical quantity review;
   * it must throw (rolling everything back) if the promoted state is not usable. */
  afterPromotion: (client: PoolClient) => Promise<void>;
  /** Optional typed refusal when the post-promotion review is not ready.
   * Without it, applyMappingPreparation refuses with STOCK_MAPPING_NOT_READY. */
  assertReviewReady?: (review: MappingPreparationReview) => void;
}

/**
 * The exact eBay SKU stock link, shared by the channel readiness writer and the Dropship store readiness writer.
 * Since channels PR2 (PLAN-CH2 v4.1 §4.1) it is a thin wrapper over the generalised exact-identity core
 * (exact-stock-identity.apply.ts): an eBay member's provider item is its SKU, and its draft is the capture's mapping
 * row. The keys, statements and their order are unchanged (Dropship goldens and PG 29 pin them;
 * IP/__tests__/unit/dropship-ebay-stock-keys.golden.test.ts, dropship-ebay-stock-command-lock.integration.test.ts).
 * The caller owns the transaction, the inventory cutover fence, its command lock and its own receipt; no provider
 * I/O happens here.
 */
export async function applyExactEbaySkuMappingsInsideTransaction(client: PoolClient, scopeKeys: string[],
  input: ExactEbaySkuMappingApplyInput): Promise<PublicationMappingPreparationReceipt> {
  const { variants, rows, ...shared } = input;
  return applyExactStockIdentityInsideTransaction(client, scopeKeys, { ...shared, members: variants.map(variant => {
    const row = rows.find(candidate => candidate.id === variant.productVariantId)!;
    return ebayMember(variant, row);
  }) });
}

function ebayMember(variant: ExactEbaySkuMappingApplyInput["variants"][number], row: EbayPublicationMappingRow):
  ExactStockIdentityMember {
  if (variant.mappingAction === "create") return { productVariantId: variant.productVariantId, mappingAction: "create",
    externalInventoryItemId: variant.sku, externalSku: variant.sku, expectedHeadRevision: row.head_revision ?? "0" };
  if (variant.mappingAction === "promote_draft") return { productVariantId: variant.productVariantId,
    mappingAction: "promote_draft", draft: { mappingId: row.mapping_id!, definitionHash: row.mapping_hash! } };
  return { productVariantId: variant.productVariantId, mappingAction: "none" };
}
