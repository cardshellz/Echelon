/** Offline proposal only. No database, provider, saved attestation or apply mode. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openingSourceSchema, openingVerificationSchema, requiredOpeningItems,
  type OpeningSource, type OpeningVerification, type OpeningAssessment } from "../shared/types/inventory-cutover-opening";
import type { CutoverReconstructionBlocker, CutoverReconstructionEvidence } from "../shared/types/inventory-cutover-reconstruction";
import { evaluateCutoverOpening } from "../server/modules/inventory-planning/domain/inventory-cutover-opening";
import { reconstructionEvidenceHash, reconstructionHash } from "../server/modules/inventory-planning/domain/inventory-cutover-reconstruction";

type Level = CutoverReconstructionEvidence["levels"][number];
type Lot = CutoverReconstructionEvidence["lots"][number];
export interface RecordedBinOpeningProposal {
  contractVersion: "inventory_recorded_bin_opening_proposal_v1";
  executable: false;
  sourceEvidenceHash: string;
  quantityBasis: "owner_accepted_recorded_bin_on_hand_not_a_physical_count";
  proposedCustodyTreatment: "retire_unowned_legacy_counters_then_replan_all_current_demand";
  blockers: CutoverReconstructionBlocker[];
  levelChanges: Array<{ before: Level; after: Level }>;
  lotChanges: Array<{ before: Lot; after: Lot }>;
  onHandValueDeltaMills: string;
  candidate: OpeningVerification | null;
  assessment: OpeningAssessment | null;
}

/** This proposes a NEW opening, never claims to reconstruct historical picks.
 * Every current customer line must be unstarted; any current picked/build/claim
 * custody stops the bulk proposal. Historical counters are listed as explicit
 * proposed retirements, not silently released or added back to on-hand stock. */
