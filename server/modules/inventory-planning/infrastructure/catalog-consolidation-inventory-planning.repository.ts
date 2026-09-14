import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { canonicalJson } from "@shared/utils/canonical-json";
import { sqlIntegerArray } from "../../../infrastructure/postgres-array";
import {
  CatalogConsolidationInventoryPlanningError,
  type CatalogConsolidationDraftInvalidationResult,
  type CatalogConsolidationInventoryPlanningEvidence,
  type CatalogConsolidationInventoryPlanningPort,
  type CatalogConsolidationInventoryPlanningTransaction,
} from "../application/catalog-consolidation-inventory-planning.port";

const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
const MAX_DATABASE_INTEGER = 2_147_483_647;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function evidenceError(message: string, context: Readonly<Record<string, unknown>> = {}) {
  return new CatalogConsolidationInventoryPlanningError(
    "INVENTORY_PLANNING_CONSOLIDATION_EVIDENCE_INVALID",
    message,
    context,
  );
}

function rows(result: unknown): Record<string, unknown>[] {
  if (
    typeof result !== "object"
    || result === null
    || !("rows" in result)
    || !Array.isArray(result.rows)
  ) {
    throw evidenceError("The inventory-planning store returned malformed query results.");
  }
  return result.rows as Record<string, unknown>[];
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > MAX_DATABASE_INTEGER) {
    throw evidenceError(`Invalid ${field}.`, { field, value });
  }
  return parsed;
}

function nonnegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_DATABASE_INTEGER) {
    throw evidenceError(`Invalid ${field}.`, { field, value });
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined
    ? null
    : positiveInteger(value, field);
}

function sortedUniquePositiveIds(values: readonly number[], field: string): number[] {
  return [...new Set(values.map((value) => positiveInteger(value, field)))]
    .sort((left, right) => left - right);
}

function requiredText(value: string, field: string, maximumLength: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw evidenceError(`Invalid ${field}.`, { field });
  }
  return normalized;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseVariantIdentities(
  variants: readonly { variantId: number; productId: number }[],
): Array<{ variantId: number; productId: number }> {
  const byVariantId = new Map<number, number>();
  for (const variant of variants) {
    const variantId = positiveInteger(variant.variantId, "variant id");
    const productId = positiveInteger(variant.productId, `variant ${variantId} product id`);
    const priorProductId = byVariantId.get(variantId);
    if (priorProductId !== undefined && priorProductId !== productId) {
      throw evidenceError("A variant was associated with conflicting product identities.", {
        variantId,
        productIds: [priorProductId, productId],
      });
    }
    byVariantId.set(variantId, productId);
  }
  return [...byVariantId.entries()]
    .map(([variantId, productId]) => ({ variantId, productId }))
    .sort((left, right) => left.variantId - right.variantId);
}

async function loadProductEvidence(
  client: CatalogConsolidationInventoryPlanningTransaction,
  productIds: readonly number[],
) {
  if (productIds.length === 0) return [];
  const result = rows(await client.execute(sql`
    SELECT
      requested.product_id,
      model_head.active_model_id,
      model_head.draft_model_id,
      (
        SELECT COUNT(*)::integer
        FROM inventory.channel_exposure_policy_heads AS exposure_head
        JOIN inventory.channel_exposure_policy_versions AS exposure_policy
          ON exposure_policy.id = exposure_head.active_policy_id
        WHERE exposure_policy.product_id = requested.product_id
      ) AS active_channel_exposure_policy_count
    FROM unnest(${sqlIntegerArray(productIds)}) AS requested(product_id)
    LEFT JOIN inventory.transformation_model_heads AS model_head
      ON model_head.product_id = requested.product_id
    ORDER BY requested.product_id
  `));
  if (result.length !== productIds.length) {
    throw evidenceError("Inventory-planning product evidence was incomplete.", {
      expectedCount: productIds.length,
      actualCount: result.length,
    });
  }
  return result.map((row) => {
    const productId = positiveInteger(row.product_id, "planning product id");
    return Object.freeze({
      productId,
      activeTransformationModelId: nullablePositiveInteger(
        row.active_model_id,
        `product ${productId} active transformation model id`,
      ),
      draftTransformationModelId: nullablePositiveInteger(
        row.draft_model_id,
        `product ${productId} draft transformation model id`,
      ),
      activeChannelExposurePolicyCount: nonnegativeInteger(
        row.active_channel_exposure_policy_count,
        `product ${productId} active channel exposure policy count`,
      ),
    });
  });
}

