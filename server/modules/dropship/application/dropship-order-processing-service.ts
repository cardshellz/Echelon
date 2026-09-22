import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { isDropshipFundingDeclineError } from "../domain/vendor-standing";
import { syncDropshipAcceptedOrderToWmsSafely } from "./dropship-fulfillment-sync-dispatch";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import { DROPSHIP_NOTIFICATION_EVENTS } from "./dropship-notification-events";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
  DropshipOmsFulfillmentSync,
  DropshipOmsFulfillmentSyncRetryQueue,
} from "./dropship-ports";
import type {
  DropshipAcceptanceReloadContext,
  DropshipOrderAcceptanceResult,
  DropshipOrderAcceptanceService,
} from "./dropship-order-acceptance-service";
import type {
  DropshipOrderIntakeStatus,
  NormalizedDropshipOrderPayload,
} from "./dropship-order-intake-service";
import type {
  DropshipShippingQuoteResult,
  DropshipShippingQuoteService,
} from "./dropship-shipping-quote-service";
import type {
  DropshipVendorStandingChange,
  DropshipVendorStandingService,
} from "./dropship-vendor-standing-service";
import type {
  DropshipAutoReloadResult,
  DropshipWalletService,
} from "./dropship-wallet-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

export const processDropshipOrderIntakeInputSchema = z.object({
  intakeId: positiveIdSchema,
  workerId: z.string().trim().min(1).max(255),
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type ProcessDropshipOrderIntakeInput = z.infer<typeof processDropshipOrderIntakeInputSchema>;

export interface DropshipOrderProcessingIntakeRecord {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  platform: "ebay" | "shopify";
  externalOrderId: string;
  status: DropshipOrderIntakeStatus;
  paymentHoldExpiresAt: Date | null;
  normalizedPayload: NormalizedDropshipOrderPayload;
}

export interface DropshipOrderProcessingConfig {
  defaultWarehouseId: number | null;
  warehouseConfigError: {
    code: string;
    message: string;
    context: Record<string, unknown>;
  } | null;
}

export interface DropshipOrderProcessingClaim {
  claimed: boolean;
  skipReason: string | null;
  intake: DropshipOrderProcessingIntakeRecord;
  config: DropshipOrderProcessingConfig;
}

export interface DropshipOrderProcessingQuoteItem {
  lineIndex: number;
  productVariantId: number;
  quantity: number;
}

export interface DropshipOrderProcessingRepository {
  claimIntake(input: {
    intakeId: number;
    workerId: string;
    now: Date;
  }): Promise<DropshipOrderProcessingClaim>;

  resolveQuoteItems(input: {
    intake: DropshipOrderProcessingIntakeRecord;
  }): Promise<DropshipOrderProcessingQuoteItem[]>;

  markIntakeFailure(input: {
    intakeId: number;
    vendorId: number;
    storeConnectionId: number;
    workerId: string;
    status: "failed" | "retrying";
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    now: Date;
  }): Promise<void>;

  markPaymentHoldExpired(input: {
    intakeId: number;
    vendorId: number;
    storeConnectionId: number;
    workerId: string;
    now: Date;
  }): Promise<boolean>;
}

export interface DropshipOrderProcessingResult {
  outcome: "accepted" | "payment_hold" | "failed" | "skipped" | "cancelled";
  intakeId: number;
  vendorId: number | null;
  storeConnectionId: number | null;
  shippingQuoteSnapshotId: number | null;
  omsOrderId: number | null;
  walletLedgerEntryId: number | null;
  economicsSnapshotId: number | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryable: boolean;
}

export interface DropshipOrderProcessingServiceDependencies {
  repository: DropshipOrderProcessingRepository;
  shippingQuote: Pick<DropshipShippingQuoteService, "quote">;
  orderAcceptance: Pick<DropshipOrderAcceptanceService, "acceptOrder" | "notifyAcceptanceOutcome">;
  walletAutoReload?: Pick<DropshipWalletService, "handleAutoReload">;
  /** Pauses the vendor when the backstop card charge is declined outright. */
  vendorStanding?: Pick<DropshipVendorStandingService, "pauseForFundingFailure">;
  notificationSender?: DropshipNotificationSender;
  fulfillmentSync?: DropshipOmsFulfillmentSync;
  fulfillmentSyncRetryQueue?: DropshipOmsFulfillmentSyncRetryQueue;
  clock: DropshipClock;
  logger: DropshipLogger;
}

export class DropshipOrderProcessingService {
  constructor(private readonly deps: DropshipOrderProcessingServiceDependencies) {}

  async processIntake(input: unknown): Promise<DropshipOrderProcessingResult> {
    const parsed = parseProcessInput(input);
    const now = this.deps.clock.now();
    const claim = await this.deps.repository.claimIntake({
      intakeId: parsed.intakeId,
      workerId: parsed.workerId,
      now,
    });

    if (!claim.claimed) {
      return {
        outcome: "skipped",
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        shippingQuoteSnapshotId: null,
        omsOrderId: null,
        walletLedgerEntryId: null,
        economicsSnapshotId: null,
        failureCode: "DROPSHIP_ORDER_PROCESSING_SKIPPED",
        failureMessage: claim.skipReason,
        retryable: false,
      };
    }

    try {
      const destination = buildQuoteDestination(claim.intake);
      const items = aggregateQuoteItems(await this.deps.repository.resolveQuoteItems({
        intake: claim.intake,
      }));
      const quote = await this.deps.shippingQuote.quote({
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        warehouseId: requireDefaultWarehouseId(claim),
        destination,
        items: items.map((item) => ({
          productVariantId: item.productVariantId,
          quantity: item.quantity,
        })),
        idempotencyKey: deriveOrderProcessingIdempotencyKey("quote", parsed),
      });
      // Notices are deferred: a pass can hold, top up and re-accept, and the
      // vendor hears about its one final outcome (notifyPassOutcome).
      const acceptance = await this.deps.orderAcceptance.acceptOrder({
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        shippingQuoteSnapshotId: quote.quoteSnapshotId,
        idempotencyKey: deriveOrderProcessingIdempotencyKey("accept", parsed),
        actor: {
          actorType: "job",
          actorId: parsed.workerId,
        },
      }, { notify: false });

      const reload = await this.tryHandleAutoReload({
        parsed,
        claim,
        acceptance,
      });
      const finalAcceptance = await this.retryAcceptanceAfterReload({
        parsed,
        claim,
        quote,
        acceptance,
        reload: reload.result,
      });
      await this.notifyPassOutcome(claim, finalAcceptance, reload);
      await syncDropshipAcceptedOrderToWmsSafely(this.deps, {
        acceptance: finalAcceptance,
        source: "order_processing",
      });

      this.logProcessed(parsed, claim, quote, finalAcceptance);
      return mapAcceptanceResult(finalAcceptance);
    } catch (error) {
      const classified = classifyOrderProcessingError(error);
      if (classified.code === "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED") {
        const cancelled = await this.deps.repository.markPaymentHoldExpired({
          intakeId: claim.intake.intakeId,
          vendorId: claim.intake.vendorId,
          storeConnectionId: claim.intake.storeConnectionId,
          workerId: parsed.workerId,
          now: this.deps.clock.now(),
        });
        if (cancelled) {
          this.deps.logger.warn({
            code: "DROPSHIP_ORDER_PROCESSING_PAYMENT_HOLD_EXPIRED",
            message: "Dropship order processing cancelled an expired payment hold.",
            context: {
              intakeId: claim.intake.intakeId,
              vendorId: claim.intake.vendorId,
              storeConnectionId: claim.intake.storeConnectionId,
            },
          });
          await this.notifyPaymentHoldExpired(claim, classified);
          return {
            outcome: "cancelled",
            intakeId: claim.intake.intakeId,
            vendorId: claim.intake.vendorId,
            storeConnectionId: claim.intake.storeConnectionId,
            shippingQuoteSnapshotId: null,
            omsOrderId: null,
            walletLedgerEntryId: null,
            economicsSnapshotId: null,
            failureCode: classified.code,
            failureMessage: classified.message,
            retryable: false,
          };
        }
      }
      await this.deps.repository.markIntakeFailure({
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        workerId: parsed.workerId,
        status: classified.retryable ? "retrying" : "failed",
        errorCode: classified.code,
        errorMessage: classified.message,
        retryable: classified.retryable,
        now: this.deps.clock.now(),
      });
      await this.notifyProcessingFailure(claim, classified);
      this.deps.logger.warn({
        code: "DROPSHIP_ORDER_PROCESSING_FAILED",
        message: "Dropship order intake processing failed.",
        context: {
          intakeId: claim.intake.intakeId,
          vendorId: claim.intake.vendorId,
          storeConnectionId: claim.intake.storeConnectionId,
          errorCode: classified.code,
          retryable: classified.retryable,
        },
      });
      return {
        outcome: "failed",
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        shippingQuoteSnapshotId: null,
        omsOrderId: null,
        walletLedgerEntryId: null,
        economicsSnapshotId: null,
        failureCode: classified.code,
        failureMessage: classified.message,
        retryable: classified.retryable,
      };
    }
  }

  private logProcessed(
    parsed: ProcessDropshipOrderIntakeInput,
    claim: DropshipOrderProcessingClaim,
    quote: DropshipShippingQuoteResult,
    acceptance: DropshipOrderAcceptanceResult,
  ): void {
    this.deps.logger.info({
      code: "DROPSHIP_ORDER_PROCESSING_COMPLETED",
      message: "Dropship order intake processing completed.",
      context: {
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        shippingQuoteSnapshotId: quote.quoteSnapshotId,
        quoteIdempotentReplay: quote.idempotentReplay,
        outcome: acceptance.outcome,
        omsOrderId: acceptance.omsOrderId,
        walletLedgerEntryId: acceptance.walletLedgerEntryId,
        economicsSnapshotId: acceptance.economicsSnapshotId,
        workerId: parsed.workerId,
      },
    });
  }

  /**
   * Second acceptance attempt, in the same pass, once a held order's shortfall
   * has been charged.
   *
   * Without this, the card is charged and the order stays parked until the
   * next worker pass happens to pick it up — a visible hold the vendor did
   * nothing to deserve, with the marketplace's cancellation clock running the
   * whole time. Only a SETTLED credit qualifies: a pending one (ACH) is not
   * spendable yet and acceptance would hold again.
   *
   * A failure here is logged and the original hold is returned rather than
   * thrown. The vendor's card was charged and the wallet holds the credit, so
   * there is nothing to unwind; the intake stays in payment_hold, which is a
   * re-acceptable status, and the next pass retries with money in place.
   * Throwing would route the intake through the failure path instead.
   */
  private async retryAcceptanceAfterReload(input: {
    parsed: ProcessDropshipOrderIntakeInput;
    claim: DropshipOrderProcessingClaim;
    quote: DropshipShippingQuoteResult;
    acceptance: DropshipOrderAcceptanceResult;
    reload: DropshipAutoReloadResult | null;
  }): Promise<DropshipOrderAcceptanceResult> {
    if (input.acceptance.outcome !== "payment_hold") {
      return input.acceptance;
    }
    const settled = input.reload?.outcome === "funding_created" && input.reload.fundingStatus === "settled";
    if (!settled) {
      return input.acceptance;
    }

    const context = {
      intakeId: input.claim.intake.intakeId,
      vendorId: input.claim.intake.vendorId,
      storeConnectionId: input.claim.intake.storeConnectionId,
      reloadLedgerEntryId: input.reload?.fundingLedgerEntryId ?? null,
      reloadAmountCents: input.reload?.amountCents ?? null,
    };
    try {
      const retried = await this.deps.orderAcceptance.acceptOrder({
        intakeId: input.claim.intake.intakeId,
        vendorId: input.claim.intake.vendorId,
        storeConnectionId: input.claim.intake.storeConnectionId,
        shippingQuoteSnapshotId: input.quote.quoteSnapshotId,
        idempotencyKey: deriveOrderProcessingIdempotencyKey("accept-after-reload", input.parsed),
        actor: {
          actorType: "job",
          actorId: input.parsed.workerId,
        },
      }, { notify: false });
      this.deps.logger.info({
        code: retried.outcome === "accepted"
          ? "DROPSHIP_ORDER_ACCEPTED_AFTER_RELOAD"
          : "DROPSHIP_ORDER_STILL_HELD_AFTER_RELOAD",
        message: retried.outcome === "accepted"
          ? "Dropship order was accepted in the same pass after its shortfall was charged."
          : "Dropship order remains on payment hold after the reload credit.",
        context: { ...context, outcome: retried.outcome, totalDebitCents: retried.totalDebitCents },
      });
      return retried;
    } catch (error) {
      this.deps.logger.warn({
        code: "DROPSHIP_ORDER_REACCEPTANCE_AFTER_RELOAD_FAILED",
        message: "Dropship order could not be re-accepted after its shortfall was charged; the credit stays in the wallet and the hold stands for the next pass.",
        context: { ...context, error: error instanceof Error ? error.message : String(error) },
      });
      return input.acceptance;
    }
  }

  private async tryHandleAutoReload(input: {
    parsed: ProcessDropshipOrderIntakeInput;
    claim: DropshipOrderProcessingClaim;
    acceptance: DropshipOrderAcceptanceResult;
  }): Promise<AutoReloadAttempt> {
    if (!this.deps.walletAutoReload) {
      return { result: null, issue: null, vendorPaused: false };
    }
    if (input.acceptance.outcome === "payment_hold" && input.acceptance.paymentHoldReason === "vendor_paused") {
      // The vendor is paused because their funding already failed; charging
      // the same card once per held order would only repeat the decline. The
      // daily wallet run retries the charge, and a manual top-up resumes them.
      this.deps.logger.info({
        code: "DROPSHIP_ORDER_BACKSTOP_SKIPPED_VENDOR_PAUSED",
        message: "Dropship order is held because the vendor is paused; no backstop charge while paused.",
        context: {
          intakeId: input.claim.intake.intakeId,
          vendorId: input.claim.intake.vendorId,
          storeConnectionId: input.claim.intake.storeConnectionId,
          paymentHoldExpiresAt: input.acceptance.paymentHoldExpiresAt?.toISOString() ?? null,
        },
      });
      return { result: null, issue: null, vendorPaused: false };
    }
    const autoReloadInput = input.acceptance.outcome === "payment_hold"
      ? {
          vendorId: input.claim.intake.vendorId,
          reason: "payment_hold" as const,
          requiredBalanceCents: input.acceptance.totalDebitCents,
          intakeId: input.claim.intake.intakeId,
          idempotencyKey: deriveOrderProcessingIdempotencyKey("auto-reload-payment-hold", input.parsed),
        }
      : {
          vendorId: input.claim.intake.vendorId,
          reason: "minimum_balance" as const,
          intakeId: input.claim.intake.intakeId,
          idempotencyKey: deriveOrderProcessingIdempotencyKey("auto-reload-minimum", input.parsed),
        };
    try {
      const result = await this.deps.walletAutoReload.handleAutoReload(autoReloadInput);
      if (
        result.outcome === "skipped"
        && (autoReloadInput.reason === "payment_hold" || result.skipReason !== "balance_already_sufficient")
      ) {
        this.deps.logger.warn({
          code: autoReloadInput.reason === "payment_hold"
            ? "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_SKIPPED"
            : "DROPSHIP_ORDER_MINIMUM_BALANCE_AUTO_RELOAD_SKIPPED",
          message: autoReloadInput.reason === "payment_hold"
            ? "Dropship order payment hold auto-reload was skipped."
            : "Dropship order minimum balance auto-reload was skipped.",
          context: {
            intakeId: input.claim.intake.intakeId,
            vendorId: input.claim.intake.vendorId,
            storeConnectionId: input.claim.intake.storeConnectionId,
            skipReason: result.skipReason,
          },
        });
        // A routine top-up skipped after an accepted order is the daily wallet
        // run's to report; only a held order's skip belongs in this pass's notice.
        return {
          result,
          issue: autoReloadInput.reason === "payment_hold"
            ? { kind: "skipped", reason: result.skipReason ?? "unknown" }
            : null,
          vendorPaused: false,
        };
      }
      return { result, issue: null, vendorPaused: false };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn({
        code: autoReloadInput.reason === "payment_hold"
          ? "DROPSHIP_ORDER_PAYMENT_HOLD_AUTO_RELOAD_FAILED"
          : "DROPSHIP_ORDER_MINIMUM_BALANCE_AUTO_RELOAD_FAILED",
        message: autoReloadInput.reason === "payment_hold"
          ? "Dropship order payment hold auto-reload failed."
          : "Dropship order minimum balance auto-reload failed.",
        context: {
          intakeId: input.claim.intake.intakeId,
          vendorId: input.claim.intake.vendorId,
          storeConnectionId: input.claim.intake.storeConnectionId,
          error: errorMessage,
        },
      });
      // A decline is the bank refusing the vendor's card: the vendor is paused
      // on the first one, and the pause notice then stands in for this pass's
      // order notice (see notifyPassOutcome).
      const declined = isDropshipFundingDeclineError(error);
      const pause = declined
        ? await this.pauseVendorForDeclineSafely(input.claim, autoReloadInput.reason, error)
        : null;
      const issue: AutoReloadIssue | null = autoReloadInput.reason !== "payment_hold"
        ? null
        : declined
          ? { kind: "declined", detail: declineDetailFor(error) }
          : { kind: "failed", message: errorMessage };
      return { result: null, issue, vendorPaused: pause?.outcome === "paused" };
    }
  }

  /**
   * Standing is a separate concern with its own retry (the daily wallet
   * maintenance run declines again and pauses then), so a failure here is
   * logged for a human and must not fail the order pass.
   */
  private async pauseVendorForDeclineSafely(
    claim: DropshipOrderProcessingClaim,
    reason: "minimum_balance" | "payment_hold",
    error: DropshipError,
  ): Promise<DropshipVendorStandingChange | null> {
    if (!this.deps.vendorStanding) {
      return null;
    }
    try {
      return await this.deps.vendorStanding.pauseForFundingFailure({
        vendorId: claim.intake.vendorId,
        reason: "card_declined",
        evidence: {
          source: "order_backstop",
          intakeId: claim.intake.intakeId,
          autoReloadReason: reason,
          failureCode: error.code,
          stripeCode: error.context?.stripeCode ?? null,
          stripeDeclineCode: error.context?.stripeDeclineCode ?? null,
        },
      });
    } catch (pauseError) {
      this.deps.logger.error({
        code: "DROPSHIP_ORDER_VENDOR_PAUSE_FAILED",
        message: "Dropship vendor could not be paused after a declined backstop charge; the daily wallet run retries the decline.",
        context: {
          intakeId: claim.intake.intakeId,
          vendorId: claim.intake.vendorId,
          error: pauseError instanceof Error ? pauseError.message : String(pauseError),
        },
      });
      return null;
    }
  }

  /**
   * One order notice per pass, for its final outcome: accepted (possibly
   * after a top-up), or held with what the top-up attempt came to. When the
   * pass paused the vendor, the pause notice already said what happened and
   * the held order shows on their Dashboard, so no second email goes out.
   * Never fails the pass: the outcome is already committed.
   */
  private async notifyPassOutcome(
    claim: DropshipOrderProcessingClaim,
    acceptance: DropshipOrderAcceptanceResult,
    reload: AutoReloadAttempt,
  ): Promise<void> {
    if (acceptance.idempotentReplay) {
      return;
    }
    if (acceptance.outcome === "payment_hold" && reload.vendorPaused) {
      this.deps.logger.info({
        code: "DROPSHIP_ORDER_HOLD_NOTICE_COVERED_BY_PAUSE",
        message: "Dropship order hold notice was not sent: the vendor was paused in this pass and told so.",
        context: {
          intakeId: claim.intake.intakeId,
          vendorId: claim.intake.vendorId,
          storeConnectionId: claim.intake.storeConnectionId,
        },
      });
      return;
    }
    try {
      // The context reaches both outcomes now: an accepted order whose backup
      // card was charged in this same pass has to say so, with the fee.
      await this.deps.orderAcceptance.notifyAcceptanceOutcome(acceptance, {
        reload: reloadContextFor(reload),
      });
    } catch (error) {
      this.deps.logger.error({
        code: "DROPSHIP_ORDER_OUTCOME_NOTICE_FAILED",
        message: "Dropship order outcome notice failed after the pass completed.",
        context: {
          intakeId: claim.intake.intakeId,
          vendorId: claim.intake.vendorId,
          outcome: acceptance.outcome,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async notifyPaymentHoldExpired(
    claim: DropshipOrderProcessingClaim,
    classified: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: claim.intake.vendorId,
      eventType: DROPSHIP_NOTIFICATION_EVENTS.ORDER_PAYMENT_HOLD_EXPIRED,
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship order payment hold expired",
      message: `Order intake ${claim.intake.intakeId} was cancelled because the wallet payment hold expired.`,
      payload: {
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        platform: claim.intake.platform,
        externalOrderId: claim.intake.externalOrderId,
        paymentHoldExpiresAt: claim.intake.paymentHoldExpiresAt?.toISOString() ?? null,
        failureCode: classified.code,
        failureMessage: classified.message,
      },
      idempotencyKey: `order-processing:${claim.intake.intakeId}:payment-hold-expired`,
    }, {
      code: "DROPSHIP_ORDER_PROCESSING_NOTIFICATION_FAILED",
      message: "Dropship order processing notification failed after payment hold expiry.",
      context: {
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        outcome: "cancelled",
      },
    });
  }

  private async notifyProcessingFailure(
    claim: DropshipOrderProcessingClaim,
    classified: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: claim.intake.vendorId,
      eventType: classified.retryable
        ? DROPSHIP_NOTIFICATION_EVENTS.ORDER_PROCESSING_RETRYING
        : DROPSHIP_NOTIFICATION_EVENTS.ORDER_PROCESSING_FAILED,
      critical: !classified.retryable,
      channels: ["email", "in_app"],
      title: classified.retryable ? "Dropship order processing retrying" : "Dropship order processing failed",
      message: classified.retryable
        ? `Order intake ${claim.intake.intakeId} processing hit a retryable issue: ${classified.message}.`
        : `Order intake ${claim.intake.intakeId} could not be processed: ${classified.message}.`,
      payload: {
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        platform: claim.intake.platform,
        externalOrderId: claim.intake.externalOrderId,
        status: claim.intake.status,
        failureCode: classified.code,
        failureMessage: classified.message,
        retryable: classified.retryable,
      },
      idempotencyKey: `order-processing:${claim.intake.intakeId}:${classified.code}`,
    }, {
      code: "DROPSHIP_ORDER_PROCESSING_NOTIFICATION_FAILED",
      message: "Dropship order processing notification failed after processing failure.",
      context: {
        intakeId: claim.intake.intakeId,
        vendorId: claim.intake.vendorId,
        storeConnectionId: claim.intake.storeConnectionId,
        failureCode: classified.code,
        retryable: classified.retryable,
      },
    });
  }
}

export function buildQuoteDestination(
  intake: DropshipOrderProcessingIntakeRecord,
): { country: string; region?: string; postalCode: string } {
  const shipTo = intake.normalizedPayload.shipTo;
  if (!shipTo?.country?.trim() || !shipTo?.postalCode?.trim()) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_DESTINATION_REQUIRED",
      "Dropship order processing requires country and postal code before quoting shipping.",
      { intakeId: intake.intakeId },
    );
  }
  return {
    country: shipTo.country.trim().toUpperCase(),
    postalCode: shipTo.postalCode.trim(),
    ...(shipTo.region?.trim() ? { region: shipTo.region.trim() } : {}),
  };
}

export function aggregateQuoteItems(
  items: readonly DropshipOrderProcessingQuoteItem[],
): DropshipOrderProcessingQuoteItem[] {
  if (items.length === 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_ITEMS_REQUIRED",
      "Dropship order processing requires at least one quotable item.",
    );
  }
  const byVariant = new Map<number, number>();
  for (const item of items) {
    if (!Number.isInteger(item.productVariantId) || item.productVariantId <= 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_PROCESSING_ITEM_VARIANT_INVALID",
        "Dropship order processing resolved an invalid product variant.",
        { lineIndex: item.lineIndex, productVariantId: item.productVariantId },
      );
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_PROCESSING_ITEM_QUANTITY_INVALID",
        "Dropship order processing resolved an invalid item quantity.",
        { lineIndex: item.lineIndex, quantity: item.quantity },
      );
    }
    byVariant.set(item.productVariantId, (byVariant.get(item.productVariantId) ?? 0) + item.quantity);
  }
  return [...byVariant.entries()].map(([productVariantId, quantity], lineIndex) => ({
    lineIndex,
    productVariantId,
    quantity,
  }));
}

