import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  buildRecipeComponents,
  buildRecipes,
  plannerShadowRuns,
  products,
  productVariants,
  transformationModelHeads,
  transformationModelReviews,
  transformationModelVersions,
} from "@shared/schema";
import {
  inventoryAvailabilityBackfillReviewSchema,
} from "@shared/types/inventory-availability-backfill";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import type {
  CapturedInventoryAvailabilityBackfillCatalog,
  CapturedInventoryAvailabilityBackfillProduct,
  InventoryAvailabilityBackfillCatalogStore,
} from "../application/inventory-availability-backfill.service";
import {
  InventoryAvailabilityMasterDataError,
} from "../domain/inventory-availability-master-data.contracts";
import {
  inventoryAvailabilityBackfillSourceSchema,
  planInventoryAvailabilityBackfill,
  type InventoryAvailabilityBackfillSource,
} from "../domain/inventory-availability-backfill";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

const MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE = 918420;
const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
const DRAFT_UPDATE_RECEIPT_PREFIX = "inventory-availability:";

export async function loadInventoryAvailabilityBackfillSources(
  executor: Executor,
  requestedProductIds?: readonly number[],
): Promise<InventoryAvailabilityBackfillSource[]> {
  if (requestedProductIds && requestedProductIds.length === 0) return [];
  const productFilter = requestedProductIds
    ? and(eq(products.isActive, true), inArray(products.id, [...requestedProductIds]))
    : eq(products.isActive, true);
  const productRows = await executor
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      isActive: products.isActive,
      legacyInventoryStrategy: products.inventoryStrategy,
    })
    .from(products)
    .where(productFilter)
    .orderBy(asc(products.id));
  if (productRows.length === 0) return [];
  const productIds = productRows.map((product) => product.id);

  const variantRows = await executor
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      name: productVariants.name,
      unitsPerVariant: productVariants.unitsPerVariant,
      uomType: productVariants.uomType,
      isActive: productVariants.isActive,
    })
    .from(productVariants)
    .where(and(
      inArray(productVariants.productId, productIds),
      eq(productVariants.isActive, true),
    ))
    .orderBy(
      asc(productVariants.productId),
      asc(productVariants.unitsPerVariant),
      asc(productVariants.id),
    );

  const recipeRows = await executor
    .select({
      id: buildRecipes.id,
      code: buildRecipes.code,
      name: buildRecipes.name,
      version: buildRecipes.version,
      status: buildRecipes.status,
      recipeType: buildRecipes.recipeType,
      outputProductId: buildRecipes.outputProductId,
      outputVariantId: buildRecipes.outputVariantId,
      outputUnitsPerVariant: buildRecipes.outputUnitsPerVariant,
      outputQty: buildRecipes.outputQty,
    })
    .from(buildRecipes)
    .where(and(
      inArray(buildRecipes.outputProductId, productIds),
      eq(buildRecipes.status, "active"),
    ))
    .orderBy(asc(buildRecipes.outputProductId), asc(buildRecipes.id));
  const recipeIds = recipeRows.map((recipe) => recipe.id);
  const componentRows = recipeIds.length === 0
    ? []
    : await executor
        .select({
          recipeId: buildRecipeComponents.recipeId,
          componentVariantId: buildRecipeComponents.componentVariantId,
          componentProductId: buildRecipeComponents.componentProductId,
          componentUnitsPerVariant: buildRecipeComponents.componentUnitsPerVariant,
          actualProductId: productVariants.productId,
          actualUnitsPerVariant: productVariants.unitsPerVariant,
          componentQty: buildRecipeComponents.qty,
          sku: productVariants.sku,
          name: productVariants.name,
          isActive: productVariants.isActive,
        })
        .from(buildRecipeComponents)
        .innerJoin(productVariants, eq(productVariants.id, buildRecipeComponents.componentVariantId))
        .where(inArray(buildRecipeComponents.recipeId, recipeIds))
        .orderBy(asc(buildRecipeComponents.recipeId), asc(buildRecipeComponents.componentVariantId));

  const variantsByProduct = new Map<number, typeof variantRows>();
  for (const variant of variantRows) {
    const entries = variantsByProduct.get(variant.productId) ?? [];
    entries.push(variant);
    variantsByProduct.set(variant.productId, entries);
  }
  const componentsByRecipe = new Map<number, typeof componentRows>();
  for (const component of componentRows) {
    const entries = componentsByRecipe.get(component.recipeId) ?? [];
    entries.push(component);
    componentsByRecipe.set(component.recipeId, entries);
  }
  const recipesByProduct = new Map<number, Array<typeof recipeRows[number] & {
    components: typeof componentRows;
  }>>();
  for (const recipe of recipeRows) {
    const entries = recipesByProduct.get(recipe.outputProductId) ?? [];
    entries.push({ ...recipe, components: componentsByRecipe.get(recipe.id) ?? [] });
    recipesByProduct.set(recipe.outputProductId, entries);
  }

  return productRows.map((product) => inventoryAvailabilityBackfillSourceSchema.parse({
    product: {
      id: product.id,
      sku: product.sku,
      name: product.name,
      isActive: true,
      legacyInventoryStrategy: product.legacyInventoryStrategy,
    },
    variants: (variantsByProduct.get(product.id) ?? []).map((variant) => ({
      ...variant,
      isActive: true,
    })),
    recipes: (recipesByProduct.get(product.id) ?? []).map((recipe) => ({
      ...recipe,
      status: "active",
    })),
  }));
}

