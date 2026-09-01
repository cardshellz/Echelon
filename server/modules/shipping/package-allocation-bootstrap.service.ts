import { createHash } from "node:crypto";

import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  buildPackageAllocationAuthorityRelationshipSelectionEvidence,
  resolvePackageAllocationAuthorityEvidence,
  type PackageAllocationAuthorityRelationshipSelectionEvidenceV1,
} from "./package-allocation-authority-resolution.service";
import {
  PackageAllocationLedgerRepositoryError,
  type PackageAllocationLedgerRepository,
  type PackageAllocationLedgerTransaction,
} from "./package-allocation-ledger.repository";
import {
  PackageAllocationPlanningService,
  type PersistPackageAllocationPlanResult,
} from "./package-allocation-planning.service";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_SOURCE_LINES = 500;
const MAX_SERIALIZABLE_ATTEMPTS = 3;

const sourceWmsShipmentItemIdsSchema = z.array(
  z.number().int().positive().max(POSTGRES_INTEGER_MAX),
).min(1).max(MAX_SOURCE_LINES);

export const persistDiscoveredPackageAllocationBootstrapCommandSchema = z.object({
  contractVersion: z.literal(1),
  authorityMode: z.literal("shadow_only"),
  bootstrapMode: z.literal("relationship_discovery"),
  sourceWmsShipmentItemIds: sourceWmsShipmentItemIdsSchema,
  writeContext: z.object({
    createdBy: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(1).max(500),
  }).strict(),
}).strict();

export type PersistDiscoveredPackageAllocationBootstrapCommand = z.input<
  typeof persistDiscoveredPackageAllocationBootstrapCommandSchema
>;

export type PackageAllocationBootstrapPersistenceErrorCode =
  | "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID"
  | "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY"
  | "INVALID_BOOTSTRAP_COMMAND";

