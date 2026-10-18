import type { QueryClient } from "@tanstack/react-query";
import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionApplyInputSchema,
  listingRulesConversionApplyResponseSchema,
  type ListingRulesConversionApplyInput,
  type ListingRulesConversionApplyResponse,
  type ListingRulesConversionCheck,
} from "@shared/dropship/listing-rules-conversion";
import { DropshipApiError, postJson, queryErrorMessage } from "./dropship-ops-surface";
import { LISTING_SETTINGS_OFF_CONTRACT, ListingSettingsReadError, listingSettingsQueryKey } from "./dropship-listing-settings";
import { contentProfileQueryKey, ebayCategoryRulesQueryKey } from "./dropship-listing-settings-content-requests";
import {
  CONVERSION_EDITOR_ID,
  CONVERSION_UNCONFIRMED_WORDS,
  classifyWriteFailure,
  failureAfterUnconfirmed,
  LISTING_SETTINGS_KEY_PREFIXES,
  type DraftValue,
  type ListingSettingsDraft,
  type WriteFailure,
} from "./dropship-listing-settings-drafts";
import { DRAWER_WORDS } from "./dropship-listing-settings-drawer";
import type { ProductSettingsSaveCallbacks, ProductSettingsSaveDrafts } from "./dropship-listing-settings-product-requests";
import { isStoreSizePriceQuery, pricingRulesQueryKey } from "./dropship-listing-settings-recipe";
import { LISTING_SETTINGS_EDIT_WORDS } from "./dropship-listing-settings-words";

/**
 * [Move them over] in "Your older group rules" (W11, `POST
 * …/listing-settings/conversion/apply`; Listing settings PR 11d, plan 8.2,
 * 8.3, 8.4): the request, its answer's contract, the re-reads after it, and
 * the run from the button to settled, as `runCategoryMovesAcknowledge` runs
 * W13's.
 *
 * Rules this module keeps (plan D1, D12, 8.3, 8.4; PLAN10 D5, D7, D9):
 * - Nothing is sent that the vendor didn't press, and never without the two
 *   hashes of the page 0 he pressed it on (`conversionDraftValue`): the
 *   server keeps no copy of the plan it showed, so it recomputes both under
 *   the store lock and writes only when they are these (D1).
 * - One request key per plan shown (`ls-convert:…`, its signature the
 *   store and the two hashes), reused only while the plan is the same, so a
 *   Check again is answered by the first send (D12, PLAN10 D5).
 * - A refusal that says the plan moved (409 CHANGED, the three 422 blocks,
 *   409 IDEMPOTENCY_CONFLICT) reads page 0 again and sends nothing more: the
 *   vendor presses once more on the new hashes, with a new key (8.3).
 * - An answer is checked against its contract, never shown or cached: every
 *   view the move changed is read again instead (8.4).
 * - A Check again answered "not now" keeps its doubt (PLAN10 D7b).
 *
 * The network calls and the query client are passed in, so every step can be
 * run in a test.
 */

