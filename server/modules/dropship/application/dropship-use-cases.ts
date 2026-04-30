import type { z } from "zod";
import { DropshipError, DropshipUseCaseNotImplementedError } from "../domain/errors";
import type { DropshipApplicationPorts } from "./dropship-ports";
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
    never
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

class PendingDropshipUseCase<TInput> implements DropshipUseCase<TInput, never> {
  constructor(
    public readonly descriptor: DropshipUseCaseDescriptor<TInput>,
  ) {}

  async execute(input: unknown): Promise<never> {
    validateDropshipUseCaseInput(this.descriptor, input);
    throw new DropshipUseCaseNotImplementedError(this.descriptor.name);
  }
}

export function createDropshipUseCaseRegistry(
  _ports: DropshipApplicationPorts,
): DropshipUseCaseRegistry {
  return {
    GenerateVendorListingPreview: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.GenerateVendorListingPreview,
    ),
    CreateListingPushJob: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.CreateListingPushJob,
    ),
    ProcessListingPushJob: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.ProcessListingPushJob,
    ),
    RecordMarketplaceOrderIntake: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.RecordMarketplaceOrderIntake,
    ),
    AcceptDropshipOrder: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.AcceptDropshipOrder,
    ),
    QuoteDropshipShipping: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.QuoteDropshipShipping,
    ),
    CreditWalletFunding: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.CreditWalletFunding,
    ),
    DebitWalletForOrder: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.DebitWalletForOrder,
    ),
    HandleAutoReload: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.HandleAutoReload,
    ),
    RefreshStoreToken: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.RefreshStoreToken,
    ),
    PushTrackingToVendorStore: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.PushTrackingToVendorStore,
    ),
    ProcessReturnInspection: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.ProcessReturnInspection,
    ),
    SendDropshipNotification: new PendingDropshipUseCase(
      dropshipUseCaseDescriptors.SendDropshipNotification,
    ),
  };
}
