import { logger as platformLogger } from "../../../platform/observability/logger";
import type { RecordDropshipOrderIntakeInput } from "./dropship-order-intake-service";
import type {
  DropshipOrderIntakeRepositoryResult,
  DropshipOrderIntakeService,
} from "./dropship-order-intake-service";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
import type { DropshipOrderIntakeHealthService } from "./dropship-order-intake-health-service";
import { DropshipError } from "../domain/errors";
import { salesLedgerSinceFor } from "../domain/marketplace-quantity-decision";
import { decideParkedOrderLine } from "../domain/marketplace-unmatched-order";
import { permanentDatabaseErrorCode } from "./dropship-order-processing-service";

export const IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE = "DROPSHIP_ORDER_INTAKE_IMMUTABLE_PAYLOAD_CHANGE";
/** A cancellation the poll could not apply for a reason no retry fixes: dead-lettered for a person (plan v2 §7.2). */
export const EBAY_ORDER_CANCEL_UNPROCESSABLE_CODE = "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE";

/** // PROPOSED (sync-back): the hourly check of accepted orders (plan v2 §7.2): at most this many per store per poll. */
export const ACCEPTED_ORDER_CHECK_LIMIT = 50;
/** // PROPOSED (sync-back): accepted orders are checked for this long after acceptance. */
export const ACCEPTED_ORDER_CHECK_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** // PROPOSED (sync-back): an accepted order is asked about again after this long. */
export const ACCEPTED_ORDER_RECHECK_AFTER_MS = 60 * 60_000;
/** // PROPOSED (sync-back): orders of parked lines fetched again per store per poll once their item number is proven Card Shellz's. */
export const PARKED_ORDER_RELEASE_LIMIT = 10;

export interface DropshipEbayOrderIntakeStoreConnection {
  vendorId: number;
  storeConnectionId: number;
  platform: "ebay";
  lastOrderSyncAt: Date | null;
  /**
   * eBay item numbers (`legacyItemId`) of every listing this store published
   * for dropship, now or before a relist (plan v4 §7.3 step 1). Only order
   * lines sold through one of these are dropship work; the rest of the
   * vendor's eBay store is the vendor's own business.
   */
  dropshipListingIds: readonly string[];
  /** The same item numbers with their listing: the sales ledger's key (§6.4). */
  itemNumbers: ReadonlyArray<{ listingId: number; externalListingId: string }>;
  /** The store's listing custom labels (COALESCE(variant SKU, product SKU)): unknown item numbers are matched on them (§7.3 step 3). */
  listingSkus: ReadonlyArray<{ listingId: number; sku: string }>;
}

/** One order line on a known item number (paid or not): a sale for the ledger (§6.4). */
export interface DropshipEbayOrderSaleLine {
  listingId: number;
  externalOrderId: string;
  externalLineItemId: string;
  quantity: number;
  orderedAt: Date;
}

/** One order line on an item number the store never had, whose custom label is exactly one listing's (§7.3 step 3). */
export interface DropshipEbayUnmatchedOrderLine {
  externalOrderId: string;
  externalLineItemId: string;
  externalListingId: string;
  sku: string;
  candidateListingId: number;
  orderedAt: Date | null;
}

export interface DropshipEbayOrderIntakeOrder {
  externalOrderId: string;
  input: RecordDropshipOrderIntakeInput;
}

export interface DropshipEbayOrderIntakeFetchResult {
  orders: DropshipEbayOrderIntakeOrder[];
  ignored: number;
  saleLines: DropshipEbayOrderSaleLine[];
  /** Orders eBay cancelled that sold through the store's listings (§7.2). */
  cancelledOrders: Array<{ externalOrderId: string }>;
  unmatchedLines: DropshipEbayUnmatchedOrderLine[];
}

/** One eBay order read by id (the hourly check of accepted orders, and parked lines once proven). */
export type DropshipEbayOrderLookup =
  | { kind: "not_found" }
  | {
    kind: "order";
    cancelled: boolean;
    fulfilled: boolean;
    /** The intake input when the order is one intake records (paid, dropship lines, not cancelled or fulfilled); else null. */
    recordable: DropshipEbayOrderIntakeOrder | null;
  };

