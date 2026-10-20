/**
 * Catalog step 1's requests (step 1 stage 1): the catalog list read 200 rows
 * at a time, the saved selection rules, and the save run from "Save changes"
 * to its outcome. Every answer is checked against its Zod contract before the
 * page trusts it. The network calls, the pause and the key maker are passed
 * into the save runner, so every path can be run in a test.
 *
 * The one write is `PUT /api/dropship/catalog/selection-rules` with
 * `{ idempotencyKey, rules }` (dropship-vendor-catalog.routes.ts): the whole
 * rule set, applied all or nothing in one transaction. The server is
 * unchanged in stage 1.
 */
import { infiniteQueryOptions, keepPreviousData, queryOptions, type QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { buildQueryUrl, fetchJson, putJson } from "./dropship-ops-surface";
import {
  buildChooseSelectionSave,
  CHOOSE_PAGE_SIZE,
  CHOOSE_SAVE_BACKOFF_MS,
  CHOOSE_SAVE_MAX_TRIES,
  CHOOSE_SEARCH_MAX_LENGTH,
  chooseCatalogPageSchema,
  chooseMarksKey,
  chooseNextPageParam,
  chooseSaveBlock,
  chooseSelectionRulesResponseSchema,
  ChooseUnverifiedAnswerError,
  classifyChooseSaveError,
  rulesFingerprint,
  sameRuleContent,
  type ChooseCatalogPage,
  type ChooseMark,
  type ChooseRuleInput,
  type ChooseSaveBlock,
  type ChooseSelectionRule,
  type ChooseSelectionRulesResponse,
} from "./dropship-catalog-choose";
import { CHOOSE_WORDS } from "./dropship-catalog-choose-words";

export const CHOOSE_CATALOG_URL = "/api/dropship/catalog";
export const SELECTION_RULES_URL = "/api/dropship/catalog/selection-rules";
/** Step 1's list, apart from the page's "selected" read (`["/api/dropship/catalog", "selected"]`). */
export const CHOOSE_CATALOG_QUERY_KEY = [CHOOSE_CATALOG_URL, "choose"] as const;
/** Shared with the page's rail tick (`chooseStepTick`), so a save's re-read moves both. */
export const SELECTION_RULES_QUERY_KEY = [SELECTION_RULES_URL] as const;

/** An answer that is not the contract: the page says so in words and never guesses; `chooseReadErrorData` puts its code and issues on the card. */
export class ChooseReadError extends Error {
  readonly code: "DROPSHIP_CATALOG_CHOOSE_OFF_CONTRACT";
  readonly context: Readonly<Record<string, unknown>>;
  constructor(read: "catalog" | "rules", issues: z.ZodIssue[]) {
    super(read === "catalog" ? CHOOSE_WORDS.catalogUnreadable : CHOOSE_WORDS.rulesUnreadable);
    this.name = "ChooseReadError";
    this.code = "DROPSHIP_CATALOG_CHOOSE_OFF_CONTRACT";
    this.context = Object.freeze({
      read,
      issues: issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), code: issue.code })),
    });
  }
}

/**
 * The failure card's data attributes for an off-contract read (review CT7): the code and the first issue paths, so
 * support can see which field failed without a client logger. Empty for any other error.
 */
export function chooseReadErrorData(error: unknown): Record<string, string> {
  if (!(error instanceof ChooseReadError)) return {};
  const issues = error.context.issues;
  const paths = Array.isArray(issues)
    ? issues.map((issue: { path?: unknown; code?: unknown }) => `${String(issue.path ?? "")}:${String(issue.code ?? "")}`).join(",")
    : "";
  return { "data-error-code": error.code, "data-error-issues": paths };
}

export interface ChooseFilters {
  /** Already trimmed by the page; trimmed and capped again here. */
  search: string;
  /** A category from the facet list, or null for every category. */
  category: string | null;
  /** Show = Selected. */
  selectedOnly: boolean;
}

/**
 * One page of the step's list. Never sends `productLineIds`, `productLineId`
 * or `productId` (owner Q2; no Product menu): only search, category, Show,
 * the page and 200 rows.
 */
