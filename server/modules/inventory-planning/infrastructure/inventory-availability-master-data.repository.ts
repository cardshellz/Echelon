import { createHash } from "node:crypto";
import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import {
  buildRecipeComponents,
  buildRecipes,
  idempotencyKeys,
  inventoryAvailabilityRuntimeAuthority,
  locationPromisePolicyHeads,
  locationPromisePolicyVersions,
  products,
  productVariants,
  promiseSafetyPolicyHeads,
  promiseSafetyPolicyVersions,
  transformationModelHeads,
  transformationModelPaths,
  transformationModelReviews,
  transformationModelVersions,
  transformationRecipeBindings,
  transformationRecipeComponentSnapshots,
  warehouseLocations,
} from "@shared/schema";
import type {
  InventoryPlanningProductOptionsQuery,
  InventoryPlanningProductOptionsResponse,
  SupplyTransformationsAdminView,
  TransformationAdminBinding,
  TransformationAdminModel,
  TransformationAdminPath,
  TransformationAdminRecipe,
} from "@shared/types/inventory-availability-admin";
import {
  createTransformationModelDraftResultSchema,
  supplyTransformationsAdminViewSchema,
  transformationAdminRecipeSchema,
} from "@shared/types/inventory-availability-admin";
import {
  inventoryAvailabilityBackfillReviewSchema,
} from "@shared/types/inventory-availability-backfill";

import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import type {
  InventoryAvailabilityMasterDataAdminStore,
  InventoryAvailabilityMasterDataReplay,
} from "../application/inventory-availability-master-data.service";
import {
  calculateLocationPromisePolicyDefinitionHash,
  calculatePromiseSafetyPolicyDefinitionHash,
  calculateTransformationModelDefinitionHash,
  InventoryAvailabilityMasterDataError,
  safetyPolicyScopeKey,
  type TransformationModelDefinition,
} from "../domain/inventory-availability-master-data.contracts";
import {
  planInventoryAvailabilityBackfill,
  calculateInventoryAvailabilityBackfillInputHash,
} from "../domain/inventory-availability-backfill";
import {
  loadInventoryAvailabilityBackfillSources,
} from "./inventory-availability-backfill.repository";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Transaction;

const LOCATION_POLICY_LOCK_NAMESPACE = 918421;
const TRANSFORMATION_MODEL_LOCK_NAMESPACE = 918422;
const SAFETY_POLICY_LOCK_NAMESPACE = 918423;
const MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE = 918420;
const DRAFT_UPDATE_RECEIPT_PREFIX = "inventory-availability:";

