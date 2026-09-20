import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";
import * as schema from "../../shared/schema";
import { canonicalJson } from "../../shared/utils/canonical-json";
import { persistAuditEvent } from "../../server/infrastructure/auditLogger";
import { assertProductInventoryStrategyTransition } from "../../server/modules/catalog/inventory-strategy-policy";
import { InventoryLegacyAdminControlService, INVENTORY_LEGACY_ADMIN_CONTROLS } from "../../server/modules/inventory-planning/application/inventory-legacy-admin-control.service";
import { PostgresInventoryAvailabilityRuntimeAtpExecutor, type PostgresInventoryAvailabilityRuntimeTransaction } from "../../server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository";
import { InventoryAvailabilityMasterDataService } from "../../server/modules/inventory-planning/application/inventory-availability-master-data.service";
import { PostgresInventoryAvailabilityMasterDataStore } from "../../server/modules/inventory-planning/infrastructure/inventory-availability-master-data.repository";
import { InventoryAvailabilityBackfillService } from "../../server/modules/inventory-planning/application/inventory-availability-backfill.service";
import { PostgresInventoryAvailabilityBackfillRepository } from "../../server/modules/inventory-planning/infrastructure/inventory-availability-backfill.repository";
import { planInventoryAvailabilityBackfill } from "../../server/modules/inventory-planning/domain/inventory-availability-backfill";

const id = z.number().int().positive().max(2_147_483_647);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const selectionSchema = z.array(z.object({ id, sku: z.string().min(1), name: z.string().min(1) }).strict())
  .min(1).max(200).refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Duplicate product IDs");
const variantSchema = z.object({ id, product_id: id, sku: z.string().nullable(), name: z.string(),
  units_per_variant: id, uom_type: z.string(), is_active: z.boolean(), requires_shipping: z.boolean(),
  track_inventory: z.boolean().nullable(), sales_eligibility: z.string() }).strict();
const productStateSchema = z.object({ id, sku: z.string(), name: z.string(), inventory_strategy: z.string(),
  is_active: z.boolean(), active_model_id: id.nullable(), model_id: id, version: id,
  head_revision: z.string().regex(/^\d+$/), definition_hash: hashSchema, lifecycle_status: z.string(),
  build_to_promise_enabled: z.boolean(), path_count: z.number().int().nonnegative(),
  binding_count: z.number().int().nonnegative(), recipe_count: z.number().int().nonnegative(),
  latest_review_id: z.string().nullable(), review_decision: z.string().nullable() }).strict();
const stateSchema = z.object({ products: z.array(productStateSchema), variants: z.array(variantSchema) }).strict();
export const gradedCardCorrectionPreviewSchema = z.object({
  schemaVersion: z.literal(1), capturedAt: z.string().datetime(), selection: selectionSchema,
  state: stateSchema, stateHash: hashSchema,
}).strict();
export type GradedCardCorrectionPreview = z.infer<typeof gradedCardCorrectionPreviewSchema>;
export const gradedCardCorrectionCommandSchema = z.object({
  operationId: z.string().regex(/^[a-zA-Z0-9:-]{1,65}$/), actor: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000), preview: gradedCardCorrectionPreviewSchema,
}).strict();
export type GradedCardCorrectionCommand = z.infer<typeof gradedCardCorrectionCommandSchema>;
type Database = ReturnType<typeof drizzle<typeof schema>>;
type Executor = Pick<Database, "execute">;
type CorrectionSelection = z.infer<typeof selectionSchema>;
type CorrectionState = z.infer<typeof stateSchema>;
// Matches the existing master-data receipt lock namespace. The receipt prefix
// keeps this operation distinct from draft and review commands.
const MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE = 918420;

export class GradedCardPolicyCorrectionError extends Error {
  readonly code = "GRADED_CARD_CORRECTION_BLOCKED";