export interface DropshipEbayOrderIntakeImmutableConflictInput {
  vendorId: number;
  storeConnectionId: number;
  intakeId: number;
  externalOrderId: string;
  failureCode: typeof IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE;
  message: string;
  now: Date;
}

export interface DropshipEbayOrderIntakeProvider {
  fetchOrders(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    since: Date;
    until: Date;
  }): Promise<DropshipEbayOrderIntakeFetchResult>;

  fetchOrder(input: {
    connection: DropshipEbayOrderIntakeStoreConnection;
    externalOrderId: string;
  }): Promise<DropshipEbayOrderLookup>;
}

/** A parked line with what is known now about its candidate listing (§7.3 step 4). */
export interface DropshipParkedOrderLine {
  id: number;
  externalOrderId: string;
  externalListingId: string;
  sku: string;
  candidateListingId: number | null;
  firstSeenAt: Date;
  /** The candidate's item number now, and whether it ever had the parked one (a recorded previous number). */
  candidateExternalListingId: string | null;
  candidateHadItemNumber: boolean;
  /** When the sweep last read the candidate's eBay listing; null when it is due. */
  candidateReadAt: Date | null;
}

/**
 * The order poll's writes besides intake (plan v4 §6.4, §7.2, §7.3): each a
 * transaction of its own, each idempotent (unique lines, compare-and-set
 * flags, unique notice subjects), so a replayed poll writes nothing new.
 */
export interface DropshipEbayMarketplaceOrderEffects {
  /** Sales-ledger lines and parked lines (marking each newly parked line's candidate due), in one transaction. */
  recordPollFacts(input: {
    storeConnectionId: number; saleLines: readonly DropshipEbayOrderSaleLine[]; unmatchedLines: readonly DropshipEbayUnmatchedOrderLine[];
    seenAt: Date;
  }): Promise<{ saleLinesRecorded: number; linesParked: number }>;
  /** One eBay cancellation, applied to the intake (§7.2 intake table) and the ledger, in one transaction. */
  applyCancellation(input: { storeConnectionId: number; externalOrderId: string; at: Date }): Promise<{ action: string; intakeId: number | null }>;
  /** A cancellation that cannot be applied, for good: one dead-letter audit row per store and order. Answers whether it was new. */
  recordCancellationDeadLetter(input: {
    vendorId: number; storeConnectionId: number; externalOrderId: string; failureCode: string; message: string; at: Date;
  }): Promise<boolean>;
  listAcceptedOrdersToCheck(input: {
    storeConnectionId: number; now: Date; limit: number; acceptedWithinMs: number; recheckAfterMs: number;
  }): Promise<Array<{ intakeId: number; externalOrderId: string }>>;
  markMarketplaceStatusChecked(input: { intakeIds: readonly number[]; at: Date }): Promise<void>;
  listOpenParkedLines(input: { storeConnectionId: number }): Promise<DropshipParkedOrderLine[]>;
  resolveParkedLines(input: { ids: readonly number[]; resolution: "relinked" | "cancelled" | "fulfilled_elsewhere"; at: Date }): Promise<number>;
  /** The one vendor question per store and item (rule 7d, subject item:{number}). Answers whether it was new. */
  askAboutUnknownItem(input: {
    vendorId: number; storeConnectionId: number; externalListingId: string; sku: string; at: Date;
  }): Promise<boolean>;
  /** Open parked lines 30 days old expire (§7.3 step 6). Answers how many. */
  expireParkedLines(input: { now: Date }): Promise<number>;
  /** Starts the store's sales ledger once (§8 notes). Answers whether this call started it. */
  startSalesLedger(input: { storeConnectionId: number; since: Date }): Promise<boolean>;
}

export interface DropshipEbayOrderIntakeRepository {
  listPollableStoreConnections(input: {
    limit: number;
  }): Promise<DropshipEbayOrderIntakeStoreConnection[]>;


  recordImmutableOrderConflict(
    input: DropshipEbayOrderIntakeImmutableConflictInput,
  ): Promise<{ created: boolean }>;
}

