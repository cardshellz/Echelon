import { createHash } from "node:crypto";

import type {
  ApplyInventoryAvailabilityBackfillDraftResult,
  InventoryAvailabilityBackfillQueueResponse,
  InventoryAvailabilityBackfillReview,
  InventoryAvailabilityBackfillDefinition,
  InventoryAvailabilityChannelPreview,
  RefreshInventoryAvailabilityBackfillDraftResult,
} from "@shared/types/inventory-availability-backfill";
import {
  applyInventoryAvailabilityBackfillDraftRequestSchema,
  applyInventoryAvailabilityBackfillDraftResultSchema,
  INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
  inventoryAvailabilityBackfillQueueResponseSchema,
  inventoryAvailabilityChannelPreviewSchema,
  refreshInventoryAvailabilityBackfillDraftRequestSchema,
  refreshInventoryAvailabilityBackfillDraftResultSchema,
  reviewInventoryAvailabilityBackfillDraftRequestSchema,
  reviewInventoryAvailabilityBackfillDraftResultSchema,
} from "@shared/types/inventory-availability-backfill";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import {
  calculateMasterDataDraftRequestHash,
  InventoryAvailabilityMasterDataError,
  type InventoryAvailabilityMasterDataRepository,
} from "../domain/inventory-availability-master-data.contracts";
import {
  calculateInventoryAvailabilityBackfillCatalogHash,
  planInventoryAvailabilityBackfill,
  type InventoryAvailabilityBackfillSource,
} from "../domain/inventory-availability-backfill";

const positiveDatabaseIntegerSchema = z.number().int().positive().max(2_147_483_647);
const actorSchema = z.string().trim().min(1).max(100);

export interface CapturedInventoryAvailabilityBackfillDraft {
  modelId: number;
  version: number;
  definitionHash: string;
  headRevision: string;
  origin: "operator" | "phase3_backfill";
  originInputHash: string | null;
  originResultHash: string | null;
  operatorInputHash?: string | null;
  validationState?: "valid" | "invalid";
}

export interface CapturedInventoryAvailabilityBackfillReview {
  reviewId: string;
  decision: "approved" | "changes_required";
  reason: string;
  reviewedBy: string;
  reviewedAt: string;
  modelId: number;
  modelVersion: number;
  modelDefinitionHash: string;
}

export interface CapturedInventoryAvailabilityBackfillProduct {
  source: InventoryAvailabilityBackfillSource;
  draft: CapturedInventoryAvailabilityBackfillDraft | null;
  draftDefinition?: InventoryAvailabilityBackfillDefinition | null;
  review: CapturedInventoryAvailabilityBackfillReview | null;
  latestShadow: {
    runId: string;
    status: "completed" | "blocked";
    snapshotFingerprint: string;
    modelDefinitionHash: string | null;
    capturedAt: string;
  } | null;
}

export interface CapturedInventoryAvailabilityBackfillCatalog {
  capturedAt: string;
  products: CapturedInventoryAvailabilityBackfillProduct[];
}

export interface InventoryAvailabilityBackfillCatalogStore {
  captureBackfillCatalog(): Promise<CapturedInventoryAvailabilityBackfillCatalog>;
  captureBackfillProduct(
    productId: number,
  ): Promise<CapturedInventoryAvailabilityBackfillProduct | null>;
  reviewTransformationModelDraft(command: {
    expectedLatestReviewId?: string | null;
    productId: number;
    expectedModelId: number;
    expectedModelVersion: number;
    expectedDefinitionHash: string;
    expectedHeadRevision: string;
    decision: "approved" | "changes_required";
    reason: string;
    actorId: string;
    idempotencyKey: string;
    requestHash: string;
    occurredAt: Date;
  }): Promise<{ review: InventoryAvailabilityBackfillReview; alreadyApplied: boolean }>;
}

export interface InventoryAvailabilityChannelPreviewStore {
  previewLatestShadowChannels(productId: number): Promise<InventoryAvailabilityChannelPreview | null>;
}

export interface InventoryAvailabilityBackfillClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityBackfillClock = { now: () => new Date() };

export class InventoryAvailabilityBackfillService {
  constructor(
    private readonly catalogStore: InventoryAvailabilityBackfillCatalogStore,
    private readonly masterDataStore: InventoryAvailabilityMasterDataRepository,
    private readonly channelPreviewStore: InventoryAvailabilityChannelPreviewStore,
    private readonly clock: InventoryAvailabilityBackfillClock = systemClock,
  ) {}

