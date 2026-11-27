import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { productDefinitionReceiptSchema } from "@shared/types/inventory-product-definition";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import { pool as defaultPool } from "../../../db";
import { logger } from "../../../platform/observability/logger";
import { calculateMasterDataDraftRequestHash } from "../domain/inventory-availability-master-data.contracts";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import {
  buildAutoSyncedPackagingModelDefinition,
  type PackagingSyncVariantSnapshot,
} from "../domain/catalog-packaging-model-sync";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";
import {
  loadTransformationModel,
  PostgresInventoryAvailabilityMasterDataStore,
} from "./inventory-availability-master-data.repository";
import {
  captureProductDefinitionReviewInsideTransaction,
  enqueueReviewedDefinitionPublication,
} from "./inventory-product-definition.repository";

const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
const DEFAULT_SYNC_ACTOR = "system:catalog-packaging-sync";
const DEFAULT_SYNC_REASON = "Auto-synced same-product package hierarchy break paths from catalog variants.";

export type CatalogPackagingModelSyncResult =
  | {
      status: "synced";
      productId: number;
      modelId: number;
      definitionHash: string;
      pathCount: number;
    }
  | {
      status: "up_to_date";
      productId: number;
      definitionHash: string;
      pathCount: number;
    }
  | {
      status: "skipped";
      productId: number;
      reason: string;
      blockers?: string[];
    };

class ReviewBlockedRollback extends Error {
  constructor(readonly blockers: string[]) {
    super("Auto-synced packaging transformation model review has blockers.");
  }
}