export function proposeRecordedBinOpening(raw: OpeningSource): RecordedBinOpeningProposal {
  const source = openingSourceSchema.parse(raw), evidence = source.evidence;
  assert.equal(source.evidenceHash, reconstructionEvidenceHash(evidence), "Source evidence changed");
  const result: RecordedBinOpeningProposal = { contractVersion: "inventory_recorded_bin_opening_proposal_v1",
    executable: false, sourceEvidenceHash: source.evidenceHash,
    quantityBasis: "owner_accepted_recorded_bin_on_hand_not_a_physical_count",
    proposedCustodyTreatment: "retire_unowned_legacy_counters_then_replan_all_current_demand",
    blockers: [], levelChanges: [], lotChanges: [], onHandValueDeltaMills: "0", candidate: null, assessment: null };
  const block = (code: string, subject: string, message: string) => result.blockers.push({ code, subject, message });
  if (source.runtimeAuthority !== "legacy" || evidence.canonicalClaimCount !== "0" || evidence.canonicalResources.length) {
    block("BIN_OPENING_EXISTING_AUTHORITY", "authority", "Existing canonical ownership cannot be replaced by a bin-baseline proposal.");
  }
  if (evidence.buildReservations.length || evidence.buildDemands.some(row => ["planning", "awaiting_build"].includes(row.status))) {
    block("BIN_OPENING_ACTIVE_BUILD", "builds", "Current build demand/custody requires an explicit owner-preserving handoff.");
  }
  const owners = requiredOpeningItems(evidence);
  for (const item of owners) if (item.pickedQuantity !== 0 || item.fulfilledQuantity !== 0) {
    block("BIN_OPENING_CURRENT_CUSTODY", `order-item:${item.id}`, "This current line is not unstarted. Preserve its exact physical and cost ownership.");
  }
  const position = (location: number | null, variant: number) => `${location}:${variant}`;
  const levelByPosition = new Map<string, Level>();
  const lotsByPosition = new Map<string, Lot[]>();
  for (const level of evidence.levels) {
    const key = position(level.warehouseLocationId, level.productVariantId);
    if (levelByPosition.has(key)) block("BIN_OPENING_DUPLICATE_POSITION", key, "Bin identity is ambiguous.");
    levelByPosition.set(key, level);
    if (BigInt(level.variantQty) < BigInt(0) || level.warehouseId === null || level.packedQty !== "0") {
      block("BIN_OPENING_POSITION_REVIEW", `level:${level.id}`, "Negative on-hand, missing warehouse, or packed custody cannot be translated by this proposal.");
    }
  }
  const lots = evidence.lots.map(lot => ({ ...lot, reservedQty: "0", pickedQty: "0" }));
  for (const lot of lots) {
    const key = position(lot.warehouseLocationId, lot.productVariantId), rows = lotsByPosition.get(key) ?? [];
    rows.push(lot); lotsByPosition.set(key, rows);
    if (!levelByPosition.has(key) && lot.onHandQty !== "0") {
      block("BIN_OPENING_UNLOCATED_STOCK", `lot:${lot.id}`, "Nonzero on-hand has no matching bin; a location or quantity cannot be invented.");
    }
  }
  for (const [key, level] of levelByPosition) {
    const rows = lotsByPosition.get(key) ?? [];
    const total = rows.reduce((sum, lot) => sum + BigInt(lot.onHandQty), BigInt(0));
    const delta = BigInt(level.variantQty) - total;
    if (delta === BigInt(0)) continue;
    const positiveLots = rows.filter(lot => BigInt(lot.onHandQty) > BigInt(0));
    // Quantity choice is already bin-authoritative. Cost-layer choice is not:
    // only a single existing positive layer permits a non-arbitrary proposal.
    if (positiveLots.length !== 1 || BigInt(positiveLots[0].onHandQty) + delta < BigInt(0)) {
      block("BIN_OPENING_COST_LAYER_AMBIGUOUS", `level:${level.id}`, "The bin quantity is settled, but its changed quantity cannot be assigned to one exact existing cost layer.");
      continue;
    }
    positiveLots[0].onHandQty = (BigInt(positiveLots[0].onHandQty) + delta).toString();
    result.onHandValueDeltaMills = (BigInt(result.onHandValueDeltaMills) + delta * BigInt(positiveLots[0].unitCostMills)).toString();
  }
  if (result.blockers.length) return result;
  // PROPOSAL ONLY: using the observed capture time here is deterministic and
  // does not attest to a fresh physical count or authorize custody retirement.
  const candidate = openingVerificationSchema.parse({ contractVersion: "inventory_cutover_opening_v2",
    expectedEvidenceHash: source.evidenceHash, expectedAuthorityRevision: source.authorityRevision,
    expectedConfigurationRunId: source.configurationRunId,
    verificationReference: "PROPOSAL ONLY. Owner-accepted recorded bin on-hand; not a physical count. Legacy custody-counter retirement still requires explicit approval.",
    verificationEvidenceHash: reconstructionHash({ basis: result.quantityBasis, treatment: result.proposedCustodyTreatment, sourceEvidenceHash: source.evidenceHash }),
    verifiedAt: source.capturedAt, historicalDisposition: "preserve_unresolved", levels: evidence.levels, lots,
    owners: owners.map(item => ({ orderId: item.orderId, orderItemId: item.id, remainingQty: String(item.quantity),
      reservedQty: "0", pickedQty: "0", allocations: [] })) });
  result.candidate = candidate;
  const levelsById = new Map(evidence.levels.map(level => [level.id, level]));
  result.levelChanges = candidate.levels.flatMap(after => {
    const before = levelsById.get(after.id)!;
    return reconstructionHash(before) === reconstructionHash(after) ? [] : [{ before, after }];
  });
  result.lotChanges = candidate.lots.flatMap((after, index) => {
    const before = evidence.lots[index];
    return reconstructionHash(before) === reconstructionHash(after) ? [] : [{ before, after }];
  });
  result.assessment = evaluateCutoverOpening(evidence, candidate);
  result.blockers = result.assessment.blockers;
  return result;
}

function main(args: readonly string[]): void {
  const [sourceFile, sourceHash, outputFile, extra] = args;
  assert.ok(sourceFile && /^[a-f0-9]{64}$/.test(sourceHash ?? "") && outputFile && !extra,
    "Usage: propose-inventory-cutover-bin-opening <capture> <sha256> <new-output-file>");
  const raw = readFileSync(resolve(sourceFile));
  assert.equal(createHash("sha256").update(raw).digest("hex"), sourceHash, "Capture fingerprint changed");
  const proposal = proposeRecordedBinOpening(openingSourceSchema.parse(JSON.parse(raw.toString("utf8")).source));
  const bytes = JSON.stringify(proposal, null, 2) + "\n";
  writeFileSync(resolve(outputFile), bytes, { flag: "wx" });
  const blockerGroups = proposal.blockers.reduce<Record<string, number>>((groups, blocker) => {
    groups[blocker.code] = (groups[blocker.code] ?? 0) + 1; return groups;
  }, {});
  console.log(JSON.stringify({ outputFile: resolve(outputFile), sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: false, productionWrites: false, blockerGroups, levelChanges: proposal.levelChanges.length,
    lotChanges: proposal.lotChanges.length, onHandValueDeltaMills: proposal.onHandValueDeltaMills,
    requiredCurrentOwners: proposal.candidate?.owners.length, historicalExceptions: proposal.assessment?.historicalExceptions.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(JSON.stringify({ code: "BIN_OPENING_PROPOSAL_FAILED", message: error instanceof Error ? error.message : "Unknown error" })); process.exitCode = 1; }
}
