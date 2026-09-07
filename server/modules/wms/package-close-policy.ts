import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  packageCloseActorSchema,
  packageCloseCommandSchema,
  packageCloseDecisionSchema,
  packageCloseEvidenceSchema,
  type PackageCloseActor,
  type PackageCloseBlocker,
  type PackageCloseDecision,
  type PackageCloseEvidence,
} from "@shared/warehouse-package-close";
import { normalizeTrackingNumber } from "../shipping/carrier-tracking.domain";

/** Canonical ordering only; parsing creates new objects and never mutates owner evidence. */
function normalizeEvidence(raw: unknown): PackageCloseEvidence {
  const evidence = packageCloseEvidenceSchema.parse(raw);
  evidence.labels.sort((left, right) => {
    if (BigInt(left.id) !== BigInt(right.id)) return BigInt(left.id) < BigInt(right.id) ? -1 : 1;
    return left.revision - right.revision || compareCanonical(left, right);
  });
  evidence.lines.sort((left, right) => left.sourceShipmentItemId - right.sourceShipmentItemId || compareCanonical(left, right));
  return evidence;
}

function compareCanonical(left: unknown, right: unknown): number {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function evidenceHash(evidence: PackageCloseEvidence): string {
  return createHash("sha256").update(canonicalJson(evidence)).digest("hex");
}

function packageBlockers(evidence: PackageCloseEvidence, actor: PackageCloseActor): Set<PackageCloseBlocker> {
  const blockers = new Set<PackageCloseBlocker>();
  if (evidence.authorityMode !== "live") blockers.add("PACKAGE_AUTHORITY_UNAVAILABLE");
  if (!evidence.contentsComplete || evidence.lines.length === 0) blockers.add("PACKAGE_CONTENTS_UNPROVEN");
  if (evidence.cancelled) blockers.add("PACKAGE_CANCELLED");
  if (evidence.currentCloseReceiptId !== null) blockers.add("PACKAGE_ALREADY_CLOSED");
  if (evidence.carrierPossessionConfirmed) blockers.add("CARRIER_ALREADY_HAS_PACKAGE");
  if (actor.warehouseId !== evidence.warehouseId) blockers.add("PACKAGE_SCOPE_MISMATCH");
  if (!actor.canPack) blockers.add("PACKING_NOT_AUTHORIZED");
  if (actor.actorId !== actor.assignedActorId) blockers.add("PACKING_WORKER_MISMATCH");
  if (!actor.stationEnabled || !actor.stationSupportsPacking) blockers.add("PACKING_STATION_UNAVAILABLE");

  const sources = new Set<number>();
  const orderLines = new Set<number>();
  for (const line of evidence.lines) {
    if (sources.has(line.sourceShipmentItemId)) blockers.add("PACKAGE_SOURCE_DUPLICATE");
    sources.add(line.sourceShipmentItemId);
    // Until the owner supplies a source-specific pick allocation, an order-line
    // picked total cannot safely authorize two distinct shipment source lines.
    if (orderLines.has(line.orderItemId)) blockers.add("PACKAGE_ORDER_LINE_AMBIGUOUS");
    orderLines.add(line.orderItemId);
    if (line.warehouseId !== evidence.warehouseId) blockers.add("PACKAGE_SCOPE_MISMATCH");
    if (line.held || line.cancelled || !line.requiresShipping) blockers.add("PACKAGE_LINE_INELIGIBLE");
    const required = BigInt(line.quantity) + BigInt(line.otherClosedQuantity);
    if (required > BigInt(line.authorizedSourceQuantity)) blockers.add("PACKAGE_QUANTITY_EXCEEDS_AUTHORITY");
    if (required > BigInt(line.pickedQuantity)) blockers.add("PACKAGE_QUANTITY_NOT_PICKED");
  }

  const activeLabels = evidence.labels.filter((label) => label.status === "active");
  if (activeLabels.length === 0) blockers.add("PACKAGE_LABEL_MISSING");
  if (activeLabels.length > 1) blockers.add("PACKAGE_LABEL_AMBIGUOUS");
  for (const label of activeLabels) {
    if (label.provider !== evidence.provider || label.providerAccountId !== evidence.providerAccountId
      || label.providerPackageId !== evidence.providerPackageId) blockers.add("PACKAGE_LABEL_IDENTITY_MISMATCH");
    if (label.direction !== "outbound") blockers.add("PACKAGE_LABEL_NOT_OUTBOUND");
  }
  return blockers;
}

function decision(evidence: PackageCloseEvidence, blockers: Set<PackageCloseBlocker>): PackageCloseDecision {
  return packageCloseDecisionSchema.parse({
    contractVersion: 1,
    packageId: evidence.packageId,
    evidenceHash: evidenceHash(evidence),
    eligible: blockers.size === 0,
    blockers: [...blockers].sort(),
  });
}

/** Pure preflight. Eligible is NOT a receipt or permission to bypass owner locking. */
export function previewPackageClose(rawEvidence: unknown, rawActor: unknown): PackageCloseDecision {
  const evidence = normalizeEvidence(rawEvidence);
  return decision(evidence, packageBlockers(evidence, packageCloseActorSchema.parse(rawActor)));
}

/**
 * Re-evaluate from freshly fenced owner facts before appending a close receipt.
 * No time, database, inventory, label purchase, allocation, or dispatch effects.
 * Receipt replay must be handled by the application BEFORE attempting a new close.
 */
export function evaluatePackageClose(rawEvidence: unknown, rawActor: unknown, rawCommand: unknown): PackageCloseDecision {
  const evidence = normalizeEvidence(rawEvidence);
  const actor = packageCloseActorSchema.parse(rawActor);
  const command = packageCloseCommandSchema.parse(rawCommand);
  const blockers = packageBlockers(evidence, actor);
  if (command.packageId !== evidence.packageId) blockers.add("PACKAGE_COMMAND_IDENTITY_MISMATCH");
  if (command.expectedEvidenceHash !== evidenceHash(evidence)) blockers.add("PACKAGE_EVIDENCE_CHANGED");
  const label = evidence.labels.find((candidate) => candidate.id === command.labelId
    && candidate.status === "active" && candidate.revision === command.expectedLabelRevision);
  if (!label) {
    blockers.add("PACKAGE_LABEL_CHANGED");
  } else {
    try {
      if (normalizeTrackingNumber(command.scannedTrackingNumber) !== label.normalizedTrackingNumber)
        blockers.add("PACKAGE_TRACKING_MISMATCH");
    } catch {
      // The existing normalizer rejects a scan with no usable tracking identity.
      blockers.add("PACKAGE_TRACKING_MISMATCH");
    }
  }
  return decision(evidence, blockers);
}
