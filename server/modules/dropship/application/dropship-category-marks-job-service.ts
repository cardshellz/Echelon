import { categoryMarksJobKey } from "../domain/category-marks-job";
import { DropshipError } from "../domain/errors";
import type { ListingSettingWriteRepository } from "./dropship-listing-setting-writes";
import type { DropshipClock } from "./dropship-ports";

/**
 * The first-mark job (plan PR 9, P28, 10.5): every hour, a category mark for
 * each chosen product of each eligible eBay store that has none yet, so a
 * later Card Shellz move of that product is listed under "Card Shellz updated
 * products" (W13). A move before a product's first mark is not reported
 * (Listing settings design 8.12).
 *
 * One tick: the eligible stores in one read; per vendor, its chosen products
 * in one read-only snapshot (selection is per vendor, so one scan serves all
 * its stores); per store, one system transaction (the store lock and the
 * owner rows) inserting the missing marks. The insert is ON CONFLICT DO
 * NOTHING from catalog.products, so a rerun inserts and audits nothing, an
 * existing mark is never changed, and the scan outside the transaction is
 * safe: a "Got it" committing in between makes the insert a no-op for that
 * product. A failure skips its vendor or its store only; the next tick runs
 * in an hour.
 */

/** A store the job marks: eBay, connected, needing a sign-in or a token refresh, of an active or onboarding vendor. */
export interface CategoryMarksStore {
  vendorId: number;
  storeConnectionId: number;
}

/** What the job reads outside any write transaction. */
export interface CategoryMarksJobSource {
  /** Every eligible store, ascending by vendor, then store; each store once. */
  listMarkableStores(): Promise<CategoryMarksStore[]>;
  /** The vendor's chosen products (at least one chosen size), ascending, in one read-only snapshot; no cap. */
  listSelectedProductIds(vendorId: number, now: Date): Promise<number[]>;
}

/** The job's lines through the platform logger (plan 3.4): it needs DEBUG for its quiet ticks, which DropshipLogger lacks. */
export interface CategoryMarksJobLog {
  debug(action: string, fields: Record<string, unknown>): void;
  info(action: string, fields: Record<string, unknown>): void;
  warn(action: string, fields: Record<string, unknown>): void;
  error(action: string, fields: Record<string, unknown>): void;
}

export interface DropshipCategoryMarksJobServiceDependencies {
  source: CategoryMarksJobSource;
  repository: Pick<ListingSettingWriteRepository, "executeForSystem">;
  clock: DropshipClock;
  /** Monotonic milliseconds, for `elapsed_ms` only; the marks' time is `clock`, read once per tick. */
  timer: () => number;
  log: CategoryMarksJobLog;
}

export interface CategoryMarksTickResult {
  jobKey: string;
  /** Eligible stores listed this tick. */
  storesScanned: number;
  /** Their vendors: one selection scan each. */
  vendorsScanned: number;
  /** Vendors whose scan failed; their stores were skipped this tick. */
  vendorsFailed: number;
  /** Stores whose first-mark transaction failed. */
  storesFailed: number;
  /** Marks inserted, over every store. */
  insertedCount: number;
  elapsedMs: number;
}

/** A log line names at most this many products, with the full count beside it (plan 3.5). */
const MAX_LOGGED_PRODUCTS = 100;
const STORE_GONE = "DROPSHIP_STORE_CONNECTION_REQUIRED";
/** The codes a failure line carries when the error is not a DropshipError (CLAUDE.md §6, §10: every line has a code). */
const VENDOR_FAILED_CODE = "DROPSHIP_CATEGORY_MARKS_VENDOR_FAILED";
const STORE_FAILED_CODE = "DROPSHIP_CATEGORY_MARKS_STORE_FAILED";

type FailureLevel = "debug" | "warn" | "error";

export class DropshipCategoryMarksJobService {
  constructor(private readonly deps: DropshipCategoryMarksJobServiceDependencies) {}

