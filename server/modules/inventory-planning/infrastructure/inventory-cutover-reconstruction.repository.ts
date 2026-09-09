import type { PoolClient } from "pg";
import { cutoverReconstructionCommitSchema, cutoverReconstructionEvidenceSchema, cutoverReconstructionReceiptSchema,
  type CutoverReconstructionCommit, type CutoverReconstructionEvidence, type CutoverReconstructionPlan,
  type CutoverReconstructionReceipt } from "@shared/types/inventory-cutover-reconstruction";
import type { InventoryCutoverReconstructionStore } from "../application/inventory-cutover-reconstruction.port";
import type { CanonicalClaimInventoryMutationPort } from "../application/canonical-claim-inventory.port";
import { PostgresCanonicalClaimInventoryRepository } from "../../inventory/infrastructure/canonical-claim-inventory.repository";
import { readInventoryCutoverReconstruction } from "../../inventory/infrastructure/inventory-cutover-reconstruction.reader";
import { readWmsCutoverReconstruction, readWmsCutoverShipmentReviews } from "../../wms/inventory-cutover-reconstruction.reader";
import { readCutoverOriginalCosts } from "../../orders/inventory-cutover-reconstruction-cost.reader";
import { readOmsCutoverReconstruction } from "../../oms/inventory-cutover-reconstruction.reader";
import { planCutoverReconstruction, reconstructionEvidenceHash, reconstructionHash } from "../domain/inventory-cutover-reconstruction";
import { loadLatestCutoverOpening } from "./inventory-cutover-opening.reader";
import { planFreshCutoverClaims } from "../domain/inventory-cutover-reconstruction-planning";
import { assertInventoryCutoverFenceHeldInsideTransaction } from "./inventory-cutover-admission-fence.repository";
import { captureActiveClaimSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { persistReconstructedCutoverClaim } from "./inventory-availability-claim.repository";
import type { InventoryCutoverLegacyPromisePort } from "../application/inventory-cutover-legacy-promise.port";
import { PostgresInventoryCutoverLegacyPromiseRepository } from "../../inventory/infrastructure/inventory-cutover-legacy-promise.repository";
import { captureInventoryCutoverStage } from "./inventory-cutover-capture-stage";

const inventoryCaptureSchema = cutoverReconstructionEvidenceSchema.pick({ levels: true, lots: true,
  journals: true, buildReservations: true, canonicalResources: true, canonicalClaimCount: true, canonicalClaimHash: true });

export class CutoverReconstructionError extends Error {
  constructor(readonly code: string, message: string, readonly context: Record<string, unknown> = {}) { super(message); this.name = "CutoverReconstructionError"; }
}

/** No connection checkout, commit, rollback, stock correction, COGS rewrite or publication. */
export class PostgresInventoryCutoverReconstructionRepository implements InventoryCutoverReconstructionStore {
  constructor(private readonly inventoryWriter: CanonicalClaimInventoryMutationPort = new PostgresCanonicalClaimInventoryRepository(),
    private readonly promiseWriter: InventoryCutoverLegacyPromisePort = new PostgresInventoryCutoverLegacyPromiseRepository()) {}

  async capture(client: PoolClient): Promise<CutoverReconstructionEvidence> {
    await captureInventoryCutoverStage("transaction_guard", async () => {
      const transaction = (await client.query(`SELECT current_setting('transaction_isolation') AS isolation,
        current_setting('transaction_read_only') AS readonly`)).rows[0];
      if (!(transaction?.readonly === "on" && ["repeatable read","serializable"].includes(transaction.isolation))) {
        await assertInventoryCutoverFenceHeldInsideTransaction(client);
      }
    });
    const inventory = await captureInventoryCutoverStage("inventory_custody", async () =>
      inventoryCaptureSchema.parse(await readInventoryCutoverReconstruction(client)));
    const residual = inventory.journals.filter((row) => BigInt(row.reservedQty) !== BigInt(0) || BigInt(row.pickedQty) !== BigInt(0));
    const wms = await captureInventoryCutoverStage("wms_demand_and_packages", () => readWmsCutoverReconstruction(client,
      [...new Set(residual.flatMap((row) => row.orderId == null ? [] : [row.orderId]))],
      [...new Set(residual.flatMap((row) => row.orderItemId == null ? [] : [row.orderItemId]))]));
    const variants = await captureInventoryCutoverStage("variant_identity", async () => {
      const rows = (await client.query(`SELECT id, product_id AS "productId", sku, is_active AS "isActive",
      requires_shipping AS "requiresShipping", COALESCE(track_inventory,true) AS "trackInventory", sales_eligibility AS "salesEligibility"
      FROM catalog.product_variants WHERE upper(sku)=ANY($1::text[]) ORDER BY id LIMIT 100001`,
      [[...new Set(wms.items.map((item) => item.sku.toUpperCase()))]])).rows;
      if (rows.length > 100_000) throw new CutoverReconstructionError("CUTOVER_VARIANT_CENSUS_LIMIT_EXCEEDED", "Variant evidence exceeds the complete bounded census.");
      return rows;
    });
    const costs = await captureInventoryCutoverStage("original_costs", () => readCutoverOriginalCosts(client, wms.items.map((item) => item.id)));
    const oms = await captureInventoryCutoverStage("oms_demand_and_receipts", () => readOmsCutoverReconstruction(client));
    const shipmentReviews = await captureInventoryCutoverStage("shipment_reviews", () => readWmsCutoverShipmentReviews(client));
    return captureInventoryCutoverStage("evidence_validation", async () => cutoverReconstructionEvidenceSchema.parse({
      schemaVersion: "inventory_cutover_reconstruction_v1", ...inventory, ...wms, ...oms,
      variants, costs, shipmentReviewEvidence: [...oms.shipmentReviewEvidence, ...shipmentReviews] }));
  }

  async preview(client: PoolClient): Promise<CutoverReconstructionPlan> { return this.resolvePlan(client, await this.capture(client)); }

  private async resolvePlan(client: PoolClient, evidence: CutoverReconstructionEvidence): Promise<CutoverReconstructionPlan> {
    const opening = await loadLatestCutoverOpening(client);
    if (!opening) return planCutoverReconstruction(evidence);
    const authority = (await client.query(`SELECT authority, revision::text AS revision
      FROM inventory.availability_runtime_authority WHERE singleton_key=true`)).rows;
    if (authority.length !== 1 || authority[0].authority !== "legacy"
      || authority[0].revision !== opening.saved.authorityRevision
      || reconstructionEvidenceHash(evidence) !== opening.saved.sourceEvidenceHash) {
      const strict = planCutoverReconstruction(evidence);
      return { ...strict, ready: false, orders: [], legacyPromiseReleases: [], blockers: [...strict.blockers, {
        code: "CUTOVER_OPENING_EVIDENCE_CHANGED", subject: `opening:${opening.saved.id}`,
        message: "The selected opening verification is stale. Independently verify the current snapshot; no older verification or strict-mode fallback is selected automatically.",
      }] };
    }
    // The reader verifies immutable request/result/evidence hashes and rebuilds
    // this plan from the original verified facts. Current source equality above
    // binds it to this transaction; no inventory or historical row is changed.
    const plan = structuredClone(opening.assessment.plan);
    plan.openingBalance = { ...plan.openingBalance!, snapshotId: opening.saved.id };
    return plan;
  }

  async persistReviewed(client: PoolClient, rawCommand: CutoverReconstructionCommit, expectedImpactHash: string): Promise<CutoverReconstructionReceipt> {
    const command = cutoverReconstructionCommitSchema.parse(rawCommand);
    if (!/^[0-9a-f]{64}$/.test(expectedImpactHash)) throw new CutoverReconstructionError("CUTOVER_IMPACT_HASH_INVALID", "Reviewed fresh-demand impact hash is required.");
    await assertInventoryCutoverFenceHeldInsideTransaction(client);
    const request = { ...command, expectedImpactHash };
    const replay = (await client.query(`SELECT evidence_hash,impact_hash,request_hash,result_hash,request_payload,result_payload
      FROM inventory.availability_cutover_reconstruction_receipts WHERE activation_run_id=$1`, [command.activationRunId])).rows[0];
    if (replay) {
      const { expectedImpactHash: originalImpactHash, ...originalFields } = replay.request_payload;
      const originalCommand = cutoverReconstructionCommitSchema.parse(originalFields);
      const originalResult = cutoverReconstructionReceiptSchema.parse(replay.result_payload);
      if (reconstructionHash(replay.request_payload) !== replay.request_hash || reconstructionHash(replay.result_payload) !== replay.result_hash
        || replay.evidence_hash !== command.expectedEvidenceHash || replay.impact_hash !== expectedImpactHash
        || originalImpactHash !== replay.impact_hash || originalCommand.expectedEvidenceHash !== replay.evidence_hash
        || originalResult.evidenceHash !== replay.evidence_hash
        || replay.request_payload.activationRunId !== command.activationRunId
        || replay.request_payload.runtimeAuthorityRevision !== command.runtimeAuthorityRevision) {
        throw new CutoverReconstructionError("CUTOVER_RECONSTRUCTION_REPLAY_CONFLICT", "Reconstruction receipt does not match original reviewed business evidence.");
      }
      return originalResult;
    }
    const evidence = await this.capture(client);
    const reconstruction = await this.resolvePlan(client, evidence);
    if (reconstruction.evidenceHash !== command.expectedEvidenceHash) throw new CutoverReconstructionError("CUTOVER_RECONSTRUCTION_EVIDENCE_CHANGED", "Demand, custody, lot costs or independent build ownership changed since review.");
    if (!reconstruction.ready) throw new CutoverReconstructionError("CUTOVER_RECONSTRUCTION_BLOCKED", "Current ownership evidence does not support safe canonical adoption.", { blockers: reconstruction.blockers });
    const targetIds = [...new Set(reconstruction.orders.flatMap((order) => order.lines.map((line) => line.targetVariantId)))].sort((a,b) => a-b);
    if (targetIds.length > 500) throw new CutoverReconstructionError("CUTOVER_CLAIM_TARGET_LIMIT_EXCEEDED", "Full demand exceeds the current complete claim snapshot bound; no targets are truncated.");
    const planning = targetIds.length === 0 ? { orders: [], freshReservationsByLevel: [],
      impactHash: reconstructionHash({ evidenceHash: reconstruction.evidenceHash, freshReservationsByLevel: [], orders: [] }) }
      : planFreshCutoverClaims(await captureActiveClaimSupplySnapshotInsideTransaction(client, targetIds), reconstruction);
    if (planning.impactHash !== expectedImpactHash) throw new CutoverReconstructionError("CUTOVER_FRESH_DEMAND_IMPACT_CHANGED", "Canonical remaining-demand allocation changed from reviewed preview.");
    const legacyPromiseReleaseTransactionIds = reconstruction.legacyPromiseReleases.length === 0 ? []
      : await this.promiseWriter.releaseForReplanning({ client, command, releases: reconstruction.legacyPromiseReleases });
    const claimIds: string[] = [];
    for (const order of planning.orders) claimIds.push(await persistReconstructedCutoverClaim(client, this.inventoryWriter, order, command));
    const receipt = cutoverReconstructionReceiptSchema.parse({ evidenceHash: reconstruction.evidenceHash, claimIds,
      ...(reconstruction.openingBalance ? { openingBalance: reconstruction.openingBalance } : {}),
      orderIds: reconstruction.orders.map((order) => order.orderId), retainedIndependentBuildReservationIds: reconstruction.retainedIndependentBuildReservationIds,
      ...(reconstruction.legacyPromiseReleases.length > 0 ? { legacyPromiseReleases: reconstruction.legacyPromiseReleases,
        legacyPromiseReleaseTransactionIds } : {}) });
    await client.query(`INSERT INTO inventory.availability_cutover_reconstruction_receipts
      (activation_run_id,evidence_hash,impact_hash,request_hash,result_hash,request_payload,result_payload,evidence_payload,actor,reason,occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11)`, [command.activationRunId,reconstruction.evidenceHash,
      planning.impactHash,reconstructionHash(request),reconstructionHash(receipt),JSON.stringify(request),JSON.stringify(receipt),JSON.stringify(evidence),
      command.actor,command.reason,command.occurredAt]);
    return receipt;
  }
}
