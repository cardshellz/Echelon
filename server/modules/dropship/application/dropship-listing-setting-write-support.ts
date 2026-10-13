import { z } from "zod";
import { LISTING_SETTING_WRITE_ERROR_CODES } from "../../../../shared/dropship/listing-setting-writes";
import { evaluateDropshipCatalogExposure } from "../domain/catalog-exposure";
import { DropshipError } from "../domain/errors";
import type { RequestKeyUseDecision } from "../domain/listing-setting-request-key-use";
import { listingSettingRequestHash, listingSettingsInvariantFailed } from "../domain/listing-setting-values";
import { evaluateDropshipVendorCatalogSelection } from "../domain/vendor-selection";
import type { ListingPriceCatalogReader } from "./dropship-listing-price-service";
import type { DropshipListingCatalogCandidate, DropshipListingStoreContext } from "./dropship-listing-preview-service";

/**
 * What every listing-settings write service shares (plan PR 9, section 3.1):
 * the input parser, the gate, the request hash, the replay decision as
 * errors, and the log port.
 * Every error here carries `retryable` and `classification` (CLAUDE.md §6).
 */

/** One INFO line per successful write (plan 3.4), through the platform logger behind this port. Never any text value. */
export interface ListingSettingWriteLog {
  info(action: string, fields: Record<string, unknown>): void;
}

/** Store connection ids are int4 keys. */
export const listingSettingStoreIdSchema = z.number().int().positive().max(2_147_483_647);

/** The words of every 400 a write answers for its own input. */
export const LISTING_SETTING_INVALID_INPUT_MESSAGE = "Check the listing settings change and reload if the page is out of date.";
/** At most this many Zod issues, so a large body cannot make a large answer (plan P5). */
export const MAX_ECHOED_ISSUES = 20;

/** One issue as it may leave the server (plan P5). 8a's writers report the path as one dotted string. */
export interface ListingSettingIssue {
  path: string | Array<string | number>;
  code: string;
  message?: string;
}

/**
 * A write's route input (store id, body), parsed: the value, or the permanent
 * 400 DROPSHIP_LISTING_SETTINGS_INVALID_INPUT with at most 20 issues. Only an
 * input parsed here is the vendor's mistake; a ZodError thrown anywhere else
 * (a stored row or a derived value failing its contract inside the
 * transaction) is a broken contract, answered 500 and logged as fatal.
 */
export function parseListingSettingInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw permanent(LISTING_SETTING_WRITE_ERROR_CODES.invalidInput, LISTING_SETTING_INVALID_INPUT_MESSAGE, {
    issues: listingSettingIssues(parsed.error.issues),
  });
}

/**
 * Issues rebuilt as `{ path, code }`, keeping the message only for a custom
 * issue, whose words are ours: Zod's own messages and fields (`received`,
 * `keys`, `unionErrors`) can quote what was sent (an 8a finding). Anything
 * that is not an issue is dropped; at most MAX_ECHOED_ISSUES are kept.
 */
export function listingSettingIssues(issues: readonly unknown[]): ListingSettingIssue[] {
  const echoed: ListingSettingIssue[] = [];
  for (const issue of issues) {
    if (echoed.length === MAX_ECHOED_ISSUES) break;
    if (issue === null || typeof issue !== "object" || Array.isArray(issue)) continue;
    const { path, code, message } = issue as { path?: unknown; code?: unknown; message?: unknown };
    if (typeof code !== "string") continue;
    const echoedPath = typeof path === "string" ? path
      : Array.isArray(path) ? path.filter((part): part is string | number => typeof part === "string" || typeof part === "number")
        : null;
    if (echoedPath === null) continue;
    echoed.push({ path: echoedPath, code, ...(code === "custom" && typeof message === "string" ? { message } : {}) });
  }
  return echoed;
}

/** W9's allow-lists (plan P10): one rule for every listing writer. */
const WRITABLE_VENDOR_STATUSES: ReadonlySet<string> = new Set(["active", "onboarding"]);
// Token health is not authority for a local setting: a store that needs a
// sign-in keeps its settings writable; paused and disconnected stores do not.
const WRITABLE_STORE_STATUSES: ReadonlySet<string> = new Set(["connected", "needs_reauth", "refresh_failed"]);

