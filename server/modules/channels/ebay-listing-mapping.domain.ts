import { z } from "zod";
import { ebayListingMappingReviewSchema, ebayListingMappingOfferSchema,
  type EbayListingMappingReview, type EbayListingMappingRow } from "@shared/types/ebay-listing-mapping";
import { marketplaceObservedListingPublicationSchema, type EbayListingInspection, type EbayListingInspectionIssue,
  type EbayListingInspectedSku, type MarketplaceObservedListingPublication } from "../marketplace-listings";
import { ebayListingSyncIdentitySchema, syncStageHash, type EbayListingSyncIdentity } from "./ebay-listing-sync.domain";
import type { EbayListingMappingSource } from "./ebay-listing-mapping.service";

const issueSchema = z.object({ code: z.string().min(1).max(150), message: z.string().min(1).max(1000), status: z.number().int().min(100).max(599).optional(),
  sku: z.string().max(255).optional(), listingId: z.string().max(255).optional(), groupKey: z.string().max(255).optional(), listingStatus: z.string().max(255).optional(), groupVariantSkus: z.array(z.string().max(255)).max(10000).optional() }).strict();
export const ebayListingInspectionSchema: z.ZodType<EbayListingInspection> = z.object({
  providerAccount: z.object({ provider: z.string(), accountNamespace: z.string(), externalAccountId: z.string().min(1),
    identityScheme: z.literal("provider_user_id"), externalDisplayNameSnapshot: z.string().nullable(), evidenceHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  observedAt: z.date(),
  skus: z.array(z.object({ sku: z.string().min(1).max(100), inventoryItemExists: z.boolean().nullable(),
    offers: z.array(ebayListingMappingOfferSchema).max(10000), issue: issueSchema.nullable() }).strict()).max(250),
  publication: marketplaceObservedListingPublicationSchema.nullable(), publicationIssue: issueSchema.nullable(),
  groupKey: z.string().min(1).max(255).nullable(), groupSkus: z.array(z.string().min(1).max(100)).max(10000).nullable(),
}).strict();
export interface EbayListingMappingDiagnosis {
  review: EbayListingMappingReview;
  provenIdentity: EbayListingSyncIdentity | null;
  observation: MarketplaceObservedListingPublication | null;
}

export function mappingFailureKind(issue: EbayListingInspectionIssue): "reconnect" | "retry_read" | "manual" {
  if (issue.status === 401 || issue.status === 403 || /AUTH|ACCOUNT_UNVERIFIED|ACCOUNT_IDENTITY/.test(issue.code)) return "reconnect";
  if (issue.status !== undefined && issue.status >= 400 && issue.status < 500 && issue.status !== 408 && issue.status !== 429) return "manual";
  if (issue.status === 408 || issue.status === 429 || (issue.status !== undefined && issue.status >= 500)
    || /TIMEOUT|UNAVAILABLE|READ_FAILED|READ_TIMEOUT|RATE_LIMIT|STALE|IDENTITY_CHANGED/.test(issue.code)) return "retry_read";
  return "manual";
}
export function mappingReadFailure(issue: EbayListingInspectionIssue): { code: string; title: string; explanation: string; kind: "reconnect" | "retry_read" | "manual" } {
  if (issue.status === 401 || /AUTH_REQUIRED|AUTH_REFRESH/.test(issue.code)) return { code: "EBAY_AUTH_REQUIRED", title: "eBay authorization was rejected", explanation: "eBay rejected the credential used for this check. Reconnect the intended account in Connection settings, then check again.", kind: "reconnect" };
  if (issue.status === 403) return { code: "EBAY_PROVIDER_ACCESS_DENIED", title: "eBay denied listing access", explanation: "The connected account lacks access to a required eBay resource. Review seller/API permissions in Connection settings, then check again.", kind: "reconnect" };
  if (/ACCOUNT_UNVERIFIED|ACCOUNT_IDENTITY/.test(issue.code)) return { code: "EBAY_SYNC_ACCOUNT_UNVERIFIED", title: "Account identity needs verification", explanation: "This channel does not have one matching verified eBay account. Review its Connection settings and reconnect the intended account.", kind: "reconnect" };
  if (issue.status === 429 || /RATE_LIMIT/.test(issue.code)) return { code: "EBAY_PROVIDER_RATE_LIMITED", title: "eBay is limiting requests", explanation: "eBay asked this connection to wait. Wait before checking again; no mapping mismatch has been established.", kind: "retry_read" };
  if (issue.status === 408 || /TIMEOUT/.test(issue.code)) return { code: "EBAY_REGISTRATION_READ_TIMEOUT", title: "eBay check timed out", explanation: "A required eBay read did not complete before its timeout. Check again before changing the saved mapping.", kind: "retry_read" };
  if (/STALE|IDENTITY_CHANGED/.test(issue.code)) return { code: "EBAY_MAPPING_REVIEW_STALE", title: "Mapping changed during review", explanation: "The saved product mapping or live listing changed during this check. Check eBay again to review the new values.", kind: "retry_read" };
  if (/SOURCE_INVALID|MAPPING_INVALID|SCOPE_INVALID/.test(issue.code)) return { code: "EBAY_MAPPING_SOURCE_INVALID", title: "Saved mapping is incomplete", explanation: "The local mapping has missing, duplicate, or inconsistent product variant identities. Review the product's saved eBay mapping before checking again.", kind: "manual" };
  if (/RESPONSE_INVALID|IDENTITY_INVALID|SKU_MISMATCH|MARKETPLACE_MISMATCH|PAGINATION|TOTAL_|PAGE_/.test(issue.code)) return { code: "EBAY_SYNC_PROVIDER_RESPONSE_INVALID", title: "eBay response could not be validated", explanation: "eBay returned an incomplete or inconsistent identity response. The saved mapping is not proven stale. Check again; if it repeats, give this diagnostic code to an administrator.", kind: "retry_read" };
  if (issue.status !== undefined && issue.status >= 400 && issue.status < 500) return { code: "EBAY_SYNC_PROVIDER_IDENTITY_INVALID", title: "eBay refused the identity lookup", explanation: `eBay returned HTTP ${issue.status} for a required listing lookup. Check the exact SKU and listing in the connected account, then check again.`, kind: "manual" };
  return { code: "EBAY_REGISTRATION_READ_FAILED", title: "Listing check is unavailable", explanation: "A required read could not finish. Check again; if the failure repeats, give this diagnostic code to an administrator. The saved mapping has not been proven wrong.", kind: "retry_read" };
}
export function mappingBlockedReview(input: {
  productId: number; observedAt: Date; rows: EbayListingMappingRow[]; title: string; explanation: string;
  kind?: "reconnect" | "retry_read" | "manual" | "review_registered_listing";
  code?: string;
  membership?: EbayListingMappingReview["membership"];
}): EbayListingMappingDiagnosis {
  const kind = input.kind ?? "manual";
  const localInclusion = input.code === "EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE";
  const localSource = input.code === "EBAY_MAPPING_SOURCE_INVALID" || input.code === "EBAY_MAPPING_OWNERSHIP_CONFLICT";
  return { provenIdentity: null, observation: null, review: ebayListingMappingReviewSchema.parse({
    productId: input.productId, observedAt: input.observedAt.toISOString(), rows: input.rows, reviewHash: null,
    title: input.title, explanation: input.explanation, diagnosticCode: input.code ?? null, membership: input.membership ?? null, effects: [], canApply: false,
    action: { kind, label: localInclusion ? "Review local inclusion" : localSource ? "Review saved mapping" : kind === "reconnect" ? "Review connection" : kind === "retry_read" ? "Check eBay again" : kind === "review_registered_listing" ? "Review registered listing" : "Review listing in eBay" },
    manualSteps: localInclusion ? [{ text: "In this Echelon listing feed, enable the product and each intended variant using its inclusion switch.", href: "/channels/ebay" },
        { text: "Then return to this product and select Check eBay again before resuming sync." }]
      : localSource ? [{ text: `Ask an administrator to review product ${input.productId}'s saved channel variant mappings using diagnostic ${input.code}. The local mapping cannot be corrected in Seller Hub.` },
        { text: "Include the saved identifiers and conflicting variant details shown in this review. Check eBay again after the local mapping is corrected." }]
      : kind === "reconnect" ? [{ text: "Open this channel's Connection settings and reconnect the intended eBay account before checking again." }]
      : kind === "retry_read" ? [{ text: "Check again after eBay responds. No mapping changes are authorized from an incomplete read." }]
      : kind === "review_registered_listing" ? [{ text: "Open the registered listing review below to compare the registered publication and its members with the current eBay listing." }]
      : [{ text: "Open Seller Hub and search the exact SKU shown below. Compare its publication status, offer, and listing with the saved values.", href: "https://www.ebay.com/sh/lst/active" },
        { text: "Resolve the specific differences shown below, then use Check eBay again. Do not delete or recreate the listing to bypass this check." }],
  }) };
}

function rowDiagnosis(member: EbayListingSyncIdentity["variants"][number], observed?: EbayListingInspectedSku): EbayListingMappingRow {
  const row: EbayListingMappingRow = { variantId: member.variantId, catalogSku: member.catalogSku ?? member.sku,
    savedSku: member.externalSku, savedOfferId: member.offerId, savedListingId: member.listingId,
    observedOffers: observed ? [...observed.offers] : [], problem: "matches", recommendation: "The saved SKU, offer, and listing match eBay." };
  if (!observed || observed.issue) return { ...row,
    problem: observed?.issue && /RESPONSE_INVALID|MISMATCH|PAGINATION|TOTAL_|PAGE_/.test(observed.issue.code) ? "invalid_response" : "read_failed",
    recommendation: "This SKU could not be read completely or its response was invalid. Check again before changing its mapping." };
  if (observed.inventoryItemExists !== true)
    return { ...row, problem: "missing", recommendation: "eBay did not return the inventory item for this SKU. Check the exact SKU in the connected account before choosing a mapping." };
  if (observed.offers.length === 0)
    return { ...row, problem: "missing", recommendation: "eBay returned no offers for this SKU in the configured marketplace. Review the SKU and marketplace before choosing a mapping." };
  const published = observed.offers.filter(offer => offer.status === "PUBLISHED");
  if (published.length === 0) return { ...row, problem: "unpublished", recommendation: "The returned offers are unpublished. Review the intended listing in Seller Hub; changing saved IDs cannot publish it." };
  if (published.length !== 1) return { ...row, problem: "ambiguous", recommendation: "More than one published offer uses this SKU. Identify the intended listing in Seller Hub before changing its mapping." };
  const offer = published[0]!;
  if (offer.sku !== member.sku)
    return { ...row, problem: "invalid_response", recommendation: `Offer ${offer.offerId} did not return the expected SKU ${member.sku}. Check again; this response cannot authorize a mapping change.` };
  if (!offer.listingId)
    return { ...row, problem: "invalid_response", recommendation: `Published offer ${offer.offerId} did not return a listing ID. Check again before applying a mapping.` };
  if (!["ACTIVE", "OUT_OF_STOCK"].includes(offer.listingStatus ?? ""))
    return { ...row, problem: "invalid_response", recommendation: `Offer ${offer.offerId} is published but its listing status is ${offer.listingStatus ?? "missing"}. Review that listing's status in Seller Hub.` };
  if (member.offerId !== null && member.offerId !== offer.offerId)
    return { ...row, problem: "offer_changed", recommendation: `The saved offer is ${member.offerId}; eBay currently reports ${offer.offerId}. A repair is available only if the complete listing is verified below.` };
  if (member.listingId !== null && member.listingId !== offer.listingId)
    return { ...row, problem: "listing_changed", recommendation: `The saved listing is ${member.listingId}; eBay currently reports ${offer.listingId}. A repair is available only if the complete listing is verified below.` };
  if (member.offerId === null || member.listingId === null || member.externalSku === null)
    return { ...row, problem: "mapping_missing", recommendation: "eBay returned the live offer, but one or more saved identifiers are missing. Fill them only after complete listing verification." };
  return row;
}

/** Pure comparison. Canonical publication proof comes from marketplace-listings;
 * this function owns only the channel mapping repair recommendation. */
export function buildEbayListingMappingDiagnosis(source: EbayListingMappingSource, raw: unknown): EbayListingMappingDiagnosis {
  const inspection = ebayListingInspectionSchema.parse(raw);
  const bySku = new Map(inspection.skus.map(member => [member.sku, member]));
  const rows = source.identity.variants.map(member => rowDiagnosis(member, bySku.get(member.sku)));
  const expectedSkus = source.identity.variants.map(member => member.sku).sort();
  const observedSkus = inspection.groupSkus ?? inspection.publication?.members.map(member => member.sku) ?? null;
  const membership = observedSkus === null ? null : { expectedSkus, observedSkus: [...observedSkus].sort(),
    missingSkus: expectedSkus.filter(sku => !observedSkus.includes(sku)), extraSkus: observedSkus.filter(sku => !expectedSkus.includes(sku)).sort(), groupKey: inspection.groupKey };
  const base = { productId: source.identity.productId, observedAt: inspection.observedAt, rows, membership };
  if (bySku.size !== inspection.skus.length || bySku.size !== source.identity.variants.length
    || source.identity.variants.some(member => !bySku.has(member.sku)))
    return mappingBlockedReview({ ...base, title: "Incomplete eBay check", explanation: "The response did not cover every saved variant exactly once.", kind: "retry_read" });
  if (inspection.providerAccount.provider !== "ebay" || inspection.providerAccount.externalAccountId !== source.identity.accountId
    || inspection.providerAccount.accountNamespace !== source.environment)
    return mappingBlockedReview({ ...base, title: "Connected account differs", explanation: "The live eBay account or environment differs from this channel's verified identity. Reconnect the intended account.", kind: "reconnect" });
  const readIssue = inspection.skus.find(member => member.issue)?.issue;
  if (readIssue) return mappingBlockedReview({ ...base, ...mappingReadFailure(readIssue) });
  const blockedRows = rows.filter(row => ["missing", "unpublished", "ambiguous", "invalid_response"].includes(row.problem));
  if (blockedRows.length) return mappingBlockedReview({ ...base, title: "Listing needs review", explanation: "The returned offers do not prove one live offer for every saved SKU. Follow the recommendation for each affected variant." });
  const publication = inspection.publication;
  if (membership && (membership.extraSkus.length || membership.missingSkus.length)) {
    const summarize = (values: readonly string[]) => values.length ? `${values.slice(0,5).join(", ")}${values.length > 5 ? ` (and ${values.length-5} more)` : ""}` : "none";
    return mappingBlockedReview({ ...base, title: "Listing membership differs", code: "EBAY_SYNC_MEMBERSHIP_CHANGED",
      explanation: `Missing from eBay's group: ${summarize(membership.missingSkus)}. Extra in eBay's group: ${summarize(membership.extraSkus)}. Review the complete group before changing this product's mapping.`.slice(0,1000),
      rows: rows.map(row => ({ ...row, problem: "membership_changed", recommendation: "Compare the missing and extra SKUs above with the intended group membership before remapping." })) });
  }
  if (!publication && inspection.publicationIssue && mappingFailureKind(inspection.publicationIssue) !== "manual")
    return mappingBlockedReview({ ...base, ...mappingReadFailure(inspection.publicationIssue) });
  if (!publication) return mappingBlockedReview({ ...base, title: "Complete listing could not be verified", code: inspection.publicationIssue?.code,
    explanation: inspection.publicationIssue ? `${inspection.publicationIssue.message}${inspection.publicationIssue.sku ? ` Affected SKU: ${inspection.publicationIssue.sku}.` : ""}${inspection.publicationIssue.listingStatus ? ` Listing status: ${inspection.publicationIssue.listingStatus}.` : ""}`.slice(0,1000)
      : "No complete publication identity was returned. Check the variant details before changing the mapping.",
    kind: inspection.publicationIssue ? mappingFailureKind(inspection.publicationIssue) : "manual" });
  if (publication.providerAccount.externalAccountId !== source.identity.accountId || publication.providerAccount.accountNamespace !== source.environment
    || publication.providerAccount.provider !== "ebay" || publication.marketplaceId !== source.identity.marketplaceId || !publication.isPublished)
    return mappingBlockedReview({ ...base, title: "Listing account differs", explanation: "The verified publication does not belong to the expected eBay account, environment, or marketplace.", kind: "reconnect" });
  const members = new Map(publication.members.map(member => [member.sku, member]));
  if (members.size !== publication.members.length || members.size !== source.identity.variants.length
    || (source.identity.variants.length > 1 && publication.publicationKeyIdentity === null)
    || source.identity.variants.some(member => !members.has(member.sku)))
    return mappingBlockedReview({ ...base, rows: rows.map(row => ({ ...row, problem: "membership_changed", recommendation: "The complete eBay group contains a different set of SKUs. Review every group member before remapping this product." })),
      title: "Listing membership differs", explanation: `Expected ${source.identity.variants.length} saved product variants; eBay's verified listing contains ${publication.members.length} members. No variants will be dropped or guessed.` });
  if (source.identity.variants.some(member => {
    const proven = members.get(member.sku)!;
    const observed = bySku.get(member.sku)!.offers.filter(offer => offer.status === "PUBLISHED");
    return proven.inventoryItemIdentity?.externalId !== member.sku || !proven.offerIdentity || observed.length !== 1
      || observed[0]!.offerId !== proven.offerIdentity.externalId || observed[0]!.listingId !== publication.listingIdentity.externalId;
  })) return mappingBlockedReview({ ...base, title: "eBay changed during the check", explanation: "The per-SKU response and complete group verification disagree. Check again before applying a mapping.", kind: "retry_read" });
  if (source.identity.variants.every(member => member.contentSyncEnabled === false))
    return mappingBlockedReview({ ...base, title: "No variants are enabled for sync", code: "EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE",
      explanation: "The identity matches a live eBay listing, but every local variant is excluded or ineligible for content sync. Enable the intended product and variant in the listing feed, then check again." });
  const provenIdentity = ebayListingSyncIdentitySchema.parse({ ...source.identity, groupKey: publication.publicationKeyIdentity?.externalId ?? null,
    variants: source.identity.variants.map(member => ({ ...member, externalSku: member.sku,
      offerId: members.get(member.sku)!.offerIdentity!.externalId, listingId: publication.listingIdentity.externalId })) });
  const changed = rows.some(row => row.problem !== "matches");
  const reviewHash = syncStageHash({ identity: { ...source.identity, variants: [...source.identity.variants].sort((a,b) => a.variantId-b.variantId) },
    environment: source.environment, candidates: source.candidates.map(({ availableQuantity: _quantity, ...candidate }) => candidate).sort((a,b) => a.productVariantId-b.productVariantId),
    provenIdentity: { ...provenIdentity, variants: [...provenIdentity.variants].sort((a,b) => a.variantId-b.variantId) },
    observed: [...inspection.skus].sort((a,b) => a.sku.localeCompare(b.sku)).map(member => ({ sku: member.sku,
      inventoryItemExists: member.inventoryItemExists, offers: [...member.offers].sort((a,b) => a.offerId.localeCompare(b.offerId)) })) });
  return { provenIdentity, observation: publication, review: ebayListingMappingReviewSchema.parse({ ...base, observedAt: inspection.observedAt.toISOString(),
    reviewHash, canApply: true, title: changed ? "Verified mapping repair available" : "Saved mapping matches eBay",
    explanation: changed ? "The connected account and the complete live listing match this product's exact SKUs. The saved identifiers can be updated to the verified values shown below."
      : "Every saved offer and listing matches the fresh eBay read. The previous error is historical; a new sync can be queued against this verified identity.",
    effects: [changed ? "Update only this product's saved eBay SKU, offer, and listing identifiers to the verified values." : "Keep the verified mapping unchanged.",
      "Retain an audit receipt and queue one durable listing sync. The sync uses current inventory and existing publication guards."],
    action: { kind: changed ? "apply_fix" : "resume_sync", label: changed ? "Apply verified mapping and sync" : "Resume sync" }, manualSteps: [],
  }) };
}