  async getMigrationQueue(): Promise<InventoryAvailabilityBackfillQueueResponse> {
    const capture = await this.catalogStore.captureBackfillCatalog();
    const candidates = capture.products.map((product) => ({
      captured: product,
      candidate: planInventoryAvailabilityBackfill(product.source),
    }));
    const rows = candidates.map(({ captured, candidate }) => {
      const definitionMatch = Boolean(
        captured.draft && candidate.definitionHash
          && captured.draft.definitionHash === candidate.definitionHash,
      );
      const provenanceMatch = Boolean(
        captured.draft?.origin === "phase3_backfill"
          && captured.draft.originInputHash === candidate.inputHash
          && captured.draft.originResultHash === candidate.resultHash,
      );
      const candidateMatch = definitionMatch && provenanceMatch;
      const operatorDraft = captured.draft?.origin === "operator";
      const operatorSourceMatch = operatorDraft
        && captured.draft?.operatorInputHash === candidate.inputHash
        && captured.draft?.validationState === "valid"
        && captured.draftDefinition != null;
      const draft = captured.draft
        ? { ...captured.draft, definitionMatch, provenanceMatch, candidateMatch }
        : null;
      const queueState = candidate.classification === "blocked"
        ? "blocked" as const
        : candidate.classification === "excluded_unmanaged"
          || candidate.classification === "excluded_internal_supply_only"
          ? "excluded" as const
        : !draft
          ? "not_backfilled" as const
          : !(operatorDraft ? operatorSourceMatch : candidateMatch)
            ? "conflicting_draft" as const
            : captured.review?.decision === "approved"
              ? "approved" as const
              : captured.review?.decision === "changes_required"
                ? "changes_required" as const
                : "awaiting_review" as const;
      return {
        productId: candidate.source.product.id,
        productSku: candidate.source.product.sku,
        productName: candidate.source.product.name,
        legacyInventoryStrategy: candidate.source.product.legacyInventoryStrategy,
        activeVariantCount: candidate.source.variants.length,
        activeRecipeCount: candidate.source.recipes.length,
        classification: candidate.classification,
        inputHash: candidate.inputHash,
        resultHash: candidate.resultHash,
        candidateDefinitionHash: candidate.definitionHash,
        candidateDefinition: candidate.publicDefinition,
        issues: candidate.issues,
        queueState,
        draft,
        draftDefinition: captured.draftDefinition ?? null,
        review: captured.review,
        latestShadow: captured.latestShadow,
      };
    });
    const count = (state: typeof rows[number]["queueState"]) =>
      rows.filter((row) => row.queueState === state).length;
    const generatedResultHash = calculateInventoryAvailabilityBackfillCatalogHash(
      "result", candidates.map(({ candidate }) => candidate),
    );
    // Manual selections are not generated candidates; bind catalog previews to their
    // exact saved versions without changing existing generated-only provenance.
    const operatorSelections = rows.filter((row) => row.draft?.origin === "operator")
      .sort((left, right) => left.productId - right.productId)
      .map((row) => ({ productId: row.productId, draft: row.draft }));
    return inventoryAvailabilityBackfillQueueResponseSchema.parse({
      algorithmVersion: INVENTORY_AVAILABILITY_BACKFILL_ALGORITHM_VERSION,
      capturedAt: capture.capturedAt,
      catalogInputHash: calculateInventoryAvailabilityBackfillCatalogHash(
        "input",
        candidates.map(({ candidate }) => candidate),
      ),
      catalogResultHash: operatorSelections.length === 0 ? generatedResultHash
        : createHash("sha256").update(canonicalJson({ generatedResultHash, operatorSelections }))
          .digest("hex"),
      summary: {
        totalActiveProducts: rows.length,
        blocked: count("blocked"),
        excluded: count("excluded"),
        notBackfilled: count("not_backfilled"),
        conflictingDraft: count("conflicting_draft"),
        awaitingReview: count("awaiting_review"),
        changesRequired: count("changes_required"),
        approved: count("approved"),
      },
      products: rows,
    });
  }