async function captureProducts(
  executor: Executor,
  sources: InventoryAvailabilityBackfillSource[],
): Promise<CapturedInventoryAvailabilityBackfillProduct[]> {
  if (sources.length === 0) return [];
  const productIds = sources.map((source) => source.product.id);
  const headRows = await executor
    .select({
      productId: transformationModelHeads.productId,
      headRevision: transformationModelHeads.revision,
      modelId: transformationModelVersions.id,
      version: transformationModelVersions.version,
      definitionHash: transformationModelVersions.definitionHash,
      origin: transformationModelVersions.origin,
      originInputHash: transformationModelVersions.originInputHash,
      originResultHash: transformationModelVersions.originResultHash,
    })
    .from(transformationModelHeads)
    .innerJoin(
      transformationModelVersions,
      eq(transformationModelVersions.id, transformationModelHeads.draftModelId),
    )
    .where(inArray(transformationModelHeads.productId, productIds));
  const draftByProduct = new Map(headRows.map((row) => [row.productId, row] as const));
  const draftIds = headRows.map((row) => row.modelId);
  const reviewRows = draftIds.length === 0
    ? []
    : await executor
        .select()
        .from(transformationModelReviews)
        .where(inArray(transformationModelReviews.modelId, draftIds))
        .orderBy(desc(transformationModelReviews.reviewedAt), desc(transformationModelReviews.id));
  const reviewByModelAndHash = new Map<string, typeof reviewRows[number]>();
  for (const review of reviewRows) {
    const key = `${review.modelId}:${review.modelDefinitionHash}`;
    if (!reviewByModelAndHash.has(key)) reviewByModelAndHash.set(key, review);
  }
  const shadowRows = await executor
    .select({
      id: plannerShadowRuns.id,
      productId: plannerShadowRuns.productId,
      status: plannerShadowRuns.status,
      snapshotFingerprint: plannerShadowRuns.snapshotFingerprint,
      modelDefinitionHash: plannerShadowRuns.modelDefinitionHash,
      capturedAt: plannerShadowRuns.capturedAt,
    })
    .from(plannerShadowRuns)
    .where(inArray(plannerShadowRuns.productId, productIds))
    .orderBy(asc(plannerShadowRuns.productId), desc(plannerShadowRuns.completedAt), desc(plannerShadowRuns.id));
  const shadowByProduct = new Map<number, typeof shadowRows[number]>();
  for (const shadow of shadowRows) {
    if (!shadowByProduct.has(shadow.productId)) shadowByProduct.set(shadow.productId, shadow);
  }

  return sources.map((source) => {
    const draftRow = draftByProduct.get(source.product.id);
    const reviewRow = draftRow
      ? reviewByModelAndHash.get(`${draftRow.modelId}:${draftRow.definitionHash}`)
      : undefined;
    const shadowRow = shadowByProduct.get(source.product.id);
    return {
      source,
      draft: draftRow
        ? {
            modelId: draftRow.modelId,
            version: draftRow.version,
            definitionHash: draftRow.definitionHash,
            headRevision: draftRow.headRevision.toString(),
            origin: draftRow.origin as "operator" | "phase3_backfill",
            originInputHash: draftRow.originInputHash,
            originResultHash: draftRow.originResultHash,
          }
        : null,
      review: reviewRow
        ? {
            reviewId: reviewRow.id.toString(),
            decision: reviewRow.decision as "approved" | "changes_required",
            reason: reviewRow.reason,
            reviewedBy: reviewRow.reviewedBy,
            reviewedAt: reviewRow.reviewedAt.toISOString(),
            modelId: reviewRow.modelId,
            modelVersion: reviewRow.modelVersion,
            modelDefinitionHash: reviewRow.modelDefinitionHash,
          }
        : null,
      latestShadow: shadowRow
        ? {
            runId: shadowRow.id.toString(),
            status: shadowRow.status as "completed" | "blocked",
            snapshotFingerprint: shadowRow.snapshotFingerprint,
            modelDefinitionHash: shadowRow.modelDefinitionHash,
            capturedAt: shadowRow.capturedAt.toISOString(),
          }
        : null,
    };
  });
}