export function assertListingSettingMember(memberId: string): void {
  if (typeof memberId !== "string" || !memberId.trim()) {
    throw permanent("DROPSHIP_AUTH_REQUIRED", "Dropship authentication is required.", {});
  }
}

/**
 * The gate, first inside every write transaction (plan 3.8): the store, then
 * the vendor, the .ops entitlement, the store's status and its platform. The
 * wrapper checked only that the member's vendor owns the store; the vendor and
 * store rows are held FOR SHARE, so the answer holds until commit. The
 * read-only preflight (plan 6.2 #4) runs it once more before any eBay call
 * (plan P10), so it takes only the store context read.
 */
export async function authorizeListingSettingWrite(
  tx: { vendorId: number; storeConnectionId: number; catalog: Pick<ListingPriceCatalogReader, "loadStoreContext"> },
): Promise<DropshipListingStoreContext> {
  const { storeConnectionId } = tx;
  const context = await tx.catalog.loadStoreContext({ vendorId: tx.vendorId, storeConnectionId });
  if (!context) throw permanent("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.", { storeConnectionId });
  if (!WRITABLE_VENDOR_STATUSES.has(context.vendorStatus)) {
    throw permanent("DROPSHIP_LISTING_VENDOR_BLOCKED", "Your vendor status does not permit listing settings changes.",
      { storeConnectionId, reason: context.vendorStatus });
  }
  if (context.entitlementStatus !== "active") {
    throw permanent("DROPSHIP_LISTING_ENTITLEMENT_BLOCKED", "An active .ops entitlement is required to change listing settings.",
      { storeConnectionId, reason: context.entitlementStatus });
  }
  if (!WRITABLE_STORE_STATUSES.has(context.storeStatus)) {
    throw permanent("DROPSHIP_LISTING_STORE_BLOCKED", "This store is not available for listing settings changes.",
      { storeConnectionId, reason: context.storeStatus });
  }
  if (context.platform !== "ebay") {
    throw permanent("DROPSHIP_LISTING_SETTINGS_EBAY_ONLY", "Listing settings work for eBay stores only.", { storeConnectionId });
  }
  return context;
}

/**
 * The request hash (plan 3.7): the writer's versioned operation and the
 * route-parsed body without its key, arrays sorted by id. Pass Zod-parsed
 * values so equal requests hash equal (listingSettingRequestHash).
 */
export function listingSettingWriteHash(operation: string, parsedBody: Record<string, unknown>): string {
  if ("idempotencyKey" in parsedBody) {
    throw listingSettingsInvariantFailed("A listing settings request hash never includes the request key.", { operation });
  }
  return listingSettingRequestHash({ operation, ...parsedBody });
}

/**
 * The replay probe's decision as the request's path: `new` writes, `replay`
 * answers from the probe's rows; a key used for another change is the
 * permanent key conflict, and rows a committed request cannot have left on
 * their own are fatal (plan 4.6).
 */
export function requestKeyUsePath(decision: RequestKeyUseDecision, context: { storeConnectionId: number }): "new" | "replay" {
  switch (decision.kind) {
    case "new":
    case "replay":
      return decision.kind;
    case "conflict":
      throw listingSettingKeyConflict(decision.mismatched, context);
    case "incomplete":
      throw new DropshipError(LISTING_SETTING_WRITE_ERROR_CODES.replayIncomplete,
        "An earlier save with this request key is only partly recorded.", {
          ...context, retryable: false, classification: "fatal",
        });
  }
}

/** The code, words and class of listingSettingsIdempotencyConflict (8a), with the fields that differ. */
export function listingSettingKeyConflict(mismatched: readonly string[], context: { storeConnectionId: number }): DropshipError {
  return permanent("DROPSHIP_IDEMPOTENCY_CONFLICT", "This request key was already used for a different listing settings change.",
    { ...context, mismatched: [...mismatched] });
}

/** A refusal or a log line names at most this many sizes, with the full count beside it (plan 3.5). */
export const MAX_LISTED_SIZES = 100;

/**
 * The prices the vendor was shown are not the ones the server computes now,
 * or the product's sizes changed (plan P14, P15): reload, then save again.
 * One code for W5 and a stale W7 apply.
 */