  async applyProductDraft(
    productIdInput: number,
    input: unknown,
    actorInput: string,
  ): Promise<ApplyInventoryAvailabilityBackfillDraftResult> {
    const productId = parseProductId(productIdInput);
    const actorId = parseActor(actorInput);
    const request = parseInput(applyInventoryAvailabilityBackfillDraftRequestSchema, input);
    const captured = await this.catalogStore.captureBackfillProduct(productId);
    if (!captured) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_AVAILABILITY_PRODUCT_NOT_FOUND",
        "The active catalog product does not exist.",
      );
    }
    const candidate = planInventoryAvailabilityBackfill(captured.source);
    if (
      request.expectedInputHash !== candidate.inputHash
      || request.expectedResultHash !== candidate.resultHash
    ) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_PREVIEW_STALE",
        "The deterministic backfill preview changed; reload the migration queue.",
      );
    }
    if (!candidate.definition || !candidate.definitionHash) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_BLOCKED",
        "The product has blocking source-data issues and cannot create a draft.",
        candidate.issues
          .filter((entry) => entry.severity === "blocking")
          .map((entry) => `${entry.code}: ${entry.message}`),
      );
    }
    if (captured.draft) {
      if (isExactBackfillDraft(captured.draft, candidate)) {
        return applyInventoryAvailabilityBackfillDraftResultSchema.parse({
          modelId: captured.draft.modelId,
          version: captured.draft.version,
          definitionHash: captured.draft.definitionHash,
          alreadyApplied: true,
          inputHash: candidate.inputHash,
          resultHash: candidate.resultHash,
        });
      }
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_DRAFT_CONFLICT",
        "A different or stale draft already exists. Phase 3 drafts may be refreshed with explicit supersession evidence; operator drafts must be reviewed manually.",
      );
    }

    const requestHash = calculateMasterDataDraftRequestHash("transformation_model", {
      actorId,
      changeReason: request.changeReason,
      definition: {
        candidate: candidate.definition,
        backfillEvidence: {
          inputHash: candidate.inputHash,
          resultHash: candidate.resultHash,
        },
      },
    });
    const created = await this.masterDataStore.createTransformationModelDraft({
      actorId,
      changeReason: request.changeReason,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      definition: candidate.definition,
      backfillEvidence: {
        inputHash: candidate.inputHash,
        resultHash: candidate.resultHash,
      },
      occurredAt: validNow(this.clock),
    });
    return applyInventoryAvailabilityBackfillDraftResultSchema.parse({
      ...created,
      inputHash: candidate.inputHash,
      resultHash: candidate.resultHash,
    });
  }

  async refreshProductDraft(
    productIdInput: number,
    draftModelIdInput: number,
    input: unknown,
    actorInput: string,
  ): Promise<RefreshInventoryAvailabilityBackfillDraftResult> {
    const productId = parseProductId(productIdInput);
    const draftModelId = parseProductId(draftModelIdInput);
    const actorId = parseActor(actorInput);
    const request = parseInput(refreshInventoryAvailabilityBackfillDraftRequestSchema, input);
    const captured = await this.catalogStore.captureBackfillProduct(productId);
    if (!captured) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_AVAILABILITY_PRODUCT_NOT_FOUND",
        "The active catalog product does not exist.",
      );
    }
    const candidate = planInventoryAvailabilityBackfill(captured.source);
    if (
      request.expectedInputHash !== candidate.inputHash
      || request.expectedResultHash !== candidate.resultHash
    ) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_PREVIEW_STALE",
        "The deterministic backfill preview changed; reload the migration queue.",
      );
    }
    if (!candidate.definition || !candidate.definitionHash) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_BLOCKED",
        "The product has blocking source-data issues and cannot refresh its draft.",
        candidate.issues
          .filter((entry) => entry.severity === "blocking")
          .map((entry) => `${entry.code}: ${entry.message}`),
      );
    }
    const draft = captured.draft;
    if (
      !draft
      || draft.modelId !== draftModelId
      || draft.version !== request.expectedDraftVersion
      || draft.definitionHash !== request.expectedDraftDefinitionHash
      || draft.headRevision !== request.expectedDraftHeadRevision
    ) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_DRAFT_STALE",
        "The current draft changed; reload the migration queue before refreshing it.",
      );
    }
    if (draft.origin !== "phase3_backfill") {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_OPERATOR_DRAFT",
        "Operator-authored drafts cannot be superseded by the deterministic backfill command.",
      );
    }
    if (
      draft.originInputHash !== request.expectedDraftOriginInputHash
      || draft.originResultHash !== request.expectedDraftOriginResultHash
    ) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_DRAFT_STALE",
        "The current draft changed; reload the migration queue before refreshing it.",
      );
    }
    if (isExactBackfillDraft(draft, candidate)) {
      throw new InventoryAvailabilityMasterDataError(
        409,
        "INVENTORY_AVAILABILITY_BACKFILL_DRAFT_CURRENT",
        "The Phase 3 draft already has the current deterministic provenance and does not need refresh.",
      );
    }

    const requestHash = calculateMasterDataDraftRequestHash(
      "transformation_model_backfill_refresh",
      {
        actorId,
        changeReason: request.changeReason,
        definition: {
          productId,
          draftModelId,
          expectedDraftVersion: request.expectedDraftVersion,
          expectedDraftDefinitionHash: request.expectedDraftDefinitionHash,
          expectedDraftHeadRevision: request.expectedDraftHeadRevision,
          expectedDraftOriginInputHash: request.expectedDraftOriginInputHash,
          expectedDraftOriginResultHash: request.expectedDraftOriginResultHash,
          candidate: candidate.definition,
          backfillEvidence: {
            inputHash: candidate.inputHash,
            resultHash: candidate.resultHash,
          },
        },
      },
    );
    const refreshed = await this.masterDataStore.supersedeTransformationModelBackfillDraft({
      actorId,
      changeReason: request.changeReason,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      productId,
      draftModelId,
      expectedDraftVersion: request.expectedDraftVersion,
      expectedDraftDefinitionHash: request.expectedDraftDefinitionHash,
      expectedDraftHeadRevision: request.expectedDraftHeadRevision,
      expectedDraftOriginInputHash: request.expectedDraftOriginInputHash,
      expectedDraftOriginResultHash: request.expectedDraftOriginResultHash,
      definition: candidate.definition,
      backfillEvidence: {
        inputHash: candidate.inputHash,
        resultHash: candidate.resultHash,
      },
      occurredAt: validNow(this.clock),
    });
    return refreshInventoryAvailabilityBackfillDraftResultSchema.parse({
      ...refreshed,
      inputHash: candidate.inputHash,
      resultHash: candidate.resultHash,
    });
  }

  async reviewProductDraft(
    productIdInput: number,
    input: unknown,
    actorInput: string,
  ) {
    const productId = parseProductId(productIdInput);
    const actorId = parseActor(actorInput);
    const request = parseInput(reviewInventoryAvailabilityBackfillDraftRequestSchema, input);
    const requestHash = createHash("sha256").update(canonicalJson({
      commandType: "transformation_model_review",
      productId,
      actorId,
      ...request,
    }), "utf8").digest("hex");
    return reviewInventoryAvailabilityBackfillDraftResultSchema.parse(
      await this.catalogStore.reviewTransformationModelDraft({
        expectedLatestReviewId: request.expectedLatestReviewId,
        productId,
        expectedModelId: request.expectedModelId,
        expectedModelVersion: request.expectedModelVersion,
        expectedDefinitionHash: request.expectedDefinitionHash,
        expectedHeadRevision: request.expectedHeadRevision,
        decision: request.decision,
        reason: request.reason,
        actorId,
        idempotencyKey: request.idempotencyKey,
        requestHash,
        occurredAt: validNow(this.clock),
      }),
    );
  }

  async getChannelPreview(productIdInput: number): Promise<InventoryAvailabilityChannelPreview> {
    const productId = parseProductId(productIdInput);
    const preview = await this.channelPreviewStore.previewLatestShadowChannels(productId);
    if (!preview) {
      throw new InventoryAvailabilityMasterDataError(
        404,
        "INVENTORY_AVAILABILITY_SHADOW_RUN_NOT_FOUND",
        "Run and review a current ATP shadow comparison before channel publication preview.",
      );
    }
    return inventoryAvailabilityChannelPreviewSchema.parse(preview);
  }
}

