import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import { syncDropshipAcceptedOrderToWmsSafely } from "./dropship-fulfillment-sync-dispatch";
import type { NormalizedDropshipOrderPayload } from "./dropship-order-intake-service";
import type {
  DropshipOrderAcceptanceResult,
  DropshipOrderAcceptanceService,
} from "./dropship-order-acceptance-service";
import type {
  DropshipShippingQuoteResult,
  DropshipShippingQuoteService,
} from "./dropship-shipping-quote-service";
import type { DropshipLogEvent, DropshipLogger, DropshipOmsFulfillmentSync } from "./dropship-ports";
import type { DropshipVendorProvisioningService } from "./dropship-vendor-provisioning-service";

const positiveIdSchema = z.number().int().positive();
const idempotencyKeySchema = z.string().trim().min(8).max(200);

const acceptDropshipOrderForMemberInputSchema = z.object({
  intakeId: positiveIdSchema,
  idempotencyKey: idempotencyKeySchema,
}).strict();

export type AcceptDropshipOrderForMemberInput = z.infer<typeof acceptDropshipOrderForMemberInputSchema>;

export interface DropshipOrderAcceptanceWorkflowContext {
  intakeId: number;
  vendorId: number;
  storeConnectionId: number;
  defaultWarehouseId: number | null;
  normalizedPayload: NormalizedDropshipOrderPayload;
}

export interface DropshipOrderAcceptanceWorkflowRepository {
  loadOrderAcceptanceContext(input: {
    vendorId: number;
    intakeId: number;
  }): Promise<DropshipOrderAcceptanceWorkflowContext | null>;
}

export interface DropshipOrderAcceptanceWorkflowResult {
  quote: DropshipShippingQuoteResult;
  acceptance: DropshipOrderAcceptanceResult;
}

export interface DropshipOrderAcceptanceWorkflowDependencies {
  vendorProvisioning: DropshipVendorProvisioningService;
  repository: DropshipOrderAcceptanceWorkflowRepository;
  shippingQuoteService: Pick<DropshipShippingQuoteService, "quote">;
  acceptanceService: Pick<DropshipOrderAcceptanceService, "acceptOrder">;
  fulfillmentSync?: DropshipOmsFulfillmentSync;
  logger: DropshipLogger;
}

export class DropshipOrderAcceptanceWorkflowService {
  constructor(private readonly deps: DropshipOrderAcceptanceWorkflowDependencies) {}

  async acceptOrderForMember(
    memberId: string,
    input: unknown,
  ): Promise<DropshipOrderAcceptanceWorkflowResult> {
    const parsed = parseAcceptOrderForMemberInput(input);
    const provisioned = await this.deps.vendorProvisioning.provisionForMember(memberId);
    const vendorId = provisioned.vendor.vendorId;
    const context = await this.deps.repository.loadOrderAcceptanceContext({
      vendorId,
      intakeId: parsed.intakeId,
    });
    if (!context) {
      throw new DropshipError(
        "DROPSHIP_ORDER_INTAKE_NOT_FOUND",
        "Dropship order intake was not found for acceptance.",
        { vendorId, intakeId: parsed.intakeId },
      );
    }

    const warehouseId = requireDefaultWarehouse(context);
    const destination = quoteDestinationFromOrder(context.normalizedPayload, context.intakeId);
    const items = quoteItemsFromOrder(context.normalizedPayload, context.intakeId);
    const quote = await this.deps.shippingQuoteService.quote({
      vendorId,
      storeConnectionId: context.storeConnectionId,
      warehouseId,
      destination,
      items,
      idempotencyKey: deriveShippingQuoteIdempotencyKey(parsed.idempotencyKey),
    });
    const acceptance = await this.deps.acceptanceService.acceptOrder({
      intakeId: context.intakeId,
      vendorId,
      storeConnectionId: context.storeConnectionId,
      shippingQuoteSnapshotId: quote.quoteSnapshotId,
      idempotencyKey: parsed.idempotencyKey,
      actor: {
        actorType: "vendor",
        actorId: memberId,
      },
    });
    await syncDropshipAcceptedOrderToWmsSafely(this.deps, {
      acceptance,
      source: "vendor_acceptance",
    });

    this.deps.logger.info({
      code: "DROPSHIP_ORDER_ACCEPTANCE_WORKFLOW_COMPLETED",
      message: "Dropship order acceptance workflow completed.",
      context: {
        intakeId: context.intakeId,
        vendorId,
        storeConnectionId: context.storeConnectionId,
        quoteSnapshotId: quote.quoteSnapshotId,
        outcome: acceptance.outcome,
        totalDebitCents: acceptance.totalDebitCents,
        idempotentReplay: acceptance.idempotentReplay,
      },
    });

    return { quote, acceptance };
  }
}

export function makeDropshipOrderAcceptanceWorkflowLogger(): DropshipLogger {
  return {
    info: (event) => logDropshipOrderAcceptanceWorkflowEvent("info", event),
    warn: (event) => logDropshipOrderAcceptanceWorkflowEvent("warn", event),
    error: (event) => logDropshipOrderAcceptanceWorkflowEvent("error", event),
  };
}