async function loadVariantEvidence(
  client: CatalogConsolidationInventoryPlanningTransaction,
  variants: readonly { variantId: number; productId: number }[],
) {
  if (variants.length === 0) return [];
  const variantIds = variants.map((variant) => variant.variantId);
  const productIds = variants.map((variant) => variant.productId);
  const result = rows(await client.execute(sql`
    SELECT
      requested.variant_id,
      (
        SELECT COUNT(DISTINCT claim.id)::integer
        FROM inventory.availability_claims AS claim
        WHERE claim.status = 'active'
          AND (
            EXISTS (SELECT 1 FROM inventory.availability_claim_lines AS line
              WHERE line.claim_id = claim.id AND line.target_variant_id = requested.variant_id)
            OR EXISTS (SELECT 1 FROM inventory.availability_claim_resources AS resource
              WHERE resource.claim_id = claim.id AND resource.source_variant_id = requested.variant_id)
            OR EXISTS (SELECT 1 FROM inventory.availability_claim_operations AS operation
              WHERE operation.claim_id = claim.id AND operation.destination_variant_id = requested.variant_id)
            OR EXISTS (
              SELECT 1
              FROM inventory.availability_claim_operation_inputs AS input
              WHERE input.claim_id = claim.id AND input.source_variant_id = requested.variant_id
            )
          )
      ) AS active_claim_count,
      (
        (SELECT COUNT(DISTINCT work.id)
          FROM warehouse.work_items AS work
          JOIN inventory.availability_claim_operations AS operation
            ON operation.id = work.claim_operation_id
          LEFT JOIN inventory.availability_claim_operation_inputs AS input
            ON input.claim_operation_id = operation.id
          WHERE work.state NOT IN ('completed', 'cancelled')
            AND (operation.destination_variant_id = requested.variant_id
              OR input.source_variant_id = requested.variant_id))
        + (SELECT COUNT(*)
          FROM inventory.inventory_publication_outbox AS publication
          WHERE publication.product_variant_id = requested.variant_id
            AND publication.state NOT IN ('verified', 'dead_letter', 'superseded', 'cancelled'))
      )::integer AS open_planning_work_reference_count,
      (
        SELECT COUNT(DISTINCT model.id)::integer
        FROM inventory.transformation_model_versions AS model
        JOIN inventory.transformation_model_paths AS path ON path.model_id = model.id
        WHERE model.lifecycle_status <> 'draft'
          AND (path.source_variant_id = requested.variant_id
            OR path.destination_variant_id = requested.variant_id)
      ) AS non_draft_transformation_reference_count,
      (SELECT COUNT(*)::integer
        FROM inventory.channel_exposure_policy_versions AS policy
        WHERE policy.product_variant_id = requested.variant_id
          AND policy.product_id = requested.product_id)
        AS channel_exposure_policy_version_count,
      (SELECT COUNT(*)::integer
        FROM inventory.transformation_recipe_bindings AS binding
        WHERE binding.output_variant_id_snapshot = requested.variant_id
          AND binding.output_product_id_snapshot = requested.product_id)
        AS transformation_recipe_binding_count,
      (SELECT COUNT(*)::integer
        FROM inventory.transformation_recipe_component_snapshots AS component
        WHERE component.component_variant_id = requested.variant_id
          AND component.component_product_id = requested.product_id)
        AS transformation_recipe_component_snapshot_count
    FROM unnest(
      ${sqlIntegerArray(variantIds)},
      ${sqlIntegerArray(productIds)}
    ) AS requested(variant_id, product_id)
    ORDER BY requested.variant_id
  `));
  if (result.length !== variants.length) {
    throw evidenceError("Inventory-planning variant evidence was incomplete.", {
      expectedCount: variants.length,
      actualCount: result.length,
    });
  }
  return result.map((row) => {
    const variantId = positiveInteger(row.variant_id, "planning variant id");
    return Object.freeze({
      variantId,
      activeClaimCount: nonnegativeInteger(
        row.active_claim_count,
        `variant ${variantId} active claim count`,
      ),
      openPlanningWorkReferenceCount: nonnegativeInteger(
        row.open_planning_work_reference_count,
        `variant ${variantId} open planning work count`,
      ),
      nonDraftTransformationReferenceCount: nonnegativeInteger(
        row.non_draft_transformation_reference_count,
        `variant ${variantId} non-draft transformation reference count`,
      ),
      channelExposurePolicyVersionCount: nonnegativeInteger(
        row.channel_exposure_policy_version_count,
        `variant ${variantId} channel exposure policy reference count`,
      ),
      transformationRecipeBindingCount: nonnegativeInteger(
        row.transformation_recipe_binding_count,
        `variant ${variantId} transformation recipe binding count`,
      ),
      transformationRecipeComponentSnapshotCount: nonnegativeInteger(
        row.transformation_recipe_component_snapshot_count,
        `variant ${variantId} transformation recipe component count`,
      ),
    });
  });
}

