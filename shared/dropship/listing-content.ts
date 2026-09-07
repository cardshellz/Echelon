import { z } from "zod";
import { catalogScopeSchema, MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";

export const MAX_DESCRIPTION_TEXT_LENGTH = 20_000;
export const MAX_TEMPLATE_TEXT_LENGTH = 4_000;
export const MAX_DESCRIPTION_HTML_LENGTH = 200_000;
const id = z.number().int().positive().max(2_147_483_647);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const saveKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
// Vendor-authored content is text, never HTML. Normalize before hashing/saving.
const text = (max: number) => z.string().max(max).transform((value) => value.replace(/\r\n?/g, "\n").trim())
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Control characters are not allowed.");
export const descriptionTextSchema = text(MAX_DESCRIPTION_TEXT_LENGTH).refine((value) => value.length > 0, "Enter a description or reset to catalog.");
export const descriptionTemplateSchema = z.object({ introduction: text(MAX_TEMPLATE_TEXT_LENGTH), footer: text(MAX_TEMPLATE_TEXT_LENGTH) }).strict();
export const contentProfileSchema = z.object({
  defaultTemplate: descriptionTemplateSchema,
  groups: z.array(z.object({
    id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().min(1).max(120),
    priority: z.number().int().min(1).max(100_000), scope: catalogScopeSchema, template: descriptionTemplateSchema,
  }).strict()).max(100)
    .refine((groups) => new Set(groups.map((group) => group.id)).size === groups.length, "Group identities must be unique.")
    .refine((groups) => groups.reduce((total, group) => total + (group.scope.type === "listings" ? group.scope.productVariantIds.length : 0), 0) <= MAX_NAMED_CATALOG_GROUP_ITEMS,
      "Templates support up to 10,000 named-listing assignments. Use category, product, or product-line groups for broader coverage."),
}).strict();
export const contentProfileStateSchema = z.object({ revisionId: id.nullable(), profile: contentProfileSchema.nullable(), updatedAt: z.string().datetime().nullable() }).strict();
export const saveContentProfileInputSchema = z.object({ expectedRevisionId: id.nullable(), profile: contentProfileSchema, idempotencyKey: saveKey }).strict();
export const listingContentTargetSchema = z.object({ storeConnectionId: id, productVariantId: id }).strict();
export const previewListingContentInputSchema = z.object({
  customText: descriptionTextSchema.nullable(), expectedRevisionId: id.nullable(), expectedCatalogHash: hash,
  expectedProfileRevisionId: id.nullable(),
}).strict();
export const saveListingContentInputSchema = previewListingContentInputSchema.extend({ idempotencyKey: saveKey }).strict();
export const resolvedListingContentSchema = z.object({
  descriptionHtml: z.string().max(MAX_DESCRIPTION_HTML_LENGTH), descriptionText: z.string(),
  catalogHtml: z.string().max(MAX_DESCRIPTION_HTML_LENGTH), catalogText: z.string(), catalogHash: hash,
  facts: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  evidenceHash: hash, source: z.enum(["catalog", "custom"]), templateName: z.string().nullable(),
  revisionId: id.nullable(), profileRevisionId: id.nullable(), needsCatalogReview: z.boolean(), issues: z.array(z.string()),
}).strict();
export const listingContentSettingSchema = listingContentTargetSchema.extend({
  customText: descriptionTextSchema.nullable(), revisionId: id.nullable(), updatedAt: z.string().datetime().nullable(),
  resolved: resolvedListingContentSchema,
}).strict();
export const listingContentResponseSchema = z.object({ content: listingContentSettingSchema }).strict();
export const saveListingContentResponseSchema = listingContentResponseSchema.extend({ idempotentReplay: z.boolean() }).strict();
export const saveContentProfileResponseSchema = z.object({ state: contentProfileStateSchema, idempotentReplay: z.boolean() }).strict();
export type DescriptionTemplate = z.infer<typeof descriptionTemplateSchema>;
export type ContentProfile = z.infer<typeof contentProfileSchema>;
export type ContentProfileState = z.infer<typeof contentProfileStateSchema>;
export type ListingContentTarget = z.infer<typeof listingContentTargetSchema>;
export type PreviewListingContentInput = z.infer<typeof previewListingContentInputSchema>;
export type SaveListingContentInput = z.infer<typeof saveListingContentInputSchema>;
export type SaveContentProfileInput = z.infer<typeof saveContentProfileInputSchema>;
export type ResolvedListingContent = z.infer<typeof resolvedListingContentSchema>;
export type ListingContentSetting = z.infer<typeof listingContentSettingSchema>;
export interface SavedListingContent {
  revisionId: number; customText: string | null; catalogHash: string; updatedAt: string;
}
