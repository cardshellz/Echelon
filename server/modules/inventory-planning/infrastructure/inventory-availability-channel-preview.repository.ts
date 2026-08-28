import { eq, sql } from "drizzle-orm";

import {
  transformationModelHeads,
  transformationModelVersions,
} from "@shared/schema";
import {
  inventoryAvailabilityChannelPreviewSchema,
  type InventoryAvailabilityBackfillIssue,
  type InventoryAvailabilityChannelPreview,
} from "@shared/types/inventory-availability-backfill";
import type { PlannerShadowRunDto } from "@shared/types/inventory-availability-planner";

import { db } from "../../../db";
import {
  clearVelocityCache,
  createAllocationEngine,
  type ProductAllocationResult,
  type VariantChannelAllocation,
} from "../../channels/allocation-engine.service";
import type {
  InventoryAvailabilityChannelPreviewStore,
} from "../application/inventory-availability-backfill.service";
import {
  PostgresInventoryAvailabilityShadowRepository,
  type InventoryAvailabilityShadowStore,
} from "./inventory-availability-shadow.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type ShadowQuantityKind = "legacy" | "proposed";
const MAX_SAFE_ALLOCATION_INPUT = Math.floor(Number.MAX_SAFE_INTEGER / 100);

interface SelectedModelEvidence {
  modelId: number;
  version: number;
  definitionHash: string;
}

function issue(
  code: string,
  severity: "review" | "blocking",
  message: string,
  context: Record<string, unknown>,
): InventoryAvailabilityBackfillIssue {
  return { code, severity, message, context };
}

function toSafeQuantity(value: string, field: string): number {
  const quantity = BigInt(value);
  if (quantity < BigInt(0) || quantity > BigInt(MAX_SAFE_ALLOCATION_INPUT)) {
    throw new RangeError(`${field} is outside the allocation engine's safe integer range`);
  }
  return Number(quantity);
}

function shadowAtpAdapter(run: PlannerShadowRunDto, kind: ShadowQuantityKind) {
  const rowsForScope = (warehouseId: number | null) => run.results
    .filter((result) => result.warehouseId === warehouseId)
    .map((result) => ({
      productVariantId: result.productVariantId,
      sku: result.productVariantSkuSnapshot ?? "",
      name: result.productVariantNameSnapshot,
      unitsPerVariant: result.productVariantUnitsPerVariantSnapshot,
      atpUnits: toSafeQuantity(
        kind === "legacy" ? result.legacyAtpUnits : result.proposedAtpUnits,
        `${kind}.atpUnits`,
      ),
      atpBase: toSafeQuantity(
        kind === "legacy"
          ? result.legacyAtpBaseUnits
          : result.proposedProjection.atpBaseUnits,
        `${kind}.atpBase`,
      ),
    }));
  return {
    async getAtpBase(productId: number): Promise<number> {
      assertProduct(run, productId);
      return rowsForScope(null)[0]?.atpBase ?? 0;
    },
    async getAtpPerVariant(productId: number) {
      assertProduct(run, productId);
      return rowsForScope(null);
    },
    async getAtpPerVariantByWarehouse(productId: number, warehouseId: number) {
      assertProduct(run, productId);
      return rowsForScope(warehouseId);
    },
  };
}

function assertProduct(run: PlannerShadowRunDto, productId: number): void {
  if (run.productId !== productId) {
    throw new Error(`Shadow run ${run.runId} belongs to product ${run.productId}, not ${productId}`);
  }
}

function allocationKey(allocation: VariantChannelAllocation): string {
  return `${allocation.channelId}:${allocation.productVariantId}`;
}

function assertSafeAllocationResult(result: ProductAllocationResult, kind: ShadowQuantityKind): void {
  const quantities: Array<[string, number]> = [
    [`${kind}.totalAtpBase`, result.totalAtpBase],
  ];
  for (const allocation of result.allocations) {
    const prefix = `${kind}.channel.${allocation.channelId}.variant.${allocation.productVariantId}`;
    quantities.push(
      [`${prefix}.allocatedUnits`, allocation.allocatedUnits],
      [`${prefix}.allocatedBase`, allocation.allocatedBase],
      ...allocation.warehouseBreakdown.map((entry) => [
        `${prefix}.warehouse.${entry.warehouseId}.qty`,
        entry.qty,
      ] as [string, number]),
    );
  }
  const unsafe = quantities.find(([, value]) => !Number.isSafeInteger(value) || value < 0);
  if (unsafe) {
    throw new RangeError(`${unsafe[0]} is outside the allocation engine's safe integer range`);
  }
}

