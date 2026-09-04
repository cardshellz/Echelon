import { isCustomerSellableVariant } from "@shared/catalog/variant-sales-eligibility";
import {
  inventoryChannelExposureRuntimePlanSchema,
  type InventoryChannelExposureRuntimePlan,
} from "@shared/types/inventory-channel-exposure";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";

import {
  calculateChannelExposure,
  findPartitionedShareOverages,
  resolveChannelExposurePolicy,
  type ChannelExposurePolicyCandidate,
} from "../domain/inventory-channel-exposure";
import { projectCanonicalAtp } from "../domain/inventory-availability-planner";
import type { InventoryAvailabilityRuntimeAuthority } from "./inventory-availability-runtime-atp.service";

const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");

export interface ActiveChannelExposurePolicySnapshot extends ChannelExposurePolicyCandidate {
  policyId: number;
  version: number;
  definitionHash: string;
}

export interface ActivePublicationSourceBindingSnapshot {
  bindingId: number;
  version: number;
  definitionHash: string;
  members: readonly {
    fulfillmentNodeId: number;
    warehouseId: number;
    fulfillmentNodeLifecycleStatus: "draft" | "active" | "retired";
  }[];
}

export interface ActivePublicationVariantMappingSnapshot {
  mappingId: number;
  productVariantId: number;
  version: number;
  definitionHash: string;
  externalInventoryItemId: string;
  externalSku: string | null;
}

export interface ActiveInventoryPublicationTargetSnapshot {
  publicationTargetId: number;
  publicationTargetRevision: string;
  channelId: number;
  channelName: string;
  channelProvider: string;
  channelConnectionId: number;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  publicationAuthority: "echelon";
  publicationTargetState: "live";
  sourceBinding: ActivePublicationSourceBindingSnapshot | null;
  policies: readonly ActiveChannelExposurePolicySnapshot[];
  mappings: readonly ActivePublicationVariantMappingSnapshot[];
}

export interface InventoryChannelExposureRuntimeContext {
  authority: InventoryAvailabilityRuntimeAuthority;
  authorityRevision: string;
  activationRunId: string | null;
  supplySnapshot: SupplySnapshotDto | null;
  managedSellableVariantIds: readonly number[];
  publicationTargets: readonly ActiveInventoryPublicationTargetSnapshot[];
}

export interface InventoryChannelExposureRuntimeExecutor {
  execute<T>(
    productId: number,
    work: (context: InventoryChannelExposureRuntimeContext) => Promise<T>,
  ): Promise<T>;
}

export interface InventoryChannelExposureRuntimeLogger {
  warn(event: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: InventoryChannelExposureRuntimeLogger = {
  warn(event) {
    console.warn(JSON.stringify(event));
  },
};

export class InventoryChannelExposureRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryChannelExposureRuntimeError";
  }
}

/**
 * Plans exact provider quantities from one authority revision and active-only
 * channel-exposure configuration. It is deliberately side-effect free: a
 * later publication boundary must persist the complete plan to the outbox.
 */
export class InventoryChannelExposureRuntimeService {
  constructor(
    private readonly executor: InventoryChannelExposureRuntimeExecutor,
    private readonly logger: InventoryChannelExposureRuntimeLogger = defaultLogger,
  ) {}

