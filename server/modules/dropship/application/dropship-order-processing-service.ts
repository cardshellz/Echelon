import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { syncDropshipAcceptedOrderToWmsSafely } from "./dropship-fulfillment-sync-dispatch";
import { sendDropshipNotificationSafely } from "./dropship-notification-dispatch";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
  DropshipNotificationSender,
  DropshipOmsFulfillmentSync,
} from "./dropship-ports";
import type {
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
  orderAcceptance: Pick<DropshipOrderAcceptanceService, "acceptOrder">;
  walletAutoReload?: Pick<DropshipWalletService, "handleAutoReload">;
  notificationSender?: DropshipNotificationSender;
  fulfillmentSync?: DropshipOmsFulfillmentSync;
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
      });

      await this.tryHandleAutoReload({
        parsed,
        claim,
        acceptance,
      });
      await syncDropshipAcceptedOrderToWmsSafely(this.deps, {
        acceptance,
        source: "order_processing",
      });

      this.logProcessed(parsed, claim, quote, acceptance);
      return mapAcceptanceResult(acceptance);
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

  private async tryHandleAutoReload(input: {
    parsed: ProcessDropshipOrderIntakeInput;
    claim: DropshipOrderProcessingClaim;
    acceptance: DropshipOrderAcceptanceResult;
  }): Promise<DropshipAutoReloadResult | null> {
    if (!this.deps.walletAutoReload) {
      return null;
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
        await this.notifyAutoReloadIssue({
          claim: input.claim,
          reason: autoReloadInput.reason,
          issueType: "skipped",
          issueCode: result.skipReason ?? "unknown",
          issueMessage: `Auto-reload was skipped: ${result.skipReason ?? "unknown"}.`,
        });
      }
      return result;
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
      await this.notifyAutoReloadIssue({
        claim: input.claim,
        reason: autoReloadInput.reason,
        issueType: "failed",
        issueCode: "auto_reload_provider_error",
        issueMessage: errorMessage,
      });
      return null;
    }
  }

  private async notifyAutoReloadIssue(input: {
    claim: DropshipOrderProcessingClaim;
    reason: "minimum_balance" | "payment_hold";
    issueType: "skipped" | "failed";
    issueCode: string;
    issueMessage: string;
  }): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: input.claim.intake.vendorId,
      eventType: "dropship_auto_reload_failed",
      critical: true,
      channels: ["email", "in_app"],
      title: "Dropship auto-reload failed",
      message: `Auto-reload for order intake ${input.claim.intake.intakeId} did not complete: ${input.issueMessage}`,
      payload: {
        intakeId: input.claim.intake.intakeId,
        vendorId: input.claim.intake.vendorId,
        storeConnectionId: input.claim.intake.storeConnectionId,
        platform: input.claim.intake.platform,
        externalOrderId: input.claim.intake.externalOrderId,
        autoReloadReason: input.reason,
        issueType: input.issueType,
        issueCode: input.issueCode,
        issueMessage: input.issueMessage,
      },
      idempotencyKey: deriveAutoReloadIssueNotificationKey({
        intakeId: input.claim.intake.intakeId,
        reason: input.reason,
        issueType: input.issueType,
        issueCode: input.issueCode,
        issueMessage: input.issueMessage,
      }),
    }, {
      code: "DROPSHIP_AUTO_RELOAD_NOTIFICATION_FAILED",
      message: "Dropship auto-reload failure notification failed.",
      context: {
        intakeId: input.claim.intake.intakeId,
        vendorId: input.claim.intake.vendorId,
        storeConnectionId: input.claim.intake.storeConnectionId,
        autoReloadReason: input.reason,
        issueType: input.issueType,
        issueCode: input.issueCode,
      },
    });
  }

  private async notifyPaymentHoldExpired(
    claim: DropshipOrderProcessingClaim,
    classified: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    await sendDropshipNotificationSafely(this.deps, {
      vendorId: claim.intake.vendorId,
      eventType: "dropship_order_payment_hold_expired",
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
      eventType: classified.retryable ? "dropship_order_processing_retrying" : "dropship_order_processing_failed",
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

export function deriveOrderProcessingIdempotencyKey(
  stage: "quote" | "accept" | "auto-reload-payment-hold" | "auto-reload-minimum",
  input: ProcessDropshipOrderIntakeInput,
): string {
  const digest = createHash("sha256").update(input.idempotencyKey).digest("hex").slice(0, 32);
  return `order:${input.intakeId}:${stage}:${digest}`;
}

export function deriveAutoReloadIssueNotificationKey(input: {
  intakeId: number;
  reason: "minimum_balance" | "payment_hold";
  issueType: "skipped" | "failed";
  issueCode: string;
  issueMessage: string;
}): string {
  const digest = createHash("sha256")
    .update(`${input.reason}:${input.issueType}:${input.issueCode}:${input.issueMessage}`)
    .digest("hex")
    .slice(0, 32);
  return `order:${input.intakeId}:auto-reload-alert:${digest}`;
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
      retryable: false,
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