async function loadActiveCutoverFreezeId(
  client: CatalogConsolidationInventoryPlanningTransaction,
): Promise<string | null> {
  const result = rows(await client.execute(sql`
    SELECT activation_run_id::text AS activation_run_id
    FROM inventory.availability_activation_freezes
    WHERE released_at IS NULL
    ORDER BY activation_run_id
    LIMIT 2
  `));
  if (result.length > 1) {
    throw evidenceError("More than one inventory cutover freeze is active.");
  }
  const value = result[0]?.activation_run_id;
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw evidenceError("The active inventory cutover freeze has an invalid identity.");
  }
  return normalized;
}

function validateInvalidationInput(input: Parameters<
  CatalogConsolidationInventoryPlanningPort["invalidateDrafts"]
>[0]) {
  const canonicalProductId = positiveInteger(input.canonicalProductId, "canonical product id");
  const externalProductId = requiredText(input.externalProductId, "external product id", 100);
  if (!/^\d+$/.test(externalProductId)) {
    throw evidenceError("The external product id must be numeric.");
  }
  if (!SHA256_PATTERN.test(input.requestHash)) {
    throw evidenceError("The consolidation request hash is invalid.");
  }
  if (!UUID_PATTERN.test(input.idempotencyKey)) {
    throw evidenceError("The consolidation idempotency key is invalid.");
  }
  const actor = requiredText(input.actor, "actor", 100);
  const reason = requiredText(input.reason, "reason", 1_000);
  if (!(input.occurredAt instanceof Date) || Number.isNaN(input.occurredAt.getTime())) {
    throw evidenceError("The consolidation occurrence timestamp is invalid.");
  }
  const byProductId = new Map<number, number>();
  const usedModelIds = new Set<number>();
  for (const expected of input.expectedDrafts) {
    const productId = positiveInteger(expected.productId, "draft product id");
    const draftModelId = positiveInteger(expected.draftModelId, `product ${productId} draft model id`);
    if (byProductId.has(productId) || usedModelIds.has(draftModelId)) {
      throw evidenceError("Draft invalidation identities must be unique.", {
        productId,
        draftModelId,
      });
    }
    byProductId.set(productId, draftModelId);
    usedModelIds.add(draftModelId);
  }
  const expectedDrafts = [...byProductId.entries()]
    .map(([productId, draftModelId]) => ({ productId, draftModelId }))
    .sort((left, right) => left.productId - right.productId);
  return {
    canonicalProductId,
    externalProductId,
    actor,
    reason,
    expectedDrafts,
  };
}

