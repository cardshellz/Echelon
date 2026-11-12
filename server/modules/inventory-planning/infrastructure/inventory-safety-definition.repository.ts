import type { Pool, PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool } from "../../../db";
import { safetyDefinitionReviewSchema, safetyDefinitionReceiptSchema, safetyDefinitionProgressSchema,
  type SafetyDefinitionSelection, type ApplySafetyDefinition, type SafetyDefinitionReview,
  type PromiseSafetyOverview, type SafetyDefinitionReceipt, type SafetyDefinitionSetResult, type SetSafetyDefinition,
} from "@shared/types/inventory-safety-definition";
import { safetyPolicyScopeKey } from "../domain/inventory-availability-master-data.contracts";
import { PostgresInventoryAvailabilityMasterDataStore } from "./inventory-availability-master-data.repository";
import { PostgresInventoryPromiseSafetyAdminStore } from "./inventory-promise-safety-admin.repository";
import { promiseSafetyAdminValueSchema } from "@shared/types/inventory-promise-safety-admin";
import type { SafetyDefinitionStore } from "../application/inventory-safety-definition.service";
import { ProductDefinitionError } from "../application/inventory-product-definition.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { captureSafetyDraftReviewSnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { captureDefinitionImpact, enqueueReviewedDefinitionPublication } from "./inventory-product-definition.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";

/** The version row's idempotency key for a version written by `set`; distinct from keys the draft endpoints are given. */
const SAFETY_SET_DRAFT_KEY_PREFIX = "safety-set:";
/** Same namespace the two draft writers lock a scope under (advisory locks are re-entrant in one session). */
const SAFETY_POLICY_LOCK_NAMESPACE = 918423;
const DEFAULT_SET_REASON = "Set in Channel Inventory, Available stock.";
/** How many moved SKU/warehouse rows a set returns; the full count is returned beside them. */
const SET_RESULT_CHANGE_LIMIT = 50;

type DraftWriters = {
  create: Pick<PostgresInventoryAvailabilityMasterDataStore, "createPromiseSafetyPolicyDraftInsideTransaction">;
  update: Pick<PostgresInventoryPromiseSafetyAdminStore, "updatePromiseSafetyPolicyDraftInsideTransaction">;
};

