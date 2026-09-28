import { z } from "zod";
import { resolveInventoryTrackingPolicy } from "@shared/catalog/inventory-tracking-policy";
import {
  initialPublicationScopeReviewSchema, type InitialPublicationScopeReview, type ReviewInitialPublicationScope,
} from "@shared/types/inventory-publication-initial-scope";
import { inventoryCutoverEvidenceHash } from "./inventory-cutover-manifest";

const id = z.number().int().positive().max(2_147_483_647);
const text = z.string().trim().min(1);
const revision = z.string().regex(/^[1-9]\d*$/);
/** Every current listing source and reviewed bundle exclusion is retained in the review hash. */
export const initialPublicationScopeFactsSchema = z.object({
  authority: z.enum(["legacy", "canonical"]), authorityRevision: revision, frozen: z.boolean(),
  target: z.object({
    id, revision, state: z.enum(["disabled", "preview", "live"]), mode: z.enum(["whole_product", "explicit"]),
    authority: z.enum(["echelon", "external_provider", "manual"]), destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
    channelId: id, channelConnectionId: id.nullable(), dropshipStoreConnectionId: id.nullable(),
    provider: text, providerScopeType: z.enum(["account", "location"]), externalScopeId: text,
  }).strict(),
  existingMemberCount: z.number().int().nonnegative(),
  listings: z.array(z.object({
    sourceKey: text, productVariantId: id, active: z.boolean(), uncertain: z.boolean(), quarantined: z.boolean(),
    externalInventoryItemId: text.nullable(), externalSku: text.nullable(),
  }).strict()),
  ownerIssues: z.array(text),
  ownerEvidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  variants: z.array(z.object({
    id, productId: id, productActive: z.boolean(), variantActive: z.boolean(), requiresShipping: z.boolean(),
    inventoryTrackingDefault: z.boolean(), inventoryTrackingOverride: z.boolean().nullable(), salesEligibility: text,
    mapping: z.object({ id, version: id, definitionHash: z.string().regex(/^[a-f0-9]{64}$/),
      externalInventoryItemId: text, externalSku: text.nullable() }).strict().nullable(),
  }).strict()),
}).strict();
export type InitialPublicationScopeFacts = z.infer<typeof initialPublicationScopeFactsSchema>;