function blockerOnlyPreview(
  run: PlannerShadowRunDto,
  blockers: InventoryAvailabilityBackfillIssue[],
): InventoryAvailabilityChannelPreview {
  return inventoryAvailabilityChannelPreviewSchema.parse({
    productId: run.productId,
    shadowRunId: run.runId,
    snapshotFingerprint: run.snapshotFingerprint,
    shadowCapturedAt: run.capturedAt,
    modelId: run.modelId,
    modelVersion: run.modelVersion,
    modelDefinitionHash: run.modelDefinitionHash,
    policyAuthority: "legacy_channel_allocation_rules",
    runtimeAuthorityChanged: false,
    providerWriteAttempted: false,
    allocationAuditWritten: false,
    blockers,
    rows: [],
  });
}

function compareAllocations(
  run: PlannerShadowRunDto,
  legacy: ProductAllocationResult,
  proposed: ProductAllocationResult,
  initialBlockers: InventoryAvailabilityBackfillIssue[],
): InventoryAvailabilityChannelPreview {
  const blockers = [...initialBlockers];
  const legacyByKey = new Map(legacy.allocations.map((row) => [allocationKey(row), row] as const));
  const proposedByKey = new Map(proposed.allocations.map((row) => [allocationKey(row), row] as const));
  const keys = [...new Set([...legacyByKey.keys(), ...proposedByKey.keys()])].sort();
  if (keys.some((key) => !legacyByKey.has(key) || !proposedByKey.has(key))) {
    blockers.push(issue(
      "CHANNEL_ALLOCATION_SHAPE_MISMATCH",
      "blocking",
      "Legacy and proposed allocation previews did not return the same channel and variant rows.",
      { legacyKeys: [...legacyByKey.keys()].sort(), proposedKeys: [...proposedByKey.keys()].sort() },
    ));
    return blockerOnlyPreview(run, blockers);
  }
  const networkByVariant = new Map(run.results
    .filter((result) => result.warehouseId === null)
    .map((result) => [result.productVariantId, result] as const));
  const rows = keys.map((key) => {
    const legacyRow = legacyByKey.get(key)!;
    const proposedRow = proposedByKey.get(key)!;
    const shadowRow = networkByVariant.get(proposedRow.productVariantId);
    if (!shadowRow) {
      throw new Error(`Shadow run ${run.runId} has no network row for variant ${proposedRow.productVariantId}`);
    }
    const warehouseIds = [...new Set([
      ...legacyRow.warehouseBreakdown.map((entry) => entry.warehouseId),
      ...proposedRow.warehouseBreakdown.map((entry) => entry.warehouseId),
    ])].sort((left, right) => left - right);
    const legacyWarehouse = new Map(legacyRow.warehouseBreakdown.map((entry) =>
      [entry.warehouseId, entry.qty] as const));
    const proposedWarehouse = new Map(proposedRow.warehouseBreakdown.map((entry) =>
      [entry.warehouseId, entry.qty] as const));
    return {
      channelId: proposedRow.channelId,
      channelName: proposedRow.channelName,
      channelProvider: proposedRow.channelProvider,
      productVariantId: proposedRow.productVariantId,
      sku: shadowRow.productVariantSkuSnapshot,
      unitsPerVariant: shadowRow.productVariantUnitsPerVariantSnapshot,
      warehouseScopeSource: proposedRow.warehouseScopeSource,
      legacyAtpUnits: shadowRow.legacyAtpUnits,
      proposedAtpUnits: shadowRow.proposedAtpUnits,
      legacyPublishedUnits: String(legacyRow.allocatedUnits),
      proposedPublishedUnits: String(proposedRow.allocatedUnits),
      differenceUnits: String(proposedRow.allocatedUnits - legacyRow.allocatedUnits),
      allocationMethod: proposedRow.method,
      allocationReason: proposedRow.reason,
      warehouseBreakdown: warehouseIds.map((warehouseId) => ({
        warehouseId,
        legacyQty: legacyWarehouse.get(warehouseId) ?? 0,
        proposedQty: proposedWarehouse.get(warehouseId) ?? 0,
      })),
    };
  });
  const fallbackChannels = [...new Set(rows
    .filter((row) => row.warehouseScopeSource === "legacy_all_active_fallback")
    .map((row) => row.channelId))].sort((left, right) => left - right);
  if (fallbackChannels.length > 0) {
    blockers.push(issue(
      "LEGACY_WAREHOUSE_SCOPE_FALLBACK",
      "blocking",
      "One or more channels inherit every active operations/3PL warehouse because no explicit warehouse assignment exists.",
      { channelIds: fallbackChannels },
    ));
  }
  const shadowWarehouseIds = new Set(run.results
    .flatMap((result) => result.warehouseId === null ? [] : [result.warehouseId]));
  const missingWarehouseIds = [...new Set(rows.flatMap((row) =>
    row.warehouseBreakdown
      .filter((entry) => !shadowWarehouseIds.has(entry.warehouseId))
      .map((entry) => entry.warehouseId)))].sort((left, right) => left - right);
  if (missingWarehouseIds.length > 0) {
    blockers.push(issue(
      "CHANNEL_WAREHOUSE_MISSING_FROM_SHADOW",
      "blocking",
      "Current channel allocation references a warehouse absent from the sealed ATP shadow snapshot.",
      { warehouseIds: missingWarehouseIds },
    ));
  }
  return inventoryAvailabilityChannelPreviewSchema.parse({
    ...blockerOnlyPreview(run, blockers),
    rows,
  });
}