export class PackageAllocationBootstrapPersistenceError extends Error {
  readonly code: PackageAllocationBootstrapPersistenceErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: PackageAllocationBootstrapPersistenceErrorCode,
    message: string,
    context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PackageAllocationBootstrapPersistenceError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export interface PackageAllocationBootstrapPersistenceResultV1 {
  readonly contractVersion: 1;
  readonly authority: "shadow_only";
  readonly groupKey: string;
  readonly outcome: "review" | "persisted";
  readonly reviewReason: "no_related_packages_discovered" | null;
  readonly selectedShippingProviderLabelIds: readonly number[];
  readonly relationshipSelectionEvidence:
    PackageAllocationAuthorityRelationshipSelectionEvidenceV1;
  readonly readiness:
    | ReturnType<typeof resolvePackageAllocationAuthorityEvidence>["readiness"]
    | null;
  readonly resolution: ReturnType<typeof resolvePackageAllocationAuthorityEvidence>["resolution"];
  readonly persistence: PersistPackageAllocationPlanResult | null;
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
  return Object.freeze(error.issues.map((issue) => Object.freeze({
    code: issue.code,
    path: Object.freeze([...issue.path]),
    message: issue.message,
  })));
}

function uuidV8FromSha256Digest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  // RFC 9562 version 8 is the standards-defined space for application-specific
  // UUID derivation; version 5 would incorrectly claim SHA-1 namespace hashing.
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function derivePackageAllocationBootstrapGroupKey(
  sourceWmsShipmentItemIds: readonly number[],
): string {
  const parsed = sourceWmsShipmentItemIdsSchema.safeParse(sourceWmsShipmentItemIds);
  if (!parsed.success) {
    throw new PackageAllocationBootstrapPersistenceError(
      "INVALID_BOOTSTRAP_COMMAND",
      "Package-allocation bootstrap group-key input failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }
  const duplicateSourceId = duplicateValue(parsed.data);
  if (duplicateSourceId !== null) {
    throw new PackageAllocationBootstrapPersistenceError(
      "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      "Package-allocation bootstrap group key requires unique source identities",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }
  const normalized = [...parsed.data].sort(
    (left, right) => left - right,
  );
  return uuidV8FromSha256Digest(createHash("sha256")
    .update(canonicalJson({
      contractVersion: 1,
      namespace: "package_allocation_group",
      sourceWmsShipmentItemIds: normalized,
    }), "utf8")
    .digest());
}

function normalizeCommand(
  rawCommand: PersistDiscoveredPackageAllocationBootstrapCommand,
): z.output<typeof persistDiscoveredPackageAllocationBootstrapCommandSchema> {
  const parsed = persistDiscoveredPackageAllocationBootstrapCommandSchema.safeParse(
    rawCommand,
  );
  if (!parsed.success) {
    throw new PackageAllocationBootstrapPersistenceError(
      "INVALID_BOOTSTRAP_COMMAND",
      "Package-allocation bootstrap command failed validation",
      { issues: sanitizedIssues(parsed.error) },
    );
  }
  const duplicateSourceId = duplicateValue(parsed.data.sourceWmsShipmentItemIds);
  if (duplicateSourceId !== null) {
    throw new PackageAllocationBootstrapPersistenceError(
      "DUPLICATE_SOURCE_WMS_SHIPMENT_ITEM_ID",
      "Package-allocation bootstrap requires unique source identities",
      { sourceWmsShipmentItemId: duplicateSourceId },
    );
  }
  return Object.freeze({
    ...parsed.data,
    sourceWmsShipmentItemIds:
      [...parsed.data.sourceWmsShipmentItemIds].sort((left, right) => left - right),
    writeContext: { ...parsed.data.writeContext },
  });
}

export class PackageAllocationBootstrapPersistenceService {
  private readonly planning: Pick<PackageAllocationPlanningService, "persistInTransaction">;

  constructor(
    private readonly repository: PackageAllocationLedgerRepository,
    planning?: Pick<PackageAllocationPlanningService, "persistInTransaction">,
  ) {
    this.planning = planning ?? new PackageAllocationPlanningService(repository);
  }

  async persistDiscovered(
    rawCommand: PersistDiscoveredPackageAllocationBootstrapCommand,
  ): Promise<PackageAllocationBootstrapPersistenceResultV1> {
    const command = normalizeCommand(rawCommand);
    let attempt = 1;
    while (true) {
      try {
        return await this.repository.withSerializableTransaction((transaction) =>
          this.persistDiscoveredInTransaction(transaction, command));
      } catch (error) {
        if (!(error instanceof PackageAllocationLedgerRepositoryError)
            || error.code !== "CONCURRENT_WRITE"
            || attempt >= MAX_SERIALIZABLE_ATTEMPTS) {
          throw error;
        }
        attempt += 1;
      }
    }
  }

  private async persistDiscoveredInTransaction(
    transaction: PackageAllocationLedgerTransaction,
    command: z.output<typeof persistDiscoveredPackageAllocationBootstrapCommandSchema>,
  ): Promise<PackageAllocationBootstrapPersistenceResultV1> {
    const groupKey = derivePackageAllocationBootstrapGroupKey(
      command.sourceWmsShipmentItemIds,
    );
    const existingGroup = await transaction.lockGroup(groupKey, false);
    if (existingGroup !== null && existingGroup.currentVersion > 1) {
      throw new PackageAllocationBootstrapPersistenceError(
        "EXISTING_GROUP_REQUIRES_VERSIONED_REPLAY",
        "Package-allocation bootstrap cannot replace a versioned group history",
        { groupKey, currentVersion: existingGroup.currentVersion },
      );
    }

    const sourceFacts = await transaction.lockSourceFacts(
      command.sourceWmsShipmentItemIds,
    );
    const discoveredPackages = await transaction
      .discoverAuthorityReadinessPackageSelection(
        command.sourceWmsShipmentItemIds,
      );
    const relationshipSelectionEvidence =
      buildPackageAllocationAuthorityRelationshipSelectionEvidence(
        command.sourceWmsShipmentItemIds,
        discoveredPackages,
      );
    const selectedShippingProviderLabelIds = Object.freeze(
      relationshipSelectionEvidence.packages.map(
        (pkg) => pkg.shippingProviderLabelId,
      ),
    );
    if (selectedShippingProviderLabelIds.length === 0) {
      return Object.freeze({
        contractVersion: 1 as const,
        authority: "shadow_only" as const,
        groupKey,
        outcome: "review" as const,
        reviewReason: "no_related_packages_discovered" as const,
        selectedShippingProviderLabelIds,
        relationshipSelectionEvidence,
        readiness: null,
        resolution: null,
        persistence: null,
      });
    }
    const packages = await transaction.lockAuthorityReadinessPackages(
      selectedShippingProviderLabelIds,
    );
    const evidenceResolution = resolvePackageAllocationAuthorityEvidence({
      groupKey,
      expectedGroupVersion: 0,
      previousPlan: null,
      sourceFacts,
      packages,
      actions: [],
    });
    const resolution = evidenceResolution.resolution;
    if (resolution === null || resolution.outcome !== "proposed") {
      return Object.freeze({
        contractVersion: 1 as const,
        authority: "shadow_only" as const,
        groupKey,
        outcome: "review" as const,
        reviewReason: null,
        selectedShippingProviderLabelIds,
        relationshipSelectionEvidence,
        readiness: evidenceResolution.readiness,
        resolution,
        persistence: null,
      });
    }

    const persistence = await this.planning.persistInTransaction(
      transaction,
      {
        contractVersion: resolution.plannerInput.contractVersion,
        authorityMode: resolution.plannerInput.authorityMode,
        groupKey: resolution.plannerInput.groupKey,
        expectedGroupVersion: resolution.plannerInput.expectedGroupVersion,
        sourceLines: resolution.plannerInput.sourceLines.map((source) => ({ ...source })),
        packages: resolution.plannerInput.packages.map((pkg) => ({
          ...pkg,
          membership: { ...pkg.membership },
          lifecycle: {
            ...pkg.lifecycle,
            events: pkg.lifecycle.events.map((event) => ({ ...event })),
          },
        })),
        actions: [],
        writeContext: command.writeContext,
      },
      Object.freeze({
        contractVersion: 1 as const,
        authorityMode: "shadow_only" as const,
        selectionAuthority: "database_relationship_closure" as const,
        selectionCompleteness: "unproven_outside_persisted_relationships" as const,
        relationshipSelectionEvidence: {
          contractVersion: relationshipSelectionEvidence.contractVersion,
          evidenceType: relationshipSelectionEvidence.evidenceType,
          evidenceHash: relationshipSelectionEvidence.evidenceHash,
          sourceWmsShipmentItemIds: [
            ...relationshipSelectionEvidence.sourceWmsShipmentItemIds,
          ],
          packages: relationshipSelectionEvidence.packages.map((pkg) => ({
            shippingProviderLabelId: pkg.shippingProviderLabelId,
            relationshipTypes: [...pkg.relationshipTypes],
          })),
        },
      }),
    );
    return Object.freeze({
      contractVersion: 1 as const,
      authority: "shadow_only" as const,
      groupKey,
      outcome: "persisted" as const,
      reviewReason: null,
      selectedShippingProviderLabelIds,
      relationshipSelectionEvidence,
      readiness: evidenceResolution.readiness,
      resolution,
      persistence,
    });
  }
}
