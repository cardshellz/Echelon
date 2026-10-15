import { createHash } from "node:crypto";
import sanitizeHtml from "sanitize-html";
import { matchesCatalogScope } from "../../../../shared/dropship/catalog-scope";
import { MAX_DESCRIPTION_HTML_LENGTH, resolvedListingContentSchema, type ContentProfileState,
  type DescriptionTemplate, type ResolvedListingContent, type SavedListingContent } from "../../../../shared/dropship/listing-content";
import type { ListingSettingMainText, ListingSettingTemplateText } from "../../../../shared/dropship/listing-setting-values";
import { EMPTY_LISTING_SETTING_LAYERS, layersFor, type ListingSettingLayerValues, type ListingSettingLayers } from "./dropship-listing-setting-layers";
import type { DropshipListingCatalogCandidate } from "./dropship-listing-preview-service";
import { descriptionAsPlainText } from "./dropship-listing-presentation";

// Version 2 keeps catalog facts outside the description. Previously reviewed
// content must be refreshed before it can be queued under this renderer.
const CONTENT_RENDERER_VERSION = 2;
// Version of the `layers` key a description's evidence gains once a product or
// category setting gives it a part (plan PR 8b, 4.7). Without one the evidence
// is today's object exactly, so no queued push or reviewed preview is refused.
const CONTENT_LAYER_EVIDENCE_VERSION = 2;
// Tags what productCatalogHash hashes, so its input never has the per-size hash's shape.
const PRODUCT_CATALOG_HASH_KIND = "product_catalog_v1";
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
/**
 * The catalog facts a product's own main text is written against (plan D17):
 * the product's description, brand, condition and item specifics. Nothing a
 * size owns (variant id, size name, SKU, GTIN, MPN, units) is in it, so a
 * size-only catalog change does not ask the vendor to re-check product text
 * (design record 8.3). The product name is left out too (D17, risk R9).
 * Item specifics sort by UTF-16 code units, not localeCompare, so the stored
 * hash never depends on the server's locale.
 */