export class PostgresSafetyDefinitionStore implements SafetyDefinitionStore {
  /** `drafts`: the version writers `set` runs inside its own transaction. Built on first use, so review, apply
   * and progress never construct them. */
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool, private drafts: DraftWriters | null = null) {}
  review(selection: SafetyDefinitionSelection) { return this.transaction(false, client => captureSafetyReview(client, selection)); }
  apply(command: ApplySafetyDefinition, actor: string, requestHash: string, now: Date) {
    return this.transaction(true, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`safety_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; receipt: unknown }>(
        "SELECT request_hash,receipt FROM inventory.safety_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey])).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ProductDefinitionError("DEFINITION_COMMAND_CONFLICT", "Retry key belongs to another command or user.");
        return { ...safetyDefinitionReceiptSchema.parse(replay.receipt), alreadyApplied: true };
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      const selection = { scopeKey: command.scopeKey, draftPolicyId: command.draftPolicyId,
        expectedHeadRevision: command.expectedHeadRevision, expectedDefinitionHash: command.expectedDefinitionHash };
      const review = await captureSafetyReview(client, selection);
      if (review.reviewHash !== command.expectedReviewHash) throw new ProductDefinitionError("DEFINITION_REVIEW_STALE", "The affected inventory or configuration changed. Review again.");
      if (!review.ready) throw new ProductDefinitionError("DEFINITION_REVIEW_BLOCKED", "Resolve every review blocker before applying.");
      return promoteReviewedSafety(client, review, { idempotencyKey: command.idempotencyKey, requestHash, actor, now });
    });
  }

  /**
   * Save + review + apply of ONE promise-safety setting as a single
   * transaction, so a refused or failed set leaves no rows at all (versions are
   * append-only: one that committed could never be deleted again).
   *
   * How the writers share one transaction: this method's pinned client owns
   * BEGIN/COMMIT/ROLLBACK. The version writers are the existing drizzle code,
   * so they are handed a drizzle handle bound to that same client and used for
   * statements only. `.transaction()` is never called on that handle: on a bare
   * client it would issue its own BEGIN/COMMIT and commit this transaction
   * early. Same arrangement as PostgresChannelRuleStore.set.
   *
   * Lock order: retry key, cutover fence, then the scope lock. Apply takes the
   * fence before any head row, so taking it after the scope lock here could
   * deadlock against it.
   */
  async set(command: SetSafetyDefinition, actor: string, requestHash: string, now: Date): Promise<SafetyDefinitionSetResult> {
    const scopeKey = safetyPolicyScopeKey(command.scope);
    const result = await this.transaction(true, async client => {
      // One retry-key space with apply: a key has one owner on either endpoint.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`safety_definition:${command.idempotencyKey}`]);
      const replay = (await client.query<{ request_hash: string; review: unknown; receipt: unknown }>(
        "SELECT request_hash,review,receipt FROM inventory.safety_definition_applications WHERE idempotency_key=$1", [command.idempotencyKey])).rows[0];
      if (replay) {
        if (replay.request_hash !== requestHash) throw new ProductDefinitionError("DEFINITION_COMMAND_CONFLICT", "Retry key belongs to another command or user.");
        return setResult({ ...safetyDefinitionReceiptSchema.parse(replay.receipt), alreadyApplied: true }, safetyDefinitionReviewSchema.parse(replay.review));
      }
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "canonical", expectedConfigurationRunId: null });
      await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [SAFETY_POLICY_LOCK_NAMESPACE, scopeKey]);
      const head = (await client.query<{ revision: string; draft_policy_id: number | null }>(
        "SELECT revision::text,draft_policy_id FROM inventory.promise_safety_policy_heads WHERE scope_key=$1", [scopeKey])).rows[0] ?? null;
      if ((head?.revision ?? null) !== command.expectedHeadRevision) {
        throw new ProductDefinitionError("DEFINITION_DRAFT_CHANGED", "This setting changed since it was loaded. Nothing was saved; reload to see the latest.");
      }
      this.drafts ??= { create: new PostgresInventoryAvailabilityMasterDataStore(), update: new PostgresInventoryPromiseSafetyAdminStore() };
      const audited = { value: command.value, actorId: actor, changeReason: command.changeReason ?? DEFAULT_SET_REASON,
        idempotencyKey: `${SAFETY_SET_DRAFT_KEY_PREFIX}${command.idempotencyKey}`, requestHash, occurredAt: now };
      let saved: { policyId: number; definitionHash: string; alreadyApplied: boolean };
      if (head?.draft_policy_id != null) {
        // A version saved earlier and never applied: versions cannot be deleted and a scope holds one unapplied
        // version at a time, so this set replaces it (the existing draft writer checks it is still that version).
        const unapplied = (await client.query<{ version: number; definition_hash: string }>(
          "SELECT version,definition_hash FROM inventory.promise_safety_policy_versions WHERE id=$1 AND scope_key=$2", [head.draft_policy_id, scopeKey])).rows[0];
        if (!unapplied) throw new ProductDefinitionError("DEFINITION_DRAFT_CHANGED", "This setting changed since it was loaded. Nothing was saved; reload to see the latest.");
        saved = await this.drafts.update.updatePromiseSafetyPolicyDraftInsideTransaction(drizzle(client), { ...audited,
          policyId: head.draft_policy_id, expectedVersion: unapplied.version, expectedDefinitionHash: unapplied.definition_hash,
          expectedHeadRevision: head.revision });
      } else {
        saved = await this.drafts.create.createPromiseSafetyPolicyDraftInsideTransaction(drizzle(client), { ...audited, scope: command.scope });
      }
      // The version receipt is written in this transaction, so it cannot exist without the receipt checked above.
      if (saved.alreadyApplied) throw new ProductDefinitionError("DEFINITION_SET_RECEIPT_INCONSISTENT", "This command's records are incomplete. Nothing was changed.", 500);
      const written = (await client.query<{ revision: string }>(
        "SELECT revision::text FROM inventory.promise_safety_policy_heads WHERE scope_key=$1", [scopeKey])).rows[0];
      if (!written) throw new ProductDefinitionError("DEFINITION_SET_RECEIPT_INCONSISTENT", "This command's records are incomplete. Nothing was changed.", 500);
      // Captured under the fence against the version just written: nothing can move between this review and the apply.
      const review = await captureSafetyReview(client, { scopeKey, draftPolicyId: saved.policyId,
        expectedHeadRevision: written.revision, expectedDefinitionHash: saved.definitionHash });
      if (!review.ready) {
        throw new ProductDefinitionError("DEFINITION_REVIEW_BLOCKED",
          `Not saved, nothing changed. ${[...new Set(review.blockers)].slice(0, 3).join(" ")}`.trim());
      }
      const receipt = await promoteReviewedSafety(client, review, { idempotencyKey: command.idempotencyKey, requestHash, actor, now });
      return setResult(receipt, review);
    });
    // After COMMIT only. The durable audit trail is the receipt row, the sealed version and its audit event.
    console.info(JSON.stringify({ level: "info", event: "safety_definition_set", action: "safety_definition_set",
      outcome: result.receipt.alreadyApplied ? "replayed" : "applied", error_code: null, actor, scope_key: scopeKey,
      after: { active_policy_id: result.receipt.policyId }, affected_products: result.affectedProducts,
      publication_ids: result.receipt.publicationIds, applied_at: result.receipt.appliedAt }));
    return result;
  }

  /** Read-only. Every scope that has ever had a setting, with the names a person needs to recognise a SKU. */
  overview(): Promise<PromiseSafetyOverview> {
    return this.transaction(false, async client => {
      const authority = (await client.query<{ authority: string }>(
        "SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true")).rows[0];
      const rows = (await client.query<OverviewRow>(`
        SELECT head.scope_key, head.revision::text, head.draft_policy_id, head.updated_at, head.updated_by,
          active.id AS active_id, active.definition_hash, active.policy_mode, active.fixed_units, active.days_of_cover_milli_days,
          active.untrusted_demand_fallback_units, active.demand_method_version,
          COALESCE(active.product_variant_id, draft.product_variant_id) AS product_variant_id,
          COALESCE(active.warehouse_id, draft.warehouse_id) AS warehouse_id,
          variant.sku, variant.name AS variant_name, variant.units_per_variant, product.id AS product_id, product.name AS product_name,
          warehouse.code AS warehouse_code
        FROM inventory.promise_safety_policy_heads head
        LEFT JOIN inventory.promise_safety_policy_versions active ON active.id=head.active_policy_id
        LEFT JOIN inventory.promise_safety_policy_versions draft ON draft.id=head.draft_policy_id
        LEFT JOIN catalog.product_variants variant ON variant.id=COALESCE(active.product_variant_id, draft.product_variant_id)
        LEFT JOIN catalog.products product ON product.id=variant.product_id
        LEFT JOIN warehouse.warehouses warehouse ON warehouse.id=COALESCE(active.warehouse_id, draft.warehouse_id)
        ORDER BY product.name NULLS FIRST, variant.sku, head.scope_key LIMIT 5001`)).rows;
      const setting = (row: OverviewRow) => ({ scopeKey: row.scope_key, revision: row.revision,
        value: row.active_id === null ? null : policyValue({ ...row, id: row.active_id } as PolicyRow),
        updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by, hasUnappliedChange: row.draft_policy_id !== null });
      const business = rows.find(row => row.scope_key === "business");
      return { runtimeAuthority: authority?.authority === "canonical" ? "canonical" as const : "legacy" as const,
        business: business ? setting(business) : null,
        // A SKU deleted from the catalog cannot be named or edited; its setting can no longer resolve for anything.
        exceptions: rows.filter(row => row.scope_key !== "business" && row.product_variant_id !== null && row.product_id !== null)
          .slice(0, 5000).map(row => ({ ...setting(row), productId: row.product_id!, productName: row.product_name ?? "",
            productVariantId: row.product_variant_id!, sku: row.sku, variantName: row.variant_name ?? "",
            unitsPerVariant: row.units_per_variant ?? 1, warehouseId: row.warehouse_id, warehouseCode: row.warehouse_code })) };
    });
  }
  progress(scopeKey: string) {
    return this.transaction(false, async client => {
      const row = (await client.query<{ receipt: unknown }>("SELECT receipt FROM inventory.safety_definition_applications WHERE scope_key=$1 ORDER BY id DESC LIMIT 1", [scopeKey])).rows[0];
      if (!row) return null;
      const receipt = safetyDefinitionReceiptSchema.parse(row.receipt);
      const publications = (await client.query(`SELECT id::text,publication_target_id AS "targetId",product_variant_id AS "variantId",
        state,desired_quantity::text AS "desiredQuantity",last_error_class AS "errorCode"
        FROM inventory.inventory_publication_outbox WHERE id=ANY($1::bigint[]) ORDER BY id`, [receipt.publicationIds])).rows;
      if (publications.length !== receipt.publicationIds.length) throw new ProductDefinitionError("DEFINITION_OUTBOX_MISSING", "Publication status is incomplete.", 500);
      return safetyDefinitionProgressSchema.parse({ receipt, publications });
    });
  }
  private async transaction<T>(applying: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let discard = false;
    try {
      await client.query(applying ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL SERIALIZABLE");
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='60s'");
      const result = await work(client); await client.query("COMMIT"); return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { discard = true; throw new AggregateError([error, rollbackError], "Safety apply rollback failed"); }
      throw error;
    } finally { client.release(discard); }
  }
}

type OverviewRow = { scope_key: string; revision: string; draft_policy_id: number | null; updated_at: Date; updated_by: string | null;
  active_id: number | null; definition_hash: string | null; policy_mode: string | null; fixed_units: number | null;
  days_of_cover_milli_days: number | null; untrusted_demand_fallback_units: number | null; demand_method_version: string | null;
  product_variant_id: number | null; warehouse_id: number | null; sku: string | null; variant_name: string | null;
  units_per_variant: number | null; product_id: number | null; product_name: string | null; warehouse_code: string | null };

/** The write half shared by apply and set: seal the reviewed version, enqueue every affected product's stock, store the receipt. */
async function promoteReviewedSafety(client: PoolClient, review: SafetyDefinitionReview,
  input: { idempotencyKey: string; requestHash: string; actor: string; now: Date }): Promise<SafetyDefinitionReceipt> {
  const { actor, now } = input;
  const { scopeKey, draftPolicyId, expectedDefinitionHash } = review.selection;
  await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
    contractVersion: "inventory_cutover_selection_manifest_v1", productIds: review.affectedProductIds, publicationTargetIds: [],
    selections: [{ kind: "safety_policy", key: scopeKey, definitionId: draftPolicyId, definitionHash: expectedDefinitionHash }],
  }, { actor, occurredAt: now, reason: "Applied reviewed promise safety policy across its complete affected scope." });
  const publicationIds = await enqueueReviewedDefinitionPublication(client, review);
  const receipt = safetyDefinitionReceiptSchema.parse({ scopeKey, policyId: draftPolicyId,
    appliedAt: now.toISOString(), appliedBy: actor, reviewHash: review.reviewHash, publicationIds, alreadyApplied: false });
  await client.query(`INSERT INTO inventory.safety_definition_applications
    (scope_key,policy_id,idempotency_key,request_hash,actor,occurred_at,review,receipt)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
  [scopeKey, draftPolicyId, input.idempotencyKey, input.requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(receipt)]);
  return receipt;
}

