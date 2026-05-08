import type { z } from "zod";
import { DropshipError } from "../domain/errors";
import type { DropshipApplicationPorts, DropshipTransaction } from "./dropship-ports";
import {
  acceptDropshipOrderInputSchema,
  createListingPushJobInputSchema,
  creditWalletFundingInputSchema,
  debitWalletForOrderInputSchema,
  generateVendorListingPreviewInputSchema,
  handleAutoReloadInputSchema,
  processListingPushJobInputSchema,
  processReturnInspectionInputSchema,
  pushTrackingToVendorStoreInputSchema,
  quoteDropshipShippingInputSchema,
  recordMarketplaceOrderIntakeInputSchema,
  refreshStoreTokenInputSchema,
  sendDropshipNotificationInputSchema,
  type AcceptDropshipOrderInput,
  type CreateListingPushJobInput,
  type CreditWalletFundingInput,
  type DebitWalletForOrderInput,
  type GenerateVendorListingPreviewInput,
  type HandleAutoReloadInput,
  type ProcessListingPushJobInput,
  type ProcessReturnInspectionInput,
  type PushTrackingToVendorStoreInput,
  type QuoteDropshipShippingInput,
  type RecordMarketplaceOrderIntakeInput,
  type RefreshStoreTokenInput,
  type SendDropshipNotificationInput,
} from "./dropship-use-case-dtos";

export const DROPSHIP_REQUIRED_USE_CASE_NAMES = [
  "GenerateVendorListingPreview",
  "CreateListingPushJob",
  "ProcessListingPushJob",
  "RecordMarketplaceOrderIntake",
  "AcceptDropshipOrder",
  "QuoteDropshipShipping",
  "CreditWalletFunding",
  "DebitWalletForOrder",
  "HandleAutoReload",
  "RefreshStoreToken",
  "PushTrackingToVendorStore",
  "ProcessReturnInspection",
  "SendDropshipNotification",
] as const;

export type DropshipUseCaseName = typeof DROPSHIP_REQUIRED_USE_CASE_NAMES[number];
export type DropshipTransactionPolicy = "read_only" | "required";
export type DropshipIdempotencyPolicy = "not_required" | "required";
export type DropshipAuditPolicy = "not_required" | "required";

export interface DropshipUseCaseDescriptor<TInput> {
  readonly name: DropshipUseCaseName;
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  readonly transactionPolicy: DropshipTransactionPolicy;
  readonly idempotencyPolicy: DropshipIdempotencyPolicy;
  readonly auditPolicy: DropshipAuditPolicy;
  readonly externalApiMocksRequired: readonly string[];
}

export interface DropshipUseCase<TInput, TOutput> {
  readonly descriptor: DropshipUseCaseDescriptor<TInput>;
  execute(input: unknown): Promise<TOutput>;
}

export type DropshipUseCaseOutputMap = {
  GenerateVendorListingPreview: unknown;
  CreateListingPushJob: { jobId: number };
  ProcessListingPushJob: unknown;
  RecordMarketplaceOrderIntake: { intakeId: number };
  AcceptDropshipOrder: unknown;
  QuoteDropshipShipping: { quoteSnapshotId: number };
  CreditWalletFunding: void;
  DebitWalletForOrder: void;
  HandleAutoReload: unknown;
  RefreshStoreToken: void;
  PushTrackingToVendorStore: void;
  ProcessReturnInspection: void;
  SendDropshipNotification: void;
};