export function chooseCatalogUrl(filters: ChooseFilters, page: number): string {
  const search = filters.search.trim().slice(0, CHOOSE_SEARCH_MAX_LENGTH);
  const category = filters.category?.trim().slice(0, CHOOSE_SEARCH_MAX_LENGTH) || undefined;
  return buildQueryUrl(CHOOSE_CATALOG_URL, {
    search: search || undefined,
    category,
    selectedOnly: filters.selectedOnly ? true : undefined,
    page,
    limit: CHOOSE_PAGE_SIZE,
  });
}

export type JsonFetcher = (url: string, options?: { signal?: AbortSignal }) => Promise<unknown>;

const defaultFetcher: JsonFetcher = (url, options) => fetchJson<unknown>(url, options);

export async function readChooseCatalogPage(url: string, fetcher: JsonFetcher = defaultFetcher, signal?: AbortSignal): Promise<ChooseCatalogPage> {
  const parsed = chooseCatalogPageSchema.safeParse(await fetcher(url, { signal }));
  if (!parsed.success) throw new ChooseReadError("catalog", parsed.error.issues);
  return parsed.data;
}

export async function readSelectionRules(fetcher: JsonFetcher = defaultFetcher, signal?: AbortSignal): Promise<ChooseSelectionRulesResponse> {
  const parsed = chooseSelectionRulesResponseSchema.safeParse(await fetcher(SELECTION_RULES_URL, { signal }));
  if (!parsed.success) throw new ChooseReadError("rules", parsed.error.issues);
  return parsed.data;
}

/**
 * The step's list: 200 rows a page, "Load more" up to 1,000 rows. The rows of
 * the last filter stay on screen while the next load (boxes off meanwhile);
 * never read again on focus, so rows never reorder under the vendor's hand.
 */