export function deriveShippingQuoteIdempotencyKey(acceptanceIdempotencyKey: string): string {
  const idempotencyKey = acceptanceIdempotencyKey.trim();
  const suffix = ":shipping-quote";
  if (idempotencyKey.length + suffix.length <= 200) {
    return `${idempotencyKey}${suffix}`;
  }
  return `order-acceptance-quote:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}

function parseAcceptOrderForMemberInput(input: unknown): AcceptDropshipOrderForMemberInput {
  const result = acceptDropshipOrderForMemberInputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_ORDER_ACCEPTANCE_WORKFLOW_INVALID_INPUT",
      "Dropship order acceptance request failed validation.",
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

function requireDefaultWarehouse(context: DropshipOrderAcceptanceWorkflowContext): number {
  const defaultWarehouseId = context.defaultWarehouseId;
  if (typeof defaultWarehouseId === "number" && Number.isInteger(defaultWarehouseId) && defaultWarehouseId > 0) {
    return defaultWarehouseId;
  }
  throw new DropshipError(
    "DROPSHIP_ORDER_DEFAULT_WAREHOUSE_REQUIRED",
    "Store connection default warehouse is required before accepting dropship orders.",
    {
      intakeId: context.intakeId,
      storeConnectionId: context.storeConnectionId,
    },
  );
}

function quoteDestinationFromOrder(
  payload: NormalizedDropshipOrderPayload,
  intakeId: number,
): { country: string; region?: string; postalCode: string } {
  const shipTo = requireCompleteShipToForAcceptance(payload.shipTo, intakeId);
  const country = requiredTrimmedString(shipTo?.country, "shipTo.country", 2, intakeId).toUpperCase();
  if (country.length !== 2) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_COUNTRY_INVALID",
      "Dropship order ship-to country must be a two-letter country code.",
      { intakeId, country },
    );
  }
  const postalCode = requiredTrimmedString(shipTo?.postalCode, "shipTo.postalCode", 20, intakeId);
  const region = optionalTrimmedString(shipTo?.region, "shipTo.region", 100, intakeId);
  return region ? { country, region, postalCode } : { country, postalCode };
}

function requireCompleteShipToForAcceptance(
  shipTo: NormalizedDropshipOrderPayload["shipTo"],
  intakeId: number,
): NonNullable<NormalizedDropshipOrderPayload["shipTo"]> {
  if (!shipTo) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_REQUIRED",
      "Dropship order ship-to data is required before acceptance.",
      { intakeId },
    );
  }
  requiredTrimmedString(shipTo.name, "shipTo.name", 255, intakeId);
  requiredTrimmedString(shipTo.address1, "shipTo.address1", 255, intakeId);
  requiredTrimmedString(shipTo.city, "shipTo.city", 120, intakeId);
  requiredTrimmedString(shipTo.region, "shipTo.region", 100, intakeId);
  requiredTrimmedString(shipTo.postalCode, "shipTo.postalCode", 20, intakeId);
  requiredTrimmedString(shipTo.country, "shipTo.country", 2, intakeId);
  return shipTo;
}

function quoteItemsFromOrder(
  payload: NormalizedDropshipOrderPayload,
  intakeId: number,
): Array<{ productVariantId: number; quantity: number }> {
  if (!Array.isArray(payload.lines) || payload.lines.length === 0) {
    throw new DropshipError(
      "DROPSHIP_ORDER_LINES_REQUIRED",
      "Dropship order acceptance requires at least one normalized order line.",
      { intakeId },
    );
  }
  return payload.lines.map((line, lineIndex) => {
    const productVariantId = line.productVariantId;
    if (typeof productVariantId !== "number" || !Number.isInteger(productVariantId) || productVariantId <= 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_LINE_VARIANT_REQUIRED",
        "Dropship order line must resolve to a product variant before acceptance.",
        { intakeId, lineIndex },
      );
    }
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new DropshipError(
        "DROPSHIP_ORDER_LINE_QUANTITY_INVALID",
        "Dropship order line quantity must be a positive integer before acceptance.",
        { intakeId, lineIndex, quantity: line.quantity },
      );
    }
    return {
      productVariantId,
      quantity: line.quantity,
    };
  });
}

function requiredTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
  intakeId: number,
): string {
  if (typeof value !== "string") {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_REQUIRED",
      "Dropship order ship-to data is required before acceptance.",
      { intakeId, field },
    );
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_INVALID",
      "Dropship order ship-to data is invalid before acceptance.",
      { intakeId, field },
    );
  }
  return trimmed;
}

function optionalTrimmedString(
  value: unknown,
  field: string,
  maxLength: number,
  intakeId: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_INVALID",
      "Dropship order ship-to data is invalid before acceptance.",
      { intakeId, field },
    );
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > maxLength) {
    throw new DropshipError(
      "DROPSHIP_ORDER_SHIP_TO_INVALID",
      "Dropship order ship-to data is invalid before acceptance.",
      { intakeId, field },
    );
  }
  return trimmed;
}

function logDropshipOrderAcceptanceWorkflowEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
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
