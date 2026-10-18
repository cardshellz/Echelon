import {
  type OriginRepairChoices,
  type OriginRepairContext,
} from "@shared/procurement/cost-origin-repair";
import { costInteger } from "../../inventory/infrastructure/cost-evidence-values";
export interface OriginRepairFacts {
  lot: Record<string, unknown>;
  source: {
    purchaseOrderLine: Record<string, unknown>;
    approvedInvoices: Record<string, unknown>[];
  } | null;
  receipts: Record<string, unknown>[];
  shipments: Record<string, unknown>[];
  origins: Record<string, unknown>[];
  siblings: Record<string, unknown>[];
  approval: OriginRepairContext["approval"];
}

export class OriginRepairError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}
export function originRepairBlocker(facts: OriginRepairFacts): string | null {
  const { lot, receipts, shipments, origins, siblings, source, approval } =
    facts;
  if (approval)
    return "This cost origin has already been repaired. The saved approval is shown below.";
  if (
    origins.some((row) => Number(row.inventory_lot_id) === Number(lot.id)) ||
    lot.has_contribution
  )
    return "This lot already has cost lineage. Use its existing cost history instead of creating a second origin.";
  if (!source || source.approvedInvoices.length !== 1)
    return "This repair needs one approved supplier invoice covering the PO line. Resolve the invoice coverage first.";
  if (receipts.length !== 1 || siblings.length !== 1 || shipments.length !== 1)
    return "A unique receipt line, original lot and shipment line must identify this receipt before an origin can be reconstructed.";
  const line = receipts[0];
  if (
    lot.receipt_status !== "closed" ||
    lot.receipt_shipment_id !== lot.inbound_shipment_id ||
    line.reversed ||
    Number(line.reversed_qty ?? 0) !== 0 ||
    Number(line.damaged_qty ?? 0) !== 0 ||
    Number(line.received_qty) !== Number(lot.qty_received) ||
    Number(lot.qty_received) <= 0
  )
    return "The receipt quantity, shipment or reversal evidence conflicts with this original lot.";
  if (
    Number(lot.qty_on_hand) !== 0 ||
    Number(lot.qty_reserved) !== 0 ||
    Number(lot.qty_picked) !== 0 ||
    Number(lot.qty_packed ?? 0) !== 0 ||
    lot.has_cogs ||
    lot.has_legacy_cogs ||
    lot.protected ||
    lot.cost_source === "manual"
  )
    return "This lot has stock, commitments, protected costs or recorded order costs. Those records must be reconciled before a historical expense can be approved.";
  if (
    line.cost_source_kind != null ||
    line.cost_source_evidence != null ||
    line.units_per_variant_snapshot != null ||
    line.inbound_shipment_line_id != null
  )
    return "This receipt already has cost-source evidence. Review the conflicting evidence rather than replacing it.";
  return null;
}
export function validateOriginRepair(
  facts: OriginRepairFacts,
  choices: OriginRepairChoices,
): void {
  const blocker = originRepairBlocker(facts);
  if (blocker)
    throw new OriginRepairError("COST_ORIGIN_REPAIR_BLOCKED", blocker);
  const source = facts.source!;
  const invoice = source.approvedInvoices[0];
  const basePieces = costInteger(
    source.purchaseOrderLine.received_qty,
    "receivedPieces",
    1,
  );
  if (
    invoice.currency !== "USD" ||
    source.purchaseOrderLine.currency !== "USD" ||
    costInteger(invoice.qty_invoiced, "invoiceQty", 1) !== basePieces ||
    BigInt(choices.productMills) + BigInt(choices.packagingMills) !==
      BigInt(costInteger(invoice.line_total_cents, "invoiceAmount")) *
        BigInt(100)
  )
    throw new OriginRepairError(
      "COST_ORIGIN_REPAIR_INVOICE",
      "The confirmed product and packaging amounts must equal the complete USD supplier invoice line, with full received quantity coverage.",
    );
  let end = BigInt(0);
  for (const origin of facts.origins) {
    if (BigInt(String(origin.purchase_start_base_piece)) !== end)
      throw new OriginRepairError(
        "COST_ORIGIN_REPAIR_INTERVAL",
        "Existing receipt cost intervals are incomplete or overlap. They cannot be replaced by this repair.",
      );
    end +=
      BigInt(costInteger(origin.received_variant_qty, "origin.quantity", 1)) *
      BigInt(costInteger(origin.units_per_variant_snapshot, "origin.units", 1));
  }
  const pieces =
    BigInt(costInteger(facts.lot.qty_received, "lot.quantity", 1)) *
    BigInt(choices.unitsPerCase);
  if (end + pieces !== BigInt(basePieces))
    throw new OriginRepairError(
      "COST_ORIGIN_REPAIR_COVERAGE",
      "The repaired receipt plus the existing receipt origins must exactly cover the PO's received pieces. Check the pieces per case.",
    );
  if (
    facts.origins.some(
      (origin) =>
        Number(origin.inbound_shipment_line_id) ===
        Number(facts.shipments[0].id),
    )
  )
    throw new OriginRepairError(
      "COST_ORIGIN_REPAIR_SHIPMENT",
      "This shipment line already has a different original receipt. Its quantity needs a separate reconciliation.",
    );
}