export class PostgresCatalogConsolidationInventoryPlanningRepository
implements CatalogConsolidationInventoryPlanningPort {
  async lockProducts(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
    productIds: readonly number[];
  }): Promise<void> {
    for (const productId of sortedUniquePositiveIds(input.productIds, "planning lock product id")) {
      await input.client.execute(sql`
        SELECT pg_advisory_xact_lock(${TRANSFORMATION_MODEL_LOCK_NAMESPACE}, ${productId})
      `);
    }
  }

  async fenceDependencies(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
  }): Promise<void> {
    await input.client.execute(sql`
      LOCK TABLE
        inventory.transformation_model_heads,
        inventory.transformation_model_versions,
        inventory.transformation_model_paths,
        inventory.transformation_recipe_bindings,
        inventory.transformation_recipe_component_snapshots,
        inventory.availability_activation_freezes,
        inventory.availability_claims,
        inventory.availability_claim_lines,
        inventory.availability_claim_resources,
        inventory.availability_claim_operations,
        inventory.availability_claim_operation_inputs,
        inventory.channel_exposure_policy_heads,
        inventory.channel_exposure_policy_versions,
        inventory.inventory_publication_outbox
      IN SHARE ROW EXCLUSIVE MODE
    `);
  }

  async loadEvidence(input: {
    client: CatalogConsolidationInventoryPlanningTransaction;
    productIds: readonly number[];
    variants: readonly { variantId: number; productId: number }[];
  }): Promise<CatalogConsolidationInventoryPlanningEvidence> {
    const productIds = sortedUniquePositiveIds(input.productIds, "planning evidence product id");
    const variants = parseVariantIdentities(input.variants);
    const productIdSet = new Set(productIds);
    const unscopedVariant = variants.find((variant) => !productIdSet.has(variant.productId));
    if (unscopedVariant) {
      throw evidenceError("A requested variant is outside the requested product scope.", unscopedVariant);
    }
    const products = await loadProductEvidence(input.client, productIds);
    const variantEvidence = await loadVariantEvidence(input.client, variants);
    const activeCutoverFreezeId = await loadActiveCutoverFreezeId(input.client);
    return Object.freeze({
      activeCutoverFreezeId,
      products: Object.freeze(products),
      variants: Object.freeze(variantEvidence),
    });
  }

  async invalidateDrafts(input: Parameters<
    CatalogConsolidationInventoryPlanningPort["invalidateDrafts"]
  >[0]): Promise<CatalogConsolidationDraftInvalidationResult> {
    const validated = validateInvalidationInput(input);
    await this.lockProducts({
      client: input.client,
      productIds: validated.expectedDrafts.map((draft) => draft.productId),
    });
    const invalidatedModelIds: number[] = [];
    const replacementModelIds: number[] = [];
    for (const expected of validated.expectedDrafts) {
      const supersessionReason = `Product family consolidated into catalog product ${validated.canonicalProductId}. ${validated.reason}`;
      const updatedRows = rows(await input.client.execute(sql`
        UPDATE inventory.transformation_model_versions
        SET lifecycle_status = 'superseded',
            superseded_by = ${validated.actor},
            superseded_at = ${input.occurredAt},
            supersession_reason = ${supersessionReason},
            updated_at = ${input.occurredAt}
        WHERE id = ${expected.draftModelId}
          AND product_id = ${expected.productId}
          AND lifecycle_status = 'draft'
        RETURNING id, version
      `));
      if (updatedRows.length !== 1) {
        throw new CatalogConsolidationInventoryPlanningError(
          "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_STALE",
          "A transformation draft changed after consolidation review.",
          { productId: expected.productId, expectedDraftModelId: expected.draftModelId },
        );
      }
      const priorVersion = positiveInteger(
        updatedRows[0].version,
        `product ${expected.productId} transformation model version`,
      );
      if (priorVersion >= MAX_DATABASE_INTEGER) {
        throw new CatalogConsolidationInventoryPlanningError(
          "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_VERSION_EXHAUSTED",
          "The transformation model version range is exhausted.",
          { productId: expected.productId, priorVersion },
        );
      }
      const validationErrors = [{
        code: "PRODUCT_FAMILY_CONSOLIDATED",
        message: "Rebuild and review this transformation model against the canonical product family before activation.",
        context: {
          shopifyProductId: validated.externalProductId,
          canonicalProductId: validated.canonicalProductId,
          priorProductId: expected.productId,
          priorModelId: expected.draftModelId,
        },
      }];
      const definitionHash = sha256Json({
        contractVersion: 1,
        productId: expected.productId,
        buildToPromiseEnabled: false,
        paths: [],
        validationErrors,
      });
      const modelRequestHash = sha256Json({
        commandRequestHash: input.requestHash,
        productId: expected.productId,
        priorModelId: expected.draftModelId,
        definitionHash,
      });
      const operatorInputHash = sha256Json({
        shopifyProductId: validated.externalProductId,
        canonicalProductId: validated.canonicalProductId,
        sourceProductId: expected.productId,
        priorModelId: expected.draftModelId,
      });
      const insertedRows = rows(await input.client.execute(sql`
        INSERT INTO inventory.transformation_model_versions (
          product_id,
          version,
          lifecycle_status,
          build_to_promise_enabled,
          definition_hash,
          validation_state,
          validation_errors,
          supersedes_model_id,
          change_reason,
          idempotency_key,
          request_hash,
          origin,
          operator_input_hash,
          created_by,
          created_at,
          updated_at
        ) VALUES (
          ${expected.productId},
          ${priorVersion + 1},
          'draft',
          false,
          ${definitionHash},
          'invalid',
          ${JSON.stringify(validationErrors)}::jsonb,
          ${expected.draftModelId},
          ${supersessionReason},
          ${`shopify-consolidation:${input.idempotencyKey}:${expected.productId}`},
          ${modelRequestHash},
          'operator',
          ${operatorInputHash},
          ${validated.actor},
          ${input.occurredAt},
          ${input.occurredAt}
        )
        RETURNING id
      `));
      if (insertedRows.length !== 1) {
        throw new CatalogConsolidationInventoryPlanningError(
          "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_NOT_REPLACED",
          "The invalid replacement transformation draft was not recorded.",
          { productId: expected.productId, priorModelId: expected.draftModelId },
        );
      }
      const replacementModelId = positiveInteger(
        insertedRows[0].id,
        `product ${expected.productId} replacement transformation model id`,
      );
      const headRows = rows(await input.client.execute(sql`
        UPDATE inventory.transformation_model_heads
        SET draft_model_id = ${replacementModelId},
            revision = revision + 1,
            updated_by = ${validated.actor},
            update_reason = ${supersessionReason},
            updated_at = ${input.occurredAt}
        WHERE product_id = ${expected.productId}
          AND draft_model_id = ${expected.draftModelId}
          AND active_model_id IS NULL
        RETURNING product_id
      `));
      if (headRows.length !== 1) {
        throw new CatalogConsolidationInventoryPlanningError(
          "INVENTORY_PLANNING_CONSOLIDATION_DRAFT_STALE",
          "A transformation model head changed after consolidation review.",
          { productId: expected.productId, expectedDraftModelId: expected.draftModelId },
        );
      }
      invalidatedModelIds.push(expected.draftModelId);
      replacementModelIds.push(replacementModelId);
    }
    return Object.freeze({
      invalidatedModelIds: Object.freeze(invalidatedModelIds),
      replacementModelIds: Object.freeze(replacementModelIds),
    });
  }
}