export function listingSettingPricesMoved(
  storeConnectionId: number,
  sizes: ReadonlyArray<Record<string, number | null>>,
): DropshipError {
  return permanent(LISTING_SETTING_WRITE_ERROR_CODES.pricesMoved,
    "Prices changed while you were editing. Reload to see the new prices, then save again.", {
      storeConnectionId, sizes: sizes.slice(0, MAX_LISTED_SIZES), sizeCount: sizes.length,
    });
}

/**
 * The store needs an eBay sign-in, and the change names eBay values the
 * target has not saved yet, so eBay cannot be asked about them (plan P13).
 * Raised before any eBay call. A change that only re-saves known values, or
 * sets none, still saves.
 */
export function listingSettingEbaySignInRequired(storeConnectionId: number, fields: readonly string[]): DropshipError {
  return permanent(LISTING_SETTING_WRITE_ERROR_CODES.ebaySignInRequired,
    "Sign in to eBay again to choose new eBay values. Settings that keep their saved eBay values can still be saved.", {
      storeConnectionId, fields: [...fields],
    });
}

/** The store's saved product text would pass its cap (plan 3.10 (e)): permanent, with the words that say what to do. */
export function listingSettingStoreTextLimit(storeConnectionId: number, textBytes: number, maxTextBytes: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_TOO_LARGE",
    "This store's saved listing text is at its limit. Shorten or remove text on other products, or set it once on a category or as the store default.", {
      storeConnectionId, reason: "store_text_limit", textBytes, maxTextBytes,
    });
}

/**
 * The text a heavy write would carry passes MAX_BULK_TEXT_BYTES (plan P9 (b),
 * 3.10 (b)): fewer products, or shorter text, fit. Permanent: the same
 * request is refused again.
 */
export function listingSettingBulkTooLarge(storeConnectionId: number, textBytes: number, maxTextBytes: number,
  productCount: number): DropshipError {
  return permanent("DROPSHIP_LISTING_SETTINGS_BULK_TOO_LARGE",
    "This change carries too much listing text to save at once. Choose fewer products, or set the text once on a category or as the store default.", {
      storeConnectionId, textBytes, maxTextBytes, productCount,
    });
}

/** Seconds a vendor waits before resending a heavy write the gate refused (plan 3.10 (a)). */
export const HEAVY_WRITE_RETRY_AFTER_SECONDS = 5;

/**
 * One heavy write at a time in this process (plan P9 (a), 3.10 (a)): W6, and
 * later W12 with a clear list and W7's review and apply. Explicitly stateful:
 * `run` refuses while another heavy write holds the gate, with the transient
 * DROPSHIP_LISTING_SETTINGS_BUSY (503, Retry-After 5), and releases in
 * `finally`, so a failed write never keeps it. The check and the claim run in
 * the same synchronous step, so two calls cannot both pass.
 *
 * It wraps the write transaction only (repository.execute), never the
 * preflight or an eBay call, so an eBay timeout never holds it. A refused
 * write never opens its write transaction (that takes a pool connection,
 * then the store lock, so a queue there would hold connections; the pool has
 * 20, server/db.ts). A write whose patch sets an eBay id has already run its
 * read-only preflight (one pooled connection, released) and its eBay calls
 * when the gate refuses it, and its retry runs both again. Nothing bounds how
 * long a write holds the gate but the write itself: its transaction sets no
 * lock or statement timeout. Precedent: the manual sync runner's overlap guard
 * (server/modules/channels/manual-sync-runner.ts). One instance per process,
 * built by the services factory and shared by every heavy writer. Two web
 * dynos would mean two gates, still one heavy write per heap (HYPOTHESIS:
 * one web dyno, server/db.ts).
 */
export class ListingSettingHeavyWriteGate {
  private held = false;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held) {
      throw new DropshipError(LISTING_SETTING_WRITE_ERROR_CODES.busy,
        "Another large listing settings change is being saved. Try again in a few seconds.", {
          reason: "heavy_write_in_progress", retryAfterSeconds: HEAVY_WRITE_RETRY_AFTER_SECONDS,
          retryable: true, classification: "transient",
        });
    }
    this.held = true;
    try {
      return await work();
    } finally {
      this.held = false;
    }
  }
}