export function chooseCatalogQueryOptions(filters: ChooseFilters, fetcher: JsonFetcher = defaultFetcher) {
  return infiniteQueryOptions({
    queryKey: [...CHOOSE_CATALOG_QUERY_KEY, { search: filters.search, category: filters.category, selectedOnly: filters.selectedOnly }] as const,
    queryFn: ({ pageParam, signal }) => readChooseCatalogPage(chooseCatalogUrl(filters, pageParam), fetcher, signal),
    initialPageParam: 1,
    getNextPageParam: (lastPage: ChooseCatalogPage, allPages: ChooseCatalogPage[]) => chooseNextPageParam(lastPage, allPages),
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The vendor's saved rules, checked against their contract. */
export function selectionRulesQueryOptions(fetcher: JsonFetcher = defaultFetcher) {
  return queryOptions({
    queryKey: SELECTION_RULES_QUERY_KEY,
    queryFn: ({ signal }) => readSelectionRules(fetcher, signal),
  });
}

/**
 * A fresh GET of the saved rules (never the cache), which also puts the newest rules in the shared cache, so the
 * rail tick and the step's rules map follow it. The save runner and the check behind Undo read through it.
 */
export function freshSelectionRulesReader(queryClient: QueryClient): () => Promise<readonly ChooseSelectionRule[]> {
  return async () => (await queryClient.fetchQuery({ ...selectionRulesQueryOptions(), staleTime: 0 })).rules;
}

// ---------------------------------------------------------------------------
// The save
// ---------------------------------------------------------------------------

export interface ChooseSaveBody {
  idempotencyKey: string;
  rules: ChooseRuleInput[];
}

/** One built save, kept after a try with no answer so the next press sends the same key and body. */
export interface ChoosePendingSave {
  idempotencyKey: string;
  body: ChooseSaveBody;
  /** The fingerprint of the rules the body was built on. */
  baseFingerprint: string;
  /** `chooseMarksKey` of the marks it was built from. */
  marksKey: string;
  /**
   * True once any try got no sure answer (no answer, a 5xx, an unreadable 2xx): the server may have saved it, even
   * after a read showed it hadn't yet (a late commit). Only then is the vendor told "couldn't confirm" rather than
   * "weren't saved", and only then does Undo check the rules before it forgets this attempt (review MC1).
   */
  mayHaveCommitted: boolean;
}

export interface ChooseSaveDeps {
  /** A fresh read of the saved rules (never the cache). */
  readRules(): Promise<readonly ChooseSelectionRule[]>;
  /** The PUT. Resolves once the server answered 2xx: the save committed. */
  putRules(body: ChooseSaveBody): Promise<{ idempotentReplay: boolean }>;
  sleep(ms: number): Promise<void>;
  newKey(): string;
}

export interface ChooseSaveInput {
  marks: readonly ChooseMark[];
  baseFingerprint: string | null;
  pending: ChoosePendingSave | null;
}

export type ChooseSaveOutcome =
  /** Committed (a 2xx, or the rules now are what was sent). */
  | { kind: "saved"; replay: boolean }
  /** An earlier try whose answer was lost went through; nothing sent now. `marksKey`: the marks it saved (review MC3). */
  | { kind: "committedEarlier"; marksKey: string }
  /** Another tab saved since the first mark; nothing sent. */
  | { kind: "stale" }
  /** Over a limit on the rules just read; nothing sent. */
  | { kind: "blocked"; block: ChooseSaveBlock }
  /** A permanent refusal, never sent again. */
  | { kind: "rejected"; message: string }
  /** Nothing of this save was written (the first read failed, or every answer said so): keep `pending` for the next press. */
  | { kind: "notSaved"; pending: ChoosePendingSave | null; busyMessage: string | null; error: unknown }
  /** No sure answer and the rules don't show it saved yet: it may still have gone through. Keep `pending` (review MC1). */
  | { kind: "unconfirmed"; pending: ChoosePendingSave; error: unknown };

/** True when `rules` hold what `attempt` sent, under new ids: that save went through. */
function showsCommitted(rules: readonly ChooseSelectionRule[], attempt: ChoosePendingSave): boolean {
  return rulesFingerprint(rules) !== attempt.baseFingerprint && sameRuleContent(rules, attempt.body.rules);
}

/**
 * One press of "Save changes" (plan 5.6), in this order:
 * 1. Read the rules again. A read failure stops: nothing is sent.
 * 2. Reuse `pending` when the marks are the same and nobody saved since (same
 *    key, same body: the earlier try never committed). Else, when the rules
 *    now are what `pending` sent under new ids, the earlier try went through.
 *    Else, when the rules moved since the first mark, another tab saved: stop.
 *    Else build a new save with a new key, unless it passes a limit.
 * 3. Send it up to CHOOSE_SAVE_MAX_TRIES times, the same key and body each
 *    time, pausing between tries. A permanent refusal stops at once. Before
 *    each resend, read the rules again (review MC2): our content under new
 *    ids means it went through; any other move means another tab saved during
 *    the pause, so stop rather than send a body built on older rules over it;
 *    a read that fails sends nothing that try.
 * 4. After the last try, read the rules once more: our content under new ids
 *    means it went through. Otherwise "unconfirmed" when any try may have
 *    committed, else "not saved"; either way with `pending`.
 */
export async function runChooseSave(deps: ChooseSaveDeps, input: ChooseSaveInput): Promise<ChooseSaveOutcome> {
  if (input.marks.length === 0) throw new Error("runChooseSave needs at least one change to save.");
  let fresh: readonly ChooseSelectionRule[];
  try {
    fresh = await deps.readRules();
  } catch (error) {
    // Nothing sent now; an earlier attempt that may have gone through is still unconfirmed.
    if (input.pending?.mayHaveCommitted) return { kind: "unconfirmed", pending: input.pending, error };
    return { kind: "notSaved", pending: input.pending, busyMessage: null, error };
  }
  const fingerprint = rulesFingerprint(fresh);
  const marksKey = chooseMarksKey(input.marks);
  const pending = input.pending;
  let attempt: ChoosePendingSave;
  if (pending && pending.marksKey === marksKey && fingerprint === pending.baseFingerprint) {
    attempt = pending;
  } else if (pending && showsCommitted(fresh, pending)) {
    return { kind: "committedEarlier", marksKey: pending.marksKey };
  } else if (fingerprint !== input.baseFingerprint) {
    return { kind: "stale" };
  } else {
    const block = chooseSaveBlock(fresh, input.marks);
    if (block) return { kind: "blocked", block };
    const idempotencyKey = deps.newKey();
    attempt = {
      idempotencyKey, body: { idempotencyKey, rules: buildChooseSelectionSave(fresh, input.marks) }, baseFingerprint: fingerprint, marksKey,
      mayHaveCommitted: false,
    };
  }

  let lastError: unknown = null;
  let busyMessage: string | null = null;
  let mayHaveCommitted = attempt.mayHaveCommitted;
  for (let tryIndex = 0; tryIndex < CHOOSE_SAVE_MAX_TRIES; tryIndex += 1) {
    if (tryIndex > 0) {
      await deps.sleep(CHOOSE_SAVE_BACKOFF_MS[tryIndex - 1] ?? CHOOSE_SAVE_BACKOFF_MS[CHOOSE_SAVE_BACKOFF_MS.length - 1]);
      let current: readonly ChooseSelectionRule[];
      try {
        current = await deps.readRules();
      } catch (readError) {
        // Deliberate: never resend without a fresh look at the rules; this try sends nothing, the next one looks again.
        lastError = readError;
        continue;
      }
      if (rulesFingerprint(current) !== attempt.baseFingerprint) {
        if (sameRuleContent(current, attempt.body.rules)) return { kind: "saved", replay: true };
        return { kind: "stale" };
      }
    }
    try {
      const answer = await deps.putRules(attempt.body);
      return { kind: "saved", replay: answer.idempotentReplay };
    } catch (error) {
      const classified = classifyChooseSaveError(error);
      if (classified.classification === "permanent") return { kind: "rejected", message: classified.message };
      lastError = error;
      busyMessage = classified.busyMessage;
      mayHaveCommitted = mayHaveCommitted || classified.mayHaveCommitted;
    }
  }

  const kept: ChoosePendingSave = mayHaveCommitted === attempt.mayHaveCommitted ? attempt : { ...attempt, mayHaveCommitted };
  try {
    const after = await deps.readRules();
    if (showsCommitted(after, kept)) return { kind: "saved", replay: true };
  } catch (readError) {
    // Deliberate: the outcome is still unknown, so `pending` is kept. The next press reads the rules first and either
    // resends the same key and body or finds that this save went through.
    return mayHaveCommitted ? { kind: "unconfirmed", pending: kept, error: readError } : { kind: "notSaved", pending: kept, busyMessage, error: readError };
  }
  return mayHaveCommitted ? { kind: "unconfirmed", pending: kept, error: lastError } : { kind: "notSaved", pending: kept, busyMessage, error: lastError };
}

export type ChoosePendingCheck = "wentThrough" | "moved" | "notSeen" | "unreadable";

/**
 * Before the page forgets an attempt that may have gone through (Undo, "Discard and leave", a reload that settled
 * the changes): read the rules once (review MC1). "wentThrough": they hold what it sent, under new ids. "moved": they
 * changed since it was built, but not to what it sent (it may have gone through with another tab's save on top, or
 * another tab saved alone): the page reads everything again and says so (verify V2). "notSeen": unchanged, so it has
 * not gone through. "unreadable": the read failed, so nobody can tell.
 */
export async function checkChoosePending(
  readRules: ChooseSaveDeps["readRules"],
  pending: ChoosePendingSave,
): Promise<ChoosePendingCheck> {
  let rules: readonly ChooseSelectionRule[];
  try {
    rules = await readRules();
  } catch {
    // Deliberate: a failed read is the "unreadable" answer itself; the caller tells the vendor to reload.
    return "unreadable";
  }
  if (showsCommitted(rules, pending)) return "wentThrough";
  return rulesFingerprint(rules) !== pending.baseFingerprint ? "moved" : "notSeen";
}

/** A 2xx answer's one field the page uses; anything else in it is not trusted (the rules are read again). */
const replaceAnswerSchema = z.object({ idempotentReplay: z.boolean() });

/**
 * The PUT. The route answers 201 (new) or 200 (replay) with its contract in
 * JSON. A 2xx the page can't read (not JSON: `putJson` throws a SyntaxError
 * only for a 2xx body; or not the contract) is not taken as saved: it throws
 * `ChooseUnverifiedAnswerError`, and the runner reads the rules to tell
 * (review CT6).
 */
export async function putChooseSelectionRules(body: ChooseSaveBody, put: (url: string, body: unknown) => Promise<unknown> = putJson): Promise<{ idempotentReplay: boolean }> {
  let answer: unknown;
  try {
    answer = await put(SELECTION_RULES_URL, body);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ChooseUnverifiedAnswerError("the answer is not JSON");
    throw error;
  }
  const parsed = replaceAnswerSchema.safeParse(answer);
  if (!parsed.success) throw new ChooseUnverifiedAnswerError("the answer is not the route's contract");
  return { idempotentReplay: parsed.data.idempotentReplay };
}
