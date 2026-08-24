import { z } from "zod";

import {
  assessPackageAllocationAuthorityReadiness,
  type PackageAllocationAuthorityReadinessResultV1,
} from "./package-allocation-authority-readiness.domain";
import {
  resolvePackageAllocationAuthority,
  type PackageAllocationAuthorityResolutionResultV1,
} from "./package-allocation-authority-resolution.domain";
import { adaptPersistedDeclaredPackageLifecycleEvidence } from "./declared-package-lifecycle-shadow.domain";
import type {
  LockedPackageAllocationAuthorityEvidence,
  PackageAllocationAuthorityPreviewRepository,
} from "./package-allocation-ledger.repository";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_LINES = 500;
const MAX_PACKAGES = 200;

const sourceIdSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const labelIdSchema = z
  .number()
  .refine(Number.isSafeInteger, "must be a safe integer")
  .refine((value) => value > 0, "must be positive");

export const packageAllocationAuthorityResolutionPreviewCommandSchema = z
  .object({
    contractVersion: z.literal(1),
    authorityMode: z.literal("shadow_only"),
    previewMode: z.literal("bootstrap_selected_scope"),
    groupKey: z.string().uuid().transform((value) => value.toLowerCase()),
    sourceWmsShipmentItemIds: z
      .array(sourceIdSchema)
      .min(1)
      .max(MAX_SOURCE_LINES),
    shippingProviderLabelIds: z.array(labelIdSchema).min(1).max(MAX_PACKAGES),
  })
  .strict();

export type PackageAllocationAuthorityResolutionPreviewCommand = z.input<
  typeof packageAllocationAuthorityResolutionPreviewCommandSchema
>;

export const packageAllocationAuthorityResolutionDiscoveryPreviewCommandSchema = z
  .object({
    contractVersion: z.literal(1),
    authorityMode: z.literal("shadow_only"),
    previewMode: z.literal("bootstrap_relationship_discovery"),
    groupKey: z.string().uuid().transform((value) => value.toLowerCase()),
    sourceWmsShipmentItemIds: z
      .array(sourceIdSchema)
      .min(1)
      .max(MAX_SOURCE_LINES),
  })
  .strict();

export type PackageAllocationAuthorityResolutionDiscoveryPreviewCommand = z.input<
  typeof packageAllocationAuthorityResolutionDiscoveryPreviewCommandSchema
>;

export type PackageAllocationAuthorityResolutionPreviewServiceErrorCode =
  | "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID"
  | "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID"
  | "EXISTING_GROUP_REQUIRES_REPLAY"
  | "INVALID_AUTHORITY_RESOLUTION_PREVIEW_COMMAND";

