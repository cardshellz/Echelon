import type { PoolClient } from "pg";
import { canonicalJson } from "@shared/utils/canonical-json";
import type { QuantityPublicationCatchup } from "../application/quantity-publication-admission.port";
import { QuantityPublicationAdmissionError, quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { readCanonicalQuantityPublicationMember } from "./canonical-quantity-publication-member.reader";
import { readPublicationStockSelection } from "./inventory-publication-selection.reader";

interface PersistedCatchup {
  revision: string;
  completed_revision: string;
  attempt_boundary_id: string;
  scope_key: string;
  scope: unknown;
  before_state: string;
}

/** The caller holds the shared selection/publication gate and exact-scope lock
 * until commit. This settles local obsolete work, never a provider request or
 * remote retirement. Catalog's selection owner remains the archive authority. */
export async function settleArchivedCatchupInsideTransaction(client: PoolClient,
  claim: QuantityPublicationCatchup, scopeKey: string, occurredAt: string): Promise<boolean> {
  // Definition promotion takes the authority row exclusively before changing
  // active mapping heads. Pin it before exact identity lookup to exclude new
  // aliases as well as edits to existing rows; NOWAIT avoids reversing that
  // owner's authority-before-publication lock order.
  const authority = (await client.query<{ authority: string; activation_run_id: string | null; suppressed: boolean }>(
    `SELECT auth.authority,auth.activation_run_id::text,gate.activation_run_id IS NOT NULL AS suppressed
     FROM inventory.availability_runtime_authority auth CROSS JOIN inventory.quantity_publication_gate gate
     WHERE auth.singleton_key=true AND gate.singleton=true FOR SHARE OF auth,gate NOWAIT`,
  )).rows[0];
  // Legacy delivery keeps its existing owner; a canonical binding cannot prove
  // which legacy request is obsolete during an authority transition.
  if (!authority || authority.authority !== "canonical" || authority.suppressed) return false;
  const activeRun = (await client.query(`SELECT id FROM inventory.availability_activation_runs
    WHERE id=$1 AND state='active' FOR SHARE`, [authority.activation_run_id])).rows[0];
  if (!activeRun) return false;

  const current = (await client.query<PersistedCatchup>(`SELECT revision::text,completed_revision::text,
    attempt_boundary_id::text,scope_key,scope,to_jsonb(catchup)::text AS before_state
    FROM inventory.quantity_publication_catchup catchup WHERE id=$1 FOR UPDATE`, [claim.catchupId])).rows[0];
  if (!current || current.revision !== claim.revision || current.attempt_boundary_id !== claim.attemptBoundaryId
    || BigInt(current.completed_revision) >= BigInt(claim.revision)) return false;
  const scope = quantityPublicationScopeSchema.parse(current.scope);
  // scope_key intentionally ignores local hints. Compare the full persisted
  // scope as well so altered product/variant hints cannot authorize settlement.
  if (current.scope_key !== scopeKey || canonicalJson(scope) !== canonicalJson(claim.scope)) {
    throw new QuantityPublicationAdmissionError("PUBLICATION_CATCHUP_SCOPE_MISMATCH",
      "The catch-up claim no longer matches its saved provider and Catalog identity.");
  }
  const unresolved = (await client.query<{ present: boolean }>(`SELECT EXISTS (
    SELECT 1 FROM inventory.quantity_publication_attempts
    WHERE affected_scope_keys @> ARRAY[$1] AND state IN ('running','uncertain')) AS present`, [scopeKey])).rows[0];
  if (unresolved?.present) throw new QuantityPublicationAdmissionError("PUBLICATION_SCOPE_UNRESOLVED",
    "An earlier provider request for this exact item is unresolved; archival cannot settle its outcome.");

  const member = await readCanonicalQuantityPublicationMember(client, scope);
  const selection = await readPublicationStockSelection(client, member,
    { productId: member.product_id, productVariantIds: [member.product_variant_id], now: new Date(occurredAt) });
  const selected = selection.variants[0];
  if (selected.catalogArchived !== true || selected.action !== "none" || selected.blockers.length !== 0) return false;

  const changed = (await client.query<{ after_state: string }>(`UPDATE inventory.quantity_publication_catchup catchup
    SET completed_revision=$2,last_error_code=NULL,last_error_message=NULL
    WHERE id=$1 AND revision=$2 AND attempt_boundary_id=$3 AND scope_key=$4 AND scope=$5::jsonb
      AND completed_revision<revision
      AND NOT EXISTS (SELECT 1 FROM inventory.quantity_publication_attempts attempt
        WHERE attempt.affected_scope_keys @> ARRAY[$4] AND attempt.state IN ('running','uncertain'))
    RETURNING to_jsonb(catchup)::text AS after_state`,
  [claim.catchupId,claim.revision,claim.attemptBoundaryId,scopeKey,JSON.stringify(scope)])).rows[0];
  if (!changed) return false;
  // Keep before/after as PostgreSQL JSON text: bigint identities/revisions must
  // not round through JavaScript's JSON-number representation.
  await client.query(`INSERT INTO inventory.quantity_publication_catchup_settlements
    (catchup_id,revision,attempt_boundary_id,scope_key,scope,basis,actor,selection_fingerprint,
     evidence,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4,$5::jsonb,'catalog_archived','system:quantity-publication-catchup',$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
  [claim.catchupId,claim.revision,claim.attemptBoundaryId,scopeKey,JSON.stringify(scope),selection.fingerprint,
    JSON.stringify({ member, selection }),current.before_state,changed.after_state,occurredAt]);
  return true;
}