export function productCatalogHash(candidate: Pick<DropshipListingCatalogCandidate, "productId" | "description" | "brand" | "condition" | "itemSpecifics">): string {
  return contentHash({ kind: PRODUCT_CATALOG_HASH_KIND, productId: candidate.productId, description: candidate.description,
    brand: candidate.brand, condition: candidate.condition,
    itemSpecifics: Object.entries(candidate.itemSpecifics ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
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

/** Where one part of a size's description template comes from, closest first (plan 4.7, D16). */
export type TemplatePartSource = "product" | "group_rule" | "category" | "store_default" | "none";
/** Text above (the template's introduction) or text below (its footer). `none` and an explicit "None" setting are "". */
export interface TemplatePart { text: string; source: TemplatePartSource }
export interface ResolvedContentTemplate {
  template: DescriptionTemplate | null; templateName: string | null; groupName: string | null; conflict: boolean;
  parts: { textAbove: TemplatePart; textBelow: TemplatePart };
}
/**
 * The product and category setting behind each template part; each part is
 * its own setting (plan D8). Exported so the PR 11 conversion planner maps a
 * group's parts to settings with this mapping, not a copy of it.
 */
export const TEMPLATE_PART_SETTING = { introduction: "textAbove", footer: "textBelow" } as const;
const NO_LAYER_VALUES: ListingSettingLayerValues = Object.freeze({ product: null, category: null });

/**
 * The template a size's description uses. Text above and text below are
 * resolved one at a time, closest first: the product's own setting (its text,
 * or "None"), then its first matching older group by priority (the group's
 * whole template is one step), then its Card Shellz category's setting, then
 * the store template. Two groups that tie at the top are a conflict only for
 * a part that reaches them (HYPOTHESIS: the intended reading of design record
 * 5.1); a conflict leaves no template at all, so neither group wins by
 * accident. `template` is assembled from the parts: with no product or
 * category part it is the group's or the store's own object, exactly as before
 * those settings existed (plan D1). `groupName` names the group a part came
 * from; `templateName` is the label previews show, which a group may share:
 * the closest part's source (D18's order). The product and category labels
 * are interim words; PR 10 owns them (D22).
 */
export function resolveContentTemplate(prepared: PreparedContentProfile, candidate: DropshipListingCatalogCandidate,
  layers: ListingSettingLayers = EMPTY_LISTING_SETTING_LAYERS): ResolvedContentTemplate {
  return templateFor(prepared, candidate, layersFor(layers, candidate));
}
/** One older description group of a prepared content profile. */
export type PreparedContentGroup = PreparedContentProfile["groups"][number]["group"];
/** The older groups that match one size, best first, and the one that wins: none when the best two tie. */
export interface MatchingContentGroups {
  groups: readonly PreparedContentGroup[];
  tie: boolean;
  winner: PreparedContentGroup | null;
}
/**
 * The older description groups that match a size, in the prepared order
 * (priority, then id), whether the best two tie, and the winner (none on a
 * tie): the one walk `templateFor` reads. Exported so the PR 11 conversion
 * planner reads today's winner from the same walk instead of a copy of it
 * (plan D2). Whether a part reaches the groups (the product's own part comes
 * first) is the caller's: `templateFor` below, or the planner. Pure.
 */
export function matchingContentGroups(prepared: PreparedContentProfile, candidate: DropshipListingCatalogCandidate): MatchingContentGroups {
  const groups = prepared.groups.filter(({ group, variantIds }) => variantIds
    ? variantIds.has(candidate.productVariantId) : matchesCatalogScope(group.scope, candidate)).map(({ group }) => group);
  const tie = groups.length > 1 && groups[0].priority === groups[1].priority;
  return { groups, tie, winner: tie ? null : groups[0] ?? null };
}
function templateFor(prepared: PreparedContentProfile, candidate: DropshipListingCatalogCandidate, layer: ListingSettingLayerValues): ResolvedContentTemplate {
  const { tie, winner } = matchingContentGroups(prepared, candidate);
  const store = prepared.state.profile?.defaultTemplate ?? null;
  // null = the part reached the tied groups.
  const part = (key: keyof typeof TEMPLATE_PART_SETTING): TemplatePart | null => {
    const own = layer.product?.[TEMPLATE_PART_SETTING[key]] ?? null;
    if (own !== null) return layerPart(own, "product");
    if (tie) return null;
    if (winner) return { text: winner.template[key], source: "group_rule" };
    const fromCategory = layer.category?.[TEMPLATE_PART_SETTING[key]] ?? null;
    if (fromCategory !== null) return layerPart(fromCategory, "category");
    return store ? { text: store[key], source: "store_default" } : noTemplatePart();
  };
  const above = part("introduction");
  const below = part("footer");
  const conflict = above === null || below === null;
  const parts = { textAbove: above ?? noTemplatePart(), textBelow: below ?? noTemplatePart() };
  const sources = [parts.textAbove.source, parts.textBelow.source];
  const fromLayer = sources.some(isLayerSource);
  const template = conflict ? null : fromLayer ? { introduction: parts.textAbove.text, footer: parts.textBelow.text } : winner?.template ?? store;
  const groupName = winner && sources.includes("group_rule") ? winner.name : null;
  return { template, templateName: conflict ? null : templateLabel(sources, groupName), groupName, conflict, parts };
}
function noTemplatePart(): TemplatePart {
  return { text: "", source: "none" };
}
function layerPart(value: ListingSettingTemplateText, source: "product" | "category"): TemplatePart {
  return { text: value.mode === "own" ? value.text : "", source };
}
function isLayerSource(source: TemplatePartSource): boolean {
  return source === "product" || source === "category";
}
function templateLabel(sources: readonly TemplatePartSource[], groupName: string | null): string | null {
  if (sources.includes("product")) return "This product";
  if (groupName !== null) return groupName;
  if (sources.includes("category")) return "Category settings";
  return sources.includes("store_default") ? "Store template" : null;
}

/** Own text saved against an older catalog version needs the vendor to check it still fits. */
export function needsListingCatalogReview(saved: Pick<SavedListingContent, "customText" | "catalogHash"> | null, catalogHash: string): boolean {
  return saved?.customText != null && saved.catalogHash !== catalogHash;
}
/** A product's own main text saved against other product catalog facts (productCatalogHash) needs the same check. */
export function needsProductCatalogReview(mainText: Pick<ListingSettingMainText, "catalogHash"> | null, catalogHash: string): boolean {
  return mainText !== null && mainText.catalogHash !== catalogHash;
}
/**
 * A size's description: text above + main text + text below. The main text
 * is the size's own text (left over from the per-size editor), else the
 * product's own text, else the Card Shellz text. Product text counts as
 * `custom` and is checked against productCatalogHash, a size's text against
 * listingCatalogHash; either mismatch is listing_content_catalog_review_required.
 * `layers` are the store's product and category settings (one read per
 * preview or caller transaction, plan D26); without them, or with none for
 * this size, the result and its evidence are exactly today's (plan D1).
 */
export function resolveListingContent(input: {
  candidate: DropshipListingCatalogCandidate; profile: ContentProfileState;
  saved: (Omit<SavedListingContent, "revisionId"> & { revisionId: number | null }) | null;
  preparedProfile?: ReturnType<typeof prepareContentProfile>;
  layers?: ListingSettingLayers;
}): ResolvedListingContent {
  const { candidate, profile, saved } = input;
  const prepared = input.preparedProfile ?? prepareContentProfile(profile);
  if (prepared.state !== profile) throw new Error("Prepared content profile does not match its source state.");
  const layer = input.layers ? layersFor(input.layers, candidate) : NO_LAYER_VALUES;
  const catalogHash = listingCatalogHash(candidate);
  const facts = listingFacts(candidate);
  const issues: string[] = [];
  const catalogTooLarge = (candidate.description?.length ?? 0) > MAX_DESCRIPTION_HTML_LENGTH;
  const catalogHtml = catalogTooLarge ? "" : sanitizeListingDescription(candidate.description ?? "");
  if (catalogTooLarge) issues.push("listing_content_catalog_too_large");
  const { template, templateName, conflict, parts } = templateFor(prepared, candidate, layer);
  if (conflict) issues.push("listing_content_template_conflict");
  // The product's own main text applies only to a size without its own text.
  const productText = saved?.customText != null ? null : layer.product?.mainText ?? null;
  const needsCatalogReview = needsListingCatalogReview(saved, catalogHash)
    || (productText !== null && needsProductCatalogReview(productText, productCatalogHash(candidate)));
  if (needsCatalogReview) issues.push("listing_content_catalog_review_required");
  const ownText = saved?.customText ?? productText?.text ?? null;
  const body = ownText !== null ? textDescriptionHtml(ownText) : catalogHtml;
  if (!descriptionAsPlainText(body).trim()) issues.push("listing_content_description_required");
  // Facts remain structured catalog-owned data for review and change detection.
  // Do not inject them into vendor prose or strip text the author entered.
  const assembled = `${textDescriptionHtml(template?.introduction ?? "")}${body}${textDescriptionHtml(template?.footer ?? "")}`;
  const htmlTooLarge = assembled.length > MAX_DESCRIPTION_HTML_LENGTH;
  if (htmlTooLarge) issues.push("listing_content_description_too_large");
  const descriptionHtml = htmlTooLarge ? "" : sanitizeListingDescription(assembled);
  const evidence = { renderer: CONTENT_RENDERER_VERSION, catalogHash, profileRevisionId: profile.revisionId,
    profileHash: prepared.hash, saved, descriptionHtml, issues };
  const used = layerEvidence(parts, productText);
  return resolvedListingContentSchema.parse({ descriptionHtml, descriptionText: descriptionAsPlainText(descriptionHtml),
    catalogHtml, catalogText: descriptionAsPlainText(catalogHtml), catalogHash, facts,
    evidenceHash: contentHash(used ? { ...evidence, layers: used } : evidence),
    source: ownText !== null ? "custom" : "catalog", templateName,
    revisionId: saved?.revisionId ?? null, profileRevisionId: profile.revisionId, needsCatalogReview, issues,
  });
}
/**
 * The product and category values a description used, as the last evidence
 * key, or null when it used none. The values are hashed, not the rows'
 * revision ids, so a product save that changes only its shelf leaves queued
 * descriptions alone; a part's source is hashed too, so the same text moving
 * from a category to the product still changes the evidence.
 */
function layerEvidence(parts: ResolvedContentTemplate["parts"], mainText: ListingSettingMainText | null) {
  const used = {
    ...(isLayerSource(parts.textAbove.source) ? { textAbove: { text: parts.textAbove.text, source: parts.textAbove.source } } : {}),
    ...(isLayerSource(parts.textBelow.source) ? { textBelow: { text: parts.textBelow.text, source: parts.textBelow.source } } : {}),
    ...(mainText ? { mainText: { text: mainText.text, catalogHash: mainText.catalogHash } } : {}),
  };
  return Object.keys(used).length > 0 ? { v: CONTENT_LAYER_EVIDENCE_VERSION, ...used } : null;
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