  async planProduct(productId: number): Promise<InventoryChannelExposureRuntimePlan> {
    const validatedProductId = positiveInteger(productId, "productId");
    return this.executor.execute(validatedProductId, async (context) => {
      if (context.authority === "legacy") {
        return inventoryChannelExposureRuntimePlanSchema.parse({
          authority: "legacy",
          authorityRevision: context.authorityRevision,
          activationRunId: null,
          productId: validatedProductId,
          snapshotFingerprint: null,
          snapshotCapturedAt: null,
          targets: [],
          providerWriteAttempted: false,
          outboxEnqueued: false,
        });
      }
      if (!context.supplySnapshot || !context.activationRunId) {
        throw new InventoryChannelExposureRuntimeError(
          "CANONICAL_CHANNEL_EXPOSURE_CONTEXT_INCOMPLETE",
          "Canonical channel exposure requires activation lineage and an active supply snapshot.",
          {
            productId: validatedProductId,
            authorityRevision: context.authorityRevision,
            activationRunId: context.activationRunId,
            hasSupplySnapshot: context.supplySnapshot !== null,
          },
        );
      }
      if (context.supplySnapshot.productId !== validatedProductId) {
        throw new InventoryChannelExposureRuntimeError(
          "CANONICAL_CHANNEL_EXPOSURE_PRODUCT_MISMATCH",
          "The active supply snapshot does not belong to the requested product.",
          { productId: validatedProductId, snapshotProductId: context.supplySnapshot.productId },
        );
      }

      const managedIds = new Set(
        context.managedSellableVariantIds.map((id) => positiveInteger(id, "managedSellableVariantId")),
      );
      const variants = context.supplySnapshot.variants
        .filter((variant) => managedIds.has(variant.id))
        .filter((variant) => variant.isActive && isCustomerSellableVariant(variant))
        .sort((left, right) => left.id - right.id);
      const foundIds = new Set(variants.map((variant) => variant.id));
      const missingVariantIds = [...managedIds].filter((id) => !foundIds.has(id)).sort((a, b) => a - b);
      if (missingVariantIds.length > 0) {
        throw new InventoryChannelExposureRuntimeError(
          "CANONICAL_CHANNEL_EXPOSURE_VARIANT_MISMATCH",
          "A managed sellable SKU is absent from the active product supply snapshot.",
          { productId: validatedProductId, productVariantIds: missingVariantIds },
        );
      }

      const plannedTargets = context.publicationTargets
        .slice()
        .sort((left, right) => left.publicationTargetId - right.publicationTargetId)
        .map((target) => planTarget(context.supplySnapshot!, validatedProductId, variants, target));

      applyPartitionOverages(plannedTargets);
      const targets: InventoryChannelExposureRuntimePlan["targets"] = plannedTargets.map((planned) => {
        const target = planned.target;
        const publishable = target.rows.length > 0
          && target.blockers.length === 0
          && target.rows.every((row) => row.blockers.length === 0
            && row.policy !== null
            && row.mapping !== null);
        if (!publishable || target.rows.some((row) => row.warnings.length > 0)) {
          this.logger.warn({
            event: "canonical_channel_exposure_not_clean",
            productId: validatedProductId,
            publicationTargetId: target.publicationTargetId,
            authorityRevision: context.authorityRevision,
            activationRunId: context.activationRunId,
            targetBlockerCodes: target.blockers.map((blocker) => blocker.code),
            rowBlockerCodes: uniqueStrings(target.rows.flatMap((row) => row.blockers.map((blocker) => blocker.code))),
            rowWarningCodes: uniqueStrings(target.rows.flatMap((row) => row.warnings.map((warning) => warning.code))),
          });
        }
        return { ...target, publishable };
      });

      return inventoryChannelExposureRuntimePlanSchema.parse({
        authority: "canonical",
        authorityRevision: context.authorityRevision,
        activationRunId: context.activationRunId,
        productId: validatedProductId,
        snapshotFingerprint: context.supplySnapshot.snapshotFingerprint,
        snapshotCapturedAt: context.supplySnapshot.capturedAt,
        targets,
        providerWriteAttempted: false,
        outboxEnqueued: false,
      });
    });
  }
}

type RuntimeTarget = InventoryChannelExposureRuntimePlan["targets"][number];
type RuntimeRow = RuntimeTarget["rows"][number];
type RuntimeIssue = RuntimeTarget["blockers"][number];

interface PlannedTarget {
  target: Omit<RuntimeTarget, "publishable">;
  sourceWarehouseIds: number[];
}