function setResult(receipt: SafetyDefinitionReceipt, review: Pick<SafetyDefinitionReview, "atp" | "affectedProductIds" | "skippedDestinations">): SafetyDefinitionSetResult {
  const moved = review.atp.filter(row => row.current !== row.proposed);
  return { receipt, affectedProducts: review.affectedProductIds.length, changedRows: moved.length,
    changes: moved.slice(0, SET_RESULT_CHANGE_LIMIT).map(row => ({ sku: row.sku, warehouseName: row.warehouseName, current: row.current, proposed: row.proposed })),
    skippedDestinations: review.skippedDestinations ?? [] };
}

type PolicyRow = { id: number; definition_hash: string; policy_mode: string; fixed_units: number | null;
  days_of_cover_milli_days: number | null; untrusted_demand_fallback_units: number | null; demand_method_version: string | null };
function policyValue(row: PolicyRow) {
  switch (row.policy_mode) {
    case "inherit": case "off": return promiseSafetyAdminValueSchema.parse({ policyMode: row.policy_mode });
    case "fixed_units": return promiseSafetyAdminValueSchema.parse({ policyMode: row.policy_mode, fixedUnits: row.fixed_units });
    default: return promiseSafetyAdminValueSchema.parse({ policyMode: row.policy_mode, daysOfCoverMilliDays: row.days_of_cover_milli_days,
      untrustedDemandFallbackUnits: row.untrusted_demand_fallback_units, demandMethodVersion: row.demand_method_version });
  }
}
async function captureSafetyReview(client: PoolClient, selection: SafetyDefinitionSelection): Promise<SafetyDefinitionReview> {
  const authority = (await client.query<{ authority: string; revision: string; activation_run_id: string | null }>(
    "SELECT authority,revision::text,activation_run_id::text FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE")).rows[0];
  if (!authority || authority.authority !== "canonical" || !authority.activation_run_id) {
    throw new ProductDefinitionError("DEFINITION_CANONICAL_REQUIRED", "Routine Apply is available after inventory migration. Drafts do not activate migration.");
  }
  const head = (await client.query<{ revision: string; active_policy_id: number | null; draft_policy_id: number | null }>(
    "SELECT revision::text,active_policy_id,draft_policy_id FROM inventory.promise_safety_policy_heads WHERE scope_key=$1", [selection.scopeKey])).rows[0];
  const draft = (await client.query<PolicyRow & { scope_type: string; product_variant_id: number | null; lifecycle_status: string }>(
    "SELECT * FROM inventory.promise_safety_policy_versions WHERE id=$1 AND scope_key=$2", [selection.draftPolicyId, selection.scopeKey])).rows[0];
  if (!head || !draft || head.revision !== selection.expectedHeadRevision || head.draft_policy_id !== draft.id
    || draft.definition_hash !== selection.expectedDefinitionHash || draft.lifecycle_status !== "draft") {
    throw new ProductDefinitionError("DEFINITION_DRAFT_CHANGED", "The saved safety draft changed. Reload before reviewing.");
  }
  const previous = head.active_policy_id === null ? null : (await client.query<PolicyRow>(
    "SELECT * FROM inventory.promise_safety_policy_versions WHERE id=$1 AND scope_key=$2", [head.active_policy_id, selection.scopeKey])).rows[0];
  // Business means all managed physical products, not the currently selected UI
  // product. SKU scopes include siblings (shared resources) and reverse recipes.
  const affectedProductIds = (await client.query<{ product_id: number }>(`WITH RECURSIVE affected(product_id) AS (
      SELECT DISTINCT product_id FROM catalog.product_variants
      WHERE ($1::boolean AND is_active=true AND requires_shipping=true AND COALESCE(track_inventory,true)=true)
         OR id=$2
      UNION SELECT heads.product_id FROM affected a
      JOIN inventory.transformation_recipe_component_snapshots components ON components.component_product_id=a.product_id
      JOIN inventory.transformation_model_heads heads ON heads.active_model_id=components.model_id
    ) SELECT product_id FROM affected ORDER BY product_id LIMIT 1001`, [draft.scope_type === "business", draft.product_variant_id])).rows.map(row => row.product_id);
  if (!affectedProductIds.length || affectedProductIds.length > 1000) throw new ProductDefinitionError("DEFINITION_SCOPE_UNSUPPORTED", "The complete scope must contain 1–1000 products. No partial apply is allowed.", 422);
  const impact = await captureDefinitionImpact(client, affectedProductIds,
    productId => captureSafetyDraftReviewSnapshotInsideTransaction(client, productId, selection.scopeKey));
  const content = { selection, authorityRevision: authority.revision, activationRunId: authority.activation_run_id,
    previousPolicy: previous ? { id: previous.id, definitionHash: previous.definition_hash, value: policyValue(previous) } : null,
    proposedPolicy: policyValue(draft), affectedProductIds, ready: impact.blockers.length === 0,
    blockers: impact.blockers, skippedDestinations: impact.skippedDestinations,
    ...(impact.notices.length > 0 ? { notices: impact.notices } : {}), atp: impact.atp, channels: impact.channels };
  return safetyDefinitionReviewSchema.parse({ ...content, reviewHash: inventoryCutoverEvidenceHash({ content, fingerprints: impact.fingerprints }) });
}