function isExactBackfillDraft(
  draft: CapturedInventoryAvailabilityBackfillDraft,
  candidate: ReturnType<typeof planInventoryAvailabilityBackfill>,
): boolean {
  return Boolean(
    candidate.definitionHash
    && draft.origin === "phase3_backfill"
    && draft.definitionHash === candidate.definitionHash
    && draft.originInputHash === candidate.inputHash
    && draft.originResultHash === candidate.resultHash,
  );
}

function parseProductId(value: number): number {
  const parsed = positiveDatabaseIntegerSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_ID",
      "Invalid product identifier.",
    );
  }
  return parsed.data;
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      401,
      "INVENTORY_AVAILABILITY_ACTOR_REQUIRED",
      "An authenticated operator is required.",
    );
  }
  return parsed.data;
}

function parseInput<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      400,
      "INVENTORY_AVAILABILITY_INVALID_INPUT",
      "Review the inventory availability backfill fields.",
      parsed.error.issues.map((entry) => `${entry.path.join(".") || "request"}: ${entry.message}`),
    );
  }
  return parsed.data;
}

function validNow(clock: InventoryAvailabilityBackfillClock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_AVAILABILITY_INVALID_CLOCK",
      "The injected backfill clock returned an invalid time.",
    );
  }
  return now;
}