  constructor(message: string) {
    super(`GRADED_CARD_CORRECTION_BLOCKED: ${message}`);
    this.name = "GradedCardPolicyCorrectionError";
  }
}

export interface GradedCardCorrectionProductResult {
  productId: number;
  modelId: number;
  reviewed: boolean;
  classification: ReturnType<typeof planInventoryAvailabilityBackfill>["classification"];
}

export interface GradedCardCorrectionResult {
  catalog: { alreadyApplied: boolean };
  products: GradedCardCorrectionProductResult[];
}

export type GradedCardCorrectionProgress =
  | { stage: "catalog"; count: number; alreadyApplied: boolean }
  | ({ stage: "definition"; completed: number; total: number } & GradedCardCorrectionProductResult);

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
function fail(message: string): never { throw new GradedCardPolicyCorrectionError(message); }
function idsSql(ids: readonly number[]) { return sql.join(ids.map(value => sql`${value}`), sql`, `); }

function assertEligibleCorrection(selection: CorrectionSelection, state: CorrectionState): void {
  if (state.products.length !== selection.length) fail("A selected product or draft is missing.");
  for (const selected of selection) {
    const product = state.products.find(row => row.id === selected.id);
    if (!product) fail(`Product ${selected.id} or its draft is missing.`);
    if (product.sku !== selected.sku || product.name !== selected.name) fail(`Product ${selected.id} identity changed.`);
    if (!product.is_active || product.inventory_strategy !== "physical_fungible"
      || product.active_model_id !== null || product.lifecycle_status !== "draft"
      || product.build_to_promise_enabled || product.binding_count || product.recipe_count
      || product.review_decision !== "approved") fail(`Product ${selected.id} no longer matches the approved correction scope.`);
    const variants = state.variants.filter(row => row.product_id === selected.id);
    if (!variants.length || variants.some(row => !row.is_active || !row.requires_shipping
      || row.units_per_variant !== 1 || row.sales_eligibility !== "sellable")) fail(`Product ${selected.id} variants require review.`);
  }
}

/** Explicit operator-selected IDs only. This is not a name-based runtime classifier. */
export class GradedCardPolicyCorrection {
  private readonly database: Database;
  private readonly legacy: InventoryLegacyAdminControlService<PostgresInventoryAvailabilityRuntimeTransaction>;
  private readonly master: InventoryAvailabilityMasterDataService;
  private readonly catalog: PostgresInventoryAvailabilityBackfillRepository;
  private readonly backfill: InventoryAvailabilityBackfillService;
  constructor(pool: Pool, private readonly clock: { now(): Date }) {
    this.database = drizzle(pool, { schema });
    const executor = new PostgresInventoryAvailabilityRuntimeAtpExecutor(pool);
    this.legacy = new InventoryLegacyAdminControlService(executor);
    const masterStore = new PostgresInventoryAvailabilityMasterDataStore(this.database);
    this.master = new InventoryAvailabilityMasterDataService(masterStore, clock);
    this.catalog = new PostgresInventoryAvailabilityBackfillRepository(this.database);
    this.backfill = new InventoryAvailabilityBackfillService(this.catalog, masterStore,
      { previewLatestShadowChannels: async () => null }, clock);
  }

