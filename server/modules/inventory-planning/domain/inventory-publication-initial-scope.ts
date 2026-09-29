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
    listingStatus: text.optional(),
    externalInventoryItemId: text.nullable(), externalSku: text.nullable(),
  }).strict()),
  ownerIssues: z.array(text),
  ownerEvidenceHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  mappingOwners: z.array(z.object({ productVariantId: id, externalInventoryItemId: text }).strict()),
  variants: z.array(z.object({
    id, productId: id, productActive: z.boolean(), variantActive: z.boolean(), requiresShipping: z.boolean(),
    inventoryTrackingDefault: z.boolean(), inventoryTrackingOverride: z.boolean().nullable(), salesEligibility: text,
    mappingHistoryCount: z.number().int().nonnegative(),
    mappingHeadExists: z.boolean(),
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
  const exclusions: NonNullable<InitialPublicationScopeReview["excludedVariants"]> = [...(input.excludedVariants ?? [])];
  const excludedIds = new Set(exclusions.map(row => row.productVariantId));
  for (const excluded of exclusions) {
    if (!facts.listings.some(listing => listing.productVariantId === excluded.productVariantId && listing.active)
      || !variants.has(excluded.productVariantId)) {
      add("INITIAL_SCOPE_EXCLUSION_IDENTITY_MISSING", "A bundle exclusion must identify an existing listed catalog variant in this destination.", excluded.productVariantId);
    }
  }
  const included = new Set<number>();
  const deferred = new Set<number>();
  const nonStock = new Set<number>();
  const mappingImports: NonNullable<InitialPublicationScopeReview["mappingImports"]> = [];
  const identityOwners = new Map<string, number>();
  for (const owner of facts.mappingOwners) identityOwners.set(owner.externalInventoryItemId, owner.productVariantId);
  const listingsByVariant = new Map<number, InitialPublicationScopeFacts["listings"]>();
  for (const listing of facts.listings) {
    if (!listing.active && !listing.uncertain) continue;
    const current = listingsByVariant.get(listing.productVariantId) ?? [];
    current.push(listing);
    listingsByVariant.set(listing.productVariantId, current);
  }
  for (const [variantId, currentListings] of [...listingsByVariant.entries()].sort(([a], [b]) => a - b)) {
    const listings = [...currentListings].sort((a, b) => compareText(a.sourceKey, b.sourceKey));
    const variant = variants.get(variantId);
    if (!variant) { add("INITIAL_SCOPE_CATALOG_IDENTITY_MISSING", "A listed SKU has no current catalog identity.", variantId); continue; }
    if (!resolveInventoryTrackingPolicy(variant)) { nonStock.add(variant.id); continue; }
    // A failed listing is not an initial stock-publication obligation. Retain it
    // in the evidence hash, but do not invent an inventory identity or persist
    // an explicit exclusion that would prevent later membership enrollment.
    // A registered/active owner, quarantine or in-flight operation still wins.
    if (facts.target.destinationKind === "dropship_store_connection"
      && listings.every(row => row.sourceKey.startsWith("dropship-listing:")
        && row.listingStatus === "failed" && !row.active && !row.quarantined)) {
      deferred.add(variant.id);
      continue;
    }
    if (listings.some(row => row.uncertain)) add("INITIAL_SCOPE_LISTING_UNCERTAIN", "A listing operation has an unresolved outcome.", variant.id);
    if (excludedIds.has(variant.id)) {
      if (listings.some(row => row.quarantined)) add("INITIAL_SCOPE_LISTING_QUARANTINED", "A listed inventory mapping is quarantined.", variant.id);
      continue;
    }
    // Preserve skips the existing publisher already applies. These decisions
    // are derived, displayed and sealed in the review, not caller-selectable
    // exclusions or permission to clear quarantine, relink, or publish zero.
    const skipReason = existingPublisherSkipReason(variant, listings, facts.target.provider);
    if (skipReason) { exclusions.push({ productVariantId: variant.id, reason: skipReason }); continue; }
    if (listings.some(row => row.quarantined)) add("INITIAL_SCOPE_LISTING_QUARANTINED", "A listed inventory mapping is quarantined.", variant.id);
    included.add(variant.id);
    const identity = listings[0]!;
    const knownSkus = [...new Set(listings.map(row => row.externalSku).filter((sku): sku is string => sku !== null))];
    if (!identity.externalInventoryItemId || listings.some(row => !row.externalInventoryItemId
      || row.externalInventoryItemId !== identity.externalInventoryItemId) || knownSkus.length > 1) {
      add("INITIAL_SCOPE_MAPPING_UNVERIFIED", "Existing listing sources do not agree on an exact inventory identity.", variant.id);
      continue;
    }
    const externalSku = knownSkus[0] ?? null;
    const owner = identityOwners.get(identity.externalInventoryItemId);
    if (owner !== undefined && owner !== variant.id) {
      add("INITIAL_SCOPE_MAPPING_IDENTITY_CONFLICT", "The provider inventory identity is already assigned to another SKU.", variant.id);
      continue;
    }
    identityOwners.set(identity.externalInventoryItemId, variant.id);
    const mapping = variant.mapping;
    if (!mapping && variant.mappingHistoryCount === 0 && !variant.mappingHeadExists) {
      mappingImports.push({ productVariantId: variant.id, externalInventoryItemId: identity.externalInventoryItemId,
        externalSku, sourceKeys: listings.map(row => row.sourceKey) });
    } else if (!mapping || mapping.externalInventoryItemId !== identity.externalInventoryItemId
      || (externalSku !== null && mapping.externalSku !== null && mapping.externalSku !== externalSku)) {
      add("INITIAL_SCOPE_MAPPING_UNVERIFIED", "The listed identity does not match the selected exact inventory mapping.", variant.id);
    }
  }
  exclusions.sort((a, b) => a.productVariantId - b.productVariantId);
  const stableFacts = { ...facts,
    ownerIssues: [...facts.ownerIssues].sort(),
    ownerEvidenceHashes: [...facts.ownerEvidenceHashes].sort(),
    listings: [...facts.listings].sort((a, b) => compareText(a.sourceKey, b.sourceKey)),
    variants: [...facts.variants].sort((a, b) => a.id - b.id),
    mappingOwners: [...facts.mappingOwners].sort((a, b) => a.productVariantId - b.productVariantId),
  };
  return initialPublicationScopeReviewSchema.parse({
    publicationTargetId: facts.target.id, targetRevision: facts.target.revision, authorityRevision: facts.authorityRevision,
    reviewHash: inventoryCutoverEvidenceHash({ contractVersion: "initial_publication_scope_v4", facts: stableFacts, exclusions, mappingImports }),
    ready: blockers.length === 0, includedVariantIds: [...included].sort((a, b) => a - b),
    excludedNonStockVariantIds: [...nonStock].sort((a, b) => a - b),
    deferredUnpublishedVariantIds: [...deferred].sort((a, b) => a - b),
    excludedVariants: exclusions,
    mappingImports,
    blockers: blockers.sort((a, b) => compareText(a.code, b.code) || (a.productVariantId ?? 0) - (b.productVariantId ?? 0)),
    runtimeAuthorityChanged: false, providerWriteAttempted: false, outboxEnqueued: false,
  });
}

function existingPublisherSkipReason(
  variant: InitialPublicationScopeFacts["variants"][number],
  listings: InitialPublicationScopeFacts["listings"],
  provider: string,
): "legacy_inactive_catalog" | "legacy_quarantined" | "legacy_missing_inventory_identity" | null {
  if (!variant.productActive || !variant.variantActive || variant.salesEligibility !== "sellable") return "legacy_inactive_catalog";
  // A registered owner contradicting a disabled compatibility feed is not a
  // proven legacy skip. Keep that disagreement visible instead of guessing.
  if (!listings.every(row => row.sourceKey.startsWith("feed:"))) return null;
  if (listings.every(row => row.quarantined)) return "legacy_quarantined";
  if (provider === "shopify" && listings.every(row => !row.externalInventoryItemId)) return "legacy_missing_inventory_identity";
  return null;
}

// Review identity must not depend on the host locale/ICU version.
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
