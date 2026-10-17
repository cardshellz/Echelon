import { costSourceRevisionSchema, type CostIssue } from "@shared/procurement/cost-source-contracts";

/** The latest saved revision is not necessarily today's source. Equal amounts
 * alone cannot prove that changed allocation, supplier or invoice inputs match. */
export function currentShipmentCostSourceIssue(input: {
  lineId: number;
  shipmentId: number;
  contract: unknown;
  currentFingerprint: string | undefined;
}): CostIssue | null {
  // Before the first revision/application exists, the consumer reports pending.
  if (input.contract == null) return null;
  const parsed = costSourceRevisionSchema.safeParse(input.contract);
  if (!parsed.success) return {
    code: "COST_SOURCE_EVIDENCE_INVALID", message: "The saved cost source could not be verified. Review its evidence before updating costs.",
  };
  const source = parsed.data;
  if (source.component !== "landed" || source.scope.kind !== "shipment_line"
    || source.scope.inboundShipmentLineId !== input.lineId || source.scope.inboundShipmentId !== input.shipmentId) return {
    code: "COST_SOURCE_IDENTITY_MISMATCH", message: "The saved cost source does not match this shipment line. Review its evidence.",
  };
  if (source.issue) return source.issue;
  if (source.fingerprint !== input.currentFingerprint) return {
    code: "COST_UPDATE_OUTDATED", message: "Shipment charges, allocation or source evidence changed. Review the current split, then update costs.",
  };
  return null;
}