export async function syncProductPackagingTransformationModel(
  productId: number,
  options: {
    actor?: string;
    reason?: string;
    connectionPool?: Pick<Pool, "connect">;
    clock?: () => Date;
  } = {},
): Promise<CatalogPackagingModelSyncResult> {
  if (!Number.isSafeInteger(productId) || productId <= 0 || productId > 2_147_483_647) {
    return { status: "skipped", productId, reason: "invalid_product_id" };
  }
  const connectionPool = options.connectionPool ?? defaultPool;
  if (!connectionPool || typeof connectionPool.connect !== "function") {
    return { status: "skipped", productId, reason: "pool_unavailable" };
  }

  const actor = (options.actor?.trim() || DEFAULT_SYNC_ACTOR).slice(0, 100);
  const reason = (options.reason?.trim() || DEFAULT_SYNC_REASON).slice(0, 1000);
  const now = (options.clock ?? (() => new Date()))();

  let client: PoolClient | null = null;
  let discard = false;
  try {
    client = await connectionPool.connect();
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='60s'");

    const authorityCheck = (
      await client.query<{
        authority: string;
        activation_run_id: string | null;
        active_configuration_run_id: string | null;
      }>(
        `SELECT authority, activation_run_id::text, active_configuration_run_id::text
         FROM inventory.availability_runtime_authority
         WHERE singleton_key = true`,
      )
    ).rows[0];
    if (
      !authorityCheck ||
      authorityCheck.authority !== "canonical" ||
      !authorityCheck.activation_run_id ||
      authorityCheck.active_configuration_run_id !== null
    ) {
      await client.query("COMMIT");
      return { status: "skipped", productId, reason: "canonical_authority_not_active" };
    }

    // Lock order matches PostgresSafetyDefinitionStore.set and PostgresProductDefinitionStore.apply:
    // global cutover fence -> transformation model scope lock -> head/catalog rows.
    await acquireInventoryCutoverFenceInsideTransaction(client, {
      expectedAuthority: "canonical",
      expectedConfigurationRunId: null,
    });
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      TRANSFORMATION_MODEL_LOCK_NAMESPACE,
      productId,
    ]);

    const productRow = (
      await client.query<{ id: number; is_active: boolean }>(
        "SELECT id, is_active FROM catalog.products WHERE id = $1",
        [productId],
      )
    ).rows[0];
    if (!productRow) {
      await client.query("COMMIT");
      return { status: "skipped", productId, reason: "product_not_found" };
    }

    const headRow = (
      await client.query<{
        revision: string;
        active_model_id: number | null;
        draft_model_id: number | null;
      }>(
        `SELECT revision::text, active_model_id, draft_model_id
         FROM inventory.transformation_model_heads
         WHERE product_id = $1`,
        [productId],
      )
    ).rows[0] ?? null;

    if (headRow?.draft_model_id != null) {
      await client.query("COMMIT");
      return { status: "skipped", productId, reason: "unapplied_draft_exists" };
    }

    const variantRows = (
      await client.query<{
        id: number;
        product_id: number;
        units_per_variant: number;
        hierarchy_level: number | null;
        is_active: boolean;
        requires_shipping: boolean;
        track_inventory: boolean | null;
        sales_eligibility: string;
      }>(
        `SELECT id, product_id, units_per_variant, hierarchy_level,
                is_active, requires_shipping, track_inventory, sales_eligibility
         FROM catalog.product_variants
         WHERE product_id = $1
         ORDER BY id ASC`,
        [productId],
      )
    ).rows;

    const recipeCountRow = (
      await client.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
         FROM inventory.build_recipes
         WHERE output_product_id = $1 AND status = 'active'`,
        [productId],
      )
    ).rows[0];

    const txDrizzle = drizzle(client);
    const existingActiveModel = headRow?.active_model_id != null
      ? await loadTransformationModel(txDrizzle, headRow.active_model_id)
      : null;

    const variants: PackagingSyncVariantSnapshot[] = variantRows.map((row) => ({
      id: Number(row.id),
      productId: Number(row.product_id),
      unitsPerVariant: Number(row.units_per_variant),
      hierarchyLevel: row.hierarchy_level == null ? null : Number(row.hierarchy_level),
      isActive: row.is_active === true || Number(row.is_active) === 1,
      requiresShipping: row.requires_shipping === true || Number(row.requires_shipping) === 1,
      trackInventory: row.track_inventory == null ? null : Boolean(row.track_inventory),
      salesEligibility: row.sales_eligibility === "internal_only" ? "internal_only" : ("sellable" as VariantSalesEligibility),
    }));

    const plan = buildAutoSyncedPackagingModelDefinition({
      product: {
        id: Number(productRow.id),
        isActive: productRow.is_active === true || Number(productRow.is_active) === 1,
      },
      variants,
      activeRecipeCount: Number(recipeCountRow?.cnt ?? 0),
      existingActiveModel: existingActiveModel
        ? {
            definitionHash: existingActiveModel.definitionHash,
            inventoryBehavior: existingActiveModel.inventoryBehavior ?? null,
            buildToPromiseEnabled: existingActiveModel.buildToPromiseEnabled,
            paths: existingActiveModel.paths,
            recipeBindings: existingActiveModel.bindings,
          }
        : null,
      hasUnappliedDraft: false,
    });

    if (plan.kind === "skip") {
      await client.query("COMMIT");
      return { status: "skipped", productId, reason: plan.reason };
    }
    if (plan.kind === "up_to_date") {
      await client.query("COMMIT");
      return {
        status: "up_to_date",
        productId,
        definitionHash: plan.definitionHash,
        pathCount: plan.pathCount,
      };
    }

    const headRevisionBefore = headRow?.revision ?? "none";
    const idempotencyKey = `auto-pkg-sync:${productId}:${headRevisionBefore}:${plan.definitionHash.slice(0, 24)}`;
    const draftRequestHash = calculateMasterDataDraftRequestHash("transformation_model", {
      actorId: actor,
      changeReason: reason,
      definition: plan.definition,
    });

    const masterDataStore = new PostgresInventoryAvailabilityMasterDataStore();
    const saved = await masterDataStore.createTransformationModelDraftInsideTransaction(txDrizzle, {
      actorId: actor,
      changeReason: reason,
      idempotencyKey: `draft:${idempotencyKey}`.slice(0, 120),
      requestHash: draftRequestHash,
      definition: plan.definition,
      occurredAt: now,
    });

    const writtenHead = (
      await client.query<{ revision: string }>(
        "SELECT revision::text FROM inventory.transformation_model_heads WHERE product_id = $1",
        [productId],
      )
    ).rows[0];
    if (!writtenHead) {
      throw new Error(`Transformation model head missing after draft write for product ${productId}`);
    }

    const review = await captureProductDefinitionReviewInsideTransaction(client, {
      productId,
      draftModelId: saved.modelId,
      expectedHeadRevision: writtenHead.revision,
      expectedDefinitionHash: saved.definitionHash,
    });
    if (!review.ready) {
      throw new ReviewBlockedRollback(review.blockers);
    }

    await promoteInventoryCutoverDefinitionsInsideTransaction(
      client,
      {
        contractVersion: "inventory_cutover_selection_manifest_v1",
        productIds: [productId],
        publicationTargetIds: [],
        selections: [
          {
            kind: "model",
            key: String(productId),
            definitionId: saved.modelId,
            definitionHash: saved.definitionHash,
          },
        ],
      },
      { actor, occurredAt: now, reason },
    );

    const publicationIds = await enqueueReviewedDefinitionPublication(client, review, {
      triggeredBy: "catalog_packaging_auto_sync",
    });

    const applyRequestHash = inventoryCutoverEvidenceHash({
      idempotencyKey,
      productId,
      modelId: saved.modelId,
      definitionHash: saved.definitionHash,
      actor,
    });
    const receipt = productDefinitionReceiptSchema.parse({
      productId,
      modelId: saved.modelId,
      appliedAt: now.toISOString(),
      appliedBy: actor,
      reviewHash: review.reviewHash,
      publicationIds,
      alreadyApplied: false,
    });
    await client.query(
      `INSERT INTO inventory.product_definition_applications
         (product_id, model_id, idempotency_key, request_hash, actor, occurred_at, review, receipt)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        productId,
        saved.modelId,
        idempotencyKey.slice(0, 120),
        applyRequestHash,
        actor,
        now.toISOString(),
        JSON.stringify(review),
        JSON.stringify(receipt),
      ],
    );

    await client.query("COMMIT");
    return {
      status: "synced",
      productId,
      modelId: saved.modelId,
      definitionHash: saved.definitionHash,
      pathCount: plan.pathCount,
    };
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
    }
    if (error instanceof ReviewBlockedRollback) {
      return {
        status: "skipped",
        productId,
        reason: "review_blocked",
        blockers: error.blockers,
      };
    }
    throw error;
  } finally {
    if (client) client.release(discard);
  }
}

export async function syncProductPackagingTransformationModelBestEffort(
  productId: number | null | undefined,
  options: {
    actor?: string;
    reason?: string;
    connectionPool?: Pick<Pool, "connect">;
    clock?: () => Date;
  } = {},
): Promise<CatalogPackagingModelSyncResult | null> {
  if (!productId || !Number.isSafeInteger(productId) || productId <= 0) return null;
  try {
    return await syncProductPackagingTransformationModel(productId, options);
  } catch (error) {
    logger.warn("catalog_packaging_model_auto_sync_skipped", {
      product_id: productId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