  async runOnce(): Promise<CategoryMarksTickResult> {
    const started = this.deps.timer();
    const now = this.deps.clock.now();
    const jobKey = categoryMarksJobKey(now);
    // A failure to list the stores fails the tick: the runner logs it, and the next tick runs in an hour.
    const stores = await this.deps.source.listMarkableStores();
    const storesByVendor = groupByVendor(stores);
    let vendorsFailed = 0;
    let storesFailed = 0;
    let insertedCount = 0;

    for (const [vendorId, storeConnectionIds] of storesByVendor) {
      let productIds: readonly number[];
      try {
        productIds = await this.deps.source.listSelectedProductIds(vendorId, now);
      } catch (error) {
        vendorsFailed += 1;
        this.logFailure("dropship.listing_settings.category_marks_vendor_failed", VENDOR_FAILED_CODE, error, {
          job_key: jobKey, vendor_id: vendorId, store_connection_ids: storeConnectionIds,
        });
        continue;
      }
      // Nothing chosen: no transaction, so no store lock is taken for nothing.
      if (productIds.length === 0) continue;
      for (const storeConnectionId of storeConnectionIds) {
        try {
          const { insertedProductIds } = await this.deps.repository.executeForSystem({ storeConnectionId, jobKey },
            (tx) => tx.insertFirstCategoryMarks({ productIds, jobKey, now }));
          insertedCount += insertedProductIds.length;
          if (insertedProductIds.length > 0) {
            this.deps.log.info("dropship.listing_settings.category_marks_seeded", {
              outcome: "seeded", job_key: jobKey, vendor_id: vendorId, store_connection_id: storeConnectionId,
              inserted_count: insertedProductIds.length, inserted_product_ids: insertedProductIds.slice(0, MAX_LOGGED_PRODUCTS),
            });
          }
        } catch (error) {
          storesFailed += 1;
          this.logFailure("dropship.listing_settings.category_marks_store_failed", STORE_FAILED_CODE, error, {
            job_key: jobKey, vendor_id: vendorId, store_connection_id: storeConnectionId,
          });
        }
      }
    }

    const result: CategoryMarksTickResult = {
      jobKey,
      storesScanned: stores.length,
      vendorsScanned: storesByVendor.size,
      vendorsFailed,
      storesFailed,
      insertedCount,
      elapsedMs: Math.max(0, Math.round(this.deps.timer() - started)),
    };
    const fields = {
      outcome: vendorsFailed > 0 || storesFailed > 0 ? "partial" : "completed",
      job_key: result.jobKey, stores_scanned: result.storesScanned, vendors_scanned: result.vendorsScanned,
      vendors_failed: result.vendorsFailed, stores_failed: result.storesFailed, inserted_count: result.insertedCount,
      elapsed_ms: result.elapsedMs,
    };
    // A tick that marked nothing and failed nowhere is the normal quiet case (CLAUDE.md §10): DEBUG.
    if (insertedCount > 0 || vendorsFailed > 0 || storesFailed > 0) this.deps.log.info("dropship.listing_settings.category_marks_tick", fields);
    else this.deps.log.debug("dropship.listing_settings.category_marks_tick", fields);
    return result;
  }

  /**
   * One failed vendor scan or store, by class: a retryable failure (the
   * database busy or unreachable) is WARN, retried next hour; a store deleted
   * since the list is expected (DEBUG); anything else, a broken contract or an
   * unexpected error, needs a human (ERROR). An error that is not a
   * DropshipError carries the line's own code, and the error's own code (a
   * server SQLSTATE, or a Node errno) as `cause_code` when it has one.
   */
  private logFailure(action: string, fallbackCode: string, error: unknown, fields: Record<string, unknown>): void {
    const code = error instanceof DropshipError ? error.code : fallbackCode;
    const classification = error instanceof DropshipError ? classificationOf(error) : "fatal";
    const level: FailureLevel = code === STORE_GONE ? "debug" : classification === "transient" ? "warn" : "error";
    const causeCode = error instanceof DropshipError ? null : causeCodeOf(error);
    const entry = {
      ...fields,
      outcome: level === "debug" ? "skipped" : level === "warn" ? "deferred" : "failed",
      error_code: code,
      error_class: code === STORE_GONE ? "permanent" : classification,
      ...(causeCode === null ? {} : { cause_code: causeCode }),
      // Only a line a human reads carries the detail; our contexts hold ids, counts and codes, never vendor text.
      ...(level === "error" ? {
        error_message: error instanceof Error ? error.message : String(error),
        ...(error instanceof DropshipError && error.context ? { error_context: error.context } : {}),
      } : {}),
    };
    this.deps.log[level](action, entry);
  }
}

/** The stores of each vendor, in the order listed (each store once). */
function groupByVendor(stores: readonly CategoryMarksStore[]): Map<number, number[]> {
  const byVendor = new Map<number, number[]>();
  for (const store of stores) {
    const storeIds = byVendor.get(store.vendorId);
    if (storeIds) storeIds.push(store.storeConnectionId);
    else byVendor.set(store.vendorId, [store.storeConnectionId]);
  }
  return byVendor;
}

/** The `code` node-postgres (a SQLSTATE) or Node (an errno) put on an error; null when there is none. */
function causeCodeOf(error: unknown): string | null {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** A DropshipError's own class (CLAUDE.md §6); one without a known class is treated as fatal. */
function classificationOf(error: DropshipError): "transient" | "permanent" | "fatal" {
  const value = error.context?.classification;
  return value === "transient" || value === "permanent" || value === "fatal" ? value : "fatal";
}
