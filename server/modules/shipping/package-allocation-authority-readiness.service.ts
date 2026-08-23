import { z } from "zod";

import {
  assessPackageAllocationAuthorityReadiness,
  type PackageAllocationAuthorityReadinessResultV1,
} from "./package-allocation-authority-readiness.domain";
import type { PackageAllocationLedgerRepository } from "./package-allocation-ledger.repository";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_LINES = 500;
const MAX_PACKAGES = 200;

const sourceIdSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const labelIdSchema = z
  .number()
  .refine(Number.isSafeInteger, "must be a safe integer")
  .refine((value) => value > 0, "must be positive");

export const packageAllocationAuthorityReadinessCommandSchema = z
  .object({
    contractVersion: z.literal(1),
    authorityMode: z.literal("shadow_only"),
    sourceWmsShipmentItemIds: z
      .array(sourceIdSchema)
      .min(1)
      .max(MAX_SOURCE_LINES),
    shippingProviderLabelIds: z.array(labelIdSchema).min(1).max(MAX_PACKAGES),
  })
  .strict();

export type PackageAllocationAuthorityReadinessCommand = z.input<
  typeof packageAllocationAuthorityReadinessCommandSchema
>;

export type PackageAllocationAuthorityReadinessServiceErrorCode =
  | "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID"
  | "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID"
  | "INVALID_AUTHORITY_READINESS_COMMAND";

export class PackageAllocationAuthorityReadinessServiceError extends Error {
  readonly code: PackageAllocationAuthorityReadinessServiceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PackageAllocationAuthorityReadinessServiceErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PackageAllocationAuthorityReadinessServiceError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

function duplicateValue(values: readonly number[]): number | null {
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function sanitizedIssues(error: z.ZodError): readonly Readonly<{
  code: string;
  path: readonly (string | number)[];
  message: string;
}>[] {
  return Object.freeze(
    error.issues.map((issue) =>
      Object.freeze({
        code: issue.code,
        path: Object.freeze([...issue.path]),
        message: issue.message,
      }),
    ),
  );
}

interface NormalizedPackageAllocationAuthorityReadinessCommand {
  readonly contractVersion: 1;
  readonly authorityMode: "shadow_only";
  readonly sourceWmsShipmentItemIds: readonly number[];
  readonly shippingProviderLabelIds: readonly number[];
}

function normalizeCommand(
  rawCommand: PackageAllocationAuthorityReadinessCommand,
): Readonly<NormalizedPackageAllocationAuthorityReadinessCommand> {
  const parsed =
    packageAllocationAuthorityReadinessCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw new PackageAllocationAuthorityReadinessServiceError(
      "INVALID_AUTHORITY_READINESS_COMMAND",
      "Package-allocation authority readiness command failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }
  const duplicateSourceId = duplicateValue(
    parsed.data.sourceWmsShipmentItemIds,
  );
  if (duplicateSourceId !== null) {
    throw new PackageAllocationAuthorityReadinessServiceError(
      "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      "Package-allocation authority readiness requires unique source identities",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }
  const duplicateLabelId = duplicateValue(parsed.data.shippingProviderLabelIds);
  if (duplicateLabelId !== null) {
    throw new PackageAllocationAuthorityReadinessServiceError(
      "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID",
      "Package-allocation authority readiness requires unique package labels",
      { shippingProviderLabelId: duplicateLabelId },
    );
  }
  return Object.freeze({
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    sourceWmsShipmentItemIds: Object.freeze(
      [...parsed.data.sourceWmsShipmentItemIds].sort(
        (left, right) => left - right,
      ),
    ),
    shippingProviderLabelIds: Object.freeze(
      [...parsed.data.shippingProviderLabelIds].sort(
        (left, right) => left - right,
      ),
    ),
  });
}

/**
 * Loads authenticated database evidence under the ledger's serializable locks
 * and runs the pure readiness classifier. This service never creates a group,
 * persists a plan, grants authority, or emits executable effects.
 */
export class PackageAllocationAuthorityReadinessService {
  constructor(private readonly repository: PackageAllocationLedgerRepository) {}

  async assess(
    rawCommand: PackageAllocationAuthorityReadinessCommand,
  ): Promise<PackageAllocationAuthorityReadinessResultV1> {
    const command = normalizeCommand(rawCommand);
    return this.repository.withSerializableTransaction(async (transaction) => {
      const sourceFacts = await transaction.lockSourceFacts(
        command.sourceWmsShipmentItemIds,
      );
      const packages = await transaction.lockAuthorityReadinessPackages(
        command.shippingProviderLabelIds,
      );
      return assessPackageAllocationAuthorityReadiness({
        contractVersion: 1,
        authorityMode: "shadow_only",
        sourceFacts: [...sourceFacts],
        packages: [...packages],
      });
    });
  }
}
