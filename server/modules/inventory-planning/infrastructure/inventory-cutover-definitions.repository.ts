import type { InventoryCutoverDefinitionSelection, InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import { inventoryCutoverManifestSchema } from "@shared/types/inventory-cutover-commit";
import type { InventoryAvailabilityTransactionQueryClient } from "../application/inventory-availability-transaction-query.port";
import { InventoryCutoverManifestError } from "../domain/inventory-cutover-manifest";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { z } from "zod";

// SQL identifiers are an internal exhaustive allowlist, never request text.
const DEFINITION_TABLES = {
  model: { heads: "transformation_model_heads", versions: "transformation_model_versions", key: "product_id::text", active: "active_model_id", draft: "draft_model_id" },
  location_policy: { heads: "location_promise_policy_heads", versions: "location_promise_policy_versions", key: "warehouse_location_id::text", active: "active_policy_id", draft: "draft_policy_id" },
  safety_policy: { heads: "promise_safety_policy_heads", versions: "promise_safety_policy_versions", key: "scope_key", active: "active_policy_id", draft: "draft_policy_id" },
  channel_policy: { heads: "channel_exposure_policy_heads", versions: "channel_exposure_policy_versions", key: "scope_key", active: "active_policy_id", draft: "draft_policy_id" },
  source_binding: { heads: "publication_source_binding_heads", versions: "publication_source_binding_versions", key: "publication_target_id::text", active: "active_binding_id", draft: "draft_binding_id" },
  variant_mapping: { heads: "publication_variant_mapping_heads", versions: "publication_variant_mapping_versions", key: "publication_target_id::text || ':' || product_variant_id::text", active: "active_mapping_id", draft: "draft_mapping_id" },
} as const;

type HeadEvidence = { active_id: number | null; draft_id: number | null; revision: string };
const auditSchema = z.object({
  actor: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
  occurredAt: z.date(),
}).strict();

/** Does not open a transaction. Its caller owns the global cutover barrier and rollback. */
export async function promoteInventoryCutoverDefinitionsInsideTransaction(
  client: InventoryAvailabilityTransactionQueryClient,
  manifestInput: InventoryCutoverManifest,
  auditInput: { actor: string; reason: string; occurredAt: Date },
): Promise<number> {
  const manifest = inventoryCutoverManifestSchema.parse(manifestInput);
  const auditResult = auditSchema.safeParse(auditInput);
  if (!auditResult.success) {
    throw new InventoryCutoverManifestError("CUTOVER_AUDIT_INVALID", "Definition promotion requires a valid actor, reason and time.");
  }
  const audit = auditResult.data;
  await assertInventoryCutoverFenceHeldInsideTransaction(client);
  let promoted = 0;
  for (const selection of manifest.selections) {
    const table = DEFINITION_TABLES[selection.kind];
    const heads = (await client.query<HeadEvidence>(
      `SELECT ${table.active} AS active_id, ${table.draft} AS draft_id, revision::text
       FROM inventory.${table.heads} WHERE ${table.key} = $1 FOR UPDATE`, [selection.key],
    )).rows;
    if (heads.length !== 1) throw changed(selection);
    const head = heads[0];
    if ((head.draft_id ?? head.active_id) !== selection.definitionId) throw changed(selection);
    const definitions = (await client.query<{ definition_hash: string; lifecycle_status: string }>(
      `SELECT definition_hash, lifecycle_status FROM inventory.${table.versions} WHERE id = $1 FOR UPDATE`,
      [selection.definitionId],
    )).rows;
    const definition = definitions[0];
    if (definitions.length !== 1 || definition.definition_hash !== selection.definitionHash) throw changed(selection);
    if (head.draft_id === null) {
      if (definition.lifecycle_status !== "sealed") throw changed(selection);
      continue; // A reviewed active head retains its revision and original sealing actor.
    }
    if (definition.lifecycle_status !== "draft") throw changed(selection);
    await client.query(
      `UPDATE inventory.${table.versions} SET lifecycle_status = 'sealed', sealed_by = $2, sealed_at = $3 WHERE id = $1`,
      [selection.definitionId, audit.actor, audit.occurredAt.toISOString()],
    );
    const updated = await client.query(
      `UPDATE inventory.${table.heads}
       SET ${table.active} = $2, ${table.draft} = NULL, revision = revision + 1, updated_by = $3, update_reason = $4
       WHERE ${table.key} = $1 AND revision = $5 AND ${table.draft} = $2`,
      [selection.key, selection.definitionId, audit.actor, audit.reason, head.revision],
    );
    if (updated.rowCount !== 1) throw changed(selection);
    promoted++;
  }
  return promoted;
}

function changed(selection: InventoryCutoverDefinitionSelection): InventoryCutoverManifestError {
  return new InventoryCutoverManifestError("CUTOVER_REVIEWED_HEAD_CHANGED", "A reviewed definition head changed before promotion.", {
    kind: selection.kind, key: selection.key, definitionId: selection.definitionId,
  });
}