function planTarget(
  snapshot: SupplySnapshotDto,
  productId: number,
  variants: SupplySnapshotDto["variants"],
  target: ActiveInventoryPublicationTargetSnapshot,
): PlannedTarget {
  const targetBlockers: RuntimeIssue[] = [];
  const binding = target.sourceBinding;
  const members = binding?.members.slice() ?? [];
  if (!binding || members.length === 0) {
    targetBlockers.push(issue(
      "CHANNEL_SOURCE_BINDING_MISSING",
      "This live publication target has no active fulfillment-node source binding.",
      {
        publicationTargetId: target.publicationTargetId,
        bindingId: binding?.bindingId ?? null,
      },
    ));
  }
  const inactiveNodeIds = members
    .filter((member) => member.fulfillmentNodeLifecycleStatus !== "active")
    .map((member) => member.fulfillmentNodeId)
    .sort((a, b) => a - b);
  if (inactiveNodeIds.length > 0) {
    targetBlockers.push(issue(
      "CHANNEL_SOURCE_NODE_NOT_ACTIVE",
      "An active source binding references a fulfillment node that is not active.",
      { publicationTargetId: target.publicationTargetId, fulfillmentNodeIds: inactiveNodeIds },
    ));
  }
  const sourceWarehouseIds = uniqueNumbers(members.map((member) => member.warehouseId));
  if (sourceWarehouseIds.length !== members.length) {
    targetBlockers.push(issue(
      "CHANNEL_SOURCE_WAREHOUSE_DUPLICATE",
      "More than one source-binding member resolves to the same warehouse.",
      { publicationTargetId: target.publicationTargetId, warehouseIds: sourceWarehouseIds },
    ));
  }
  const activeSnapshotWarehouses = new Set(snapshot.warehouses
    .filter((warehouse) => warehouse.isActive)
    .map((warehouse) => warehouse.id));
  const unavailableWarehouseIds = sourceWarehouseIds
    .filter((warehouseId) => !activeSnapshotWarehouses.has(warehouseId));
  if (unavailableWarehouseIds.length > 0) {
    targetBlockers.push(issue(
      "CHANNEL_SOURCE_WAREHOUSE_NOT_ACTIVE",
      "A source-bound warehouse is absent or inactive in the canonical supply snapshot.",
      { publicationTargetId: target.publicationTargetId, warehouseIds: unavailableWarehouseIds },
    ));
  }
  if (variants.length === 0) {
    targetBlockers.push(issue(
      "PUBLICATION_TARGET_HAS_NO_MANAGED_SKUS",
      "The product has no active, physical, inventory-managed sellable SKU to publish.",
      { publicationTargetId: target.publicationTargetId, productId },
    ));
  }

  const mappings = new Map(target.mappings.map((mapping) => [mapping.productVariantId, mapping] as const));
  const rows = variants.map((variant): RuntimeRow => {
    const blockers: RuntimeIssue[] = [];
    const warnings: RuntimeIssue[] = [];
    const resolution = resolveChannelExposurePolicy({
      channelId: target.channelId,
      productId,
      productVariantId: variant.id,
      policies: target.policies,
    });
    if (!resolution.policy) {
      blockers.push(issue(
        "CHANNEL_EXPOSURE_POLICY_INCOMPLETE",
        "Required channel-exposure fields do not resolve through SKU, product, and channel scopes.",
        {
          publicationTargetId: target.publicationTargetId,
          channelId: target.channelId,
          productId,
          productVariantId: variant.id,
          missingFields: resolution.missingFields,
        },
      ));
    }
    const mapping = mappings.get(variant.id) ?? null;
    if (!mapping) {
      blockers.push(issue(
        "PUBLICATION_TARGET_VARIANT_MAPPING_MISSING",
        "The SKU has no active exact provider inventory identity for this publication target.",
        {
          publicationTargetId: target.publicationTargetId,
          channelId: target.channelId,
          productId,
          productVariantId: variant.id,
        },
      ));
    }

    const sourceWarehouseBreakdown = sourceWarehouseIds.map((warehouseId) => {
      const projection = projectCanonicalAtp(snapshot, {
        targetVariantId: variant.id,
        scope: { kind: "warehouse", warehouseId },
      });
      if (projection.blockers.length > 0) {
        warnings.push(issue(
          "CANONICAL_ATP_PROJECTION_BLOCKED",
          "Canonical ATP used its path-local fail-closed quantity because projection evidence has blockers.",
          {
            publicationTargetId: target.publicationTargetId,
            productVariantId: variant.id,
            warehouseId,
            blockerCodes: projection.blockers.map((blocker) => blocker.code),
          },
        ));
      }
      return { warehouseId, canonicalAtpUnits: projection.atpUnits };
    });
    const canonicalAtp = sourceWarehouseBreakdown.reduce(
      (total, row) => addQuantity(total, BigInt(row.canonicalAtpUnits), {
        publicationTargetId: target.publicationTargetId,
        productVariantId: variant.id,
      }),
      BigInt(0),
    );
    const calculation = resolution.policy
      ? calculateChannelExposure(canonicalAtp, resolution.policy)
      : {
          canonicalAtpUnits: canonicalAtp,
          sharedUnits: BigInt(0),
          afterHoldbackUnits: BigInt(0),
          cappedUnits: BigInt(0),
          publishedUnits: BigInt(0),
        };
    return {
      productVariantId: variant.id,
      sku: variant.sku,
      unitsPerVariant: variant.unitsPerVariant,
      canonicalAtpUnits: calculation.canonicalAtpUnits.toString(),
      sharedUnits: calculation.sharedUnits.toString(),
      afterHoldbackUnits: calculation.afterHoldbackUnits.toString(),
      cappedUnits: calculation.cappedUnits.toString(),
      publishedUnits: calculation.publishedUnits.toString(),
      sourceWarehouseBreakdown,
      policy: resolution.policy,
      mapping: mapping ? {
        mappingId: mapping.mappingId,
        version: mapping.version,
        definitionHash: mapping.definitionHash,
        externalInventoryItemId: mapping.externalInventoryItemId,
        externalSku: mapping.externalSku,
      } : null,
      blockers: uniqueIssues(blockers),
      warnings: uniqueIssues(warnings),
    };
  });

  return {
    sourceWarehouseIds,
    target: {
      publicationTargetId: target.publicationTargetId,
      publicationTargetRevision: target.publicationTargetRevision,
      channelId: target.channelId,
      channelName: target.channelName,
      channelProvider: target.channelProvider,
      channelConnectionId: target.channelConnectionId,
      providerScopeType: target.providerScopeType,
      externalScopeId: target.externalScopeId,
      publicationAuthority: target.publicationAuthority,
      publicationTargetState: target.publicationTargetState,
      sourceBinding: binding && sourceWarehouseIds.length > 0 ? {
        bindingId: binding.bindingId,
        version: binding.version,
        definitionHash: binding.definitionHash,
        fulfillmentNodeIds: uniqueNumbers(members.map((member) => member.fulfillmentNodeId)),
        warehouseIds: sourceWarehouseIds,
      } : null,
      selectedPolicies: target.policies
        .map((policy) => ({
          scopeKey: policy.scopeKey,
          policyId: policy.policyId,
          version: policy.version,
          definitionHash: policy.definitionHash,
        }))
        .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey)),
      rows,
      blockers: uniqueIssues(targetBlockers),
    },
  };
}

