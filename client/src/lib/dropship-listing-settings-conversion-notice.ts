import type { QueryClient } from "@tanstack/react-query";
import {
  LISTING_RULES_CONVERSION_ERROR_CODES,
  listingRulesConversionNoticeAcknowledgeInputSchema,
  listingRulesConversionNoticeAcknowledgeResponseSchema,
  type ListingRulesConversionNoticeAcknowledgeInput,
  type ListingRulesConversionNoticeOutcome,
  type ListingRulesConversionNoticeResponse,
} from "@shared/dropship/listing-rules-conversion";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { listingSettingsConversionNoticeQueryOptions } from "./dropship-listing-settings";
import type { ListingSettingsReadState } from "./dropship-listing-settings-access";
import { olderRulesState } from "./dropship-listing-settings-conversion";
import { LISTING_SETTINGS_SAVE_WORDS } from "./dropship-listing-settings-drafts";
import {
  LISTING_SETTINGS_CONVERSION_WORDS,
  LISTING_SETTINGS_EDIT_WORDS,
  conversionNoticeMovedWords,
} from "./dropship-listing-settings-words";
import { DropshipApiError, postJson } from "./dropship-ops-surface";

/**
 * The one-time notice of a system conversion (Listing settings PR 11e1, plan
 * 9.2, 9.3, 11.3, 11.4, D19): after the job moved the store's older group
 * rules, one line in the strip's slot says what moved, with [Got it]; the
 * server keeps that it was seen, so [Got it] on one device hides it on every
 * other. The sheet shows the same words when it finds the store already
 * moved (D25).
 *
 * Rules this module keeps:
 * - The words come only from the server's record: its two counts (D18: the
 *   client computes nothing), never an id or a code.
 * - The line hides while the store holds older group rules again (D21): the
 *   summary's three counts decide, as they decide the older-rules line, so
 *   the two never show together.
 * - [Got it] carries no request key and no draft (plan 16): the server marks
 *   the notice seen by state, so pressing it again, here or elsewhere, is
 *   safe. A failure keeps the line, with its words, and the button works again.
 *
 * Pure but for the runner's network and cache calls, which are passed in.
 */

const W = LISTING_SETTINGS_CONVERSION_WORDS;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;

// ---------------------------------------------------------------------------
// The read (plan 9.2, D18)
// ---------------------------------------------------------------------------

/**
 * The notice's read: key `[…prefix, "conversion-notice"]`, at most 60 seconds
 * old, no retry. A mount read of the step (D18), on every store and every
 * selection size: the server reads no selection for it.
 */
export function conversionNoticeQueryOptions(storeConnectionId: number) {
  return listingSettingsConversionNoticeQueryOptions(storeConnectionId);
}

/** The notice's query key, for the reads that follow a move made elsewhere (11.5, the conflict hook). */
export function conversionNoticeQueryKey(storeConnectionId: number): readonly unknown[] {
  return conversionNoticeQueryOptions(storeConnectionId).queryKey;
}

// ---------------------------------------------------------------------------
// The model (plan 9.3, 11.3, 11.4)
// ---------------------------------------------------------------------------

/** The notice as the line and the sheet draw it. */
export interface ConversionNoticeModel {
  /** The record it names: what [Got it] sends, never shown. */
  conversionId: number;
  /** "We moved your older group rules. 2 categories and 5 products now have their own settings. …", then what later products follow. */
  text: string;
  /** [Got it], named for what it does. */
  gotIt: { label: string; ariaLabel: string };
  /** A [Got it] that failed, in its words; null otherwise. The notice stays. */
  failure: string | null;
}

/**
 * The notice's words by the record's counts (11.4): with any count,
 * `noticeMoved` then `noticeLater`; with both 0, `noticeRemoved` (its rules
 * decided nothing). Null while the read loads, after it failed, and when
 * there is no unseen system conversion. It does not read the summary: the
 * sheet shows it only where it already knows the store holds no older rules.
 */
export function conversionNoticeModel(
  read: ListingSettingsReadState<ListingRulesConversionNoticeResponse>,
  failure: string | null = null,
): ConversionNoticeModel | null {
  if (read.error !== undefined && read.error !== null) return null;
  const notice = read.data?.notice ?? null;
  if (notice === null) return null;
  const { categoryCount, productCount } = notice;
  const text = categoryCount + productCount === 0
    ? W.noticeRemoved
    : `${conversionNoticeMovedWords(categoryCount, productCount)} ${W.noticeLater}`;
  return { conversionId: notice.conversionId, text, gotIt: { label: W.gotIt, ariaLabel: W.gotItName }, failure };
}

/**
 * The line in the strip's slot (11.1, 11.3): the notice, only while the
 * summary says the store holds no older group rules (D21: a group added back
 * brings the older-rules line instead), so it is hidden while the summary
 * loads or failed too. Over 10,000 sizes it still shows: the summary's counts
 * are the profiles', which a too-large store still reports.
 */
export function noticeLineModel(
  read: ListingSettingsReadState<ListingRulesConversionNoticeResponse>,
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "storeDefaults">>,
  failure: string | null = null,
): ConversionNoticeModel | null {
  return olderRulesState(summary) === "absent" ? conversionNoticeModel(read, failure) : null;
}

// ---------------------------------------------------------------------------
// [Got it] (plan 9.2, 9.3; PLAN10 3.3 rows 1-2)
// ---------------------------------------------------------------------------

/** The notice's acknowledge route of one store (`S/interfaces/http/dropship-listing-setting-writes.routes.ts`). */
export function conversionNoticeAcknowledgeEndpoint(storeConnectionId: number): string {
  return `/api/dropship/listings/stores/${storeConnectionId}/listing-settings/conversion/notice/acknowledge`;
}

