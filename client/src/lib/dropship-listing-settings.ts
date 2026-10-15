import { keepPreviousData } from "@tanstack/react-query";
import type { z } from "zod";
import {
  LISTING_SETTINGS_PRICE_FILTERS,
  LISTING_SETTINGS_PRODUCT_FILTERS,
  listingSettingsCategoriesResponseSchema,
  listingSettingsCategoryDetailSchema,
  listingSettingsCategoryInputSchema,
  listingSettingsPricesInputSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductIdsInputSchema,
  listingSettingsProductIdsResponseSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductOwnSettingsSchema,
  listingSettingsProductsInputSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsStoreInputSchema,
  listingSettingsSummarySchema,
  listingSettingsUpdatedProductsInputSchema,
  listingSettingsUpdatedProductsResponseSchema,
  type ListingSettingsCategoriesResponse,
  type ListingSettingsCategoryDetail,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductDetail,
  type ListingSettingsProductIdsResponse,
  type ListingSettingsProductOwnSettings,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
  type ListingSettingsUpdatedProductsResponse,
} from "@shared/dropship/listing-settings";
import { fetchJson } from "./dropship-ops-surface";

/**
 * The Listing settings read model as the Catalog page reads it (design 8.4,
 * 8.9; Listing settings PR 7, plan 4.2). Contract: shared/dropship/listing-settings.ts.
 * Every request is checked against the contract's input schema before it is
 * sent, and every answer against its response schema, so the page never asks
 * for something the server would refuse and never shows a value the server
 * did not promise.
 *
 * Every read lives under `listingSettingsQueryKey(store)`, so invalidating
 * that prefix after a save refreshes them all. No read retries out of sight:
 * a failed read says so, with Try again.
 */

/** Saves on this page invalidate the reads at once; the server's own view is at most 60 seconds old. */
const LISTING_SETTINGS_STALE_MS = 60_000;

/** An answer that does not match its contract: the page and the server disagree, so nothing from it is shown. */
export const LISTING_SETTINGS_OFF_CONTRACT = "DROPSHIP_LISTING_SETTINGS_OFF_CONTRACT";
/** A read this page would send outside the contract (a bad page number, a search over 100 characters). */
export const LISTING_SETTINGS_INVALID_REQUEST = "DROPSHIP_LISTING_SETTINGS_INVALID_REQUEST";