function applyPartitionOverages(targets: PlannedTarget[]): void {
  const rows = targets.flatMap((planned) => planned.target.rows.flatMap((row) => row.policy ? [{
    productVariantId: row.productVariantId,
    sourceWarehouseIds: planned.sourceWarehouseIds,
    policy: row.policy,
  }] : []));
  for (const overage of findPartitionedShareOverages(rows)) {
    for (const planned of targets) {
      const row = planned.target.rows.find((candidate) => candidate.productVariantId === overage.productVariantId);
      if (!row?.policy || row.policy.allocationSemantics !== "partitioned" || !row.policy.eligible
        || !planned.sourceWarehouseIds.includes(overage.warehouseId)) continue;
      row.blockers = uniqueIssues([...row.blockers, issue(
        "PARTITIONED_CHANNEL_SHARE_EXCEEDS_100_PERCENT",
        "Active partitioned channel shares exceed 100 percent for a SKU and source warehouse.",
        {
          productVariantId: overage.productVariantId,
          warehouseId: overage.warehouseId,
          totalShareBps: overage.totalShareBps,
        },
      )]);
    }
  }
}

function issue(code: string, message: string, context: Record<string, unknown>): RuntimeIssue {
  return { code, message, context };
}

function uniqueIssues(issues: readonly RuntimeIssue[]): RuntimeIssue[] {
  return [...new Map(issues.map((entry) => [
    `${entry.code}:${JSON.stringify(entry.context)}`,
    entry,
  ])).values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values.map((value) => positiveInteger(value, "identifier")))]
    .sort((left, right) => left - right);
}

function addQuantity(
  left: bigint,
  right: bigint,
  context: Readonly<Record<string, unknown>>,
): bigint {
  const result = left + right;
  if (left < BigInt(0) || right < BigInt(0) || result > POSTGRES_BIGINT_MAX) {
    throw new InventoryChannelExposureRuntimeError(
      "CHANNEL_EXPOSURE_QUANTITY_OVERFLOW",
      "Exact-target canonical ATP exceeds the supported PostgreSQL bigint quantity range.",
      { ...context, left: left.toString(), right: right.toString() },
    );
  }
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryChannelExposureRuntimeError(
      "INVALID_CHANNEL_EXPOSURE_IDENTIFIER",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}