export class PostgresInventoryAvailabilityBackfillRepository
implements InventoryAvailabilityBackfillCatalogStore {
  constructor(private readonly database: typeof db = db) {}

  async captureBackfillCatalog(): Promise<CapturedInventoryAvailabilityBackfillCatalog> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const clockResult = await tx.execute(sql`SELECT transaction_timestamp() AS captured_at`);
      const clock = clockResult.rows[0] as { captured_at: Date | string } | undefined;
      if (!clock) {
        throw new Error("The database did not return a transaction timestamp for backfill capture.");
      }
      const sources = await loadInventoryAvailabilityBackfillSources(tx);
      return {
        capturedAt: new Date(clock.captured_at).toISOString(),
        products: await captureProducts(tx, sources),
      };
    });
  }

  async captureBackfillProduct(
    productId: number,
  ): Promise<CapturedInventoryAvailabilityBackfillProduct | null> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const sources = await loadInventoryAvailabilityBackfillSources(tx, [productId]);
      const [captured] = await captureProducts(tx, sources);
      return captured ?? null;
    });
  }

  async reviewTransformationModelDraft(
    command: Parameters<InventoryAvailabilityBackfillCatalogStore["reviewTransformationModelDraft"]>[0],
  ) {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE},
          hashtext(${command.idempotencyKey})
        )
      `);
      const [replay] = await tx
        .select()
        .from(transformationModelReviews)
        .where(eq(transformationModelReviews.idempotencyKey, command.idempotencyKey))
        .limit(1);
      if (replay) {
        if (replay.requestHash !== command.requestHash) {
          throw idempotencyConflict();
        }
        return {
          review: inventoryAvailabilityBackfillReviewSchema.parse({
            reviewId: replay.id.toString(),
            decision: replay.decision,
            reason: replay.reason,
            reviewedBy: replay.reviewedBy,
            reviewedAt: replay.reviewedAt.toISOString(),
            modelId: replay.modelId,
            modelVersion: replay.modelVersion,
            modelDefinitionHash: replay.modelDefinitionHash,
          }),
          alreadyApplied: true,
        };
      }
      await assertReviewIdempotencyUnused(tx, command.idempotencyKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${TRANSFORMATION_MODEL_LOCK_NAMESPACE},
          ${command.productId}
        )
      `);
      const [head] = await tx
        .select()
        .from(transformationModelHeads)
        .where(eq(transformationModelHeads.productId, command.productId))
        .limit(1)
        .for("update");
      const [model] = await tx
        .select()
        .from(transformationModelVersions)
        .where(eq(transformationModelVersions.id, command.expectedModelId))
        .limit(1)
        .for("update");
      if (
        !head
        || head.draftModelId !== command.expectedModelId
        || head.revision.toString() !== command.expectedHeadRevision
        || !model
        || model.productId !== command.productId
        || model.version !== command.expectedModelVersion
        || model.definitionHash !== command.expectedDefinitionHash
        || model.lifecycleStatus !== "draft"
      ) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_REVIEW_STALE",
          "The draft changed after it was loaded; reload before recording review.",
        );
      }
      const [source] = await loadInventoryAvailabilityBackfillSources(tx, [command.productId]);
      const candidate = source ? planInventoryAvailabilityBackfill(source) : null;
      if (
        !candidate
        || candidate.definitionHash !== model.definitionHash
        || (model.origin === "phase3_backfill" && (
          candidate.inputHash !== model.originInputHash
          || candidate.resultHash !== model.originResultHash
        ))
      ) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_REVIEW_SOURCE_CHANGED",
          "The current product, variants, recipes, or deterministic candidate no longer matches this draft.",
        );
      }
      const [created] = await tx
        .insert(transformationModelReviews)
        .values({
          modelId: model.id,
          productId: model.productId,
          modelVersion: model.version,
          modelDefinitionHash: model.definitionHash,
          decision: command.decision,
          reason: command.reason,
          reviewedBy: command.actorId,
          reviewedAt: command.occurredAt,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdAt: command.occurredAt,
        })
        .returning({ id: transformationModelReviews.id });
      const review = inventoryAvailabilityBackfillReviewSchema.parse({
        reviewId: created.id.toString(),
        decision: command.decision,
        reason: command.reason,
        reviewedBy: command.actorId,
        reviewedAt: command.occurredAt.toISOString(),
        modelId: model.id,
        modelVersion: model.version,
        modelDefinitionHash: model.definitionHash,
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.transformation_model.review_recorded",
        target: `inventory.transformation_model:${model.id}`,
        changes: { before: null, after: review },
        context: {
          productId: model.productId,
          headRevision: head.revision.toString(),
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          runtimeAuthorityChanged: false,
        },
      }, { timestamp: command.occurredAt, emitStructuredLog: false });
      return { review, alreadyApplied: false };
    });
  }
}