export type DropshipUseCaseDescriptors = {
  GenerateVendorListingPreview: DropshipUseCaseDescriptor<GenerateVendorListingPreviewInput>;
  CreateListingPushJob: DropshipUseCaseDescriptor<CreateListingPushJobInput>;
  ProcessListingPushJob: DropshipUseCaseDescriptor<ProcessListingPushJobInput>;
  RecordMarketplaceOrderIntake: DropshipUseCaseDescriptor<RecordMarketplaceOrderIntakeInput>;
  AcceptDropshipOrder: DropshipUseCaseDescriptor<AcceptDropshipOrderInput>;
  QuoteDropshipShipping: DropshipUseCaseDescriptor<QuoteDropshipShippingInput>;
  CreditWalletFunding: DropshipUseCaseDescriptor<CreditWalletFundingInput>;
  DebitWalletForOrder: DropshipUseCaseDescriptor<DebitWalletForOrderInput>;
  HandleAutoReload: DropshipUseCaseDescriptor<HandleAutoReloadInput>;
  RefreshStoreToken: DropshipUseCaseDescriptor<RefreshStoreTokenInput>;
  PushTrackingToVendorStore: DropshipUseCaseDescriptor<PushTrackingToVendorStoreInput>;
  ProcessReturnInspection: DropshipUseCaseDescriptor<ProcessReturnInspectionInput>;
  SendDropshipNotification: DropshipUseCaseDescriptor<SendDropshipNotificationInput>;
};

export const dropshipUseCaseDescriptors: DropshipUseCaseDescriptors = {
  GenerateVendorListingPreview: {
    name: "GenerateVendorListingPreview",
    inputSchema: generateVendorListingPreviewInputSchema,
    transactionPolicy: "read_only",
    idempotencyPolicy: "not_required",
    auditPolicy: "not_required",
    externalApiMocksRequired: [],
  },
  CreateListingPushJob: {
    name: "CreateListingPushJob",
    inputSchema: createListingPushJobInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: [],
  },
  ProcessListingPushJob: {
    name: "ProcessListingPushJob",
    inputSchema: processListingPushJobInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["ebay", "shopify"],
  },
  RecordMarketplaceOrderIntake: {
    name: "RecordMarketplaceOrderIntake",
    inputSchema: recordMarketplaceOrderIntakeInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["ebay", "shopify"],
  },
  AcceptDropshipOrder: {
    name: "AcceptDropshipOrder",
    inputSchema: acceptDropshipOrderInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: [],
  },
  QuoteDropshipShipping: {
    name: "QuoteDropshipShipping",
    inputSchema: quoteDropshipShippingInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["carrier"],
  },
  CreditWalletFunding: {
    name: "CreditWalletFunding",
    inputSchema: creditWalletFundingInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["stripe", "usdc_base"],
  },
  DebitWalletForOrder: {
    name: "DebitWalletForOrder",
    inputSchema: debitWalletForOrderInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: [],
  },
  HandleAutoReload: {
    name: "HandleAutoReload",
    inputSchema: handleAutoReloadInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["stripe", "usdc_base"],
  },
  RefreshStoreToken: {
    name: "RefreshStoreToken",
    inputSchema: refreshStoreTokenInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["ebay", "shopify"],
  },
  PushTrackingToVendorStore: {
    name: "PushTrackingToVendorStore",
    inputSchema: pushTrackingToVendorStoreInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["ebay", "shopify"],
  },
  ProcessReturnInspection: {
    name: "ProcessReturnInspection",
    inputSchema: processReturnInspectionInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: [],
  },
  SendDropshipNotification: {
    name: "SendDropshipNotification",
    inputSchema: sendDropshipNotificationInputSchema,
    transactionPolicy: "required",
    idempotencyPolicy: "required",
    auditPolicy: "required",
    externalApiMocksRequired: ["email"],
  },
};

export type DropshipUseCaseRegistry = {
  [K in keyof DropshipUseCaseDescriptors]: DropshipUseCase<
    z.infer<DropshipUseCaseDescriptors[K]["inputSchema"]>,
    DropshipUseCaseOutputMap[K]
  >;
};

