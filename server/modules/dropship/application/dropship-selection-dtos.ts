import { z } from "zod";
import { DropshipError } from "../domain/errors";
import {
  DROPSHIP_CATALOG_IDS_PURPOSES,
  DROPSHIP_CATALOG_READ_ERROR_CODES,
  DROPSHIP_CATALOG_SELECTION_FILTERS,
  dropshipCatalogNoticeAcknowledgeRequestSchema,
  dropshipPageVersionBodySchema,
} from "../../../../shared/dropship/vendor-catalog-reads";

const positiveIdSchema = z.number().int().positive();

/**
 * The frozen rules GET (one release; PLAN-B v4.1 §8.4). The rules save and its
 * body schemas are gone (V10): picks are written by the selection changes
 * save (dropship-selection-change-dtos.ts).
 */
export const listDropshipVendorSelectionRulesInputSchema = z.object({
  vendorId: positiveIdSchema,
  includeInactive: z.boolean().default(false),
}).strict();

/**
 * The filters every catalog GET applies before the selection is decided:
 * search, the category name (kept one release), the category id (step 1 plan
 * S2-5 §4.8), product lines and product.
 */
const catalogFilterFields = {
  vendorId: positiveIdSchema,
  search: z.string().trim().min(1).max(200).optional(),
  category: z.string().trim().min(1).max(200).optional(),
  categoryId: positiveIdSchema.optional(),
  productLineId: positiveIdSchema.optional(),
  productLineIds: z.array(positiveIdSchema).max(50).optional(),
  productId: positiveIdSchema.optional(),
  /**
   * Which rows by selection; absent means `selectedOnly`'s answer (§4.8). `new` is the new-items notice's Review
   * (PLAN-B v4.1 §11.4): the sizes new for the vendor, in `categoryId` when it is sent.
   */
  selection: z.enum(DROPSHIP_CATALOG_SELECTION_FILTERS).optional(),
  /** The one-release alias of `selection: "selected"`, for a page of stage 1. `selection` wins when both are sent. */
  selectedOnly: z.boolean().default(false),
};

export const previewDropshipVendorCatalogInputSchema = z.object({
  ...catalogFilterFields,
  /** The facet scan is a second full scan; the new page sends false and reads the categories GET instead (TESTS9). */
  includeFacets: z.boolean().default(true),
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(200).default(50),
}).strict();

/** `GET /api/dropship/catalog?idsOnly=true`: the same filters, no paging, and what the ids are for. */
export const listDropshipVendorCatalogIdsInputSchema = z.object({
  ...catalogFilterFields,
  purpose: z.enum(DROPSHIP_CATALOG_IDS_PURPOSES),
}).strict();

/** `GET /api/dropship/catalog/categories`: the whole exposed catalog, no filters (D26). */
export const listDropshipVendorCatalogCategoriesInputSchema = z.object({
  vendorId: positiveIdSchema,
}).strict();

/** `GET /api/dropship/catalog/selection`: the vendor's selection count, split for one store when named. */
export const readDropshipVendorSelectionSummaryInputSchema = z.object({
  vendorId: positiveIdSchema,
  storeConnectionId: positiveIdSchema.nullable(),
}).strict();

export type ListDropshipVendorSelectionRulesInput = z.infer<typeof listDropshipVendorSelectionRulesInputSchema>;
export type PreviewDropshipVendorCatalogInput = z.infer<typeof previewDropshipVendorCatalogInputSchema>;
export type ListDropshipVendorCatalogIdsInput = z.infer<typeof listDropshipVendorCatalogIdsInputSchema>;
export type ReadDropshipVendorSelectionSummaryInput = z.infer<typeof readDropshipVendorSelectionSummaryInputSchema>;
/** The filters a candidate scan applies in SQL (every catalog GET's filter fields apart from the selection). */
export type DropshipVendorCatalogCandidateFilter = Pick<
  PreviewDropshipVendorCatalogInput,
  "vendorId" | "search" | "category" | "categoryId" | "productLineId" | "productLineIds" | "productId"
>;

/** The selection filter a catalog GET applies: `selection` when sent, else `selectedOnly`'s alias. */
export function resolveCatalogSelectionFilter(input: { selection?: z.infer<typeof catalogFilterFields.selection>; selectedOnly: boolean }) {
  return input.selection ?? (input.selectedOnly ? "selected" : "all");
}

/**
 * "Got it" (`POST /api/dropship/catalog/new-items/acknowledge`, PLAN-B v4.1
 * §11.4): the body's page version, read before its strict schema (SAFETY-13),
 * so a newer page is answered 503 "try again", never a permanent 400. A body
 * that is not an object, or a version that is not a whole number ≥ 1, is
 * refused (400).
 */
export function readCatalogNoticeAcknowledgeClientVersion(body: unknown): number | null {
  const parsed = dropshipPageVersionBodySchema.safeParse(body);
  if (!parsed.success) throw catalogNoticeInputInvalid(parsed.error);
  return parsed.data.clientVersion ?? null;
}

/** The acknowledge body, strict: the category and the arrival id the page was shown. The vendor is the session's. */
export function parseCatalogNoticeAcknowledgeBody(body: unknown): { categoryId: number; throughArrivalId: number } {
  const parsed = dropshipCatalogNoticeAcknowledgeRequestSchema.safeParse(body);
  if (!parsed.success) throw catalogNoticeInputInvalid(parsed.error);
  return { categoryId: parsed.data.categoryId, throughArrivalId: parsed.data.throughArrivalId };
}

/** Permanent (400): the paths of what failed only, never the values sent. */
function catalogNoticeInputInvalid(error: z.ZodError): DropshipError {
  return new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.newItemsInvalidInput, "The new-items notice request failed validation.", {
    issues: error.issues.map((issue) => issue.path.join(".") || issue.code),
    classification: "permanent",
    retryable: false,
  });
}