export interface DropshipEbayOrderIntakeSweepResult {
  storesScanned: number;
  storesSucceeded: number;
  storesFailed: number;
  ordersCreated: number;
  ordersUpdated: number;
  ordersReplayed: number;
  ordersRejected: number;
  ordersIgnored: number;
  ordersConflicted: number;
  /** eBay cancellations applied to an intake (§7.2), and those dead-lettered for a person. */
  cancellationsApplied: number;
  cancellationsDeadLettered: number;
  /** Order lines parked on an unknown item number (§7.3), and parked lines released or resolved. */
  linesParked: number;
  parkedLinesResolved: number;
}

export interface DropshipEbayOrderIntakePollServiceDependencies {
  repository: DropshipEbayOrderIntakeRepository;
  healthService: Pick<
    DropshipOrderIntakeHealthService,
    "recordPollSucceeded" | "recordPollFailed" | "restoreStoresHeldOnlyByOrderIntakeHealth"
  >;
  provider: DropshipEbayOrderIntakeProvider;
  orderIntakeService: Pick<DropshipOrderIntakeService, "recordMarketplaceOrder">;
  marketplaceOrders: DropshipEbayMarketplaceOrderEffects;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipEbayOrderIntakePollService {
  constructor(private readonly deps: DropshipEbayOrderIntakePollServiceDependencies) {}

  async pollConnectedStores(input: {
    limit: number;
    initialLookbackMinutes: number;
    overlapMinutes: number;
  }): Promise<DropshipEbayOrderIntakeSweepResult> {
    const now = this.deps.clock.now();
    await this.restoreStoresHeldOnlyByIntakeHealthSafely(input.limit);
    await this.expireParkedLinesSafely(now);
    const connections = await this.deps.repository.listPollableStoreConnections({
      limit: input.limit,
    });
    const result = emptySweepResult(connections.length);

    for (const connection of connections) {
      try {
        const since = resolvePollSince({
          lastOrderSyncAt: connection.lastOrderSyncAt,
          now,
          initialLookbackMinutes: input.initialLookbackMinutes,
          overlapMinutes: input.overlapMinutes,
        });
        const fetched = await this.deps.provider.fetchOrders({
          connection,
          since,
          until: now,
        });
        result.ordersIgnored += fetched.ignored;
        // The ledger and the parked lines first, in one transaction: a cancellation below marks the ledger's lines,
        // and the sync point moves only after they are written (quantity coverage, §6.4).
        const facts = await this.deps.marketplaceOrders.recordPollFacts({
          storeConnectionId: connection.storeConnectionId,
          saleLines: fetched.saleLines,
          unmatchedLines: fetched.unmatchedLines,
          seenAt: now,
        });
        result.linesParked += facts.linesParked;
        if (facts.linesParked > 0) {
          this.deps.logger.warn({
            code: "DROPSHIP_ORDER_UNMATCHED_LISTING",
            message: "Dropship eBay order lines sold a store custom label on an item number Card Shellz does not know; parked, not shipped.",
            context: { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, linesParked: facts.linesParked },
          });
        }
        for (const order of fetched.orders) {
          try {
            const intake = await this.deps.orderIntakeService.recordMarketplaceOrder(order.input);
            applyIntakeResult(result, intake);
          } catch (error) {
            const conflict = parseImmutableOrderConflict({ error, order, connection });
            if (!conflict) throw error;

            const audit = await this.deps.repository.recordImmutableOrderConflict({
              vendorId: connection.vendorId,
              storeConnectionId: connection.storeConnectionId,
              intakeId: conflict.intakeId,
              externalOrderId: order.externalOrderId,
              failureCode: IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE,
              message: conflict.message,
              now: this.deps.clock.now(),
            });
            result.ordersConflicted += 1;
            if (audit.created) {
              this.deps.logger.warn({
                code: "DROPSHIP_EBAY_ORDER_INTAKE_IMMUTABLE_CONFLICT",
                message: "Dropship eBay order intake skipped an immutable payload conflict.",
                context: {
                  vendorId: connection.vendorId,
                  storeConnectionId: connection.storeConnectionId,
                  intakeId: conflict.intakeId,
                  externalOrderId: order.externalOrderId,
                },
              });
            }
          }
        }
        for (const cancelled of fetched.cancelledOrders) {
          await this.applyCancellation(connection, cancelled.externalOrderId, now, result);
        }
        await this.checkAcceptedOrders(connection, now, result);
        await this.releaseParkedLines(connection, now, result);
        await this.deps.healthService.recordPollSucceeded({
          vendorId: connection.vendorId,
          storeConnectionId: connection.storeConnectionId,
          platform: connection.platform,
          syncedThrough: now,
        });
        result.storesSucceeded += 1;
        await this.startSalesLedgerSafely(connection, now);
      } catch (error) {
        result.storesFailed += 1;
        await this.recordPollFailureSafely(connection, error);
        this.deps.logger.warn({
          code: "DROPSHIP_EBAY_ORDER_INTAKE_STORE_FAILED",
          message: "Dropship eBay order intake failed for a store connection.",
          context: {
            vendorId: connection.vendorId,
            storeConnectionId: connection.storeConnectionId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }

    return result;
  }

  /**
   * One eBay cancellation (plan v2 §7.2), classified per order: a passing
   * failure fails the store's pass, so the sync point stays and the order
   * comes again; a failure no retry fixes is dead-lettered once for a person
   * and the pass goes on.
   */
  private async applyCancellation(
    connection: DropshipEbayOrderIntakeStoreConnection,
    externalOrderId: string,
    now: Date,
    result: DropshipEbayOrderIntakeSweepResult,
  ): Promise<void> {
    const context = { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, externalOrderId };
    try {
      const applied = await this.deps.marketplaceOrders.applyCancellation({
        storeConnectionId: connection.storeConnectionId, externalOrderId, at: now,
      });
      if (applied.intakeId !== null && applied.action !== "already_applied" && applied.action !== "nothing_to_do") {
        result.cancellationsApplied += 1;
        this.deps.logger.info({
          code: "DROPSHIP_EBAY_ORDER_CANCEL_APPLIED",
          message: "Dropship eBay order intake applied an eBay cancellation.",
          context: { ...context, intakeId: applied.intakeId, action: applied.action },
        });
      } else {
        this.debug({ code: "DROPSHIP_EBAY_ORDER_CANCEL_SEEN", message: "Dropship eBay order cancellation needed nothing new.",
          context: { ...context, intakeId: applied.intakeId, action: applied.action } });
      }
    } catch (error) {
      if (!isPermanentCancellationFailure(error)) throw error;
      const failureCode = error instanceof DropshipError ? error.code : permanentDatabaseErrorCode(error) ?? EBAY_ORDER_CANCEL_UNPROCESSABLE_CODE;
      const created = await this.deps.marketplaceOrders.recordCancellationDeadLetter({
        vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, externalOrderId, failureCode,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 2000), at: now,
      });
      if (created) {
        result.cancellationsDeadLettered += 1;
        this.deps.logger.error({
          code: EBAY_ORDER_CANCEL_UNPROCESSABLE_CODE,
          message: "Dropship eBay order cancellation could not be applied and needs review.",
          context: { ...context, failureCode },
        });
      }
    }
  }

  /**
   * The hourly check of accepted orders (plan v2 §7.2): eBay's order list
   * filter may not show a cancel of an order already taken in, so up to 50
   * accepted, unshipped orders per store are asked about by id. A failed read
   * leaves the order to the next poll and never fails the pass.
   */
  private async checkAcceptedOrders(
    connection: DropshipEbayOrderIntakeStoreConnection,
    now: Date,
    result: DropshipEbayOrderIntakeSweepResult,
  ): Promise<void> {
    const context = { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId };
    let toCheck: Array<{ intakeId: number; externalOrderId: string }>;
    try {
      toCheck = await this.deps.marketplaceOrders.listAcceptedOrdersToCheck({
        storeConnectionId: connection.storeConnectionId, now, limit: ACCEPTED_ORDER_CHECK_LIMIT,
        acceptedWithinMs: ACCEPTED_ORDER_CHECK_WINDOW_MS, recheckAfterMs: ACCEPTED_ORDER_RECHECK_AFTER_MS,
      });
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_ACCEPTED_ORDER_CHECK_SKIPPED", "Dropship eBay accepted-order check could not list orders.", context, error);
      return;
    }
    const stillOpen: number[] = [];
    for (const order of toCheck) {
      let lookup: DropshipEbayOrderLookup;
      try {
        lookup = await this.deps.provider.fetchOrder({ connection, externalOrderId: order.externalOrderId });
      } catch (error) {
        // eBay did not answer: the rest wait for the next poll (their check time is left as it was).
        this.warnSkipped("DROPSHIP_EBAY_ACCEPTED_ORDER_CHECK_SKIPPED", "Dropship eBay accepted-order check could not read an order.",
          { ...context, intakeId: order.intakeId, externalOrderId: order.externalOrderId }, error);
        break;
      }
      if (lookup.kind === "order" && lookup.cancelled) {
        await this.applyCancellation(connection, order.externalOrderId, now, result);
      } else {
        stillOpen.push(order.intakeId);
      }
    }
    try {
      await this.deps.marketplaceOrders.markMarketplaceStatusChecked({ intakeIds: stillOpen, at: now });
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_ACCEPTED_ORDER_CHECK_SKIPPED", "Dropship eBay accepted-order check could not record its check time.",
        context, error);
    }
  }

  /**
   * Parked lines (plan v4 §7.3 step 4): once the sweep proves the item number
   * is the candidate listing's (it now shows it, or had it before a relist),
   * the order is read again and taken in; if the sweep read the candidate and
   * did not prove it, the vendor is asked once per item. Never fails the pass.
   */
  private async releaseParkedLines(
    connection: DropshipEbayOrderIntakeStoreConnection,
    now: Date,
    result: DropshipEbayOrderIntakeSweepResult,
  ): Promise<void> {
    const context = { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId };
    let lines: DropshipParkedOrderLine[];
    try {
      lines = await this.deps.marketplaceOrders.listOpenParkedLines({ storeConnectionId: connection.storeConnectionId });
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_PARKED_LINES_SKIPPED", "Dropship eBay parked order lines could not be listed.", context, error);
      return;
    }
    const proven = new Map<string, number[]>();
    for (const line of lines) {
      const decision = decideParkedOrderLine(line);
      if (decision === "release") {
        proven.set(line.externalOrderId, [...(proven.get(line.externalOrderId) ?? []), line.id]);
      } else if (decision === "ask_vendor") {
        await this.askAboutUnknownItem(connection, line, now);
      }
    }
    for (const [externalOrderId, ids] of [...proven.entries()].slice(0, PARKED_ORDER_RELEASE_LIMIT)) {
      try {
        const lookup = await this.deps.provider.fetchOrder({ connection, externalOrderId });
        if (lookup.kind === "not_found") continue;
        if (lookup.recordable) {
          const intake = await this.deps.orderIntakeService.recordMarketplaceOrder(lookup.recordable.input);
          applyIntakeResult(result, intake);
        }
        const resolution = lookup.cancelled ? "cancelled" : lookup.fulfilled ? "fulfilled_elsewhere" : "relinked";
        result.parkedLinesResolved += await this.deps.marketplaceOrders.resolveParkedLines({ ids, resolution, at: now });
        this.deps.logger.info({
          code: "DROPSHIP_ORDER_UNMATCHED_LISTING_RESOLVED",
          message: "Dropship eBay parked order lines were resolved after their item number was proven.",
          context: { ...context, externalOrderId, resolution, lines: ids.length, recorded: lookup.recordable !== null },
        });
      } catch (error) {
        // The lines stay parked (and expire after 30 days); the next poll tries again.
        this.warnSkipped("DROPSHIP_EBAY_PARKED_LINES_SKIPPED", "Dropship eBay parked order lines could not be released.",
          { ...context, externalOrderId }, error);
      }
    }
  }

  private async askAboutUnknownItem(connection: DropshipEbayOrderIntakeStoreConnection, line: DropshipParkedOrderLine, now: Date): Promise<void> {
    try {
      const asked = await this.deps.marketplaceOrders.askAboutUnknownItem({
        vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, externalListingId: line.externalListingId,
        sku: line.sku, at: now,
      });
      if (asked) {
        this.deps.logger.info({
          code: "DROPSHIP_ORDER_UNMATCHED_LISTING_ASKED",
          message: "Dropship vendor was asked about an eBay item number that sold a Card Shellz custom label.",
          context: { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, externalListingId: line.externalListingId },
        });
      }
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_PARKED_LINES_SKIPPED", "Dropship eBay unknown-item question could not be written.",
        { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, externalListingId: line.externalListingId }, error);
    }
  }

  /** The sales ledger starts with this release's first successful poll of the store (§8 notes); a failure waits for the next one. */
  private async startSalesLedgerSafely(connection: DropshipEbayOrderIntakeStoreConnection, now: Date): Promise<void> {
    try {
      const started = await this.deps.marketplaceOrders.startSalesLedger({
        storeConnectionId: connection.storeConnectionId, since: salesLedgerSinceFor(now),
      });
      if (started) {
        this.deps.logger.info({
          code: "DROPSHIP_EBAY_SALES_LEDGER_STARTED",
          message: "Dropship eBay sales ledger started for a store.",
          context: { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId, since: salesLedgerSinceFor(now).toISOString() },
        });
      }
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_SALES_LEDGER_START_DEFERRED", "Dropship eBay sales ledger start was deferred to the next poll.",
        { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId }, error);
    }
  }

  private async expireParkedLinesSafely(now: Date): Promise<void> {
    try {
      const expired = await this.deps.marketplaceOrders.expireParkedLines({ now });
      if (expired > 0) {
        this.deps.logger.info({
          code: "DROPSHIP_ORDER_UNMATCHED_LISTING_EXPIRED",
          message: "Dropship eBay parked order lines 30 days old expired.",
          context: { expired },
        });
      }
    } catch (error) {
      this.warnSkipped("DROPSHIP_EBAY_PARKED_LINES_SKIPPED", "Dropship eBay parked order lines could not be expired.", {}, error);
    }
  }

  private warnSkipped(code: string, message: string, context: Record<string, unknown>, error: unknown): void {
    this.deps.logger.warn({ code, message, context: { ...context, error: error instanceof Error ? error.message : String(error),
      errorCode: error instanceof DropshipError ? error.code : null } });
  }

  private debug(event: DropshipLogEvent): void {
    (this.deps.logger.debug ?? this.deps.logger.info).call(this.deps.logger, event);
  }

  /**
   * Runs before the stores are listed, so a store left in "attention_required"
   * only by its intake health check is ready again before its orders are
   * fetched: an order recorded while the store is not ready is rejected. A
   * failure here is logged and the sweep goes on; such a store is then simply
   * not polled this time, and the next sweep tries again.
   */
  private async restoreStoresHeldOnlyByIntakeHealthSafely(limit: number): Promise<void> {
    try {
      await this.deps.healthService.restoreStoresHeldOnlyByOrderIntakeHealth({ platform: "ebay", limit });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_STORE_SETUP_STATUS_RESTORE_FAILED",
        message: "Dropship eBay order intake could not restore stores held only by their intake health check.",
        context: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async recordPollFailureSafely(
    connection: DropshipEbayOrderIntakeStoreConnection,
    error: unknown,
  ): Promise<void> {
    try {
      await this.deps.healthService.recordPollFailed({
        vendorId: connection.vendorId,
        storeConnectionId: connection.storeConnectionId,
        platform: connection.platform,
        failureCode: error instanceof DropshipError
          ? error.code
          : "DROPSHIP_EBAY_ORDER_INTAKE_STORE_FAILED",
        failureMessage: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    } catch (healthError) {
      this.deps.logger.error({
        code: "DROPSHIP_ORDER_INTAKE_HEALTH_RECORDING_FAILED",
        message: "Dropship order-intake failure could not be persisted to the health ledger.",
        context: { vendorId: connection.vendorId, storeConnectionId: connection.storeConnectionId,
          error: healthError instanceof Error ? healthError.message : String(healthError) },
      });
    }
  }
}

export function resolvePollSince(input: {
  lastOrderSyncAt: Date | null;
  now: Date;
  initialLookbackMinutes: number;
  overlapMinutes: number;
}): Date {
  const sourceDate = input.lastOrderSyncAt ?? new Date(input.now.getTime() - input.initialLookbackMinutes * 60_000);
  const overlapMs = input.lastOrderSyncAt ? input.overlapMinutes * 60_000 : 0;
  return new Date(Math.min(sourceDate.getTime() - overlapMs, input.now.getTime()));
}

export function makeDropshipEbayOrderIntakeLogger(): DropshipLogger {
  return {
    // Expected repeats (CLAUDE.md §10): the platform logger's debug level, off at the default LOG_LEVEL (review ARCH-5).
    debug: (event) => platformLogger.debug(event.code, { message: event.message, context: event.context ?? {} }),
    info: (event) => logDropshipEbayOrderIntakeEvent("info", event),
    warn: (event) => logDropshipEbayOrderIntakeEvent("warn", event),
    error: (event) => logDropshipEbayOrderIntakeEvent("error", event),
  };
}

export const systemDropshipEbayOrderIntakeClock: DropshipClock = {
  now: () => new Date(),
};

function emptySweepResult(storesScanned: number): DropshipEbayOrderIntakeSweepResult {
  return {
    storesScanned,
    storesSucceeded: 0,
    storesFailed: 0,
    ordersCreated: 0,
    ordersUpdated: 0,
    ordersReplayed: 0,
    ordersRejected: 0,
    ordersIgnored: 0,
    ordersConflicted: 0,
    cancellationsApplied: 0,
    cancellationsDeadLettered: 0,
    linesParked: 0,
    parkedLinesResolved: 0,
  };
}

/**
 * A cancellation failure no retry fixes (plan v2 §7.2): a dropship error
 * marked permanent or not retryable (an intake state the table does not
 * cover, a ledger that cannot be followed), or an integrity or query SQLSTATE.
 * Everything else (serialization, deadlock, a lost connection) is passing.
 */
function isPermanentCancellationFailure(error: unknown): boolean {
  if (error instanceof DropshipError) {
    return error.context?.classification === "permanent" || error.context?.retryable === false;
  }
  return permanentDatabaseErrorCode(error) !== null;
}

function parseImmutableOrderConflict(input: {
  error: unknown;
  order: DropshipEbayOrderIntakeOrder;
  connection: DropshipEbayOrderIntakeStoreConnection;
}): { intakeId: number; message: string } | null {
  if (!(input.error instanceof DropshipError) || input.error.code !== IMMUTABLE_ORDER_INTAKE_CONFLICT_CODE) {
    return null;
  }

  const intakeId = input.error.context?.intakeId;
  const externalOrderId = input.error.context?.externalOrderId;
  const storeConnectionId = input.error.context?.storeConnectionId;
  if (
    !Number.isInteger(intakeId)
    || (intakeId as number) <= 0
    || externalOrderId !== input.order.externalOrderId
    || storeConnectionId !== input.connection.storeConnectionId
  ) {
    return null;
  }

  return { intakeId: intakeId as number, message: input.error.message };
}

function applyIntakeResult(
  aggregate: DropshipEbayOrderIntakeSweepResult,
  result: DropshipOrderIntakeRepositoryResult,
): void {
  if (result.intake.status === "rejected") {
    aggregate.ordersRejected += 1;
    return;
  }
  if (result.action === "created") {
    aggregate.ordersCreated += 1;
  } else if (result.action === "updated") {
    aggregate.ordersUpdated += 1;
  } else {
    aggregate.ordersReplayed += 1;
  }
}

function logDropshipEbayOrderIntakeEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
  } else if (level === "warn") {
    console.warn(payload);
  } else {
    console.info(payload);
  }
}
