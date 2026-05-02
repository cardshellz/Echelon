import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipClock, DropshipLogEvent, DropshipLogger } from "./dropship-ports";
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
  stage: "quote" | "accept",
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
