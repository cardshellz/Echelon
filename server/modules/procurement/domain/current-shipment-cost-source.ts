import { costSourceRevisionSchema, type CostIssue } from "@shared/procurement/cost-source-contracts";

type ShipmentCostSourceIdentity = {
  lineId: number;
  shipmentId: number;
  contract: unknown;
};
type ShipmentCostSourceReadRequirement =
  | { needsCurrentFingerprint: false; issue: CostIssue | null }
  | { needsCurrentFingerprint: true; savedFingerprint: string };

/** Keep the decision to read live source evidence beside the source policy.
 * Historical exception acceptance separately requires current evidence even
 * when the saved contract already contains an issue. */
export function shipmentCostSourceReadRequirement(input: ShipmentCostSourceIdentity): ShipmentCostSourceReadRequirement {
  // Before the first revision/application exists, the consumer reports pending.
  if (input.contract == null) return { needsCurrentFingerprint: false, issue: null };
  const parsed = costSourceRevisionSchema.safeParse(input.contract);
  if (!parsed.success) return { needsCurrentFingerprint: false, issue: {
    code: "COST_SOURCE_EVIDENCE_INVALID", message: "The saved cost source could not be verified. Review its evidence before updating costs.",
  } };
  const source = parsed.data;
  if (source.component !== "landed" || source.scope.kind !== "shipment_line"
    || source.scope.inboundShipmentLineId !== input.lineId || source.scope.inboundShipmentId !== input.shipmentId) return { needsCurrentFingerprint: false, issue: {
    code: "COST_SOURCE_IDENTITY_MISMATCH", message: "The saved cost source does not match this shipment line. Review its evidence.",
  } };
  if (source.issue) return { needsCurrentFingerprint: false, issue: source.issue };
  return { needsCurrentFingerprint: true, savedFingerprint: source.fingerprint };
}

/** The latest saved revision is not necessarily today's source. Equal amounts
 * alone cannot prove that changed allocation, supplier or invoice inputs match. */
export function currentShipmentCostSourceIssue(input: ShipmentCostSourceIdentity & {
  currentFingerprint: string | undefined;
}): CostIssue | null {
  const requirement = shipmentCostSourceReadRequirement(input);
  if (!requirement.needsCurrentFingerprint) return requirement.issue;
  if (requirement.savedFingerprint !== input.currentFingerprint) return {
    code: "COST_UPDATE_OUTDATED", message: "Shipment charges, allocation or source evidence changed. Review the current split, then update costs.",
  };
  return null;
}
