import type { QueryClient } from "@tanstack/react-query";
import { saveSizePricesResponseSchema, type SaveSizePricesInput, type SaveSizePricesResponse } from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsPricesResponse } from "@shared/dropship/listing-settings";
import { DropshipApiError, putJson, queryErrorMessage } from "./dropship-ops-surface";
import {
  LISTING_SETTINGS_OFF_CONTRACT,
  ListingSettingsReadError,
  listingSettingsPricesQueryOptions,
  listingSettingsQueryKey,
} from "./dropship-listing-settings";
import {
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  SIZE_PRICES_EDITOR_ID,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import { isStoreSizePriceQuery } from "./dropship-listing-settings-recipe";
import {
  noSizePricesRefusal,
  readSizePricesDraft,
  reloadTyped,
  SIZE_PRICES_REQUEST_INVALID,
  SIZE_PRICES_SHOW,
  SizePricesRequestError,
  sizePricesBody,
  sizePricesRefusalOf,
  sizePricesSaveRows,
  sizePricesSignature,
  type SizePriceRow,
  type SizePricesDraftValue,
  type SizePricesRefusal,
  type SizePricesReload,
} from "./dropship-listing-settings-size-prices";
import { LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";

/**
 * "Give these sizes a price"'s save (W8, `PUT …/listing-settings/size-prices`;
 * Listing settings PR 10f, plan 9.4, 9.5): the request, its answer's contract,
 * the re-reads after it, "Load latest" after a conflict, and the save run
 * from Save to settled, as `runProductSettingsSave` runs W5's.
 *
 * Rules this module keeps (plan D5, D6, D7, D9, D12; CC-C5):
 * - One request key per request (`ls-size-prices:…`), reused only while the
 *   request is the same, so a Check again is answered by the first save.
 * - One Save is one request of at most 200 typed sizes, all or none (D12).
 * - Each size's revision is the one its Prices row was read with (D6); a
 *   conflict's `actualRevisionId` is never reused (CC-C5): "Load latest" reads
 *   the loaded pages again and each typed size takes its new revision.
 * - A save's answer is checked, never shown or cached: the Prices pages, the
 *   Products list, the product details, the summary and every size price
 *   read are read again instead (D9).
 * - A Check again answered "not now" keeps its doubt (D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W8 route of one store (`S/interfaces/http/dropship-listing-setting-writes.routes.ts`). */
export function sizePricesEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/size-prices`;
}

/** PUT …/size-prices. Resolves with the server's answer, unread (D9). */
export function sendSizePrices(storeConnectionId: number, body: SaveSizePricesInput): Promise<unknown> {
  return putJson<unknown>(sizePricesEndpoint(storeConnectionId), body);
}

/**
 * A W8 answer checked against its contract, for the sizes it was sent for:
 * exactly those, each with a revision. Throws a ListingSettingsReadError
 * (`…_OFF_CONTRACT`) when it doesn't match: the save still stands (a 2xx),
 * only the page can't trust what it says.
 */
export function readSavedSizePrices(answer: unknown, sent: readonly SizePriceRow[]): SaveSizePricesResponse {
  const parsed = saveSizePricesResponseSchema.safeParse(answer);
  const sentIds = new Set(sent.map((row) => row.productVariantId));
  const sameSizes = parsed.success
    && parsed.data.sizes.length === sentIds.size
    && parsed.data.sizes.every((size) => sentIds.has(size.productVariantId));
  if (parsed.success && sameSizes) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W8",
      sizeCount: sent.length,
      issues: parsed.success
        ? [{ path: "sizes", code: "other_sizes" }]
        : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

export type SizePricesQueryClient = Pick<QueryClient, "cancelQueries" | "fetchQuery" | "invalidateQueries">;

/** The listing settings reads a size prices save changes (D9, plan 9.2): every Prices page, the Products list, every product's detail, the summary. */
const READS_AFTER_SIZE_PRICES = ["prices", "products", "product", "summary"] as const;

/**
 * After a confirmed save (D9): the reads above are marked stale and the
 * shown ones read now (prefixes: every page, every product; the sheet's
 * "Can't be priced" pages among them, so the saved sizes leave the list), and
 * so is every size price read of the store (W1's rule). Reads in flight are
 * cancelled first, so an older answer can't land after these. Never taken
 * from the answer. Throws when a refetch fails.
 */
export async function refreshAfterSizePricesSave(queryClient: SizePricesQueryClient, storeConnectionId: number): Promise<void> {
  const keys = READS_AFTER_SIZE_PRICES.map((read) => [...listingSettingsQueryKey(storeConnectionId), read] as const);
  await Promise.all(keys.map((queryKey) => queryClient.cancelQueries({ queryKey })));
  await Promise.all([
    ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey }, { throwOnError: true })),
    queryClient.invalidateQueries({ predicate: isStoreSizePriceQuery(storeConnectionId) }, { throwOnError: true }),
  ]);
}

/**
 * Reads the sheet's loaded pages (0..k) again, fresh (D9: never from a
 * save's answer; CC-C5: never a conflict's `actualRevisionId`). Reads in
 * flight are cancelled first. Throws when a read fails.
 */
export async function rereadSizePricesPages(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  pageCount: number,
): Promise<ListingSettingsPricesResponse[]> {
  const pages = Array.from({ length: Math.max(1, pageCount) }, (_, page) =>
    listingSettingsPricesQueryOptions(storeConnectionId, { search: "", show: SIZE_PRICES_SHOW, page }));
  await Promise.all(pages.map((options) => queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })));
  return Promise.all(pages.map((options) => queryClient.fetchQuery({ queryKey: options.queryKey, queryFn: options.queryFn, staleTime: 0, retry: false })));
}

/**
 * "Load latest and keep my changes" after a 409 (R:542, plan 9.5): reads the
 * loaded pages again, then gives the typed sizes on them (`reloadTyped`): each
 * still listed with its new revision, the rest dropped with the line. The
 * sheet sends `value`, then rebases on nothing typed; with nothing left
 * (`keeps` false) it discards the draft. Throws when a read fails.
 */
export async function loadLatestSizePrices(
  queryClient: Pick<QueryClient, "cancelQueries" | "fetchQuery">,
  storeConnectionId: number,
  pageCount: number,
  mine: SizePricesDraftValue,
): Promise<SizePricesReload> {
  return reloadTyped(mine, await rereadSizePricesPages(queryClient, storeConnectionId, pageCount));
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

export interface SizePricesSaveRun {
  storeConnectionId: number;
  /** The step's draft as the vendor pressed Save (or Check again): the typed sizes and the phase. */
  draft: ListingSettingsDraft;
  drafts: ProductSettingsSaveDrafts;
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: SaveSizePricesInput) => Promise<unknown>;
  /** Reads the views again (`refreshAfterSizePricesSave`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A save refused because of a block a banner explains. The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
}

export type SizePricesSaveOutcome =
  /** Nothing was sent: not the sheet's draft, nothing typed, another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  /** Nothing was sent: a box the parsers refuse (its row says why), or more than 200 typed (D12). */
  | { kind: "invalid"; message: string | null }
  /** Saved; the views are read again (D9). `sizeCount`: the sizes the save named. */
  | { kind: "saved"; viewStale: boolean; sizeCount: number }
  /** Shown by the sheet; `refusal` names the rows a limit refusal or a conflict marked (9.5). */
  | { kind: "failed"; failure: WriteFailure; refusal: SizePricesRefusal };

/**
 * One save of the typed prices, start to finish (plan 9.4, 9.5):
 * 1. the draft's typed sizes make the rows; with none, or a box the parsers
 *    refuse, or more than 200, nothing is sent;
 * 2. the page's pending-save counter starts, or the save does not;
 * 3. the draft takes the request key (`ls-size-prices`): the same request reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W8) and, for a Check again, keeps its doubt (D7b); what it
 *    names (the rows outside a limit, the sizes in conflict) goes back with it;
 * 5. a 2xx means saved. The views are read again (the answer is only checked);
 *    if that read or the check fails, the save still stands and the vendor sees
 *    "Saved. We couldn't load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runSizePricesSave(run: SizePricesSaveRun): Promise<SizePricesSaveOutcome> {
  const value = run.draft.editor === SIZE_PRICES_EDITOR_ID ? readSizePricesDraft(run.draft.value) : null;
  if (value === null) return { kind: "not_started", message: null };
  const rows = sizePricesSaveRows(value);
  if (!rows.ok) return rows.reason === "none" ? { kind: "not_started", message: null } : { kind: "invalid", message: rows.message };
  const signature = sizePricesSignature(run.storeConnectionId, rows.rows);
  // Read before the save starts: startSave turns the phase to "saving".
  const wasUncertain = run.draft.phase === "uncertain";

  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and Save works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.sizePrices);
    if (key === null) return { kind: "not_started", message: null };

    let body: SaveSizePricesInput;
    try {
      body = sizePricesBody({ key, rows: rows.rows });
    } catch (error) {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: error instanceof SizePricesRequestError ? error.message : LISTING_SETTINGS_EDIT_WORDS.cantBuild,
        code: SIZE_PRICES_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure, refusal: noSizePricesRefusal() };
    }

    let answer: unknown;
    try {
      answer = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W8", error);
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      const refusal = error instanceof DropshipApiError ? sizePricesRefusalOf(error.code, error.context) : noSizePricesRefusal();
      return { kind: "failed", failure, refusal };
    }

    let viewStale = false;
    try {
      // Checked for its contract only; what it says is never shown or cached (D9).
      readSavedSizePrices(answer, body.rows);
    } catch {
      // Deliberate: a 2xx saved, but the page and the server disagree on the answer. The views are
      // still read again, and the draft says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      await run.reread();
    } catch {
      // Deliberate: the save stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "saved", viewStale, sizeCount: body.rows.length };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
