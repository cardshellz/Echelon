import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { matchesCatalogScope } from "../../../../shared/dropship/catalog-scope";
import { MAX_DESCRIPTION_HTML_LENGTH, resolvedListingContentSchema, type ContentProfileState,
  type DescriptionTemplate, type ResolvedListingContent, type SavedListingContent } from "../../../../shared/dropship/listing-content";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import { descriptionAsPlainText } from "./dropship-listing-presentation";

// Version 2 keeps catalog facts outside the description. Previously reviewed
// content must be refreshed before it can be queued under this renderer.
const CONTENT_RENDERER_VERSION = 2;
const ALLOWED_DESCRIPTION_TAGS = ["p", "br", "strong", "b", "em", "i", "u", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "div", "span", "table", "tbody", "thead", "tr", "th", "td"];
const DROP_CONTENT_TAGS = ["script", "style", "textarea", "option", "noscript", "iframe", "object", "embed", "svg", "math", "xmp"];

/** Catalog HTML is also untrusted. No attributes, links, images, scripts or styles survive. */
export function sanitizeListingDescription(html: string): string {
  return sanitizeHtml(html, { allowedTags: ALLOWED_DESCRIPTION_TAGS, allowedAttributes: {},
    nonTextTags: DROP_CONTENT_TAGS, disallowedTagsMode: "discard", parseStyleAttributes: false });
}
export function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function textDescriptionHtml(text: string): string {
  if (!text.trim()) return "";
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  return escaped.split(/\n\s*\n/).map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br />")}</p>`).join("");
}
export function listingCatalogHash(candidate: DropshipListingCatalogCandidate): string {
  return contentHash({ productVariantId: candidate.productVariantId, description: candidate.description,
    facts: listingFacts(candidate), itemSpecifics: Object.entries(candidate.itemSpecifics ?? {}).sort(([a], [b]) => a.localeCompare(b)) });
}
/** Compile shared template evidence and named-group membership once per batch. */
export function prepareContentProfile(profile: ContentProfileState) {
  return {
    state: profile,
    hash: contentHash({ revisionId: profile.revisionId, profile: profile.profile }),
    groups: [...(profile.profile?.groups ?? [])].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
      .map((group) => ({ group, variantIds: group.scope.type === "listings" ? new Set(group.scope.productVariantIds) : null })),
  };
}
export type PreparedContentProfile = ReturnType<typeof prepareContentProfile>;

/**
 * The template a size's description uses: its first matching group by
 * priority, else the store template. Two groups that tie at the top leave no
 * template at all, so neither wins by accident. `groupName` names the group
 * that won; `templateName` is the label previews show, which a group may share.
 */
export function resolveContentTemplate(prepared: PreparedContentProfile, candidate: DropshipListingCatalogCandidate): {
  template: DescriptionTemplate | null; templateName: string | null; groupName: string | null; conflict: boolean;
} {
  const groups = prepared.groups.filter(({ group, variantIds }) => variantIds
    ? variantIds.has(candidate.productVariantId) : matchesCatalogScope(group.scope, candidate)).map(({ group }) => group);
  const conflict = groups.length > 1 && groups[0].priority === groups[1].priority;
  const winner = conflict ? null : groups[0] ?? null;
  const template = conflict ? null : winner?.template ?? prepared.state.profile?.defaultTemplate ?? null;
  return { template, templateName: conflict ? null : winner?.name ?? (template ? "Store template" : null),
    groupName: winner?.name ?? null, conflict };
}

/** Own text saved against an older catalog version needs the vendor to check it still fits. */
export function needsListingCatalogReview(saved: Pick<SavedListingContent, "customText" | "catalogHash"> | null, catalogHash: string): boolean {
  return saved?.customText != null && saved.catalogHash !== catalogHash;
}
export function resolveListingContent(input: {
  candidate: DropshipListingCatalogCandidate; profile: ContentProfileState;
  saved: (Omit<SavedListingContent, "revisionId"> & { revisionId: number | null }) | null;
  preparedProfile?: ReturnType<typeof prepareContentProfile>;
}): ResolvedListingContent {
  const { candidate, profile, saved } = input;
  const prepared = input.preparedProfile ?? prepareContentProfile(profile);
  if (prepared.state !== profile) throw new Error("Prepared content profile does not match its source state.");
  const catalogHash = listingCatalogHash(candidate);
  const facts = listingFacts(candidate);
  const issues: string[] = [];
  const catalogTooLarge = (candidate.description?.length ?? 0) > MAX_DESCRIPTION_HTML_LENGTH;
  const catalogHtml = catalogTooLarge ? "" : sanitizeListingDescription(candidate.description ?? "");
  if (catalogTooLarge) issues.push("listing_content_catalog_too_large");
  const { template, templateName, conflict } = resolveContentTemplate(prepared, candidate);
  if (conflict) issues.push("listing_content_template_conflict");
  const needsCatalogReview = needsListingCatalogReview(saved, catalogHash);
  if (needsCatalogReview) issues.push("listing_content_catalog_review_required");
  const body = saved?.customText != null ? textDescriptionHtml(saved.customText) : catalogHtml;
  if (!descriptionAsPlainText(body).trim()) issues.push("listing_content_description_required");
  // Facts remain structured catalog-owned data for review and change detection.
  // Do not inject them into vendor prose or strip text the author entered.
  const assembled = `${textDescriptionHtml(template?.introduction ?? "")}${body}${textDescriptionHtml(template?.footer ?? "")}`;
  const htmlTooLarge = assembled.length > MAX_DESCRIPTION_HTML_LENGTH;
  if (htmlTooLarge) issues.push("listing_content_description_too_large");
  const descriptionHtml = htmlTooLarge ? "" : sanitizeListingDescription(assembled);
  return resolvedListingContentSchema.parse({ descriptionHtml, descriptionText: descriptionAsPlainText(descriptionHtml),
    catalogHtml, catalogText: descriptionAsPlainText(catalogHtml), catalogHash, facts,
    evidenceHash: contentHash({ renderer: CONTENT_RENDERER_VERSION, catalogHash, profileRevisionId: profile.revisionId,
      profileHash: prepared.hash, saved, descriptionHtml, issues }),
    source: saved?.customText != null ? "custom" : "catalog", templateName,
    revisionId: saved?.revisionId ?? null, profileRevisionId: profile.revisionId, needsCatalogReview, issues,
  });
}
function listingFacts(candidate: DropshipListingCatalogCandidate): Array<{ name: string; value: string }> {
  const units = candidate.catalogUnitsPerVariant === undefined ? candidate.unitsPerVariant : candidate.catalogUnitsPerVariant;
  const values = [
    ["Product", candidate.productName], ["Variant", candidate.variantName], ["SKU", candidate.sku],
    ["Units per sellable pack", Number.isSafeInteger(units) && Number(units) > 0 ? String(units) : null],
    ["Brand", candidate.brand], ["Condition", candidate.condition], ["GTIN", candidate.gtin], ["MPN", candidate.mpn],
  ];
  return values.filter((row): row is [string, string] => typeof row[1] === "string" && row[1].trim().length > 0)
    .map(([name, value]) => ({ name, value }));
}