/** A listing settings read that failed on this side, with a namespaced code and what was being read. */
export class ListingSettingsReadError extends Error {
  readonly code: typeof LISTING_SETTINGS_OFF_CONTRACT | typeof LISTING_SETTINGS_INVALID_REQUEST;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(input: {
    code: ListingSettingsReadError["code"];
    message: string;
    context: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = "ListingSettingsReadError";
    this.code = input.code;
    this.context = Object.freeze({ ...input.context });
  }
}

type ListingSettingsRead = "summary" | "products" | "prices" | "product" | "product-own" | "product-ids" | "updated-products" | "categories" | "category";

/** At most this many contract issues are kept on the error: enough to find the field, never the values. */
const MAX_REPORTED_ISSUES = 5;

function listingSettingsPath(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings`;
}

/** The prefix of every listing settings read for one store: invalidating it refreshes them all. */
export function listingSettingsQueryKey(storeConnectionId: number) {
  return ["/api/dropship/listings/stores", storeConnectionId, "listing-settings"] as const;
}

/** Fetches one read and checks the answer against its contract. */
async function readListingSettings<T>(
  read: ListingSettingsRead,
  url: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  signal: AbortSignal,
): Promise<T> {
  // fetchJson throws a DropshipApiError (status, code, context) for a refused or failed request.
  const parsed = schema.safeParse(await fetchJson<unknown>(url, { signal }));
  if (parsed.success) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      read,
      // Only where the answer broke the contract, never what it held.
      issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

function invalidRequest(read: ListingSettingsRead, error: z.ZodError): ListingSettingsReadError {
  return new ListingSettingsReadError({
    code: LISTING_SETTINGS_INVALID_REQUEST,
    message: "This list can't be checked as asked. Clear the search and try again.",
    context: { read, fields: [...new Set(error.issues.map((issue) => issue.path.join(".")))] },
  });
}

function isStoreId(storeConnectionId: number): boolean {
  return Number.isInteger(storeConnectionId) && storeConnectionId > 0;
}

export function listingSettingsSummaryQueryOptions(storeConnectionId: number) {
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "summary"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsSummary> =>
      readListingSettings("summary", `${listingSettingsPath(storeConnectionId)}/summary`, listingSettingsSummarySchema, signal),
    enabled: isStoreId(storeConnectionId),
    staleTime: LISTING_SETTINGS_STALE_MS,
    // A failed check says "Couldn't check" with Try again, rather than retrying out of sight.
    retry: false,
  } as const;
}

export type ListingSettingsProductFilter = (typeof LISTING_SETTINGS_PRODUCT_FILTERS)[number];
export type ListingSettingsPriceFilter = (typeof LISTING_SETTINGS_PRICE_FILTERS)[number];

/** What a list shows: the search (server side), the filter and the page (from 0). Missing parts take the contract's defaults. */
export interface ListingSettingsListQuery<Show extends string> {
  search?: string;
  show?: Show;
  page?: number;
}

export interface ListingSettingsReadOptions {
  /** False keeps the read from running (the tab or the drawer is closed). */
  enabled?: boolean;
}

/**
 * The request a list sends, checked against the contract's input schema. The
 * key is built from the checked request, so "toploader " and "toploader"
 * share one cached answer.
 */
function listRequest<Show extends string>(
  schema: typeof listingSettingsProductsInputSchema | typeof listingSettingsPricesInputSchema,
  storeConnectionId: number,
  query: ListingSettingsListQuery<Show>,
) {
  const raw = { storeConnectionId, search: query.search ?? "", show: query.show ?? "all", page: query.page ?? 0 };
  const parsed = schema.safeParse(raw);
  return parsed.success
    ? { ok: true as const, key: { search: parsed.data.search, show: parsed.data.show, page: parsed.data.page }, input: parsed.data }
    : { ok: false as const, key: { search: raw.search, show: raw.show, page: raw.page }, error: parsed.error };
}

/** `…/products?search=&show=&page=`, in that order. URLSearchParams encodes spaces, quotes and the rest. */
function listUrl(storeConnectionId: number, list: "products" | "prices", input: { search: string; show: string; page: number }): string {
  const params = new URLSearchParams({ search: input.search, show: input.show, page: String(input.page) });
  return `${listingSettingsPath(storeConnectionId)}/${list}?${params.toString()}`;
}

/** The Products tab: one row per chosen product, 50 a page. */
export function listingSettingsProductsQueryOptions(
  storeConnectionId: number,
  query: ListingSettingsListQuery<ListingSettingsProductFilter>,
  options: ListingSettingsReadOptions = {},
) {
  const request = listRequest(listingSettingsProductsInputSchema, storeConnectionId, query);
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "products", request.key] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsProductsResponse> => {
      // `refetch()` runs even a disabled read, so a request outside the contract is refused here too.
      if (!request.ok) throw invalidRequest("products", request.error);
      return readListingSettings("products", listUrl(storeConnectionId, "products", request.input),
        listingSettingsProductsResponseSchema, signal);
    },
    enabled: (options.enabled ?? true) && request.ok,
    staleTime: LISTING_SETTINGS_STALE_MS,
    // The page being left stays on screen while the next one loads, so the list never jumps to empty.
    placeholderData: keepPreviousData,
    retry: false,
  } as const;
}

/** The Prices tab: one row per chosen size, 50 a page. */
export function listingSettingsPricesQueryOptions(
  storeConnectionId: number,
  query: ListingSettingsListQuery<ListingSettingsPriceFilter>,
  options: ListingSettingsReadOptions = {},
) {
  const request = listRequest(listingSettingsPricesInputSchema, storeConnectionId, query);
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "prices", request.key] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsPricesResponse> => {
      if (!request.ok) throw invalidRequest("prices", request.error);
      return readListingSettings("prices", listUrl(storeConnectionId, "prices", request.input),
        listingSettingsPricesResponseSchema, signal);
    },
    enabled: (options.enabled ?? true) && request.ok,
    staleTime: LISTING_SETTINGS_STALE_MS,
    placeholderData: keepPreviousData,
    retry: false,
  } as const;
}

/** One product's settings in full, with each size's price and live stock (the drawer). */
export function listingSettingsProductQueryOptions(
  storeConnectionId: number,
  productId: number,
  options: ListingSettingsReadOptions = {},
) {
  const parsed = listingSettingsProductInputSchema.safeParse({ storeConnectionId, productId });
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "product", productId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsProductDetail> => {
      if (!parsed.success) throw invalidRequest("product", parsed.error);
      return readListingSettings("product",
        `${listingSettingsPath(parsed.data.storeConnectionId)}/products/${parsed.data.productId}`,
        listingSettingsProductDetailSchema, signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    staleTime: LISTING_SETTINGS_STALE_MS,
    retry: false,
  } as const;
}

/**
 * One product's own settings, for its editor (the drawer, PR 10 plan 4.3):
 * what its own row stores, with stored names and texts, and the revision a
 * product save sends back. Read fresh whenever the drawer is open (staleTime
 * 0): the drawer's start and revision come from this one answer. An answer for
 * another store or product is off the contract.
 */
export function listingSettingsProductOwnQueryOptions(
  storeConnectionId: number,
  productId: number,
  options: ListingSettingsReadOptions = {},
) {
  const parsed = listingSettingsProductInputSchema.safeParse({ storeConnectionId, productId });
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "product-own", productId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsProductOwnSettings> => {
      if (!parsed.success) throw invalidRequest("product-own", parsed.error);
      const { storeConnectionId: store, productId: product } = parsed.data;
      return readListingSettings("product-own", `${listingSettingsPath(store)}/products/${product}/own`,
        listingSettingsProductOwnSettingsSchema.refine(
          (answer) => answer.storeConnectionId === store && answer.productId === product,
          { message: "The answer is for another store or product.", path: ["productId"] },
        ), signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    // The editor starts from what is saved now.
    staleTime: 0,
    retry: false,
  } as const;
}

/**
 * Which products' ids and revisions a "Set for selected" sheet reads
 * (`GET …/products/ids`, PR 10 plan 6.4): the Products tab's search and
 * filter for "Select all N", else every chosen product (the ticks are picked
 * from it, `pickSelected`). `categoryId` and `productId` narrow it further.
 */
export interface ListingSettingsProductIdsRequest {
  search?: string;
  show?: ListingSettingsProductFilter;
  categoryId?: number;
  productId?: number;
}

/**
 * Every product the request matches, unpaged (up to 10,000), each with its
 * own settings' revision: W6 sends each one back (D6). Read fresh when the
 * sheet opens (staleTime 0), so the revisions are the ones the save compares.
 * The key is built from the checked request, as the lists' are.
 */
export function listingSettingsProductIdsQueryOptions(
  storeConnectionId: number,
  request: ListingSettingsProductIdsRequest,
  options: ListingSettingsReadOptions = {},
) {
  const raw = {
    storeConnectionId,
    search: request.search ?? "",
    show: request.show ?? "all",
    ...(request.categoryId === undefined ? {} : { categoryId: request.categoryId }),
    ...(request.productId === undefined ? {} : { productId: request.productId }),
  };
  const parsed = listingSettingsProductIdsInputSchema.safeParse(raw);
  const source = parsed.success ? parsed.data : raw;
  const asked = {
    search: source.search,
    show: source.show,
    ...(source.categoryId === undefined ? {} : { categoryId: source.categoryId }),
    ...(source.productId === undefined ? {} : { productId: source.productId }),
  };
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "product-ids", asked] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsProductIdsResponse> => {
      if (!parsed.success) throw invalidRequest("product-ids", parsed.error);
      const input = parsed.data;
      const params = new URLSearchParams({ search: input.search, show: input.show });
      if (input.categoryId !== undefined) params.set("categoryId", String(input.categoryId));
      if (input.productId !== undefined) params.set("productId", String(input.productId));
      return readListingSettings("product-ids", `${listingSettingsPath(input.storeConnectionId)}/products/ids?${params.toString()}`,
        listingSettingsProductIdsResponseSchema, signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    // The sheet's revisions are the ones read as it opens (D6).
    staleTime: 0,
    // Dropped as soon as the sheet closes (its fetchQuery calls pass the same gcTime, which query-core would
    // otherwise raise to 5 minutes), so the next opening reads again; the sheet also waits for a read made
    // after it opened before it sets up its draft.
    gcTime: 0,
    retry: false,
  } as const;
}

export interface ListingSettingsUpdatedProductsReadOptions extends ListingSettingsReadOptions {
  /**
   * True reads fresh each time it mounts (staleTime 0): the open sheet, whose
   * "Got it" items come from this answer (plan PR 10, D6, D10). False (the
   * default) is a list read, at most 60 seconds old: the line under the
   * attention strip.
   */
  fresh?: boolean;
}

/**
 * The products Card Shellz updated (`GET …/updated-products?page=N`, PR 10
 * plan 10.2, 10.4): moved to another category since the vendor last
 * confirmed it, or whose own text needs a check, 50 a page, with every moved
 * product's "Got it" item. The key is built from the checked page, under the
 * store's prefix (D10). The caller keeps it off while the selection is too
 * large (D18): the server refuses it with the lists' 422 then.
 */
export function listingSettingsUpdatedProductsQueryOptions(
  storeConnectionId: number,
  page: number,
  options: ListingSettingsUpdatedProductsReadOptions = {},
) {
  const parsed = listingSettingsUpdatedProductsInputSchema.safeParse({ storeConnectionId, page });
  const asked = parsed.success ? parsed.data.page : page;
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "updated-products", asked] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsUpdatedProductsResponse> => {
      if (!parsed.success) throw invalidRequest("updated-products", parsed.error);
      const { storeConnectionId: store, page: wanted } = parsed.data;
      const params = new URLSearchParams({ page: String(wanted) });
      return readListingSettings("updated-products", `${listingSettingsPath(store)}/updated-products?${params.toString()}`,
        listingSettingsUpdatedProductsResponseSchema.refine(
          (answer) => answer.storeConnectionId === store && answer.page === wanted,
          { message: "The answer is for another store or page.", path: ["page"] },
        ), signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    staleTime: options.fresh === true ? 0 : LISTING_SETTINGS_STALE_MS,
    retry: false,
  } as const;
}

/**
 * The Card Shellz categories of the store's chosen products (`GET
 * …/categories`, PR 10 plan 8.2, 8.5): each with what it sets, in the stored
 * shape's order, and its settings revision; the Category settings card's read,
 * made at mount with the lists (D18). A list read, at most 60 seconds old,
 * under the store's prefix (D10). The caller keeps it off while the selection
 * is too large (D18): the server refuses it with the lists' 422 then.
 */
export function listingSettingsCategoriesQueryOptions(storeConnectionId: number, options: ListingSettingsReadOptions = {}) {
  const parsed = listingSettingsStoreInputSchema.safeParse({ storeConnectionId });
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "categories"] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsCategoriesResponse> => {
      if (!parsed.success) throw invalidRequest("categories", parsed.error);
      const { storeConnectionId: store } = parsed.data;
      return readListingSettings("categories", `${listingSettingsPath(store)}/categories`,
        listingSettingsCategoriesResponseSchema.refine(
          (answer) => answer.storeConnectionId === store,
          { message: "The answer is for another store.", path: ["storeConnectionId"] },
        ), signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    staleTime: LISTING_SETTINGS_STALE_MS,
    retry: false,
  } as const;
}

/**
 * One Card Shellz category's settings in full (`GET …/categories/:categoryId`,
 * PR 10 plan 8.2, 8.5): each setting with where it comes from, the chosen
 * products that hold their own value in one ("Also clear theirs", with the
 * revisions it sends back) and the category's revision (W12's
 * `expectedRevisionId`), for its editor. Read fresh whenever the editor is
 * open (staleTime 0): the editor's start, its revision and its clear set come
 * from this one answer (D6). An answer for another store or category is off
 * the contract.
 */
export function listingSettingsCategoryQueryOptions(
  storeConnectionId: number,
  categoryId: number,
  options: ListingSettingsReadOptions = {},
) {
  const parsed = listingSettingsCategoryInputSchema.safeParse({ storeConnectionId, categoryId });
  return {
    queryKey: [...listingSettingsQueryKey(storeConnectionId), "category", categoryId] as const,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ListingSettingsCategoryDetail> => {
      if (!parsed.success) throw invalidRequest("category", parsed.error);
      const { storeConnectionId: store, categoryId: category } = parsed.data;
      return readListingSettings("category", `${listingSettingsPath(store)}/categories/${category}`,
        listingSettingsCategoryDetailSchema.refine(
          (answer) => answer.storeConnectionId === store && answer.categoryId === category,
          { message: "The answer is for another store or category.", path: ["categoryId"] },
        ), signal);
    },
    enabled: (options.enabled ?? true) && parsed.success,
    // The editor starts from what is saved now.
    staleTime: 0,
    retry: false,
  } as const;
}