export class PostgresInventoryAvailabilityMasterDataStore
implements InventoryAvailabilityMasterDataAdminStore {
  constructor(private readonly database: typeof db = db) {}

  async findMasterDataDraftReplay(
    idempotencyKey: string,
  ): Promise<InventoryAvailabilityMasterDataReplay | null> {
    return findMasterDataReplay(this.database, idempotencyKey);
  }

  async listProductOptions(
    query: InventoryPlanningProductOptionsQuery,
  ): Promise<InventoryPlanningProductOptionsResponse["products"]> {
    const active = eq(products.isActive, true);
    const filter = query.q
      ? and(active, or(
          ilike(products.name, `%${query.q}%`),
          ilike(products.sku, `%${query.q}%`),
        ))
      : active;
    const rows = await this.database
      .select({ id: products.id, sku: products.sku, name: products.name })
      .from(products)
      .where(filter)
      .orderBy(asc(products.name), asc(products.id))
      .limit(query.limit);
    return rows;
  }

  async getSupplyTransformationsAdminView(
    productId: number,
  ): Promise<SupplyTransformationsAdminView | null> {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const [product] = await tx
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          isActive: products.isActive,
          inventoryStrategy: products.inventoryStrategy,
        })
        .from(products)
        .where(eq(products.id, productId))
        .limit(1);
      if (!product) return null;

      const variants = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          name: productVariants.name,
          unitsPerVariant: productVariants.unitsPerVariant,
          uomType: productVariants.uomType,
          isActive: productVariants.isActive,
          salesEligibility: productVariants.salesEligibility,
        })
        .from(productVariants)
        .where(and(
          eq(productVariants.productId, productId),
          eq(productVariants.requiresShipping, true),
          sql`COALESCE(${productVariants.trackInventory}, true) = true`,
        ))
        .orderBy(
          asc(productVariants.unitsPerVariant),
          asc(productVariants.hierarchyLevel),
          asc(productVariants.id),
        );
      const recipes = await loadAdminRecipes(tx, productId);
      const [head] = await tx
        .select()
        .from(transformationModelHeads)
        .where(eq(transformationModelHeads.productId, productId))
        .limit(1);
      const activeModel = head?.activeModelId
        ? await loadTransformationModel(tx, head.activeModelId)
        : null;
      const draftModel = head?.draftModelId
        ? await loadTransformationModel(tx, head.draftModelId)
        : null;

      const [runtime] = await tx.select().from(inventoryAvailabilityRuntimeAuthority)
        .where(eq(inventoryAvailabilityRuntimeAuthority.singletonKey, true)).limit(1);
      return supplyTransformationsAdminViewSchema.parse({
        product: {
          id: product.id,
          sku: product.sku,
          name: product.name,
          isActive: product.isActive,
          legacyInventoryStrategy: product.inventoryStrategy,
        },
        variants,
        recipes,
        head: head
          ? {
              revision: head.revision.toString(),
              activeModelId: head.activeModelId,
              draftModelId: head.draftModelId,
            }
          : null,
        activeModel,
        draftModel,
        runtimeSelection: runtime ? {
          authority: runtime.authority,
          revision: runtime.revision.toString(),
          activationRunId: runtime.activationRunId?.toString() ?? null,
        } : null,
        runtimeAuthority: {
          kind: "legacy_inventory_strategy",
          value: product.inventoryStrategy,
          draftAffectsRuntime: false,
        },
      });
    });
  }

  async createTransformationModelDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createTransformationModelDraft"]
    >[0],
  ) {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      const productId = command.definition.productId;
      await lockIdempotencyKey(tx, command.idempotencyKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(${TRANSFORMATION_MODEL_LOCK_NAMESPACE}, ${productId})
      `);
      await assertIdempotencyKeyUnusedByOtherType(
        tx,
        command.idempotencyKey,
        "transformation_model",
      );

      const replay = await findTransformationReplay(tx, command.idempotencyKey);
      if (replay) {
        assertReplayHash(replay.requestHash, command.requestHash);
        return {
          modelId: replay.id,
          version: replay.version,
          definitionHash: replay.definitionHash,
          alreadyApplied: true,
        };
      }

      // All transformation writers lock owner state before catalog/BOM references.
      // This makes stale checks authoritative even for writers that do not use our advisory lock.
      const [head] = await tx
        .select()
        .from(transformationModelHeads)
        .where(eq(transformationModelHeads.productId, productId))
        .limit(1)
        .for("update");
      if (head?.draftModelId) {
        throw draftExists("transformation model", String(productId));
      }
      if (command.backfillEvidence) {
        const [source] = await loadInventoryAvailabilityBackfillSources(tx, [productId]);
        if (!source) {
          throw new InventoryAvailabilityMasterDataError(
            409,
            "INVENTORY_AVAILABILITY_BACKFILL_SOURCE_CHANGED",
            "The active product is no longer eligible for deterministic backfill.",
          );
        }
        const currentCandidate = planInventoryAvailabilityBackfill(source);
        if (
          currentCandidate.inputHash !== command.backfillEvidence.inputHash
          || currentCandidate.resultHash !== command.backfillEvidence.resultHash
          || !currentCandidate.definition
          || currentCandidate.definitionHash
            !== calculateTransformationModelDefinitionHash(command.definition)
        ) {
          throw new InventoryAvailabilityMasterDataError(
            409,
            "INVENTORY_AVAILABILITY_BACKFILL_PREVIEW_STALE",
            "The product, variants, recipes, or generated draft changed after preview.",
          );
        }
      }
      await assertTransformationReferences(tx, command.definition);
      const previous = await latestTransformationModel(tx, productId);
      const operatorInputHash = command.backfillEvidence ? null
        : await captureOperatorInputHash(tx, productId);
      const version = (previous?.version ?? 0) + 1;
      const definitionHash = calculateTransformationModelDefinitionHash(command.definition);
      const [created] = await tx
        .insert(transformationModelVersions)
        .values({
          productId,
          version,
          lifecycleStatus: "draft",
          buildToPromiseEnabled: command.definition.buildToPromiseEnabled,
          definitionHash,
          validationState: "invalid",
          validationErrors: [{ code: "members_pending" }],
          supersedesModelId: previous?.id ?? null,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          origin: command.backfillEvidence ? "phase3_backfill" : "operator",
          originInputHash: command.backfillEvidence?.inputHash ?? null,
          originResultHash: command.backfillEvidence?.resultHash ?? null,
          operatorInputHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        })
        .returning({ id: transformationModelVersions.id });

      await replaceTransformationMembers(tx, created.id, command.definition, command.occurredAt);

      await tx
        .update(transformationModelVersions)
        .set({
          validationState: "valid",
          validationErrors: [],
          definitionHash,
          updatedAt: command.occurredAt,
        })
        .where(eq(transformationModelVersions.id, created.id));
      await pointTransformationDraftHead(tx, {
        productId,
        modelId: created.id,
        actorId: command.actorId,
        changeReason: command.changeReason,
        occurredAt: command.occurredAt,
        headExists: Boolean(head),
      });
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.transformation_model.draft_created",
        target: `inventory.transformation_model:${created.id}`,
        changes: {
          before: previous ? { modelId: previous.id, version: previous.version } : null,
          after: {
            modelId: created.id,
            productId,
            version,
            definitionHash,
            validationState: "valid",
          },
        },
        context: {
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          origin: command.backfillEvidence ? "phase3_backfill" : "operator",
          originInputHash: command.backfillEvidence?.inputHash ?? null,
          originResultHash: command.backfillEvidence?.resultHash ?? null,
          runtimeAuthorityChanged: false,
        },
      }, {
        timestamp: command.occurredAt,
        emitStructuredLog: false,
      });
      return {
        modelId: created.id,
        version,
        definitionHash,
        alreadyApplied: false,
      };
    });
  }

  async updateTransformationModelDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["updateTransformationModelDraft"]
    >[0],
  ) {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      // Keep the public edit receipt separate from the successor's creation key.
      const successorKey = `manual-revision:${createHash("sha256")
        .update(`manual-revision:${command.idempotencyKey}`).digest("hex")}`;
      await lockIdempotencyKey(tx, command.idempotencyKey);
      await lockIdempotencyKey(tx, successorKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${TRANSFORMATION_MODEL_LOCK_NAMESPACE},
          ${command.productId}
        )
      `);
      await assertIdempotencyKeyUnusedByOtherType(
        tx,
        command.idempotencyKey,
        "transformation_model_draft_update",
      );
      const replay = await findDraftUpdateReplay(tx, command.idempotencyKey);
      if (replay) {
        assertReplayHash(replay.requestHash, command.requestHash);
        return { ...replay.result, alreadyApplied: true };
      }
      await tx.insert(idempotencyKeys).values({
        key: draftUpdateReceiptKey(command.idempotencyKey),
        requestHash: command.requestHash,
        responseBody: null,
        createdAt: command.occurredAt,
        expiresAt: null,
      });

      const [head] = await tx
        .select()
        .from(transformationModelHeads)
        .where(eq(transformationModelHeads.productId, command.productId))
        .limit(1)
        .for("update");
      const modelResult = await tx.execute(sql`
        SELECT id, product_id, version, lifecycle_status, definition_hash
        FROM inventory.transformation_model_versions
        WHERE id = ${command.draftModelId}
        FOR UPDATE
      `);
      const model = modelResult.rows[0];
      if (
        !head
        || head.draftModelId !== command.draftModelId
        || head.revision.toString() !== command.expectedHeadRevision
        || !model
        || Number(model.product_id) !== command.productId
        || Number(model.version) !== command.expectedVersion
        || String(model.lifecycle_status) !== "draft"
        || String(model.definition_hash) !== command.expectedDefinitionHash
      ) {
        throw staleDraft();
      }

      await assertTransformationReferences(tx, command.definition);
      const before = await loadTransformationModel(tx, command.draftModelId);
      if (!before) throw staleDraft();
      const definitionHash = calculateTransformationModelDefinitionHash(command.definition);
      const operatorInputHash = await captureOperatorInputHash(tx, command.productId);
      if (command.expectedVersion >= 2_147_483_647) {
        throw new InventoryAvailabilityMasterDataError(409,
          "INVENTORY_AVAILABILITY_MODEL_VERSION_EXHAUSTED", "The transformation model version range is exhausted.");
      }
      await assertIdempotencyKeyUnusedByOtherType(tx, successorKey, "transformation_model");
      await tx.update(transformationModelVersions).set({
        lifecycleStatus: "superseded", supersededBy: command.actorId,
        supersededAt: command.occurredAt, supersessionReason: command.changeReason,
        updatedAt: command.occurredAt,
      }).where(eq(transformationModelVersions.id, command.draftModelId));
      const version = command.expectedVersion + 1;
      const [created] = await tx.insert(transformationModelVersions).values({
        productId: command.productId, version, lifecycleStatus: "draft",
        buildToPromiseEnabled: command.definition.buildToPromiseEnabled,
        definitionHash, validationState: "invalid", validationErrors: [{ code: "members_pending" }],
        supersedesModelId: command.draftModelId, changeReason: command.changeReason,
        idempotencyKey: successorKey, requestHash: command.requestHash,
        origin: "operator", operatorInputHash, createdBy: command.actorId,
        createdAt: command.occurredAt, updatedAt: command.occurredAt,
      }).returning({ id: transformationModelVersions.id });
      await replaceTransformationMembers(tx, created.id, command.definition, command.occurredAt);
      await tx.update(transformationModelVersions).set({
        validationState: "valid", validationErrors: [], definitionHash, updatedAt: command.occurredAt,
      }).where(eq(transformationModelVersions.id, created.id));
      await pointTransformationDraftHead(tx, { productId: command.productId, modelId: created.id,
        actorId: command.actorId, changeReason: command.changeReason,
        occurredAt: command.occurredAt, headExists: true });
      const after = await loadTransformationModel(tx, created.id);
      if (!after) throw staleDraft();
      const result = {
        modelId: created.id,
        version,
        definitionHash,
        alreadyApplied: false,
      };
      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.transformation_model.draft_updated",
        target: `inventory.transformation_model:${created.id}`,
        changes: { before, after },
        context: {
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          previousHeadRevision: command.expectedHeadRevision,
          supersededModelId: command.draftModelId,
          operatorInputHash,
          nextHeadRevision: (BigInt(command.expectedHeadRevision) + BigInt(1)).toString(),
          runtimeAuthorityChanged: false,
        },
      }, {
        timestamp: command.occurredAt,
        emitStructuredLog: false,
      });
      await tx
        .update(idempotencyKeys)
        .set({
          responseBody: {
            commandType: "transformation_model_draft_update",
            result,
          },
        })
        .where(eq(idempotencyKeys.key, draftUpdateReceiptKey(command.idempotencyKey)));
      return result;
    });
  }

  async supersedeTransformationModelBackfillDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["supersedeTransformationModelBackfillDraft"]
    >[0],
  ) {
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await lockIdempotencyKey(tx, command.idempotencyKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${TRANSFORMATION_MODEL_LOCK_NAMESPACE},
          ${command.productId}
        )
      `);
      await assertIdempotencyKeyUnusedByOtherType(
        tx,
        command.idempotencyKey,
        "transformation_model",
      );

      const replay = await findTransformationReplay(tx, command.idempotencyKey);
      if (replay) {
        assertReplayHash(replay.requestHash, command.requestHash);
        if (replay.supersedesModelId !== command.draftModelId) {
          throw new InventoryAvailabilityMasterDataError(
            500,
            "INVENTORY_AVAILABILITY_IDEMPOTENCY_STATE_INVALID",
            "The backfill-refresh receipt does not reference the expected superseded draft.",
          );
        }
        return {
          modelId: replay.id,
          version: replay.version,
          definitionHash: replay.definitionHash,
          supersededModelId: replay.supersedesModelId,
          alreadyApplied: true,
        };
      }

      const [head] = await tx
        .select()
        .from(transformationModelHeads)
        .where(eq(transformationModelHeads.productId, command.productId))
        .limit(1)
        .for("update");
      const modelResult = await tx.execute(sql`
        SELECT id, product_id, version, lifecycle_status, definition_hash,
               origin, origin_input_hash, origin_result_hash
        FROM inventory.transformation_model_versions
        WHERE id = ${command.draftModelId}
        FOR UPDATE
      `);
      const model = modelResult.rows[0];
      if (
        !head
        || head.draftModelId !== command.draftModelId
        || head.revision.toString() !== command.expectedDraftHeadRevision
        || !model
        || Number(model.product_id) !== command.productId
        || Number(model.version) !== command.expectedDraftVersion
        || String(model.lifecycle_status) !== "draft"
        || String(model.definition_hash) !== command.expectedDraftDefinitionHash
        || String(model.origin) !== "phase3_backfill"
        || String(model.origin_input_hash) !== command.expectedDraftOriginInputHash
        || String(model.origin_result_hash) !== command.expectedDraftOriginResultHash
      ) {
        throw staleDraft();
      }

      const [source] = await loadInventoryAvailabilityBackfillSources(tx, [command.productId]);
      if (!source) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_BACKFILL_SOURCE_CHANGED",
          "The active product is no longer eligible for deterministic backfill.",
        );
      }
      const currentCandidate = planInventoryAvailabilityBackfill(source);
      const definitionHash = calculateTransformationModelDefinitionHash(command.definition);
      if (
        currentCandidate.inputHash !== command.backfillEvidence.inputHash
        || currentCandidate.resultHash !== command.backfillEvidence.resultHash
        || !currentCandidate.definition
        || currentCandidate.definitionHash !== definitionHash
      ) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_BACKFILL_PREVIEW_STALE",
          "The product, variants, recipes, or generated draft changed after preview.",
        );
      }
      if (
        String(model.definition_hash) === definitionHash
        && String(model.origin_input_hash) === command.backfillEvidence.inputHash
        && String(model.origin_result_hash) === command.backfillEvidence.resultHash
      ) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_BACKFILL_DRAFT_CURRENT",
          "The current Phase 3 draft already has the requested deterministic provenance.",
        );
      }

      await assertTransformationReferences(tx, command.definition);
      const before = await loadTransformationModel(tx, command.draftModelId);
      if (!before) throw staleDraft();

      await tx
        .update(transformationModelVersions)
        .set({
          lifecycleStatus: "superseded",
          supersededBy: command.actorId,
          supersededAt: command.occurredAt,
          supersessionReason: command.changeReason,
          updatedAt: command.occurredAt,
        })
        .where(eq(transformationModelVersions.id, command.draftModelId));

      if (command.expectedDraftVersion >= 2_147_483_647) {
        throw new InventoryAvailabilityMasterDataError(
          409,
          "INVENTORY_AVAILABILITY_MODEL_VERSION_EXHAUSTED",
          "The transformation model has exhausted the PostgreSQL version range.",
        );
      }
      const version = command.expectedDraftVersion + 1;
      const [created] = await tx
        .insert(transformationModelVersions)
        .values({
          productId: command.productId,
          version,
          lifecycleStatus: "draft",
          buildToPromiseEnabled: command.definition.buildToPromiseEnabled,
          definitionHash,
          validationState: "invalid",
          validationErrors: [{ code: "members_pending" }],
          supersedesModelId: command.draftModelId,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          origin: "phase3_backfill",
          originInputHash: command.backfillEvidence.inputHash,
          originResultHash: command.backfillEvidence.resultHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        })
        .returning({ id: transformationModelVersions.id });
      await replaceTransformationMembers(tx, created.id, command.definition, command.occurredAt);
      await tx
        .update(transformationModelVersions)
        .set({
          validationState: "valid",
          validationErrors: [],
          definitionHash,
          updatedAt: command.occurredAt,
        })
        .where(eq(transformationModelVersions.id, created.id));
      await pointTransformationDraftHead(tx, {
        productId: command.productId,
        modelId: created.id,
        actorId: command.actorId,
        changeReason: command.changeReason,
        occurredAt: command.occurredAt,
        headExists: true,
      });
      const after = await loadTransformationModel(tx, created.id);
      if (!after) throw staleDraft();

      await persistAuditEvent(tx, {
        actor: command.actorId,
        action: "inventory_availability.transformation_model.backfill_refreshed",
        target: `inventory.transformation_model:${created.id}`,
        changes: {
          before,
          after,
        },
        context: {
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          supersededModelId: command.draftModelId,
          previousHeadRevision: command.expectedDraftHeadRevision,
          nextHeadRevision: (BigInt(command.expectedDraftHeadRevision) + BigInt(1)).toString(),
          previousOriginInputHash: command.expectedDraftOriginInputHash,
          previousOriginResultHash: command.expectedDraftOriginResultHash,
          originInputHash: command.backfillEvidence.inputHash,
          originResultHash: command.backfillEvidence.resultHash,
          runtimeAuthorityChanged: false,
        },
      }, {
        timestamp: command.occurredAt,
        emitStructuredLog: false,
      });
      return {
        modelId: created.id,
        version,
        definitionHash,
        supersededModelId: command.draftModelId,
        alreadyApplied: false,
      };
    });
  }

  async createLocationPromisePolicyDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createLocationPromisePolicyDraft"]
    >[0],
  ) {
    return this.database.transaction(async (tx) => {
      await lockIdempotencyKey(tx, command.idempotencyKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${LOCATION_POLICY_LOCK_NAMESPACE},
          ${command.warehouseLocationId}
        )
      `);
      await assertIdempotencyKeyUnusedByOtherType(
        tx,
        command.idempotencyKey,
        "location_promise_policy",
      );
      const [location] = await tx
        .select({ id: warehouseLocations.id })
        .from(warehouseLocations)
        .where(eq(warehouseLocations.id, command.warehouseLocationId))
        .limit(1);
      if (!location) throw invalidReference("The warehouse location does not exist.");

      const [replay] = await tx
        .select({
          id: locationPromisePolicyVersions.id,
          version: locationPromisePolicyVersions.version,
          requestHash: locationPromisePolicyVersions.requestHash,
        })
        .from(locationPromisePolicyVersions)
        .where(eq(locationPromisePolicyVersions.idempotencyKey, command.idempotencyKey))
        .limit(1);
      if (replay) {
        assertReplayHash(replay.requestHash, command.requestHash);
        return { policyId: replay.id, version: replay.version, alreadyApplied: true };
      }
      const [head] = await tx
        .select()
        .from(locationPromisePolicyHeads)
        .where(eq(locationPromisePolicyHeads.warehouseLocationId, command.warehouseLocationId))
        .limit(1);
      if (head?.draftPolicyId) {
        throw draftExists("location promise policy", String(command.warehouseLocationId));
      }
      const [previous] = await tx
        .select({
          id: locationPromisePolicyVersions.id,
          version: locationPromisePolicyVersions.version,
        })
        .from(locationPromisePolicyVersions)
        .where(eq(locationPromisePolicyVersions.warehouseLocationId, command.warehouseLocationId))
        .orderBy(desc(locationPromisePolicyVersions.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      const definitionHash = calculateLocationPromisePolicyDefinitionHash({
        warehouseLocationId: command.warehouseLocationId,
        eligibilityMode: command.eligibilityMode,
      });
      const [created] = await tx
        .insert(locationPromisePolicyVersions)
        .values({
          warehouseLocationId: command.warehouseLocationId,
          version,
          lifecycleStatus: "draft",
          eligibilityMode: command.eligibilityMode,
          definitionHash,
          supersedesPolicyId: previous?.id ?? null,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        })
        .returning({ id: locationPromisePolicyVersions.id });
      if (head) {
        await tx
          .update(locationPromisePolicyHeads)
          .set({
            draftPolicyId: created.id,
            revision: sql`${locationPromisePolicyHeads.revision} + 1`,
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          })
          .where(eq(locationPromisePolicyHeads.warehouseLocationId, command.warehouseLocationId));
      } else {
        await tx.insert(locationPromisePolicyHeads).values({
          warehouseLocationId: command.warehouseLocationId,
          activePolicyId: null,
          draftPolicyId: created.id,
          revision: BigInt(0),
          updatedBy: command.actorId,
          updateReason: command.changeReason,
          updatedAt: command.occurredAt,
        });
      }
      await persistDraftAudit(tx, command, {
        action: "inventory_availability.location_promise_policy.draft_created",
        target: `inventory.location_promise_policy:${created.id}`,
        owner: { warehouseLocationId: command.warehouseLocationId },
        createdId: created.id,
        version,
        definitionHash,
        previous,
      });
      return { policyId: created.id, version, alreadyApplied: false };
    });
  }

  async createPromiseSafetyPolicyDraft(
    command: Parameters<
      InventoryAvailabilityMasterDataAdminStore["createPromiseSafetyPolicyDraft"]
    >[0],
  ) {
    return this.database.transaction(async (tx) => {
      const scopeKey = safetyPolicyScopeKey(command.scope);
      await lockIdempotencyKey(tx, command.idempotencyKey);
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ${SAFETY_POLICY_LOCK_NAMESPACE},
          hashtext(${scopeKey})
        )
      `);
      await assertIdempotencyKeyUnusedByOtherType(
        tx,
        command.idempotencyKey,
        "promise_safety_policy",
      );
      const [replay] = await tx
        .select({
          id: promiseSafetyPolicyVersions.id,
          version: promiseSafetyPolicyVersions.version,
          scopeKey: promiseSafetyPolicyVersions.scopeKey,
          definitionHash: promiseSafetyPolicyVersions.definitionHash,
          requestHash: promiseSafetyPolicyVersions.requestHash,
        })
        .from(promiseSafetyPolicyVersions)
        .where(eq(promiseSafetyPolicyVersions.idempotencyKey, command.idempotencyKey))
        .limit(1);
      if (replay) {
        assertReplayHash(replay.requestHash, command.requestHash);
        return {
          policyId: replay.id,
          version: replay.version,
          scopeKey: replay.scopeKey,
          definitionHash: replay.definitionHash,
          alreadyApplied: true,
        };
      }
      const [head] = await tx
        .select()
        .from(promiseSafetyPolicyHeads)
        .where(eq(promiseSafetyPolicyHeads.scopeKey, scopeKey))
        .limit(1);
      if (head?.draftPolicyId) throw draftExists("promise safety policy", scopeKey);
      const [previous] = await tx
        .select({
          id: promiseSafetyPolicyVersions.id,
          version: promiseSafetyPolicyVersions.version,
        })
        .from(promiseSafetyPolicyVersions)
        .where(eq(promiseSafetyPolicyVersions.scopeKey, scopeKey))
        .orderBy(desc(promiseSafetyPolicyVersions.version))
        .limit(1);
      const version = (previous?.version ?? 0) + 1;
      const definitionHash = calculatePromiseSafetyPolicyDefinitionHash({
        scope: command.scope,
        value: command.value,
      });
      const [created] = await tx
        .insert(promiseSafetyPolicyVersions)
        .values({
          scopeKey,
          scopeType: command.scope.scopeType,
          productVariantId: command.scope.scopeType === "business"
            ? null
            : command.scope.productVariantId,
          warehouseId: command.scope.scopeType === "warehouse_variant"
            ? command.scope.warehouseId
            : null,
          version,
          lifecycleStatus: "draft",
          ...safetyPolicyColumns(command.value),
          definitionHash,
          supersedesPolicyId: previous?.id ?? null,
          changeReason: command.changeReason,
          idempotencyKey: command.idempotencyKey,
          requestHash: command.requestHash,
          createdBy: command.actorId,
          createdAt: command.occurredAt,
          updatedAt: command.occurredAt,
        })
        .returning({ id: promiseSafetyPolicyVersions.id });
      if (head) {
        await tx
          .update(promiseSafetyPolicyHeads)
          .set({
            draftPolicyId: created.id,
            revision: sql`${promiseSafetyPolicyHeads.revision} + 1`,
            updatedBy: command.actorId,
            updateReason: command.changeReason,
            updatedAt: command.occurredAt,
          })
          .where(eq(promiseSafetyPolicyHeads.scopeKey, scopeKey));
      } else {
        await tx.insert(promiseSafetyPolicyHeads).values({
          scopeKey,
          activePolicyId: null,
          draftPolicyId: created.id,
          revision: BigInt(0),
          updatedBy: command.actorId,
          updateReason: command.changeReason,
          updatedAt: command.occurredAt,
        });
      }
      await persistDraftAudit(tx, command, {
        action: "inventory_availability.promise_safety_policy.draft_created",
        target: `inventory.promise_safety_policy:${created.id}`,
        owner: { scopeKey },
        createdId: created.id,
        version,
        definitionHash,
        previous,
      });
      return {
        policyId: created.id,
        version,
        scopeKey,
        definitionHash,
        alreadyApplied: false,
      };
    });
  }
}

async function replaceTransformationMembers(
  tx: Transaction,
  modelId: number,
  definition: TransformationModelDefinition,
  occurredAt: Date,
): Promise<void> {
  const bindingIds = new Map<string, number>();
  for (const binding of definition.recipeBindings) {
    const [createdBinding] = await tx
      .insert(transformationRecipeBindings)
      .values({
        modelId,
        recipeId: binding.recipeId,
        relationshipRole: binding.relationshipRole,
        warehouseId: binding.warehouseId,
        recipeCodeSnapshot: binding.recipeCodeSnapshot,
        recipeVersionSnapshot: binding.recipeVersionSnapshot,
        recipeDefinitionHash: binding.recipeDefinitionHash,
        outputProductIdSnapshot: binding.outputProductIdSnapshot,
        outputVariantIdSnapshot: binding.outputVariantIdSnapshot,
        outputUnitsPerVariantSnapshot: binding.outputUnitsPerVariantSnapshot,
        outputQtySnapshot: binding.outputQtySnapshot,
        validationState: "valid",
        validationErrors: [],
        createdAt: occurredAt,
      })
      .returning({ id: transformationRecipeBindings.id });
    bindingIds.set(binding.bindingKey, createdBinding.id);
    await tx.insert(transformationRecipeComponentSnapshots).values(
      binding.components.map((component) => ({
        transformationRecipeBindingId: createdBinding.id,
        modelId,
        componentVariantId: component.componentVariantId,
        componentProductId: component.componentProductId,
        componentUnitsPerVariant: component.componentUnitsPerVariant,
        componentQty: component.componentQty,
        createdAt: occurredAt,
      })),
    );
  }
  if (definition.paths.length > 0) {
    await tx.insert(transformationModelPaths).values(
      definition.paths.map((path) => ({
        modelId,
        sourceVariantId: path.sourceVariantId,
        destinationVariantId: path.destinationVariantId,
        inputQty: path.inputQty,
        outputQty: path.outputQty,
        sourceUnitsPerVariant: path.sourceUnitsPerVariant,
        destinationUnitsPerVariant: path.destinationUnitsPerVariant,
        operationType: path.operationType,
        authorityState: path.authorityState,
        transformationRecipeBindingId: path.transformationRecipeBindingKey === null
          ? null
          : requireBindingId(bindingIds, path.transformationRecipeBindingKey),
        validationState: "valid",
        validationErrors: [],
        createdAt: occurredAt,
      })),
    );
  }
}

async function loadAdminRecipes(
  executor: Executor,
  productId: number,
): Promise<TransformationAdminRecipe[]> {
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
      eq(buildRecipes.outputProductId, productId),
      eq(buildRecipes.status, "active"),
    ))
    .orderBy(asc(buildRecipes.code), desc(buildRecipes.version), asc(buildRecipes.id));
  if (recipeRows.length === 0) return [];

  const componentRows = await executor
    .select({
      recipeId: buildRecipeComponents.recipeId,
      componentVariantId: buildRecipeComponents.componentVariantId,
      componentProductId: buildRecipeComponents.componentProductId,
      componentUnitsPerVariant: buildRecipeComponents.componentUnitsPerVariant,
      componentQty: buildRecipeComponents.qty,
      sku: productVariants.sku,
      name: productVariants.name,
      isActive: productVariants.isActive,
    })
    .from(buildRecipeComponents)
    .innerJoin(productVariants, eq(productVariants.id, buildRecipeComponents.componentVariantId))
    .where(inArray(buildRecipeComponents.recipeId, recipeRows.map((recipe) => recipe.id)))
    .orderBy(
      asc(buildRecipeComponents.recipeId),
      asc(productVariants.sku),
      asc(productVariants.id),
    );
  const componentsByRecipe = new Map<number, TransformationAdminRecipe["components"]>();
  for (const component of componentRows) {
    const components = componentsByRecipe.get(component.recipeId) ?? [];
    components.push({
      componentVariantId: component.componentVariantId,
      componentProductId: component.componentProductId,
      componentUnitsPerVariant: component.componentUnitsPerVariant,
      componentQty: component.componentQty,
      sku: component.sku,
      name: component.name,
      isActive: component.isActive,
    });
    componentsByRecipe.set(component.recipeId, components);
  }
  return recipeRows.map((recipe) => transformationAdminRecipeSchema.parse({
    ...recipe,
    components: componentsByRecipe.get(recipe.id) ?? [],
  }));
}

async function loadTransformationModel(
  executor: Executor,
  modelId: number,
): Promise<TransformationAdminModel | null> {
  const [model] = await executor
    .select()
    .from(transformationModelVersions)
    .where(eq(transformationModelVersions.id, modelId))
    .limit(1);
  if (!model) return null;
  const bindingRows = await executor
    .select()
    .from(transformationRecipeBindings)
    .where(eq(transformationRecipeBindings.modelId, modelId))
    .orderBy(
      asc(transformationRecipeBindings.recipeId),
      asc(transformationRecipeBindings.warehouseId),
      asc(transformationRecipeBindings.id),
    );
  const componentRows = await executor
    .select()
    .from(transformationRecipeComponentSnapshots)
    .where(eq(transformationRecipeComponentSnapshots.modelId, modelId))
    .orderBy(
      asc(transformationRecipeComponentSnapshots.transformationRecipeBindingId),
      asc(transformationRecipeComponentSnapshots.componentVariantId),
      asc(transformationRecipeComponentSnapshots.id),
    );
  const componentsByBinding = new Map<number, TransformationAdminBinding["components"]>();
  for (const component of componentRows) {
    const components = componentsByBinding.get(component.transformationRecipeBindingId) ?? [];
    components.push({
      componentVariantId: component.componentVariantId,
      componentProductId: component.componentProductId,
      componentUnitsPerVariant: component.componentUnitsPerVariant,
      componentQty: component.componentQty,
    });
    componentsByBinding.set(component.transformationRecipeBindingId, components);
  }
  const bindingKeyById = new Map<number, string>();
  const bindings: TransformationAdminBinding[] = bindingRows.map((binding) => {
    const bindingKey = recipeBindingKey(binding.recipeId, binding.warehouseId);
    bindingKeyById.set(binding.id, bindingKey);
    return {
      bindingKey,
      recipeId: binding.recipeId,
      relationshipRole: binding.relationshipRole as TransformationAdminBinding["relationshipRole"],
      warehouseId: binding.warehouseId,
      recipeCodeSnapshot: binding.recipeCodeSnapshot,
      recipeVersionSnapshot: binding.recipeVersionSnapshot,
      recipeDefinitionHash: binding.recipeDefinitionHash,
      outputProductIdSnapshot: binding.outputProductIdSnapshot,
      outputVariantIdSnapshot: binding.outputVariantIdSnapshot,
      outputUnitsPerVariantSnapshot: binding.outputUnitsPerVariantSnapshot,
      outputQtySnapshot: binding.outputQtySnapshot,
      components: componentsByBinding.get(binding.id) ?? [],
    };
  });
  const pathRows = await executor
    .select()
    .from(transformationModelPaths)
    .where(eq(transformationModelPaths.modelId, modelId))
    .orderBy(
      asc(transformationModelPaths.destinationVariantId),
      asc(transformationModelPaths.sourceVariantId),
      asc(transformationModelPaths.operationType),
    );
  const paths: TransformationAdminPath[] = pathRows.map((path) => ({
    sourceVariantId: path.sourceVariantId,
    destinationVariantId: path.destinationVariantId,
    inputQty: path.inputQty,
    outputQty: path.outputQty,
    sourceUnitsPerVariant: path.sourceUnitsPerVariant,
    destinationUnitsPerVariant: path.destinationUnitsPerVariant,
    operationType: path.operationType as TransformationAdminPath["operationType"],
    authorityState: path.authorityState as TransformationAdminPath["authorityState"],
    transformationRecipeBindingKey: path.transformationRecipeBindingId === null
      ? null
      : bindingKeyById.get(path.transformationRecipeBindingId) ?? null,
  }));
  return {
    id: model.id,
    productId: model.productId,
    version: model.version,
    lifecycleStatus: model.lifecycleStatus as TransformationAdminModel["lifecycleStatus"],
    buildToPromiseEnabled: model.buildToPromiseEnabled,
    definitionHash: model.definitionHash,
    origin: model.origin as TransformationAdminModel["origin"],
    originInputHash: model.originInputHash,
    originResultHash: model.originResultHash,
    operatorInputHash: model.operatorInputHash,
    validationState: model.validationState as TransformationAdminModel["validationState"],
    validationErrors: Array.isArray(model.validationErrors) ? model.validationErrors : [],
    changeReason: model.changeReason,
    createdBy: model.createdBy,
    createdAt: model.createdAt.toISOString(),
    updatedAt: model.updatedAt.toISOString(),
    bindings,
    paths,
  };
}

async function assertTransformationReferences(
  tx: Transaction,
  definition: TransformationModelDefinition,
): Promise<void> {
  // Deadlock-safe order shared with catalog writers: owner state first.
  // Reference lock order: products -> product variants -> recipes -> recipe components.
  // Rows within each reference class are locked by ascending stable identifier.
  // FOR SHARE blocks lifecycle and BOM updates. Recipe editors lock recipes first,
  // but request only compatible SHARE locks on variants/products, so they can
  // finish and release the recipe before this transaction validates its snapshot.
  const product = await tx.execute(sql`
    SELECT id, is_active
    FROM catalog.products
    WHERE id = ${definition.productId}
    FOR SHARE
  `);
  const productRow = product.rows[0];
  if (
    !productRow
    || !(productRow.is_active === true || Number(productRow.is_active) === 1)
  ) {
    throw invalidReference(
      `Product ${definition.productId} changed or is inactive; reload before saving.`,
    );
  }

  const expectedVariants = new Map<number, { productId: number; unitsPerVariant: number }>();
  for (const path of definition.paths) {
    expectedVariants.set(path.sourceVariantId, {
      productId: path.sourceProductId,
      unitsPerVariant: path.sourceUnitsPerVariant,
    });
    expectedVariants.set(path.destinationVariantId, {
      productId: path.destinationProductId,
      unitsPerVariant: path.destinationUnitsPerVariant,
    });
  }
  for (const binding of definition.recipeBindings) {
    expectedVariants.set(binding.outputVariantIdSnapshot, {
      productId: binding.outputProductIdSnapshot,
      unitsPerVariant: binding.outputUnitsPerVariantSnapshot,
    });
    for (const component of binding.components) {
      expectedVariants.set(component.componentVariantId, {
        productId: component.componentProductId,
        unitsPerVariant: component.componentUnitsPerVariant,
      });
    }
  }
  const variantIds = [...expectedVariants.keys()].sort((left, right) => left - right);
  if (variantIds.length > 0) {
    const rows = await tx.execute(sql`
      SELECT id, product_id, units_per_variant, is_active, requires_shipping, track_inventory
      FROM catalog.product_variants
      WHERE id IN (${sql.join(variantIds.map((id) => sql`${id}`), sql`, `)})
      ORDER BY id
      FOR SHARE
    `);
    const actual = new Map(rows.rows.map((row) => [Number(row.id), row]));
    for (const [variantId, expected] of expectedVariants) {
      const row = actual.get(variantId);
      if (
        !row
        || Number(row.product_id) !== expected.productId
        || Number(row.units_per_variant) !== expected.unitsPerVariant
        || !(row.is_active === true || Number(row.is_active) === 1)
        || row.requires_shipping !== true
        || row.track_inventory === false
      ) {
        throw invalidReference(
          `Variant ${variantId} changed or is inactive; reload before saving.`,
        );
      }
    }
  }

  const recipeIds = definition.recipeBindings
    .map((binding) => binding.recipeId)
    .sort((left, right) => left - right);
  if (recipeIds.length === 0) return;
  const recipeRows = await tx.execute(sql`
    SELECT id, code, version, status, output_product_id, output_variant_id,
           output_units_per_variant, output_qty
    FROM inventory.build_recipes
    WHERE id IN (${sql.join(recipeIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY id
    FOR SHARE
  `);
  const componentRows = await tx.execute(sql`
    SELECT recipe_id, component_variant_id, component_product_id,
           component_units_per_variant, qty
    FROM inventory.build_recipe_components
    WHERE recipe_id IN (${sql.join(recipeIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY recipe_id, component_variant_id
    FOR SHARE
  `);
  const recipeById = new Map(recipeRows.rows.map((row) => [Number(row.id), row]));
  const componentsByRecipe = new Map<number, typeof componentRows.rows>();
  for (const row of componentRows.rows) {
    const recipeId = Number(row.recipe_id);
    const components = componentsByRecipe.get(recipeId) ?? [];
    components.push(row);
    componentsByRecipe.set(recipeId, components);
  }
  for (const binding of definition.recipeBindings) {
    const row = recipeById.get(binding.recipeId);
    if (
      !row
      || String(row.status) !== "active"
      || String(row.code) !== binding.recipeCodeSnapshot
      || Number(row.version) !== binding.recipeVersionSnapshot
      || Number(row.output_product_id) !== binding.outputProductIdSnapshot
      || Number(row.output_variant_id) !== binding.outputVariantIdSnapshot
      || Number(row.output_units_per_variant) !== binding.outputUnitsPerVariantSnapshot
      || Number(row.output_qty) !== binding.outputQtySnapshot
    ) {
      throw invalidReference(
        `Recipe ${binding.recipeId} changed or is inactive; reload before saving.`,
      );
    }
    const actualComponents = componentsByRecipe.get(binding.recipeId) ?? [];
    const expectedComponents = [...binding.components]
      .sort((left, right) => left.componentVariantId - right.componentVariantId);
    if (actualComponents.length !== expectedComponents.length) {
      throw invalidReference(
        `Recipe ${binding.recipeId} component membership changed; reload before saving.`,
      );
    }
    for (let index = 0; index < expectedComponents.length; index += 1) {
      const expected = expectedComponents[index]!;
      const actual = actualComponents[index];
      if (
        !actual
        || Number(actual.component_variant_id) !== expected.componentVariantId
        || Number(actual.component_product_id) !== expected.componentProductId
        || Number(actual.component_units_per_variant) !== expected.componentUnitsPerVariant
        || Number(actual.qty) !== expected.componentQty
      ) {
        throw invalidReference(
          `Recipe ${binding.recipeId} component snapshots changed; reload before saving.`,
        );
      }
    }
  }
}

async function captureOperatorInputHash(tx: Transaction, productId: number): Promise<string> {
  const [source] = await loadInventoryAvailabilityBackfillSources(tx, [productId]);
  if (!source) throw invalidReference("The active catalog product no longer exists.");
  return calculateInventoryAvailabilityBackfillInputHash(source);
}

async function findTransformationReplay(tx: Transaction, idempotencyKey: string) {
  const [row] = await tx
    .select({
      id: transformationModelVersions.id,
      version: transformationModelVersions.version,
      definitionHash: transformationModelVersions.definitionHash,
      requestHash: transformationModelVersions.requestHash,
      supersedesModelId: transformationModelVersions.supersedesModelId,
    })
    .from(transformationModelVersions)
    .where(eq(transformationModelVersions.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ?? null;
}

async function findMasterDataReplay(
  executor: Executor,
  idempotencyKey: string,
): Promise<InventoryAvailabilityMasterDataReplay | null> {
  const replays: InventoryAvailabilityMasterDataReplay[] = [];
  const updateReplay = await findDraftUpdateReplay(executor, idempotencyKey);
  if (updateReplay) {
    replays.push({
      commandType: "transformation_model_draft_update",
      requestHash: updateReplay.requestHash,
      result: updateReplay.result,
    });
  }
  const result = await executor.execute(sql`
    SELECT command_type, id, version, definition_hash, scope_key, request_hash
    FROM (
      SELECT 'transformation_model'::text AS command_type,
             id, version, definition_hash, NULL::text AS scope_key, request_hash,
             idempotency_key
      FROM inventory.transformation_model_versions
      UNION ALL
      SELECT 'location_promise_policy'::text AS command_type,
             id, version, definition_hash, NULL::text AS scope_key, request_hash,
             idempotency_key
      FROM inventory.location_promise_policy_versions
      UNION ALL
      SELECT 'promise_safety_policy'::text AS command_type,
             id, version, definition_hash, scope_key, request_hash,
             idempotency_key
      FROM inventory.promise_safety_policy_versions
    ) AS replay
    WHERE replay.idempotency_key = ${idempotencyKey}
  `);
  for (const row of result.rows) {
    const commandType = String(row.command_type);
    if (commandType === "transformation_model") {
      replays.push({
        commandType,
        requestHash: String(row.request_hash),
        result: {
          modelId: Number(row.id),
          version: Number(row.version),
          definitionHash: String(row.definition_hash),
          alreadyApplied: true,
        },
      });
    } else if (commandType === "location_promise_policy") {
      replays.push({
        commandType,
        requestHash: String(row.request_hash),
        result: {
          policyId: Number(row.id),
          version: Number(row.version),
          alreadyApplied: true,
        },
      });
    } else if (commandType === "promise_safety_policy") {
      replays.push({
        commandType,
        requestHash: String(row.request_hash),
        result: {
          policyId: Number(row.id),
           version: Number(row.version),
           scopeKey: String(row.scope_key),
           definitionHash: String(row.definition_hash),
           alreadyApplied: true,
        },
      });
    }
  }
  if (replays.length > 1) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_STATE_INVALID",
      "The idempotency key is attached to more than one master-data command.",
    );
  }
  return replays[0] ?? null;
}

async function findDraftUpdateReplay(executor: Executor, idempotencyKey: string) {
  const [receipt] = await executor
    .select({
      requestHash: idempotencyKeys.requestHash,
      responseBody: idempotencyKeys.responseBody,
    })
    .from(idempotencyKeys)
    .where(eq(idempotencyKeys.key, draftUpdateReceiptKey(idempotencyKey)))
    .limit(1);
  if (!receipt) return null;
  const body = receipt.responseBody;
  const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const parsed = createTransformationModelDraftResultSchema.safeParse(bodyRecord?.result);
  if (bodyRecord?.commandType !== "transformation_model_draft_update" || !parsed.success) {
    throw new InventoryAvailabilityMasterDataError(
      500,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_RECEIPT_INVALID",
      "The transformation draft edit receipt is incomplete or malformed.",
    );
  }
  return { requestHash: receipt.requestHash, result: parsed.data };
}

function draftUpdateReceiptKey(idempotencyKey: string): string {
  return `${DRAFT_UPDATE_RECEIPT_PREFIX}${idempotencyKey}`;
}

async function lockIdempotencyKey(
  tx: Transaction,
  idempotencyKey: string,
): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      ${MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE},
      hashtext(${idempotencyKey})
    )
  `);
}

async function assertIdempotencyKeyUnusedByOtherType(
  tx: Transaction,
  idempotencyKey: string,
  commandType:
    | "transformation_model"
    | "transformation_model_draft_update"
    | "location_promise_policy"
    | "promise_safety_policy",
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
             ${idempotencyKey}::text AS idempotency_key
      FROM public.idempotency_keys
      WHERE key = ${draftUpdateReceiptKey(idempotencyKey)}
      UNION ALL
      SELECT 'promise_safety_policy_draft_update'::text AS command_type,
             ${idempotencyKey}::text AS idempotency_key
      FROM public.idempotency_keys
      WHERE key = ${`inventory-promise-safety-update:${idempotencyKey}`}
      UNION ALL
      SELECT 'inventory_demand_evidence_refresh'::text AS command_type,
             ${idempotencyKey}::text AS idempotency_key
      FROM public.idempotency_keys
      WHERE key = ${`inventory-demand-evidence:${idempotencyKey}`}
    ) AS used_key
    WHERE used_key.idempotency_key = ${idempotencyKey}
      AND used_key.command_type <> ${commandType}
    LIMIT 1
  `);
  if (result.rows.length > 0) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different command type.",
    );
  }
}

async function latestTransformationModel(tx: Transaction, productId: number) {
  const [row] = await tx
    .select({
      id: transformationModelVersions.id,
      version: transformationModelVersions.version,
    })
    .from(transformationModelVersions)
    .where(eq(transformationModelVersions.productId, productId))
    .orderBy(desc(transformationModelVersions.version))
    .limit(1);
  return row ?? null;
}

async function pointTransformationDraftHead(
  tx: Transaction,
  input: {
    productId: number;
    modelId: number;
    actorId: string;
    changeReason: string;
    occurredAt: Date;
    headExists: boolean;
  },
): Promise<void> {
  if (input.headExists) {
    await tx
      .update(transformationModelHeads)
      .set({
        draftModelId: input.modelId,
        revision: sql`${transformationModelHeads.revision} + 1`,
        updatedBy: input.actorId,
        updateReason: input.changeReason,
        updatedAt: input.occurredAt,
      })
      .where(eq(transformationModelHeads.productId, input.productId));
    return;
  }
  await tx.insert(transformationModelHeads).values({
    productId: input.productId,
    activeModelId: null,
    draftModelId: input.modelId,
    revision: BigInt(0),
    updatedBy: input.actorId,
    updateReason: input.changeReason,
    updatedAt: input.occurredAt,
  });
}

function safetyPolicyColumns(
  value: Parameters<
    InventoryAvailabilityMasterDataAdminStore["createPromiseSafetyPolicyDraft"]
  >[0]["value"],
) {
  switch (value.policyMode) {
    case "inherit":
    case "off":
      return {
        policyMode: value.policyMode,
        fixedUnits: null,
        daysOfCoverMilliDays: null,
        untrustedDemandFallbackUnits: null,
        demandMethodVersion: null,
      };
    case "fixed_units":
      return {
        policyMode: value.policyMode,
        fixedUnits: value.fixedUnits,
        daysOfCoverMilliDays: null,
        untrustedDemandFallbackUnits: null,
        demandMethodVersion: null,
      };
    case "days_of_cover":
      return {
        policyMode: value.policyMode,
        fixedUnits: null,
        daysOfCoverMilliDays: value.daysOfCoverMilliDays,
        untrustedDemandFallbackUnits: value.untrustedDemandFallbackUnits,
        demandMethodVersion: value.demandMethodVersion,
      };
  }
}

async function persistDraftAudit(
  tx: Transaction,
  command: {
    actorId: string;
    changeReason: string;
    idempotencyKey: string;
    requestHash: string;
    occurredAt: Date;
  },
  input: {
    action: string;
    target: string;
    owner: Record<string, unknown>;
    createdId: number;
    version: number;
    definitionHash: string;
    previous: { id: number; version: number } | null | undefined;
  },
): Promise<void> {
  await persistAuditEvent(tx, {
    actor: command.actorId,
    action: input.action,
    target: input.target,
    changes: {
      before: input.previous
        ? { id: input.previous.id, version: input.previous.version }
        : null,
      after: {
        ...input.owner,
        id: input.createdId,
        version: input.version,
        definitionHash: input.definitionHash,
      },
    },
    context: {
      changeReason: command.changeReason,
      idempotencyKey: command.idempotencyKey,
      requestHash: command.requestHash,
      runtimeAuthorityChanged: false,
    },
  }, {
    timestamp: command.occurredAt,
    emitStructuredLog: false,
  });
}

function recipeBindingKey(recipeId: number, warehouseId: number | null): string {
  return warehouseId === null
    ? `recipe:${recipeId}:network`
    : `recipe:${recipeId}:warehouse:${warehouseId}`;
}

function requireBindingId(bindings: ReadonlyMap<string, number>, key: string): number {
  const bindingId = bindings.get(key);
  if (!bindingId) {
    throw invalidReference(`Transformation path references unknown binding ${key}.`);
  }
  return bindingId;
}

function assertReplayHash(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new InventoryAvailabilityMasterDataError(
      409,
      "INVENTORY_AVAILABILITY_IDEMPOTENCY_KEY_REUSED",
      "The idempotency key was already used for a different request.",
    );
  }
}

function draftExists(kind: string, owner: string) {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_AVAILABILITY_DRAFT_EXISTS",
    `A draft ${kind} already exists for ${owner}.`,
  );
}

function staleDraft() {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_AVAILABILITY_DRAFT_STALE",
    "The transformation draft changed after it was loaded; reload before saving.",
  );
}

function invalidReference(message: string) {
  return new InventoryAvailabilityMasterDataError(
    409,
    "INVENTORY_AVAILABILITY_REFERENCE_CHANGED",
    message,
  );
}