/** Seconds a vendor waits before resending a write whose request key changed under it. */
const REQUEST_KEY_CHANGED_RETRY_AFTER_SECONDS = 5;

/**
 * The preflight found rows under the request key, so no eBay value was
 * resolved, but the write transaction finds none (a size delete cascaded its
 * policy and shelf revisions away, plan 6.13 #7). Unresolved eBay values are
 * never written: the retry runs the preflight again. Transient.
 */
export function listingSettingRequestKeyChanged(storeConnectionId: number): DropshipError {
  return new DropshipError(LISTING_SETTING_WRITE_ERROR_CODES.busy,
    "Listing settings are being changed by another request. Try again.", {
      storeConnectionId, reason: "request_key_changed", retryAfterSeconds: REQUEST_KEY_CHANGED_RETRY_AFTER_SECONDS,
      retryable: true, classification: "transient",
    });
}

/** The catalog reads that decide which sizes a vendor has chosen and Card Shellz shows (plan P12). */
export interface ChosenSizeReader {
  readonly vendorId: number;
  readonly catalog: Pick<ListingPriceCatalogReader,
    "listCatalogCandidates" | "listCatalogExposureRules" | "listSelectionRules" | "listVariantOverrides">;
}

/** A chosen size: Card Shellz shows it and the vendor's selection includes it. */
export interface ChosenSize {
  productVariantId: number;
  productId: number;
}
/** The scan's batch size (dropship-selected-catalog.ts): one candidate and one override read per batch. */
const CHOSEN_SIZE_BATCH_SIZE = 250;

/**
 * Which of `sizeIds` are chosen and shown, in ascending id, by the content
 * service's rule: Card Shellz exposes the size and the vendor's selection
 * includes it (stock is not part of "chosen", rawAtpUnits 0). Exposure and
 * selection rules are read once; candidates and overrides per batch of 250,
 * so a write checks only its own sizes, never the whole catalog (plan P12).
 * Each chosen size keeps its whole candidate: W5 needs the product's catalog
 * hash.
 */
export async function loadChosenSizes(tx: ChosenSizeReader, sizeIds: readonly number[],
  now: Date): Promise<Array<ChosenSize & { candidate: DropshipListingCatalogCandidate }>> {
  const ids = [...new Set(sizeIds)].sort((left, right) => left - right);
  if (ids.length === 0) return [];
  // One read at a time: these share the transaction's one connection, which runs one statement at a time anyway.
  const exposureRules = await tx.catalog.listCatalogExposureRules();
  const selectionRules = await tx.catalog.listSelectionRules(tx.vendorId);
  const chosen: Array<ChosenSize & { candidate: DropshipListingCatalogCandidate }> = [];
  for (let start = 0; start < ids.length; start += CHOSEN_SIZE_BATCH_SIZE) {
    const batch = ids.slice(start, start + CHOSEN_SIZE_BATCH_SIZE);
    const candidates = await tx.catalog.listCatalogCandidates(batch);
    const overrides = await tx.catalog.listVariantOverrides({ vendorId: tx.vendorId, productVariantIds: batch });
    const overrideById = new Map(overrides.map((row) => [row.productVariantId, row]));
    const wanted = new Set(batch);
    for (const candidate of [...candidates].sort((left, right) => left.productVariantId - right.productVariantId)) {
      if (!wanted.has(candidate.productVariantId)) continue;
      const exposure = evaluateDropshipCatalogExposure(candidate, exposureRules, now);
      const selection = evaluateDropshipVendorCatalogSelection({ candidate, adminExposureDecision: exposure,
        rules: selectionRules, rawAtpUnits: 0, override: overrideById.get(candidate.productVariantId) ?? null });
      if (!exposure.exposed || !selection.selected) continue;
      chosen.push({ productVariantId: candidate.productVariantId, productId: candidate.productId, candidate });
    }
  }
  return chosen;
}

function permanent(code: string, message: string, context: Record<string, unknown>): DropshipError {
  return new DropshipError(code, message, { ...context, retryable: false, classification: "permanent" });
}
