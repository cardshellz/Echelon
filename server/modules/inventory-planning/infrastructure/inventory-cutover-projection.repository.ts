import type { PoolClient } from "pg";
import type { InventoryCutoverReview, InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";
import type { SupplySnapshotDto } from "@shared/types/inventory-availability-planner";
import { planInventoryChannelExposureProduct } from "../application/inventory-channel-exposure-runtime.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { parseSupplySnapshot, sealSupplySnapshot } from "../domain/inventory-availability-planner";
import { planFreshCutoverClaims, projectCutoverPromiseReservations } from "../domain/inventory-cutover-reconstruction-planning";
import { captureProposedClaimSupplySnapshotInsideTransaction, captureProposedSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";
import { loadManagedSellableVariantIds, loadProposedPublicationTargetsForCutover } from "./inventory-channel-exposure-runtime.repository";
import { PostgresInventoryCutoverReconstructionRepository } from "./inventory-cutover-reconstruction.repository";
import { loadLatestCutoverOpening } from "./inventory-cutover-opening.reader";
import { projectVerifiedOpeningSupply } from "../domain/inventory-opening-supply-projection";
type Blocker = InventoryCutoverReview["blockers"][number];

/** Read-only proposed post-reconstruction state, shared by preparation and final review.
 * The supplied run ID is projection provenance, not a claim that it is active.
 */
export async function projectInventoryCutoverStateInsideTransaction(
  client: PoolClient, manifest: InventoryCutoverManifest, activationRunId: string, authorityRevision: string,
) {
  const blockers: Blocker[] = [];
  const reconstruction = await new PostgresInventoryCutoverReconstructionRepository().preview(client);
  blockers.push(...reconstruction.blockers);
  const opening = reconstruction.openingBalance ? await loadLatestCutoverOpening(client) : null;
  if (!opening || opening.saved.id !== reconstruction.openingBalance?.snapshotId) {
    blockers.push({ code: "QUANTITY_VERIFIED_OPENING_REQUIRED", subject: "inventory_quantity",
      message: "Verify the complete current lot/custody opening before cutover. Independently maintained legacy bin and lot totals cannot become the new quantity authority." });
  }
  const targetVariants = [...new Set(reconstruction.orders.flatMap((order) => order.lines.map((line) => line.targetVariantId)))].sort((a, b) => a - b);
  let impactHash = inventoryCutoverEvidenceHash({ evidenceHash: reconstruction.evidenceHash, freshReservationsByLevel: [], orders: [] });
  let additions: Array<{ inventoryLevelId: number; reservedQty: string }> = [];
  let claimsProjected = false;
  if (reconstruction.ready && targetVariants.length > 0) {
    try {
      const claimSnapshot = await captureProposedClaimSupplySnapshotInsideTransaction(client, targetVariants);
      // Accepted demand can include products with no channel listing. Their graph
      // must also be in the operator's manifest before adopting any new promise.
      checkGraphSelections(manifest, claimSnapshot, blockers);
      const fresh = planFreshCutoverClaims(claimSnapshot, reconstruction, opening?.verification ?? null);
      impactHash = fresh.impactHash;
      additions = fresh.freshReservationsByLevel;
      claimsProjected = true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "CUTOVER_FRESH_DEMAND_BLOCKED") {
        blockers.push({ code: error.code, subject: "accepted_demand", message: error.message });
      } else if (error instanceof Error && "code" in error && error.code === "INVALID_CLAIM_TARGETS") {
        blockers.push({ code: "CUTOVER_DEMAND_CENSUS_LIMIT", subject: "accepted_demand", message: error.message });
      } else {
        throw error; // A database/implementation failure is not business readiness evidence.
      }
    }
  }
  const additionalByLevel = new Map(additions.map((row) => [row.inventoryLevelId, BigInt(row.reservedQty)]));
  const publicationRows: InventoryCutoverReview["publicationRows"] = [];
  const stockFingerprints: Array<{ productId: number; fingerprint: string }> = [];
  const configurationEvidence: unknown[] = [];
  for (const productId of manifest.productIds) {
    const recorded = parseSupplySnapshot(await captureProposedSupplySnapshotInsideTransaction(client, productId));
    // Same order as claim planning: verify the promise against RAW counters
    // before projecting lot observations. Blocked claims cannot grant a release.
    const { snapshotFingerprint: _recordedFingerprint, ...recordedContent } = recorded;
    const promiseProjected = claimsProjected
      ? sealSupplySnapshot({ ...recordedContent, inventoryPositions: projectCutoverPromiseReservations(recorded.inventoryPositions, reconstruction.legacyPromiseReleases) })
      : recorded;
    const original = projectVerifiedOpeningSupply(promiseProjected, opening?.verification ?? null);
    stockFingerprints.push({ productId, fingerprint: recorded.snapshotFingerprint });
    checkGraphSelections(manifest, original, blockers);
    const { snapshotFingerprint: _fingerprint, ...content } = original;
    const snapshot = sealSupplySnapshot({ ...content, inventoryPositions: content.inventoryPositions.map((row) => ({
      ...row, reservedQty: (BigInt(row.reservedQty) + (additionalByLevel.get(row.inventoryLevelId) ?? BigInt(0))).toString(),
    })) });
    const variants = await loadManagedSellableVariantIds(client, productId);
    const targets = await loadProposedPublicationTargetsForCutover(client, productId, variants);
    configurationEvidence.push({ productId, variants, targets });
    for (const target of targets) {
      for (const policy of target.policies) checkSelection(manifest, "channel_policy", policy.scopeKey, policy.policyId, policy.definitionHash, blockers);
      if (target.sourceBinding) checkSelection(manifest, "source_binding", String(target.publicationTargetId), target.sourceBinding.bindingId, target.sourceBinding.definitionHash, blockers);
      for (const mapping of target.mappings) checkSelection(manifest, "variant_mapping", `${target.publicationTargetId}:${mapping.productVariantId}`, mapping.mappingId, mapping.definitionHash, blockers);
    }
    // This is an explicit projection of the proposed authority, not a report that
    // the database singleton or target states have changed.
    const projected = planInventoryChannelExposureProduct({
      authority: "canonical", authorityRevision: authorityRevision, activationRunId,
      supplySnapshot: snapshot, managedSellableVariantIds: variants, publicationTargets: targets,
    }, productId);
    for (const target of projected.targets) {
      for (const issue of target.blockers) blockers.push({ code: issue.code, subject: `target:${target.publicationTargetId}`, message: issue.message });
      for (const row of target.rows) {
        for (const issue of row.blockers) blockers.push({ code: issue.code, subject: `target:${target.publicationTargetId}:variant:${row.productVariantId}`, message: issue.message });
        publicationRows.push({ publicationTargetId: target.publicationTargetId, productVariantId: row.productVariantId, desiredQuantity: row.publishedUnits });
      }
    }
  }
  publicationRows.sort((a, b) => a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId);
  return { reconstruction, impactHash, publicationRows, stockFingerprints, configurationEvidence, blockers };
}

function checkSelection(manifest: InventoryCutoverManifest, kind: InventoryCutoverManifest["selections"][number]["kind"], key: string, id: number, hash: string, blockers: Blocker[]): void {
  const selected = manifest.selections.find((row) => row.kind === kind && row.key === key);
  if (!selected || selected.definitionId !== id || selected.definitionHash !== hash) blockers.push({
    code: "CUTOVER_UNREVIEWED_DEFINITION", subject: `${kind}:${key}`, message: "Current planning resolves a definition absent from the reviewed manifest.",
  });
}

function checkGraphSelections(manifest: InventoryCutoverManifest, snapshot: Pick<SupplySnapshotDto, "transformationModels" | "locations" | "safetyPolicies">, blockers: Blocker[]): void {
  for (const model of snapshot.transformationModels) checkSelection(manifest, "model", String(model.productId), model.modelId, model.definitionHash, blockers);
  for (const location of snapshot.locations) if (location.promisePolicy) checkSelection(manifest, "location_policy", String(location.id), location.promisePolicy.policyId, location.promisePolicy.definitionHash, blockers);
  for (const policy of snapshot.safetyPolicies) checkSelection(manifest, "safety_policy", policy.scopeKey, policy.policyId, policy.definitionHash, blockers);
}
