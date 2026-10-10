import { keepPreviousData } from "@tanstack/react-query";
import type { z } from "zod";
import {
  LISTING_SETTINGS_PRICE_FILTERS,
  LISTING_SETTINGS_PRODUCT_FILTERS,
  listingSettingsPricesInputSchema,
  listingSettingsPricesResponseSchema,
  listingSettingsProductDetailSchema,
  listingSettingsProductInputSchema,
  listingSettingsProductsInputSchema,
  listingSettingsProductsResponseSchema,
  listingSettingsSummarySchema,
  type ListingSettingsPricesResponse,
  type ListingSettingsProductDetail,
  type ListingSettingsProductsResponse,
  type ListingSettingsSummary,
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

type ListingSettingsRead = "summary" | "products" | "prices" | "product";

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