export class PackageAllocationAuthorityResolutionPreviewServiceError extends Error {
  readonly code: PackageAllocationAuthorityResolutionPreviewServiceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PackageAllocationAuthorityResolutionPreviewServiceErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PackageAllocationAuthorityResolutionPreviewServiceError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export interface PackageAllocationAuthorityResolutionPreviewResultV1 {
  readonly contractVersion: 1;
  readonly authority: "none";
  readonly outcome: "review";
  readonly previewMode: "bootstrap_selected_scope";
  /** The caller selected these labels; this service does not prove the set is complete. */
  readonly selectionAuthority: "caller_selected_unproven";
  readonly selectionCompleteness: "unproven_caller_selection";
  readonly selectedShippingProviderLabelIds: readonly number[];
  readonly groupState: "absent" | "empty";
  readonly readiness: PackageAllocationAuthorityReadinessResultV1;
  readonly resolution: PackageAllocationAuthorityResolutionResultV1 | null;
}

export interface PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1 {
  readonly contractVersion: 1;
  readonly authority: "none";
  readonly outcome: "review";
  readonly previewMode: "bootstrap_relationship_discovery";
  /** Labels were derived only from persisted shipment relationships. */
  readonly selectionAuthority: "database_relationship_closure";
  /** A provider package without any persisted relationship remains unknowable here. */
  readonly selectionCompleteness: "unproven_outside_persisted_relationships";
  readonly selectedShippingProviderLabelIds: readonly number[];
  readonly groupState: "absent" | "empty";
  readonly readiness: PackageAllocationAuthorityReadinessResultV1;
  readonly resolution: PackageAllocationAuthorityResolutionResultV1 | null;
}

interface NormalizedPackageAllocationAuthorityResolutionPreviewCommand {
  readonly contractVersion: 1;
  readonly authorityMode: "shadow_only";
  readonly previewMode: "bootstrap_selected_scope";
  readonly groupKey: string;
  readonly sourceWmsShipmentItemIds: readonly number[];
  readonly shippingProviderLabelIds: readonly number[];
}

interface NormalizedPackageAllocationAuthorityResolutionDiscoveryPreviewCommand {
  readonly contractVersion: 1;
  readonly authorityMode: "shadow_only";
  readonly previewMode: "bootstrap_relationship_discovery";
  readonly groupKey: string;
  readonly sourceWmsShipmentItemIds: readonly number[];
}

type NormalizedPreviewCommand =
  | NormalizedPackageAllocationAuthorityResolutionPreviewCommand
  | NormalizedPackageAllocationAuthorityResolutionDiscoveryPreviewCommand;

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
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

function normalizeCommand(
  rawCommand: PackageAllocationAuthorityResolutionPreviewCommand,
): Readonly<NormalizedPackageAllocationAuthorityResolutionPreviewCommand> {
  const parsed =
    packageAllocationAuthorityResolutionPreviewCommandSchema.safeParse(rawCommand);
  if (!parsed.success) {
    throw new PackageAllocationAuthorityResolutionPreviewServiceError(
      "INVALID_AUTHORITY_RESOLUTION_PREVIEW_COMMAND",
      "Package-allocation authority resolution preview command failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }

  const duplicateSourceId = duplicateValue(
    parsed.data.sourceWmsShipmentItemIds,
  );
  if (duplicateSourceId !== null) {
    throw new PackageAllocationAuthorityResolutionPreviewServiceError(
      "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      "Package-allocation authority resolution preview requires unique source identities",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }

  const duplicateLabelId = duplicateValue(parsed.data.shippingProviderLabelIds);
  if (duplicateLabelId !== null) {
    throw new PackageAllocationAuthorityResolutionPreviewServiceError(
      "DUPLICATE_SHIPPING_PROVIDER_LABEL_ID",
      "Package-allocation authority resolution preview requires unique package labels",
      { shippingProviderLabelId: duplicateLabelId },
    );
  }

  return Object.freeze({
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    previewMode: "bootstrap_selected_scope" as const,
    groupKey: parsed.data.groupKey,
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


function normalizeDiscoveryCommand(
  rawCommand: PackageAllocationAuthorityResolutionDiscoveryPreviewCommand,
): Readonly<NormalizedPackageAllocationAuthorityResolutionDiscoveryPreviewCommand> {
  const parsed =
    packageAllocationAuthorityResolutionDiscoveryPreviewCommandSchema.safeParse(
      rawCommand,
    );
  if (!parsed.success) {
    throw new PackageAllocationAuthorityResolutionPreviewServiceError(
      "INVALID_AUTHORITY_RESOLUTION_PREVIEW_COMMAND",
      "Package-allocation authority relationship-discovery command failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }

  const duplicateSourceId = duplicateValue(
    parsed.data.sourceWmsShipmentItemIds,
  );
  if (duplicateSourceId !== null) {
    throw new PackageAllocationAuthorityResolutionPreviewServiceError(
      "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      "Package-allocation authority relationship discovery requires unique source identities",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }

  return Object.freeze({
    contractVersion: 1 as const,
    authorityMode: "shadow_only" as const,
    previewMode: "bootstrap_relationship_discovery" as const,
    groupKey: parsed.data.groupKey,
    sourceWmsShipmentItemIds: Object.freeze(
      [...parsed.data.sourceWmsShipmentItemIds].sort(
        (left, right) => left - right,
      ),
    ),
  });
}
function sortPackages(
  packages: readonly LockedPackageAllocationAuthorityEvidence[],
): readonly LockedPackageAllocationAuthorityEvidence[] {
  return Object.freeze(
    [...packages].sort((left, right) =>
      compareText(left.evidenceKey, right.evidenceKey),
    ),
  );
}

/**
 * Produces an inert bootstrap preview from either an explicitly selected label
 * set or a bounded closure of persisted shipment relationships. It never
 * creates a group, appends a plan, accepts operator actions, or makes an effect
 * executable. Relationship discovery cannot prove packages that have no
 * persisted relationship, so both modes remain explicitly incomplete.
 */
export class PackageAllocationAuthorityResolutionPreviewService {
  constructor(private readonly repository: PackageAllocationAuthorityPreviewRepository) {}

  async preview(
    rawCommand: PackageAllocationAuthorityResolutionPreviewCommand,
  ): Promise<PackageAllocationAuthorityResolutionPreviewResultV1> {
    return this.previewNormalized(normalizeCommand(rawCommand));
  }

  async previewDiscovered(
    rawCommand: PackageAllocationAuthorityResolutionDiscoveryPreviewCommand,
  ): Promise<PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1> {
    return this.previewNormalized(normalizeDiscoveryCommand(rawCommand));
  }

  private previewNormalized(
    command: NormalizedPackageAllocationAuthorityResolutionPreviewCommand,
  ): Promise<PackageAllocationAuthorityResolutionPreviewResultV1>;
  private previewNormalized(
    command: NormalizedPackageAllocationAuthorityResolutionDiscoveryPreviewCommand,
  ): Promise<PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1>;
  private async previewNormalized(
    command: NormalizedPreviewCommand,
  ): Promise<
    PackageAllocationAuthorityResolutionPreviewResultV1
    | PackageAllocationAuthorityResolutionDiscoveryPreviewResultV1
  > {
    return this.repository.withRepeatableReadOnlyTransaction(async (transaction) => {
      const group = await transaction.readGroup(command.groupKey);
      if (group !== null && group.currentVersion !== 0) {
        throw new PackageAllocationAuthorityResolutionPreviewServiceError(
          "EXISTING_GROUP_REQUIRES_REPLAY",
          "Bootstrap authority preview cannot interpret an existing allocation group",
          {
            groupKey: command.groupKey,
            currentVersion: group.currentVersion,
          },
        );
      }

      const sourceFacts = await transaction.readSourceFacts(
        command.sourceWmsShipmentItemIds,
      );
      const sortedSourceFacts = Object.freeze(
        [...sourceFacts].sort(
          (left, right) =>
            left.sourceWmsShipmentItemId - right.sourceWmsShipmentItemId,
        ),
      );
      const selectedShippingProviderLabelIds =
        command.previewMode === "bootstrap_selected_scope"
          ? command.shippingProviderLabelIds
          : await transaction.discoverAuthorityReadinessPackageLabelIds(
              command.sourceWmsShipmentItemIds,
            );
      const packages = sortPackages(await transaction.readAuthorityReadinessPackages(
        selectedShippingProviderLabelIds,
      ));
      const readiness = assessPackageAllocationAuthorityReadiness({
        contractVersion: 1,
        authorityMode: "shadow_only",
        sourceFacts: [...sortedSourceFacts],
        packages: [...packages],
      });
      const adaptedPackages = packages.map((pkg) => ({
        evidenceKey: pkg.evidenceKey,
        adapted: adaptPersistedDeclaredPackageLifecycleEvidence(
          pkg.persistedEvidence,
        ),
      }));
      const resolvedPackages = adaptedPackages.flatMap((pkg) =>
        pkg.adapted.outcome === "adapted"
          ? [{
              evidenceKey: pkg.evidenceKey,
              lifecycle: {
                provider: pkg.adapted.input.provider,
                providerPhysicalShipmentId: pkg.adapted.input.providerPhysicalShipmentId,
                events: [...pkg.adapted.input.events],
              },
            }]
          : [],
      );
      const resolution = resolvedPackages.length === packages.length
        ? resolvePackageAllocationAuthority({
            contractVersion: 1,
            authorityMode: "shadow_only",
            groupKey: command.groupKey,
            expectedGroupVersion: 0,
            previousPlan: null,
            sourceLines: sortedSourceFacts.map((source) => ({
              wmsShipmentItemId: source.sourceWmsShipmentItemId,
              sourceQuantity: source.sourceQuantity,
            })),
            packages: resolvedPackages,
            actions: [],
          })
        : null;

      const commonResult = {
        contractVersion: 1 as const,
        authority: "none" as const,
        outcome: "review" as const,
        selectedShippingProviderLabelIds,
        groupState: group === null ? "absent" as const : "empty" as const,
        readiness,
        resolution,
      };
      return command.previewMode === "bootstrap_selected_scope"
        ? deepFreeze({
            ...commonResult,
            previewMode: "bootstrap_selected_scope" as const,
            selectionAuthority: "caller_selected_unproven" as const,
            selectionCompleteness: "unproven_caller_selection" as const,
          })
        : deepFreeze({
            ...commonResult,
            previewMode: "bootstrap_relationship_discovery" as const,
            selectionAuthority: "database_relationship_closure" as const,
            selectionCompleteness: "unproven_outside_persisted_relationships" as const,
          });
    });
  }
}