async function assertReviewIdempotencyUnused(
  tx: Transaction,
  idempotencyKey: string,
): Promise<void> {
  const result = await tx.execute(sql`
    SELECT command_type
    FROM (
      SELECT 'transformation_model'::text AS command_type, idempotency_key
      FROM inventory.transformation_model_versions
      UNION ALL
      SELECT 'location_promise_policy'::text AS command_type, idempotency_key
      FROM inventory.location_promise_policy_versions
      UNION ALL
      SELECT 'promise_safety_policy'::text AS command_type, idempotency_key
      FROM inventory.promise_safety_policy_versions
      UNION ALL
      SELECT 'transformation_model_draft_update'::text AS command_type,
             substring(key from ${DRAFT_UPDATE_RECEIPT_PREFIX.length + 1}) AS idempotency_key
      FROM public.idempotency_keys
      WHERE key = ${`${DRAFT_UPDATE_RECEIPT_PREFIX}${idempotencyKey}`}
    ) AS used_key
    WHERE used_key.idempotency_key = ${idempotencyKey}
    LIMIT 1
  `);
  if (result.rows.length > 0) throw idempotencyConflict();
}

function idempotencyConflict(): InventoryAvailabilityMasterDataError {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
    "The idempotency key was already used for a different request or command.",
  );
}
