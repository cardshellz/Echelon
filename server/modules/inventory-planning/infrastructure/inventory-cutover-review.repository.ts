import { projectInventoryCutoverStateInsideTransaction } from "./inventory-cutover-projection.repository";
import type { PoolClient } from "pg";
import { inventoryCutoverReviewSchema, type InventoryCutoverReview, type InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryCutoverCommitError } from "../application/inventory-cutover-commit.service";
import { buildInventoryCutoverManifest, inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { validateInventoryCutoverPublicationProof } from "../domain/inventory-cutover-publication-proof";
import { assertDryRunSelectionsCurrent, loadReadyDryRun, selectedSnapshots } from "./inventory-availability-activation.repository";
import { captureQuantityPublicationDrainInsideTransaction } from "./quantity-publication-admission.repository";
import { validateCutoverDrainReadbacks } from "../domain/inventory-cutover-drain-readback-proof";

const MAX_READBACK_AGE_MS = 15 * 60 * 1000;
type Blocker = InventoryCutoverReview["blockers"][number];

/** All reads use one caller-owned snapshot; no persisted draft, stock or provider changes. */
export async function captureInventoryCutoverReviewInsideTransaction(
  client: PoolClient, activationRunId: string, occurredAt: Date,
): Promise<InventoryCutoverReview> {
  const run = (await client.query<{
    state: string; source_dry_run_id: string; evidence_payload: { sourceDryRunResultHash?: unknown };
    authority: string; authority_revision: string; freeze_open: boolean;
  }>(
    `SELECT run.state, run.source_dry_run_id::text, run.evidence_payload,
            authority.authority, authority.revision::text AS authority_revision,
            EXISTS(SELECT 1 FROM inventory.availability_activation_freezes configured_freeze
                   WHERE configured_freeze.activation_run_id = run.id AND configured_freeze.released_at IS NULL) AS freeze_open
     FROM inventory.availability_activation_runs run
     CROSS JOIN inventory.availability_runtime_authority authority
     WHERE run.id = $1 AND run.mode = 'activation' AND authority.singleton_key = true`, [activationRunId],
  )).rows[0];
  if (!run || run.authority !== "legacy" || !run.freeze_open) {
    throw new InventoryCutoverCommitError("CUTOVER_PREPARATION_UNAVAILABLE", "An open legacy-authority preparation is required for cutover review.");
  }
  const dryRun = await loadReadyDryRun(client, run.source_dry_run_id, String(run.evidence_payload.sourceDryRunResultHash), false);
  await assertDryRunSelectionsCurrent(client, dryRun, false);
  const manifest = buildInventoryCutoverManifest(dryRun, await selectedSnapshots(client, dryRun, false));
  const blockers: Blocker[] = [];
  // Readiness requires the durable suppression gate, no unresolved send, and
  // exact latest admitted outbox attempts preceding every provider readback.
  if (run.state !== "publication_verified") blockers.push({ code: "CUTOVER_CONSERVATIVE_PUBLICATION_PENDING", subject: "activation", message: "Conservative publication has not been verified." });
  await checkWholeCatalogCoverage(client, manifest, blockers);
  const projection = await projectInventoryCutoverStateInsideTransaction(client, manifest, activationRunId, run.authority_revision);
  const { reconstruction, impactHash, publicationRows, stockFingerprints, configurationEvidence } = projection;
  blockers.push(...projection.blockers);
  const providerEvidence = await checkConservativePublications(client, activationRunId, publicationRows, occurredAt, blockers);
  const publicationDrain = await captureQuantityPublicationDrainInsideTransaction(client, activationRunId);
  blockers.push(...validateCutoverDrainReadbacks(publicationDrain, activationRunId, providerEvidence.evidence));
  const sortedBlockers = [...new Map(blockers.map((blocker) => [`${blocker.code}:${blocker.subject}`, blocker])).values()]
    .sort((a, b) => compare(`${a.subject}:${a.code}`, `${b.subject}:${b.code}`));
  const stableEvidence = {
    activationRunId, authorityRevision: run.authority_revision, manifest,
    reconstructionHash: reconstruction.evidenceHash, freshClaimImpactHash: impactHash,
    ...(reconstruction.openingBalance ? { openingBalance: reconstruction.openingBalance } : {}),
    legacyPromiseReleases: reconstruction.legacyPromiseReleases,
    stockFingerprints, configurationEvidence, providerEvidence, publicationDrain, publicationRows, blockers: sortedBlockers,
  };
  return inventoryCutoverReviewSchema.parse({
    contractVersion: "inventory_cutover_review_v1", activationRunId, authorityRevision: run.authority_revision,
    capturedAt: occurredAt.toISOString(), reviewHash: inventoryCutoverEvidenceHash(stableEvidence),
    selectionManifestHash: inventoryCutoverEvidenceHash(manifest), reconstructionHash: reconstruction.evidenceHash,
    freshClaimImpactHash: impactHash, ready: sortedBlockers.length === 0, manifest,
    summary: { orders: reconstruction.orders.length, lines: reconstruction.orders.reduce((sum, order) => sum + order.lines.length, 0),
      retainedIndependentBuildHolds: reconstruction.retainedIndependentBuildReservationIds.length,
      ...(reconstruction.openingBalance ? { openingBalance: reconstruction.openingBalance } : {}),
      legacyPromiseReplanning: { positions: reconstruction.legacyPromiseReleases.length,
        orderLines: reconstruction.legacyPromiseReleases.reduce((total, release) => total + release.owners.length, 0) } },
    publicationRows, blockers: sortedBlockers, operationalWriteAttempted: false, providerWriteAttempted: false,
  });
}

async function checkWholeCatalogCoverage(client: PoolClient, manifest: InventoryCutoverManifest, blockers: Blocker[]): Promise<void> {
  const productIds = (await client.query<{ id: number }>(
    `SELECT product.id FROM catalog.products product WHERE product.is_active = true
       AND EXISTS(SELECT 1 FROM catalog.product_variants variant WHERE variant.product_id = product.id
         AND variant.is_active = true AND variant.requires_shipping = true
         AND COALESCE(variant.track_inventory, true) = true AND variant.sales_eligibility = 'sellable')
     ORDER BY product.id`,
  )).rows.map((row) => row.id);
  const targetIds = (await client.query<{ id: number }>(
    "SELECT id FROM inventory.inventory_publication_targets WHERE state <> 'disabled' ORDER BY id",
  )).rows.map((row) => row.id);
  if (canonicalJson(productIds) !== canonicalJson(manifest.productIds)) blockers.push({ code: "CUTOVER_CATALOG_MEMBERSHIP_CHANGED", subject: "catalog", message: "The complete sellable physical catalog differs from the reviewed product set." });
  if (canonicalJson(targetIds) !== canonicalJson(manifest.publicationTargetIds)) blockers.push({ code: "CUTOVER_TARGET_MEMBERSHIP_CHANGED", subject: "targets", message: "The complete enabled target set differs from the reviewed target set." });
}

async function checkConservativePublications(client: PoolClient, runId: string, quantities: InventoryCutoverReview["publicationRows"], occurredAt: Date, blockers: Blocker[]): Promise<{ rows: unknown[]; evidence: unknown[] }> {
  const rows = (await client.query<Record<string, unknown>>(
    `SELECT publication.id::text, publication.publication_target_id, publication.product_variant_id,
            publication.state, publication.desired_quantity::text, publication.acknowledged_at,
            readback.observed_quantity::text, readback.observed_at,
            readback.external_inventory_item_id_snapshot, readback.publication_target_revision_snapshot::text,
            readback.destination_kind_snapshot, readback.channel_connection_id_snapshot,
            readback.dropship_store_connection_id_snapshot, readback.provider_scope_type_snapshot,
            readback.external_scope_id_snapshot,
            publication.external_inventory_item_id_snapshot AS expected_item,
            publication.publication_target_revision_snapshot::text AS expected_revision,
            publication.destination_kind_snapshot AS expected_destination_kind,
            publication.channel_connection_id_snapshot AS expected_channel_connection,
            publication.dropship_store_connection_id_snapshot AS expected_dropship_connection,
            publication.provider_scope_type_snapshot AS expected_scope_type,
            publication.external_scope_id_snapshot AS expected_scope_id
     FROM inventory.inventory_publication_outbox publication
     LEFT JOIN LATERAL (
       SELECT * FROM inventory.inventory_publication_readbacks r
       WHERE r.publication_target_id = publication.publication_target_id AND r.product_variant_id = publication.product_variant_id
       ORDER BY r.observed_at DESC, r.id DESC LIMIT 1
     ) readback ON true
     WHERE publication.activation_run_id = $1 AND publication.publication_phase = 'conservative'
     ORDER BY publication.publication_target_id, publication.product_variant_id, publication.id`, [runId],
  )).rows;
  const evidence = rows.map((row) => ({
      publicationId: row.id, publicationTargetId: row.publication_target_id, productVariantId: row.product_variant_id,
      state: row.state, conservativeQuantity: row.desired_quantity, acknowledgedAt: row.acknowledged_at,
      observedQuantity: row.observed_quantity, observedAt: row.observed_at,
      expectedIdentity: {
        externalInventoryItemId: row.expected_item, publicationTargetRevision: row.expected_revision,
        destinationKind: row.expected_destination_kind, channelConnectionId: row.expected_channel_connection,
        dropshipStoreConnectionId: row.expected_dropship_connection, providerScopeType: row.expected_scope_type,
        externalScopeId: row.expected_scope_id,
      },
      observedIdentity: row.observed_at === null ? null : {
        externalInventoryItemId: row.external_inventory_item_id_snapshot,
        publicationTargetRevision: row.publication_target_revision_snapshot,
        destinationKind: row.destination_kind_snapshot, channelConnectionId: row.channel_connection_id_snapshot,
        dropshipStoreConnectionId: row.dropship_store_connection_id_snapshot,
        providerScopeType: row.provider_scope_type_snapshot, externalScopeId: row.external_scope_id_snapshot,
      },
    }));
  const proof = validateInventoryCutoverPublicationProof({ quantities, occurredAt, maxReadbackAgeMs: MAX_READBACK_AGE_MS, evidence });
  blockers.push(...proof.blockers);
  return { rows, evidence };
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
