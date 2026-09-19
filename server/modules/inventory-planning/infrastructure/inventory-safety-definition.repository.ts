import type { Pool, PoolClient } from "pg";
import { pool } from "../../../db";
import { safetyDefinitionReviewSchema, safetyDefinitionReceiptSchema, safetyDefinitionProgressSchema,
  type SafetyDefinitionSelection, type ApplySafetyDefinition, type SafetyDefinitionReview,
} from "@shared/types/inventory-safety-definition";
import { promiseSafetyAdminValueSchema } from "@shared/types/inventory-promise-safety-admin";
import type { SafetyDefinitionStore } from "../application/inventory-safety-definition.service";
import { ProductDefinitionError } from "../application/inventory-product-definition.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { captureSafetyDraftReviewSnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { captureDefinitionImpact, enqueueReviewedDefinitionPublication } from "./inventory-product-definition.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { promoteInventoryCutoverDefinitionsInsideTransaction } from "./inventory-cutover-definitions.repository";

export class PostgresSafetyDefinitionStore implements SafetyDefinitionStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}
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
      await promoteInventoryCutoverDefinitionsInsideTransaction(client, {
        contractVersion: "inventory_cutover_selection_manifest_v1", productIds: review.affectedProductIds, publicationTargetIds: [],
        selections: [{ kind: "safety_policy", key: command.scopeKey, definitionId: command.draftPolicyId, definitionHash: command.expectedDefinitionHash }],
      }, { actor, occurredAt: now, reason: "Applied reviewed promise safety policy across its complete affected scope." });
      const publicationIds = await enqueueReviewedDefinitionPublication(client, review);
      const receipt = safetyDefinitionReceiptSchema.parse({ scopeKey: command.scopeKey, policyId: command.draftPolicyId,
        appliedAt: now.toISOString(), appliedBy: actor, reviewHash: review.reviewHash, publicationIds, alreadyApplied: false });
      await client.query(`INSERT INTO inventory.safety_definition_applications
        (scope_key,policy_id,idempotency_key,request_hash,actor,occurred_at,review,receipt)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
      [command.scopeKey, command.draftPolicyId, command.idempotencyKey, requestHash, actor, now.toISOString(), JSON.stringify(review), JSON.stringify(receipt)]);
      return receipt;
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
    blockers: impact.blockers, atp: impact.atp, channels: impact.channels };
  return safetyDefinitionReviewSchema.parse({ ...content, reviewHash: inventoryCutoverEvidenceHash({ content, fingerprints: impact.fingerprints }) });
}