/** The W11 route of one store (`S/interfaces/http/dropship-listing-setting-writes.routes.ts`). */
export function conversionApplyEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/conversion/apply`;
}

/** POST …/conversion/apply. Resolves with the server's answer, unread (8.4). */
export function sendConversionApply(storeConnectionId: number, body: ListingRulesConversionApplyInput): Promise<unknown> {
  return postJson<unknown>(conversionApplyEndpoint(storeConnectionId), body);
}

/**
 * A W11 answer checked against its strict contract
 * (`listingRulesConversionApplyResponseSchema`). Throws a
 * ListingSettingsReadError (`…_OFF_CONTRACT`) when it doesn't match: the move
 * still stands (a 2xx), only the page can't trust what it says.
 */
export function readConversionApplyAnswer(answer: unknown): ListingRulesConversionApplyResponse {
  const parsed = listingRulesConversionApplyResponseSchema.safeParse(answer);
  if (parsed.success) return parsed.data;
  throw new ListingSettingsReadError({
    code: LISTING_SETTINGS_OFF_CONTRACT,
    message: "This page couldn't read Card Shellz's answer. Reload the page and try again.",
    context: {
      write: "W11",
      issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    },
  });
}

// ---------------------------------------------------------------------------
// The draft (plan 8.2: a no-change sheet draft, the W13 pattern)
// ---------------------------------------------------------------------------

/** The sheet's draft value: the two hashes of the page 0 the vendor pressed [Move them over] on, as base and value alike. */
export type ConversionDraftValue = { planHash: string; writesHash: string };

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * The move a press on page 0 sends (D1): its two hashes, or null when page 0
 * holds no plan (`no_older_rules`, both hashes null). Never anything else:
 * the client computes no plan.
 */
export function conversionDraftValue(check: Pick<ListingRulesConversionCheck, "planHash" | "writesHash">): ConversionDraftValue | null {
  if (check.planHash === null || check.writesHash === null) return null;
  return Object.freeze({ planHash: check.planHash, writesHash: check.writesHash });
}

/** The sheet's draft value, or null when `value` is not one (another editor's draft, or hashes the contract refuses). */
export function readConversionDraft(value: DraftValue): ConversionDraftValue | null {
  const { planHash, writesHash } = value;
  if (typeof planHash !== "string" || typeof writesHash !== "string" || !SHA256_HEX.test(planHash) || !SHA256_HEX.test(writesHash)) return null;
  return { planHash, writesHash };
}

/** Whether the step's one draft is a move (sent, unconfirmed, refused or just confirmed). */
export function isConversionDraft(draft: Pick<ListingSettingsDraft, "editor"> | null): boolean {
  return draft !== null && draft.editor === CONVERSION_EDITOR_ID;
}

/**
 * What a move sends, as the draft's attempt signature (D12, PLAN10 D5): the
 * store and both hashes. The plan hash covers the writes hash (plan 3.3), so
 * this is "one key per plan hash", the store named so a key never crosses
 * stores.
 */
export function conversionSignature(storeConnectionId: number, value: ConversionDraftValue): string {
  return JSON.stringify({ v: 1, writer: "W11", storeConnectionId, planHash: value.planHash, writesHash: value.writesHash });
}

/**
 * The held move a press for `value` sends again with its kept key (PLAN10
 * D5; plan 8.3 "the key is kept"): the step's draft is a move of the same
 * plan that was rate limited or never reached the server (BUSY with a
 * reason, the costs unreadable). Null when the press is a new request,
 * which opens the draft afresh and gets a new key; a move out or
 * unconfirmed is never pressed again from [Move them over] (its own
 * [Check again] checks it).
 */
export function heldConversionFor(draft: ListingSettingsDraft | null, storeConnectionId: number, value: ConversionDraftValue): ListingSettingsDraft | null {
  if (draft === null || !isConversionDraft(draft) || draft.attempt === null) return null;
  if (draft.phase !== "rate_limited" && draft.phase !== "unreachable") return null;
  return draft.attempt.signature === conversionSignature(storeConnectionId, value) ? draft : null;
}

/** A move this page could not build; it was never sent. */
export const CONVERSION_REQUEST_INVALID = "DROPSHIP_LISTING_SETTINGS_CONVERSION_REQUEST_INVALID";

export class ConversionRequestError extends Error {
  readonly code = CONVERSION_REQUEST_INVALID;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(message: string, context: Record<string, unknown>) {
    super(message);
    this.name = "ConversionRequestError";
    this.context = Object.freeze({ ...context });
  }
}

/**
 * The W11 request, checked against the shared input schema before it is sent
 * (plan 7.B.2; the key shape and the reserved prefixes, listing-rules-conversion-keys.ts).
 * What is sent is the schema's output.
 */
export function conversionApplyBody(input: { key: string; value: ConversionDraftValue }): ListingRulesConversionApplyInput {
  const parsed = listingRulesConversionApplyInputSchema.safeParse({
    idempotencyKey: input.key, planHash: input.value.planHash, writesHash: input.value.writesHash,
  });
  if (parsed.success) return parsed.data;
  throw new ConversionRequestError("This can't be sent as it is. Reload the page and try again.", {
    issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

// ---------------------------------------------------------------------------
// Re-reads (plan 8.4, 11.5)
// ---------------------------------------------------------------------------

export type ConversionQueryClient = Pick<QueryClient, "cancelQueries" | "invalidateQueries">;

/**
 * The reads a confirmed move changes (8.4): the whole listing-settings prefix
 * (the summary, the categories, the products, the prices, every product's
 * reads and the dry run's pages), the pricing rules, the eBay category rules
 * and the description profile the step's store-default editors read (so an
 * open editor reads the new revisions instead of saving onto old ones;
 * CFC#10), and every size price read of the store (W1's rule).
 */
export function conversionRereadKeys(storeConnectionId: number): ReadonlyArray<readonly unknown[]> {
  return [
    listingSettingsQueryKey(storeConnectionId),
    pricingRulesQueryKey(storeConnectionId),
    ebayCategoryRulesQueryKey(storeConnectionId),
    contentProfileQueryKey(storeConnectionId),
  ];
}

/**
 * After a confirmed move (8.4): the reads above are marked stale, so the shown
 * ones read now and the rest on their next mount (invalidations: a query
 * refetches only if mounted, so a closed editor sends nothing).
 * Reads in flight are cancelled first, so an older answer can't land after
 * these. Never taken from the answer. Throws when a refetch fails.
 */
export async function rereadAfterConversion(queryClient: ConversionQueryClient, storeConnectionId: number): Promise<void> {
  const keys = conversionRereadKeys(storeConnectionId);
  const sizePrices = isStoreSizePriceQuery(storeConnectionId);
  await Promise.all([
    ...keys.map((queryKey) => queryClient.cancelQueries({ queryKey: [...queryKey] })),
    queryClient.cancelQueries({ predicate: sizePrices }),
  ]);
  await Promise.all([
    ...keys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [...queryKey] }, { throwOnError: true })),
    queryClient.invalidateQueries({ predicate: sizePrices }, { throwOnError: true }),
  ]);
}

const CONVERSION_CODES = LISTING_RULES_CONVERSION_ERROR_CODES;
const STORE_TEXT_LIMIT = "store_text_limit";

/**
 * The refusals after which page 0 is read again (8.3): the plan moved (409
 * CHANGED, either reason), a block the plan shown didn't have (422
 * WOULD_BE_LOST, WOULD_BLOCK_LISTING, the store text cap), or the key went
 * with another plan (409 IDEMPOTENCY_CONFLICT). The new page 0 brings the new
 * hashes and the blocked section; nothing is sent until the vendor presses.
 */
export function conversionRefusalReadsCheckAgain(error: unknown): boolean {
  if (!(error instanceof DropshipApiError)) return false;
  switch (error.code) {
    case CONVERSION_CODES.changed:
    case CONVERSION_CODES.wouldBlockListing:
    case "DROPSHIP_LISTING_PRICE_WOULD_BE_LOST":
    case "DROPSHIP_IDEMPOTENCY_CONFLICT":
      return true;
    case "DROPSHIP_LISTING_SETTINGS_TOO_LARGE":
      return error.context?.reason === STORE_TEXT_LIMIT;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Running a move
// ---------------------------------------------------------------------------

export interface ConversionApplyRun {
  storeConnectionId: number;
  /** The step's draft as the vendor pressed [Move them over] (or Check again): the two hashes and the phase. */
  draft: ListingSettingsDraft;
  /** The draft provider's two save calls. */
  drafts: ProductSettingsSaveDrafts;
  /** The page's pending-save counter (PLAN10 D10). */
  callbacks: ProductSettingsSaveCallbacks;
  send: (body: ListingRulesConversionApplyInput) => Promise<unknown>;
  /** Reads every view the move changed again (`rereadAfterConversion`). */
  reread: () => Promise<unknown>;
  /** Reads page 0 of the dry run again, alone (8.3: after a refusal that says the plan moved). */
  rereadCheck: () => Promise<unknown>;
  /** The step marks the step 3 preview stale and reads every listing settings view again. */
  onSettingsSaved: () => void;
  /** A move refused because of a block a banner explains. The draft is kept. Never given a refusal (PLAN10 D8). */
  onBlocked?: (error: unknown) => void;
}

export type ConversionApplyOutcome =
  /** Nothing was sent: not a move's draft, no plan, another action is running, or no send can start now. */
  | { kind: "not_started"; message: string | null }
  /**
   * A 2xx: the rules are moved (`converted`, this key's `replayed`) or there
   * were none left to move (`nothing_to_convert`). `answer` is null when it
   * broke its contract (then `viewStale`).
   */
  | { kind: "applied"; viewStale: boolean; answer: ListingRulesConversionApplyResponse | null }
  /** Shown by the sheet; `checkAgain`: page 0 was read again (8.3). */
  | { kind: "failed"; failure: WriteFailure; checkAgain: boolean };

/**
 * One move, start to finish (plan 8.2, 8.3, 8.4):
 * 1. the draft's two hashes make the request; with none, nothing is sent;
 * 2. the page's pending-save counter starts, or the move does not;
 * 3. the draft takes the request key (`ls-convert`): the same plan reuses its key;
 * 4. the body is checked by the shared schema, then sent; a failure is
 *    classified (W11) and, for a Check again, keeps its doubt (PLAN10 D7b);
 *    a refusal that says the plan moved reads page 0 again, and sends nothing;
 * 5. a 2xx means moved (or nothing left to move). The answer is checked and
 *    handed back; the views are read again; if that read or the check fails,
 *    the move still stands and the sheet says the view may be out of date;
 * 6. the step is told, and the counter always ends once it started.
 */
export async function runConversionApply(run: ConversionApplyRun): Promise<ConversionApplyOutcome> {
  const value = run.draft.editor === CONVERSION_EDITOR_ID ? readConversionDraft(run.draft.value) : null;
  if (value === null) return { kind: "not_started", message: null };
  const signature = conversionSignature(run.storeConnectionId, value);
  // Read before the send starts: startSave turns the phase to "saving".
  const wasUncertain = run.draft.phase === "uncertain";

  if (run.callbacks.disabled) return { kind: "not_started", message: DRAWER_WORDS.busy };
  try {
    run.callbacks.onSaveStarted();
  } catch (error) {
    // Nothing was sent, so the draft is untouched and the button works again once the other action ends.
    return { kind: "not_started", message: queryErrorMessage(error, DRAWER_WORDS.busy) };
  }
  try {
    const key = run.drafts.startSave(signature, LISTING_SETTINGS_KEY_PREFIXES.conversion);
    if (key === null) return { kind: "not_started", message: null };

    let body: ListingRulesConversionApplyInput;
    try {
      body = conversionApplyBody({ key, value });
    } catch {
      // Never sent; the next press gets a new key.
      const failure: WriteFailure = {
        phase: "refused", message: LISTING_SETTINGS_EDIT_WORDS.cantBuild, code: CONVERSION_REQUEST_INVALID, status: null, fields: [],
      };
      run.drafts.settle(key, { kind: "failure", failure });
      return { kind: "failed", failure, checkAgain: false };
    }

    let raw: unknown;
    try {
      raw = await run.send(body);
    } catch (error) {
      const classified = classifyWriteFailure("W11", error);
      const failure = failureAfterUnconfirmed(wasUncertain, classified, CONVERSION_UNCONFIRMED_WORDS);
      run.drafts.settle(key, { kind: "failure", failure });
      // The banner learns of every block, a Check again's too, which stays unconfirmed (PLAN10 D7b).
      if (classified.phase === "blocked") run.onBlocked?.(error);
      const checkAgain = conversionRefusalReadsCheckAgain(error);
      if (checkAgain) {
        try {
          await run.rereadCheck();
        } catch {
          // Deliberate: the refusal stands and is shown; page 0's own read state shows its failure, with [Try again].
        }
      }
      return { kind: "failed", failure, checkAgain };
    }

    let viewStale = false;
    let answer: ListingRulesConversionApplyResponse | null = null;
    try {
      // Checked for its contract; only its outcome is used (moved, or nothing left to move), never cached (8.4).
      answer = readConversionApplyAnswer(raw);
    } catch {
      // Deliberate: a 2xx moved them, but the page and the server disagree on the answer. The views are
      // still read again, and the sheet says the view may be out of date, with [Reload].
      viewStale = true;
    }
    try {
      await run.reread();
    } catch {
      // Deliberate: the move stands; only the view is out of date ("saved_view_stale").
      viewStale = true;
    }
    run.drafts.settle(key, { kind: viewStale ? "saved_view_stale" : "saved" });
    run.onSettingsSaved();
    return { kind: "applied", viewStale, answer };
  } finally {
    run.callbacks.onSaveSettled();
  }
}