/** POST …/conversion/notice/acknowledge. Resolves with the server's answer, unread. */
export function sendConversionNoticeAcknowledge(storeConnectionId: number, body: ListingRulesConversionNoticeAcknowledgeInput): Promise<unknown> {
  return postJson<unknown>(conversionNoticeAcknowledgeEndpoint(storeConnectionId), body);
}

export type ConversionNoticeQueryClient = Pick<QueryClient, "cancelQueries" | "invalidateQueries" | "setQueryData">;

/**
 * After a confirmed [Got it]: the notice this page holds is taken off at once
 * (only if it is still the one pressed), so the line can't be pressed twice
 * while the read goes out; reads in flight are cancelled first, so an older
 * answer can't bring it back. Never taken from the answer.
 */
export async function hideConversionNotice(queryClient: ConversionNoticeQueryClient, storeConnectionId: number, conversionId: number): Promise<void> {
  const queryKey = [...conversionNoticeQueryKey(storeConnectionId)];
  await queryClient.cancelQueries({ queryKey, exact: true });
  queryClient.setQueryData<ListingRulesConversionNoticeResponse>(queryKey, (current) =>
    current && current.notice?.conversionId === conversionId ? { ...current, notice: null } : current);
}

/** The notice read again (its own key only): what the server says now. Throws when the refetch fails. */
export async function rereadConversionNotice(queryClient: ConversionNoticeQueryClient, storeConnectionId: number): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: [...conversionNoticeQueryKey(storeConnectionId)], exact: true }, { throwOnError: true });
}

export interface ConversionNoticeAcknowledgeRun {
  storeConnectionId: number;
  /** The notice on screen when [Got it] was pressed. */
  conversionId: number;
  send: (body: ListingRulesConversionNoticeAcknowledgeInput) => Promise<unknown>;
  /** Takes the pressed notice off this page's read at once (`hideConversionNotice`). */
  hide: () => Promise<unknown>;
  /** Reads the notice again (`rereadConversionNotice`). */
  reread: () => Promise<unknown>;
}

export type ConversionNoticeAcknowledgeOutcome =
  /**
   * A 2xx: the notice is seen, by this press or an earlier one (`already_seen`).
   * `outcome` is null when the answer broke its contract: the server still
   * took it (a 2xx), so the line goes all the same.
   */
  | { kind: "acknowledged"; outcome: ListingRulesConversionNoticeOutcome | null }
  /** 404: the server has no such notice for this store (the page's read is out of date); it is read again, no words. */
  | { kind: "gone" }
  /** Anything else: the line stays with `message`, and [Got it] works again. Nothing was marked (or it is unknown, and a second press is safe). */
  | { kind: "failed"; message: string; code: string | null; status: number | null };

/**
 * One [Got it], start to finish (9.3):
 * 1. the body (`{ conversionId }`) is checked by the shared schema; one that
 *    breaks it is never sent;
 * 2. it is sent once (the caller never sends a second while one is out);
 * 3. a 2xx: the notice is taken off at once and read again; a failed re-read
 *    changes nothing (the notice is seen; the read's own state holds its error);
 * 4. 404 NOTICE_NOT_FOUND: read again, no words (there is no such notice);
 * 5. 429 and a signed-out 401 in the page's words (PLAN10 3.3 rows 1-2);
 *    anything else `noticeFailed`. A press is idempotent by state, so pressing
 *    again after an answer that never came back is safe.
 */
export async function runConversionNoticeAcknowledge(run: ConversionNoticeAcknowledgeRun): Promise<ConversionNoticeAcknowledgeOutcome> {
  const body = listingRulesConversionNoticeAcknowledgeInputSchema.safeParse({ conversionId: run.conversionId });
  if (!body.success) return { kind: "failed", message: W.noticeFailed, code: null, status: null };

  let raw: unknown;
  try {
    raw = await run.send(body.data);
  } catch (error) {
    if (error instanceof DropshipApiError && error.code === LISTING_RULES_CONVERSION_ERROR_CODES.noticeNotFound) {
      await rereadQuietly(run);
      return { kind: "gone" };
    }
    return { kind: "failed", message: failureWords(error), code: error instanceof DropshipApiError ? error.code : null,
      status: error instanceof DropshipApiError ? error.status : null };
  }
  const parsed = listingRulesConversionNoticeAcknowledgeResponseSchema.safeParse(raw);
  try {
    await run.hide();
  } catch {
    // Deliberate: the notice is seen (a 2xx); the re-read below decides what the line shows.
  }
  await rereadQuietly(run);
  return { kind: "acknowledged", outcome: parsed.success ? parsed.data.outcome : null };
}

/** The [Got it] failure's words (PLAN10 3.3 rows 1-2, else 9.3's `noticeFailed`): no id, no code. */
function failureWords(error: unknown): string {
  if (error instanceof DropshipApiError && error.status === HTTP_TOO_MANY_REQUESTS) return LISTING_SETTINGS_SAVE_WORDS.rateLimited;
  if (error instanceof DropshipApiError && error.status === HTTP_UNAUTHORIZED && error.code === "DROPSHIP_AUTH_REQUIRED") {
    return LISTING_SETTINGS_EDIT_WORDS.signedOut;
  }
  return W.noticeFailed;
}

async function rereadQuietly(run: Pick<ConversionNoticeAcknowledgeRun, "reread">): Promise<void> {
  try {
    await run.reread();
  } catch {
    // Deliberate: a read that failed keeps its error under the notice's key, and the line hides on it (`conversionNoticeModel`).
  }
}