export function validateDropshipUseCaseInput<TInput>(
  descriptor: DropshipUseCaseDescriptor<TInput>,
  input: unknown,
): TInput {
  const result = descriptor.inputSchema.safeParse(input);
  if (!result.success) {
    throw new DropshipError(
      "DROPSHIP_INVALID_USE_CASE_INPUT",
      `${descriptor.name} input failed validation.`,
      {
        useCaseName: descriptor.name,
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

type DropshipUseCaseExecutor<TInput, TOutput> = (
  input: TInput,
  transaction: DropshipTransaction | null,
) => Promise<TOutput>;

class PortBackedDropshipUseCase<TInput, TOutput> implements DropshipUseCase<TInput, TOutput> {
  constructor(
    public readonly descriptor: DropshipUseCaseDescriptor<TInput>,
    private readonly ports: DropshipApplicationPorts,
    private readonly executor: DropshipUseCaseExecutor<TInput, TOutput>,
  ) {}

  async execute(input: unknown): Promise<TOutput> {
    const parsed = validateDropshipUseCaseInput(this.descriptor, input);
    if (this.descriptor.transactionPolicy === "required") {
      return this.ports.transactions.runInTransaction(async (transaction) => {
        const output = await this.executor(parsed, transaction);
        if (this.descriptor.auditPolicy === "required") {
          await this.ports.auditEvents.record(
            buildDropshipUseCaseAuditEvent(this.descriptor.name, parsed),
            transaction,
          );
        }
        return output;
      });
    }

    return this.executor(parsed, null);
  }
}

export function createDropshipUseCaseRegistry(
  ports: DropshipApplicationPorts,
): DropshipUseCaseRegistry {
  return {
    GenerateVendorListingPreview: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.GenerateVendorListingPreview,
      ports,
      (input) => ports.listings.generateVendorListingPreview(input),
    ),
    CreateListingPushJob: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.CreateListingPushJob,
      ports,
      async (input, transaction) => ({
        jobId: await ports.listings.enqueueListingPush({
          ...input,
          transaction: requireDropshipUseCaseTransaction("CreateListingPushJob", transaction),
        }),
      }),
    ),
    ProcessListingPushJob: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.ProcessListingPushJob,
      ports,
      (input, transaction) => ports.listings.processListingPushJob({
        ...input,
        transaction: requireDropshipUseCaseTransaction("ProcessListingPushJob", transaction),
      }),
    ),
    RecordMarketplaceOrderIntake: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.RecordMarketplaceOrderIntake,
      ports,
      async (input, transaction) => ({
        intakeId: await ports.orderIntake.recordMarketplaceIntake({
          ...input,
          transaction: requireDropshipUseCaseTransaction("RecordMarketplaceOrderIntake", transaction),
        }),
      }),
    ),
    AcceptDropshipOrder: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.AcceptDropshipOrder,
      ports,
      (input, transaction) => ports.orderAcceptance.acceptOrder({
        ...input,
        transaction: requireDropshipUseCaseTransaction("AcceptDropshipOrder", transaction),
      }),
    ),
    QuoteDropshipShipping: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.QuoteDropshipShipping,
      ports,
      async (input, transaction) => ({
        quoteSnapshotId: await ports.shipping.quote({
          ...input,
          transaction: requireDropshipUseCaseTransaction("QuoteDropshipShipping", transaction),
        }),
      }),
    ),
    CreditWalletFunding: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.CreditWalletFunding,
      ports,
      (input, transaction) => ports.wallet.creditFunding({
        ...input,
        transaction: requireDropshipUseCaseTransaction("CreditWalletFunding", transaction),
      }),
    ),
    DebitWalletForOrder: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.DebitWalletForOrder,
      ports,
      (input, transaction) => ports.wallet.debitOrder({
        ...input,
        transaction: requireDropshipUseCaseTransaction("DebitWalletForOrder", transaction),
      }),
    ),
    HandleAutoReload: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.HandleAutoReload,
      ports,
      (input, transaction) => ports.wallet.handleAutoReload({
        ...input,
        transaction: requireDropshipUseCaseTransaction("HandleAutoReload", transaction),
      }),
    ),
    RefreshStoreToken: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.RefreshStoreToken,
      ports,
      (input, transaction) => ports.marketplace.refreshStoreToken({
        ...input,
        transaction: requireDropshipUseCaseTransaction("RefreshStoreToken", transaction),
      }),
    ),
    PushTrackingToVendorStore: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.PushTrackingToVendorStore,
      ports,
      (input, transaction) => ports.marketplace.pushTracking({
        ...input,
        transaction: requireDropshipUseCaseTransaction("PushTrackingToVendorStore", transaction),
      }),
    ),
    ProcessReturnInspection: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.ProcessReturnInspection,
      ports,
      (input, transaction) => ports.returns.processInspection({
        ...input,
        transaction: requireDropshipUseCaseTransaction("ProcessReturnInspection", transaction),
      }),
    ),
    SendDropshipNotification: new PortBackedDropshipUseCase(
      dropshipUseCaseDescriptors.SendDropshipNotification,
      ports,
      (input, transaction) => ports.notifications.send({
        ...input,
        transaction: requireDropshipUseCaseTransaction("SendDropshipNotification", transaction),
      }),
    ),
  };
}