  async preview(rawSelection: unknown): Promise<GradedCardCorrectionPreview> {
    const selection = selectionSchema.parse(rawSelection).sort((a, b) => a.id - b.id);
    return this.database.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      const authority = await tx.execute(sql`SELECT authority, revision::text, activation_run_id
        FROM inventory.availability_runtime_authority WHERE singleton_key=true`);
      if (authority.rows.length !== 1 || authority.rows[0].authority !== "legacy"
        || authority.rows[0].activation_run_id !== null) fail("Legacy authority is required; no cutover is authorized.");
      const state = await this.capture(tx, selection.map(row => row.id));
      assertEligibleCorrection(selection, state);
      return gradedCardCorrectionPreviewSchema.parse({ schemaVersion: 1, selection, state,
        stateHash: fingerprint(state), capturedAt: this.clock.now().toISOString() });
    });
  }

  private async capture(executor: Executor, ids: readonly number[]): Promise<CorrectionState> {
    const products = await executor.execute(sql`SELECT p.id,p.sku,p.name,p.inventory_strategy,p.is_active,
      h.active_model_id,h.draft_model_id AS model_id,h.revision::text AS head_revision,m.version,
      m.definition_hash,m.lifecycle_status,m.build_to_promise_enabled,
      (SELECT count(*)::int FROM inventory.transformation_model_paths t WHERE t.model_id=m.id) AS path_count,
      (SELECT count(*)::int FROM inventory.transformation_recipe_bindings b WHERE b.model_id=m.id) AS binding_count,
      (SELECT count(*)::int FROM inventory.build_recipes r WHERE r.output_product_id=p.id) AS recipe_count,
      review.id::text AS latest_review_id,review.decision AS review_decision
      FROM catalog.products p
      JOIN inventory.transformation_model_heads h ON h.product_id=p.id
      JOIN inventory.transformation_model_versions m ON m.id=h.draft_model_id
      LEFT JOIN LATERAL (SELECT id,decision FROM inventory.transformation_model_reviews r
        WHERE r.model_id=m.id AND r.model_definition_hash=m.definition_hash ORDER BY id DESC LIMIT 1) review ON true
      WHERE p.id IN (${idsSql(ids)}) ORDER BY p.id`);
    const variants = await executor.execute(sql`SELECT id,product_id,sku,name,units_per_variant,uom_type,
      is_active,requires_shipping,track_inventory,sales_eligibility
      FROM catalog.product_variants WHERE product_id IN (${idsSql(ids)}) ORDER BY product_id,id`);
    return stateSchema.parse({ products: products.rows, variants: variants.rows });
  }

  /** Atomic catalog stage. Successor drafts are separate, resumable audited commands.
   * A partial run leaves legacy physical-only active and stale/unapproved drafts;
   * it never activates the new ATP authority or deletes the old evidence. */
  async correctCatalog(rawCommand: unknown): Promise<{ alreadyApplied: boolean }> {
    const command = gradedCardCorrectionCommandSchema.parse(rawCommand);
    if (fingerprint(command.preview.state) !== command.preview.stateHash) fail("Preview hash mismatch.");
    const ids = command.preview.selection.map(row => row.id).sort((a,b) => a-b);
    if (canonicalJson(ids) !== canonicalJson(command.preview.state.products.map(row => row.id))) fail("Preview target mismatch.");
    // A fingerprint detects drift; it does not prove that an input came from
    // preview(). Revalidate eligibility even for an operator-supplied command.
    assertEligibleCorrection(command.preview.selection, command.preview.state);
    const receiptKey = `graded-card-policy:${command.operationId}`;
    const requestHash = fingerprint(command);
    return this.legacy.executeLegacyWrite(INVENTORY_LEGACY_ADMIN_CONTROLS.inventoryStrategy, async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${MASTER_DATA_IDEMPOTENCY_LOCK_NAMESPACE},hashtext(${receiptKey}))`);
      const [receipt] = await tx.select().from(schema.idempotencyKeys).where(eq(schema.idempotencyKeys.key, receiptKey));
      if (receipt) {
        if (receipt.requestHash !== requestHash || !receipt.responseBody) fail("Correction command key was reused or has no receipt.");
        return { alreadyApplied: true };
      }
      // Owner heads before catalog references, matching transformation writers.
      await tx.execute(sql`SELECT product_id FROM inventory.transformation_model_heads
        WHERE product_id IN (${idsSql(ids)}) ORDER BY product_id FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM catalog.products WHERE id IN (${idsSql(ids)}) ORDER BY id FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM catalog.product_variants WHERE product_id IN (${idsSql(ids)}) ORDER BY id FOR SHARE`);
      const current = await this.capture(tx, ids);
      if (fingerprint(current) !== command.preview.stateHash) fail("Catalog, tracking, draft, or review changed after preview.");
      const now = this.clock.now();
      for (const product of current.products) {
        assertProductInventoryStrategyTransition({ productId: product.id, current: "physical_fungible",
          requested: "physical_only", hasBuildRecipes: product.recipe_count > 0 });
        const updated = await tx.update(schema.products).set({ inventoryStrategy: "physical_only", updatedAt: now })
          .where(eq(schema.products.id, product.id)).returning({ id: schema.products.id });
        if (updated.length !== 1) fail(`Product ${product.id} disappeared.`);
        await persistAuditEvent(tx, { actor: command.actor, action: "catalog.inventory_strategy.changed",
          target: `catalog.products:${product.id}`, changes: { before: { inventoryStrategy: product.inventory_strategy },
            after: { inventoryStrategy: "physical_only" } }, context: { productSku: product.sku,
            operationId: command.operationId, reason: command.reason, previewHash: command.preview.stateHash,
            inventoryQuantityWriteAttempted: false, providerWriteAttempted: false, runtimeAuthorityChanged: false } },
          { timestamp: now, emitStructuredLog: false });
      }
      await tx.insert(schema.idempotencyKeys).values({ key: receiptKey, requestHash,
        responseBody: { productIds: ids, previewHash: command.preview.stateHash }, createdAt: now, expiresAt: null });
      return { alreadyApplied: false };
    });
  }

  async apply(
    rawCommand: unknown,
    progress: (value: GradedCardCorrectionProgress) => void = () => undefined,
  ): Promise<GradedCardCorrectionResult> {
    const command = gradedCardCorrectionCommandSchema.parse(rawCommand);
    const catalog = await this.correctCatalog(command);
    progress({ stage: "catalog", count: command.preview.selection.length, ...catalog });
    const results: GradedCardCorrectionProductResult[] = [];
    for (const previous of command.preview.state.products) {
      const source = await this.catalog.captureBackfillProduct(previous.id);
      if (!source || source.source.product.legacyInventoryStrategy !== "physical_only") fail(`Product ${previous.id} strategy changed.`);
      const newModel = await this.master.updateTransformationModelDraft(previous.id, previous.model_id, {
        expectedVersion: previous.version, expectedDefinitionHash: previous.definition_hash,
        expectedHeadRevision: previous.head_revision, buildToPromiseEnabled: false, paths: [], recipeBindings: [],
        changeReason: command.reason, idempotencyKey: `${command.operationId}:draft:${previous.id}`,
      }, command.actor);
      const refreshed = await this.catalog.captureBackfillProduct(previous.id);
      if (!refreshed || refreshed.draft?.modelId !== newModel.modelId || refreshed.draftDefinition?.paths.length !== 0
        || refreshed.draftDefinition.buildToPromiseEnabled || refreshed.draftDefinition.recipeBindings.length !== 0) fail(`Product ${previous.id} successor verification failed.`);
      const candidate = planInventoryAvailabilityBackfill(refreshed.source);
      const excluded = candidate.classification === "excluded_unmanaged";
      if (!excluded) {
        await this.backfill.reviewProductDraft(previous.id, {
          expectedModelId: newModel.modelId, expectedModelVersion: newModel.version,
          expectedDefinitionHash: newModel.definitionHash, expectedHeadRevision: refreshed.draft.headRevision,
          expectedLatestReviewId: null, decision: "approved", reason: command.reason,
          idempotencyKey: `${command.operationId}:review:${previous.id}`,
        }, command.actor);
      }
      const result = { productId: previous.id, modelId: newModel.modelId, reviewed: !excluded, classification: candidate.classification };
      results.push(result);
      progress({ stage: "definition", completed: results.length, total: command.preview.selection.length, ...result });
    }
    return { catalog, products: results };
  }
}
