import { poAmendmentImpactSchema } from "@shared/procurement/po-amendment-impact";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import { LotCostError, moneyToSafeNumber, normalizeLotCosts } from "../inventory/domain/lot-cost";
import type { PoAmendmentDependencies } from "./po-amendment-dependencies.repository";

type Row = Record<string, unknown>;
const integer = (value: unknown) =>
  costInteger(value, "recorded quantity or money", -Number.MAX_SAFE_INTEGER);
function unique(rows: Row[]) {
  return [...new Map(rows.map((row) => [integer(row.id), row])).values()].sort(
    (a, b) => integer(a.id) - integer(b.id),
  );
}
function lotRate(row: Row): number | null {
  try {
    return moneyToSafeNumber(
      normalizeLotCosts(row).totalMills,
      "lot unit cost",
    );
  } catch (error) {
    if (error instanceof LotCostError) return null;
    throw error;
  }
}
function recordedCogs(row: Row): number | null {
  if (row.total_cost_mills == null) return null;
  const mills = integer(row.total_cost_mills);
  // Preserve the COGS owner's existing pre-mills compatibility rule. Do not
  // multiply rounded unit costs back into an extended order amount.
  return mills === 0 && row.total_cost_cents != null
    ? moneyToSafeNumber(
        BigInt(integer(row.total_cost_cents)) * BigInt(100),
        "legacy COGS",
      )
    : mills;
}

/** Shared readback of exact cost-owner results; this never calculates a new
 * allocation or writes inventory. Preview and approval use the same projection. */
export function buildCostDestinationImpact(
  before: Pick<PoAmendmentDependencies, "evidence" | "postings">,
  after: Pick<PoAmendmentDependencies, "evidence" | "postings">,
) {
  const oldLots = unique(before.evidence.flatMap((row) => row.graph.lots));
  const newLots = new Map(
    unique(after.evidence.flatMap((row) => row.graph.lots)).map((row) => [
      integer(row.id),
      row,
    ]),
  );
  const lots = oldLots.map((lot) => {
    const next = newLots.get(integer(lot.id));
    if (
      !next ||
      integer(lot.qty_on_hand) !== integer(next.qty_on_hand) ||
      integer(lot.qty_received) !== integer(next.qty_received)
    )
      throw new Error("PO edit changed inventory quantity");
    return {
      lotId: integer(lot.id),
      lotNumber: String(lot.lot_number),
      onHandUnits: integer(lot.qty_on_hand),
      unitCostMills: { before: lotRate(lot), after: lotRate(next) },
    };
  });
  const oldCogs = unique(before.evidence.flatMap((row) => row.graph.cogs));
  const newCogs = new Map(
    unique(after.evidence.flatMap((row) => row.graph.cogs)).map((row) => [
      integer(row.id),
      row,
    ]),
  );
  const orderCosts = oldCogs.map((cost) => {
    const next = newCogs.get(integer(cost.id));
    if (!next || integer(cost.qty) !== integer(next.qty))
      throw new Error("PO edit changed sold quantity");
    return {
      costId: integer(cost.id),
      orderId: integer(cost.order_id),
      quantity: integer(cost.qty),
      totalMills: { before: recordedCogs(cost), after: recordedCogs(next) },
    };
  });
  const postingKey = (row: Row) =>
    `${row.purchase_order_line_id ?? ""}:${row.inbound_shipment_line_id ?? ""}:${row.component}:${row.destination}`;
  // Rows are read in ID order. Keep the last balance of each immutable posting
  // chain; summing balances would count prior approvals more than once.
  const balances = (rows: Row[]) =>
    new Map(rows.map((row) => [postingKey(row), row]));
  const oldPostings = balances(before.postings),
    newPostings = balances(after.postings);
  const historicalCosts = [
    ...new Set([...oldPostings.keys(), ...newPostings.keys()]),
  ]
    .sort()
    .map((key) => {
      const previous = oldPostings.get(key),
        next = newPostings.get(key),
        row = next ?? previous!;
      return {
        purchaseOrderLineId:
          row.purchase_order_line_id == null
            ? null
            : integer(row.purchase_order_line_id),
        shipmentLineId:
          row.inbound_shipment_line_id == null
            ? null
            : integer(row.inbound_shipment_line_id),
        component: row.component,
        destination: row.destination,
        totalMills: {
          before: integer(previous?.after_mills ?? 0),
          after: integer(next?.after_mills ?? 0),
        },
      };
    });
  return poAmendmentImpactSchema.pick({ lots: true, orderCosts: true, historicalCosts: true }).parse({ lots, orderCosts, historicalCosts });
}