function requireDropshipUseCaseTransaction(
  useCaseName: DropshipUseCaseName,
  transaction: DropshipTransaction | null,
): DropshipTransaction {
  if (transaction) {
    return transaction;
  }
  throw new DropshipError(
    "DROPSHIP_USE_CASE_TRANSACTION_REQUIRED",
    `${useCaseName} requires a transaction.`,
    { useCaseName },
  );
}

function buildDropshipUseCaseAuditEvent<TInput>(
  useCaseName: DropshipUseCaseName,
  input: TInput,
) {
  const auditInput = normalizeDropshipUseCaseAuditInput(input);
  return {
    vendorId: auditInput.vendorId,
    storeConnectionId: auditInput.storeConnectionId,
    entityType: "dropship_use_case",
    entityId: useCaseName,
    eventType: `dropship_use_case_${dropshipUseCaseNameToAuditEventSuffix(useCaseName)}`,
    actorType: auditInput.actorType,
    actorId: auditInput.actorId,
    severity: "info" as const,
    payload: {
      useCaseName,
      input: auditInput.payload,
    },
  };
}

function dropshipUseCaseNameToAuditEventSuffix(useCaseName: DropshipUseCaseName): string {
  return useCaseName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function normalizeDropshipUseCaseAuditInput(input: unknown): {
  vendorId?: number;
  storeConnectionId?: number;
  actorType: "vendor" | "admin" | "system" | "job";
  actorId?: string;
  payload: Record<string, unknown>;
} {
  if (!isRecord(input)) {
    return {
      actorType: "system",
      payload: {},
    };
  }

  const actor = extractDropshipUseCaseActor(input);
  return {
    vendorId: numberProperty(input, "vendorId"),
    storeConnectionId: numberProperty(input, "storeConnectionId"),
    actorType: actor.actorType,
    actorId: actor.actorId,
    payload: sanitizeDropshipUseCaseAuditPayload(input),
  };
}

function extractDropshipUseCaseActor(input: Record<string, unknown>): {
  actorType: "vendor" | "admin" | "system" | "job";
  actorId?: string;
} {
  const actor = isRecord(input.actor)
    ? input.actor
    : isRecord(input.requestedBy)
      ? input.requestedBy
      : null;
  if (actor) {
    const actorType = actor.actorType;
    if (
      actorType === "vendor"
      || actorType === "admin"
      || actorType === "system"
      || actorType === "job"
    ) {
      const actorId = typeof actor.actorId === "string" ? actor.actorId : undefined;
      return actorId ? { actorType, actorId } : { actorType };
    }
  }

  if (typeof input.workerId === "string") {
    return { actorType: "job", actorId: input.workerId };
  }
  return { actorType: "system" };
}

function sanitizeDropshipUseCaseAuditPayload(input: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "rawPayload" || key === "payload" || key === "message" || key === "destination") {
      payload[key] = "[redacted]";
      continue;
    }
    if (key === "productVariantIds" && Array.isArray(value)) {
      payload.productVariantCount = value.length;
      continue;
    }
    if (key === "items" && Array.isArray(value)) {
      payload.itemCount = value.length;
      continue;
    }
    if (key === "requestedRetailPricesByVariantId" && isRecord(value)) {
      payload.requestedRetailPriceVariantCount = Object.keys(value).length;
      continue;
    }
    if (key === "actor" || key === "requestedBy") {
      payload[key] = sanitizeDropshipUseCaseActorPayload(value);
      continue;
    }
    payload[key] = value;
  }
  return payload;
}

function sanitizeDropshipUseCaseActorPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return {
    actorType: value.actorType,
    actorId: value.actorId,
  };
}

function numberProperty(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
