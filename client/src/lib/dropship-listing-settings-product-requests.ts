import type { QueryClient } from "@tanstack/react-query";
import { saveProductSettingsResponseSchema, type SaveProductSettingsResponse } from "@shared/dropship/listing-setting-writes";
import type { ListingSettingsProductDetail } from "@shared/dropship/listing-settings";
import { queryErrorMessage } from "./dropship-ops-surface";
import {
  LISTING_SETTINGS_OFF_CONTRACT,
  ListingSettingsReadError,
  listingSettingsProductOwnQueryOptions,
  listingSettingsProductQueryOptions,
} from "./dropship-listing-settings";
import {
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  productEditorId,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import { LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";
import {
  changedFields,
  PRODUCT_SETTINGS_REQUEST_INVALID,
  productSettingsPatch,
  productSettingsSaveBody,
  productSettingsSignature,
  readProductSettingsDraft,
  rebaseProductSettingsDraft,
  sizeLeftoverFields,
  type ProductOwnSettings,
  type ProductSettingsDraftValue,
  type ProductSettingsReload,
  type ProductSettingsSaveBody,
} from "./dropship-listing-settings-product-edit";

/**
 * One product's own settings save from its drawer (W5, `PUT
 * …/listing-settings/products/:productId`; Listing settings PR 10, plan 4.6):
 * the request, its answer's contract, the re-reads after it, and the save run
 * from Save to settled, as `runSizePriceSave` runs W9's.
 *
 * Rules this module keeps (plan D5, D7, D9):
 * - One request key per request (`ls-product:…`), reused only while the
 *   request is the same, so a Check again is answered by the first save.
 * - A save's answer is checked, never shown or cached: the drawer's two reads
 *   (the product detail and its own settings) are read again instead.
 * - A Check again answered "not now" keeps its doubt (D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W5 route for one product. */
export function productSettingsEndpoint(storeConnectionId: number, productId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/products/${productId}`;
}

/**
 * A W5 answer checked against its contract, for the product it was sent for.
 * Throws a ListingSettingsReadError (`…_OFF_CONTRACT`) when it doesn't match:
 * the save still stands (a 2xx), only the page can't trust what it says.
 */
export function readSavedProductSettings(answer: unknown, productId: number): SaveProductSettingsResponse {
  const parsed = saveProductSettingsResponseSchema.safeParse(answer);
  if (parsed.success && parsed.data.productId === productId) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W5",
      productId,
      issues: parsed.success
        ? [{ path: "productId", code: "other_product" }]
        : parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

export type ProductSettingsQueryClient = Pick<QueryClient, "cancelQueries" | "fetchQuery">;

/**
 * Reads the product's detail and own settings again (D9: never from a save's
 * answer, which a replay gives with the first save's revision). Reads in
 * flight are cancelled first, so an older answer can't land after these.
 * Throws when either read fails.
 */
export async function rereadProductSettings(
  queryClient: ProductSettingsQueryClient,
  storeConnectionId: number,
  productId: number,
): Promise<{ detail: ListingSettingsProductDetail; own: ProductOwnSettings }> {
  const detailOptions = listingSettingsProductQueryOptions(storeConnectionId, productId);
  const ownOptions = listingSettingsProductOwnQueryOptions(storeConnectionId, productId);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: detailOptions.queryKey, exact: true }),
    queryClient.cancelQueries({ queryKey: ownOptions.queryKey, exact: true }),
  ]);
  const [detail, own] = await Promise.all([
    queryClient.fetchQuery({ queryKey: detailOptions.queryKey, queryFn: detailOptions.queryFn, staleTime: 0, retry: false }),
    queryClient.fetchQuery({ queryKey: ownOptions.queryKey, queryFn: ownOptions.queryFn, staleTime: 0, retry: false }),
  ]);
  return { detail, own };
}

/**
 * "Load latest and keep my changes" after a 409 (R:542, plan 4.7): reads both
 * again, then gives the vendor's choices on what is saved now and the fields
 * another window changed too. The drawer sends `edited`, then rebases on
 * `latest` with `marked`; with nothing left to keep (`keeps` false) it
 * discards the draft. A size's leftover in the detail read with it keeps a
 * choice a change. Throws when a read fails.
 */
export async function loadLatestProductSettings(
  queryClient: ProductSettingsQueryClient,
  storeConnectionId: number,
  productId: number,
  mine: ProductSettingsDraftValue,
): Promise<ProductSettingsReload> {
  const { detail, own } = await rereadProductSettings(queryClient, storeConnectionId, productId);
  return rebaseProductSettingsDraft(mine, own, sizeLeftoverFields(detail.settings));
}

// ---------------------------------------------------------------------------
// Running a save
// ---------------------------------------------------------------------------

/** The page's pending-save counter (D10): it holds back a queue or push while a save runs. */
export interface ProductSettingsSaveCallbacks {
  disabled?: boolean;
  /** Throws when another listing action is running; then nothing is sent. */
  onSaveStarted: () => void;
  onSaveSettled: () => void;
}

/** The draft provider's two save calls (ListingSettingsDraftsProvider). */
export interface ProductSettingsSaveDrafts {
  startSave: (signature: string, keyPrefix: string) => string | null;
  settle: (
    key: string,
    settlement: { kind: "saved" } | { kind: "saved_view_stale" } | { kind: "failure"; failure: WriteFailure },
  ) => void;
}

export interface ProductSettingsSaveRun {
  storeConnectionId: number;
  productId: number;
  /** For the 404's words: "This product isn't chosen for <store>." */
  storeName: string;
  /** This product's draft as the vendor pressed Save (or Check again): its settings and its phase. */
  draft: ListingSettingsDraft;
  drafts: ProductSettingsSaveDrafts;
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: ProductSettingsSaveBody) => Promise<unknown>;
  /** Reads the detail and the own settings again (`rereadProductSettings`). */
  reread: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. Never given a refusal (D8). */
  onBlocked?: (error: unknown) => void;
}

export type ProductSettingsSaveOutcome =
  /** Nothing was sent: no change, another action is running, or no save can start now. */
  | { kind: "not_started"; message: string | null }
  | { kind: "saved"; viewStale: boolean }
  | { kind: "failed"; failure: WriteFailure };

/**
 * One save of a product's own settings, start to finish (plan 4.6):
 * 1. the draft's choices make the patch; with none, nothing is sent;
 * 2. the page's pending-save counter starts, or the save does not;
 * 3. the draft takes the request key (`ls-product`): the same request reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W5) and, for a Check again, keeps its doubt (D7b);
 * 5. a 2xx means saved. The detail and the own settings are read again (the
 *    answer is only checked); if that read or the check fails, the save still
 *    stands and the vendor sees "Saved. We couldn't load the latest view.";
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runProductSettingsSave(run: ProductSettingsSaveRun): Promise<ProductSettingsSaveOutcome> {
  const value = run.draft.editor === productEditorId(run.productId) ? readProductSettingsDraft(run.draft.value) : null;
  if (value === null || changedFields(value).length === 0) return { kind: "not_started", message: null };
  const patch = productSettingsPatch(value);
  const signature = productSettingsSignature(run.storeConnectionId, run.productId, value.expectedRevisionId, patch);
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
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.productSettings);
    if (key === null) return { kind: "not_started", message: null };

    let body: ProductSettingsSaveBody;
    try {
      body = productSettingsSaveBody({ key, expectedRevisionId: value.expectedRevisionId, patch });
    } catch {
      // Never sent; the next try gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.cantBuild, code: PRODUCT_SETTINGS_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure };
    }

    let answer: unknown;
    try {
      answer = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W5", error, { storeName: run.storeName });
      const failure = failureAfterUnconfirmed(wasUncertain, classified);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      return { kind: "failed", failure };
    }

    let viewStale = false;
    try {
      // Checked for its contract only; what it says is never shown or cached (D9).
      readSavedProductSettings(answer, run.productId);
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
    return { kind: "saved", viewStale };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