export function reviewInitialPublicationScope(
  input: ReviewInitialPublicationScope, rawFacts: InitialPublicationScopeFacts,
): InitialPublicationScopeReview {
  const facts = initialPublicationScopeFactsSchema.parse(rawFacts);
  const blockers: InitialPublicationScopeReview["blockers"] = [];
  const add = (code: string, message: string, productVariantId: number | null = null): void => {
    if (!blockers.some(row => row.code === code && row.productVariantId === productVariantId)) {
      blockers.push({ code, message, productVariantId });
    }
  };
  if (facts.target.id !== input.publicationTargetId || facts.target.revision !== input.expectedTargetRevision)
    add("INITIAL_SCOPE_TARGET_CHANGED", "The destination changed; review its current revision.");
  if (facts.authority !== "legacy" || facts.frozen)
    add("INITIAL_SCOPE_AUTHORITY_UNAVAILABLE", "Initial scope requires legacy authority without an open cutover freeze.");
  if (facts.target.authority !== "echelon" || facts.target.state !== "preview"
    || facts.target.mode !== "whole_product" || facts.existingMemberCount !== 0)
    add("INITIAL_SCOPE_NOT_PRISTINE", "Only an Echelon-owned whole-product preview destination without membership can be prepared.");
  // These are the existing legacy listing owners traced by the census reader.
  // New Walmart targets are already explicit and use their normal membership
  // workflow; a future provider must not be mistaken for an empty legacy feed.
  if (!["shopify", "ebay"].includes(facts.target.provider))
    add("INITIAL_SCOPE_PROVIDER_UNSUPPORTED", "Initial scope preparation requires a supported legacy Shopify or eBay listing census.");
  if (facts.ownerIssues.length) add("INITIAL_SCOPE_LISTING_OWNER_UNRESOLVED",
    `Resolve incomplete or conflicting listing-owner evidence: ${[...facts.ownerIssues].sort().join(", ")}.`);
  if (new Set(facts.variants.map(row => row.id)).size !== facts.variants.length
    || new Set(facts.listings.map(row => row.sourceKey)).size !== facts.listings.length)
    add("INITIAL_SCOPE_DUPLICATE_EVIDENCE", "The listing census contains duplicate identities.");
  const variants = new Map(facts.variants.map(row => [row.id, row]));
  const exclusions = [...(input.excludedVariants ?? [])].sort((a, b) => a.productVariantId - b.productVariantId);
  const excludedIds = new Set(exclusions.map(row => row.productVariantId));
  for (const excluded of exclusions) {
    if (!facts.listings.some(listing => listing.productVariantId === excluded.productVariantId && listing.active)
      || !variants.has(excluded.productVariantId)) {
      add("INITIAL_SCOPE_EXCLUSION_IDENTITY_MISSING", "A bundle exclusion must identify an existing listed catalog variant in this destination.", excluded.productVariantId);
    }
  }
  const included = new Set<number>();
  const nonStock = new Set<number>();
  for (const listing of [...facts.listings].sort((a, b) => compareText(a.sourceKey, b.sourceKey))) {
    if (!listing.active && !listing.uncertain) continue;
    const variant = variants.get(listing.productVariantId);
    if (!variant) { add("INITIAL_SCOPE_CATALOG_IDENTITY_MISSING", "A listed SKU has no current catalog identity.", listing.productVariantId); continue; }
    if (!resolveInventoryTrackingPolicy(variant)) { nonStock.add(variant.id); continue; }
    if (listing.uncertain) add("INITIAL_SCOPE_LISTING_UNCERTAIN", "A listing operation has an unresolved outcome.", variant.id);
    if (listing.quarantined) add("INITIAL_SCOPE_LISTING_QUARANTINED", "A listed inventory mapping is quarantined.", variant.id);
    // Exclusion is a reviewed operator decision, never an inference from zero
    // stock or an API failure. It changes only outbound membership, not stock,
    // the catalog product, an offer's contents, or the provider listing state.
    if (excludedIds.has(variant.id)) continue;
    included.add(variant.id);
    if (!variant.productActive || !variant.variantActive || variant.salesEligibility !== "sellable")
      add("INITIAL_SCOPE_LISTED_SKU_INELIGIBLE", "A listed inventory SKU is inactive or not customer-sellable.", variant.id);
    const mapping = variant.mapping;
    if (!mapping || !listing.externalInventoryItemId || mapping.externalInventoryItemId !== listing.externalInventoryItemId
      || (listing.externalSku !== null && mapping.externalSku !== listing.externalSku))
      add("INITIAL_SCOPE_MAPPING_UNVERIFIED", "The listed identity does not match the selected exact inventory mapping.", variant.id);
  }
  const stableFacts = { ...facts,
    ownerIssues: [...facts.ownerIssues].sort(),
    ownerEvidenceHashes: [...facts.ownerEvidenceHashes].sort(),
    listings: [...facts.listings].sort((a, b) => compareText(a.sourceKey, b.sourceKey)),
    variants: [...facts.variants].sort((a, b) => a.id - b.id),
  };
  return initialPublicationScopeReviewSchema.parse({
    publicationTargetId: facts.target.id, targetRevision: facts.target.revision, authorityRevision: facts.authorityRevision,
    reviewHash: inventoryCutoverEvidenceHash({ contractVersion: "initial_publication_scope_v2", facts: stableFacts, exclusions }),
    ready: blockers.length === 0, includedVariantIds: [...included].sort((a, b) => a - b),
    excludedNonStockVariantIds: [...nonStock].sort((a, b) => a - b),
    excludedVariants: exclusions,
    blockers: blockers.sort((a, b) => compareText(a.code, b.code) || (a.productVariantId ?? 0) - (b.productVariantId ?? 0)),
    runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
  });
}

// Review identity must not depend on the host locale/ICU version.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
