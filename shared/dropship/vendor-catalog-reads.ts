import { z } from "zod";
import { MAX_NAMED_CATALOG_GROUP_ITEMS } from "./catalog-scope";

/**
 * The vendor catalog reads that step 1 plan S2-5 (PR A, §4.8) adds or extends,
 * as the server answers them and the page parses them: the catalog GET's new
 * query values and its `summary`, the `idsOnly` answer, the categories read and
 * the selection summary. The rows of the catalog GET keep their existing shape
 * (no shared schema; the step 1 client parses what it uses).
 *
 * These are answers, so none is strict: a field a later release adds is
 * dropped, never refused (a page left open across a release keeps working),
 * while a field the page needs that is missing still fails (CHK7; review
 * DUX13). The server sends what its parse returns, so nothing unlisted leaves.
 */

/** Which rows the catalog GET returns by their selection decision. `selectedOnly=true` is the one-release alias of `selected`. */
export const DROPSHIP_CATALOG_SELECTION_FILTERS = ["all", "selected", "not_selected"] as const;
export type DropshipCatalogSelectionFilter = (typeof DROPSHIP_CATALOG_SELECTION_FILTERS)[number];

/** What an `idsOnly` read is for: the ids to add (not selected) or to remove (selected). */
export const DROPSHIP_CATALOG_IDS_PURPOSES = ["add", "remove"] as const;
export type DropshipCatalogIdsPurpose = (typeof DROPSHIP_CATALOG_IDS_PURPOSES)[number];

/** The most sizes a vendor may have selected, and the longest id list an `idsOnly` read returns (D4). */
export const DROPSHIP_CATALOG_SELECTION_CAP = MAX_NAMED_CATALOG_GROUP_ITEMS;

export const DROPSHIP_CATALOG_READ_ERROR_CODES = {
  /** An unknown `selection`, `purpose`, flag or `clientVersion` value: never a fallback (CHK7). */
  queryInvalid: "DROPSHIP_CATALOG_QUERY_INVALID",
  /** The id list the purpose needs is longer than the cap (TESTS22). */
  idsTooMany: "DROPSHIP_CATALOG_IDS_TOO_MANY",
  /** A page newer than this server (CHK7); B's picks writes reuse the code for their readiness gate. */
  writesPaused: "DROPSHIP_SELECTION_WRITES_PAUSED",
  /** The store named by `storeConnectionId` is not one of the vendor's. */
  storeRequired: "DROPSHIP_STORE_CONNECTION_REQUIRED",
  /** The member's catalog read budget for the minute is spent. */
  rateLimited: "DROPSHIP_CATALOG_READ_RATE_LIMITED",
  /**
   * 410: the old rules save once PR B froze the rules (§4.9 item 2, D39). Stage 1's page, the server and its routes
   * all read it from here, so a rename on one side cannot silently break the other (review CT4).
   */
  rulesRetired: "DROPSHIP_SELECTION_RULES_RETIRED",
} as const;

/** The `reason` a catalog read answers a page that is newer than the server with (503, transient). */
export const DROPSHIP_PAGE_NEWER_THAN_SERVER_REASON = "page_newer_than_server";

const count = z.number().int().nonnegative();
const id = z.number().int().positive();

/** The catalog GET's counts for its filter, apart from `selection`: rows that match, and how many of them are selected. */
export const dropshipCatalogReadSummarySchema = z.object({
  matching: count,
  matchingSelected: count,
});
export type DropshipCatalogReadSummary = z.infer<typeof dropshipCatalogReadSummarySchema>;

/**
 * `GET /api/dropship/catalog?idsOnly=true&purpose=…`: the changeable sizes
 * (exposed and not turned off) that match the filter, ascending by id. A list
 * longer than the cap is `null`; the list the purpose needs is never null (the
 * read is refused instead).
 */
export const dropshipCatalogIdsAnswerSchema = z.object({
  selectedIds: z.array(id).max(DROPSHIP_CATALOG_SELECTION_CAP).nullable(),
  notSelectedIds: z.array(id).max(DROPSHIP_CATALOG_SELECTION_CAP).nullable(),
  total: count,
});
export type DropshipCatalogIdsAnswer = z.infer<typeof dropshipCatalogIdsAnswerSchema>;

/** `GET /api/dropship/catalog/categories`: every exposed size counted by category id, ignoring search and every filter (D26). */
export const dropshipCatalogCategoriesAnswerSchema = z.object({
  categories: z.array(z.object({
    categoryId: id,
    name: z.string(),
    rowCount: count,
    selectedCount: count,
  })),
  uncategorizedCount: count,
});
export type DropshipCatalogCategoriesAnswer = z.infer<typeof dropshipCatalogCategoriesAnswerSchema>;

/**
 * `GET /api/dropship/catalog/selection?storeConnectionId=`: the vendor's head
 * selection revision (what a publish run's `expectedSelectionRevisionId` must
 * equal) and the selected count, with the store's split into live and not live
 * when a store is named. `overCap` is `selectedTotal > cap`.
 */
export const dropshipCatalogSelectionSummarySchema = z.object({
  selectionRevisionId: id.nullable(),
  selectedTotal: count,
  cap: z.literal(DROPSHIP_CATALOG_SELECTION_CAP),
  overCap: z.boolean(),
  store: z.object({
    storeConnectionId: id,
    live: count,
    notLive: count,
  }).nullable(),
}).refine((summary) => summary.overCap === summary.selectedTotal > summary.cap, {
  message: "overCap must equal selectedTotal > cap.",
}).refine((summary) => summary.store === null || summary.store.live + summary.store.notLive === summary.selectedTotal, {
  message: "A store's live and not live counts add up to the selected total.",
});
export type DropshipCatalogSelectionSummary = z.infer<typeof dropshipCatalogSelectionSummarySchema>;