/** What a held order's top-up attempt came to, for this pass's one notice. */
type AutoReloadIssue = Exclude<DropshipAcceptanceReloadContext, { kind: "pending" } | { kind: "charged" }>;

interface AutoReloadAttempt {
  result: DropshipAutoReloadResult | null;
  issue: AutoReloadIssue | null;
  /** True when this pass paused the vendor for the decline. */
  vendorPaused: boolean;
}

function reloadContextFor(attempt: AutoReloadAttempt): DropshipAcceptanceReloadContext | null {
  if (attempt.issue) {
    return attempt.issue;
  }
  if (attempt.result?.outcome === "funding_created" && attempt.result.fundingStatus === "pending") {
    return { kind: "pending", amountCents: attempt.result.amountCents, currency: attempt.result.currency };
  }
  if (attempt.result?.outcome === "funding_created" && attempt.result.fundingStatus === "settled") {
    return {
      kind: "charged",
      amountCents: attempt.result.amountCents,
      cardFeeCents: attempt.result.cardFeeCents,
      chargedCents: attempt.result.chargedCents,
      currency: attempt.result.currency,
    };
  }
  return null;
}

function declineDetailFor(error: DropshipError): string | null {
  const detail = error.context?.stripeDeclineCode;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}

export function deriveOrderProcessingIdempotencyKey(
  stage: "quote" | "accept" | "accept-after-reload" | "auto-reload-payment-hold" | "auto-reload-minimum",
  input: ProcessDropshipOrderIntakeInput,
): string {
  const digest = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
  return `order:${input.intakeId}:${stage}:${digest}`;
}

export function makeDropshipOrderProcessingLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderProcessingEvent("info", event),
    warn: (event) => logDropshipOrderProcessingEvent("warn", event),
    error: (event) => logDropshipOrderProcessingEvent("error", event),
  };
}

export const systemDropshipOrderProcessingClock: DropshipClock = {
  now: () => new Date(),
};

function requireDefaultWarehouseId(claim: DropshipOrderProcessingClaim): number {
  if (claim.config.warehouseConfigError) {
    throw new DropshipError(
      claim.config.warehouseConfigError.code,
      claim.config.warehouseConfigError.message,
      claim.config.warehouseConfigError.context,
    );
  }
  const warehouseId = claim.config.defaultWarehouseId;
  if (warehouseId === null || !Number.isInteger(warehouseId) || warehouseId <= 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_WAREHOUSE_CONFIG_REQUIRED",
      "Dropship order processing requires a default warehouse configured on the store connection.",
      {
        intakeId: claim.intake.intakeId,
        storeConnectionId: claim.intake.storeConnectionId,
      },
    );
  }
  return warehouseId;
}

function mapAcceptanceResult(
  acceptance: DropshipOrderAcceptanceResult,
): DropshipOrderProcessingResult {
  return {
    outcome: acceptance.outcome,
    intakeId: acceptance.intakeId,
    vendorId: acceptance.vendorId,
    storeConnectionId: acceptance.storeConnectionId,
    shippingQuoteSnapshotId: acceptance.shippingQuoteSnapshotId,
    omsOrderId: acceptance.omsOrderId,
    walletLedgerEntryId: acceptance.walletLedgerEntryId,
    economicsSnapshotId: acceptance.economicsSnapshotId,
    failureCode: null,
    failureMessage: null,
    retryable: false,
  };
}

function parseProcessInput(input: unknown): ProcessDropshipOrderIntakeInput {
  const result = processDropshipOrderIntakeInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_PROCESSING_INVALID_INPUT",
      "Dropship order processing input failed validation.",
      {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          code: issue.code,
          message: issue.message,
        })),
      },
    );
  }
  return result.data;
}

function classifyOrderProcessingError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof DropshipError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.context?.retryable === true,
    };
  }
  return {
    code: "DROPSHIP_ORDER_PROCESSING_UNEXPECTED_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}

function logDropshipOrderProcessingEvent(level: "info" | "warn" | "error", event: DropshipLogEvent): void {
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