async function loadSelectedModel(
  tx: Transaction,
  productId: number,
): Promise<SelectedModelEvidence | null> {
  const [head] = await tx
    .select({
      draftModelId: transformationModelHeads.draftModelId,
      activeModelId: transformationModelHeads.activeModelId,
    })
    .from(transformationModelHeads)
    .where(eq(transformationModelHeads.productId, productId))
    .limit(1);
  const modelId = head?.draftModelId ?? head?.activeModelId ?? null;
  if (modelId === null) return null;
  const [model] = await tx
    .select({
      modelId: transformationModelVersions.id,
      version: transformationModelVersions.version,
      definitionHash: transformationModelVersions.definitionHash,
    })
    .from(transformationModelVersions)
    .where(eq(transformationModelVersions.id, modelId))
    .limit(1);
  return model ?? null;
}

export class PostgresInventoryAvailabilityChannelPreviewRepository
implements InventoryAvailabilityChannelPreviewStore {
  constructor(
    private readonly shadowStore: InventoryAvailabilityShadowStore =
      new PostgresInventoryAvailabilityShadowRepository(),
    private readonly database: typeof db = db,
  ) {}

  async previewLatestShadowChannels(
    productId: number,
  ): Promise<InventoryAvailabilityChannelPreview | null> {
    const run = await this.shadowStore.getLatestShadowRun(productId);
    if (!run) return null;
    const blockers: InventoryAvailabilityBackfillIssue[] = run.blockerCodes.map((code) => issue(
      code,
      "blocking",
      "The canonical ATP shadow run contains a configuration blocker.",
      { shadowRunId: run.runId },
    ));
    if (run.status !== "completed") return blockerOnlyPreview(run, blockers);
    try {
      return await this.database.transaction(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
        const selectedModel = await loadSelectedModel(tx, productId);
        if (!selectedModel
          || selectedModel.modelId !== run.modelId
          || selectedModel.version !== run.modelVersion
          || selectedModel.definitionHash !== run.modelDefinitionHash) {
          blockers.push(issue(
            "SHADOW_MODEL_STALE",
            "blocking",
            "The selected transformation model differs from the model captured by this shadow run.",
            { shadowRunId: run.runId, selectedModel, shadowModel: {
              modelId: run.modelId,
              version: run.modelVersion,
              definitionHash: run.modelDefinitionHash,
            } },
          ));
          return blockerOnlyPreview(run, blockers);
        }
        clearVelocityCache();
        const legacy = await createAllocationEngine(tx, shadowAtpAdapter(run, "legacy"))
          .previewProduct(productId);
        const proposed = await createAllocationEngine(tx, shadowAtpAdapter(run, "proposed"))
          .previewProduct(productId);
        assertSafeAllocationResult(legacy, "legacy");
        assertSafeAllocationResult(proposed, "proposed");
        return compareAllocations(run, legacy, proposed, blockers);
      });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      blockers.push(issue(
        "CHANNEL_PREVIEW_QUANTITY_UNSAFE",
        "blocking",
        "A shadow quantity exceeds the legacy channel allocation engine's safe integer range.",
        { shadowRunId: run.runId, error: error.message },
      ));
      return blockerOnlyPreview(run, blockers);
    }
  }
}

export const inventoryAvailabilityChannelPreviewTestables = {
  compareAllocations,
  shadowAtpAdapter,
  assertSafeAllocationResult,
};
