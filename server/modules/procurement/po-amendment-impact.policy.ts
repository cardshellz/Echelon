import {
  poAmendmentImpactSchema,
  type PoAmendmentImpact,
} from "@shared/procurement/po-amendment-impact";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import {
  LotCostError,
  moneyToSafeNumber,
  normalizeLotCosts,
} from "../inventory/domain/lot-cost";
import type { AmendmentPlan } from "./po-quantity-amendment.policy";
import type { PoAmendmentDependencies } from "./po-amendment-dependencies.repository";

type Row = Record<string, unknown>;
const integer = (value: unknown) =>
  costInteger(value, "recorded quantity or money", -Number.MAX_SAFE_INTEGER);
const sum = (rows: Row[], field: string) =>
  moneyToSafeNumber(
    rows.reduce((total, row) => total + BigInt(integer(row[field])), BigInt(0)),
    field,
  );
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

export function buildPoAmendmentImpact(
  plan: Pick<AmendmentPlan, "preview">,
  before: PoAmendmentDependencies,
  after: PoAmendmentDependencies,
  applications: PoAmendmentImpact["applications"],
): PoAmendmentImpact {
  const quantities = plan.preview.lines
    .filter((line) => line.before.lineType === "product")
    .map(({ before: old, after: next }) => {
      const shipped = sum(
        before.shipmentLines.filter(
          (line) => integer(line.purchase_order_line_id ?? 0) === old.id,
        ),
        "qty_shipped",
      );
      const pair = (actual: number) => ({
        before: Math.max(0, old.orderQty - actual),
        after: Math.max(0, next.orderQty - actual),
      });
      const oldCapacity = before.shipmentCapacity.find(
          (row) => row.lineId === old.id,
        ),
        newCapacity = after.shipmentCapacity.find(
          (row) => row.lineId === old.id,
        );
      return {
        lineId: old.id,
        name: old.name,
        ordered: { before: old.orderQty, after: next.orderQty },
        received: old.receivedQty,
        shipped,
        invoiced: old.invoicedQty,
        remainingToReceive: pair(old.receivedQty),
        remainingToShip: {
          before: oldCapacity?.remainingPieces ?? null,
          after: newCapacity?.remainingPieces ?? null,
        },
        shipmentCapacityReview: newCapacity?.reviewReason ?? null,
        remainingToInvoice: pair(old.invoicedQty),
      };
    });
  const newShipmentLines = new Map(
    after.shipmentLines.map((line) => [integer(line.id), line]),
  );
  const snapshotTotals = (state: PoAmendmentDependencies) =>
    new Map(
      state.snapshots.map((row) => [
        integer(row.inbound_shipment_line_id),
        row.total_landed_cost_cents == null
          ? null
          : integer(row.total_landed_cost_cents),
      ]),
    );
  const oldSnapshots = snapshotTotals(before),
    newSnapshots = snapshotTotals(after);
  const shipments = before.shipments.map((shipment) => {
    const shipmentId = integer(shipment.id);
    const originalCosts = before.costs.filter(
      (cost) => integer(cost.inbound_shipment_id) === shipmentId,
    );
    const charge = (costs: Row[]) =>
      moneyToSafeNumber(
        costs.reduce(
          (total, cost) =>
            total +
            BigInt(integer(cost.actual_cents ?? cost.estimated_cents ?? 0)),
          BigInt(0),
        ),
        "shipment charges",
      );
    const chargeCents = charge(originalCosts);
    if (
      chargeCents !==
      charge(
        after.costs.filter(
          (cost) => integer(cost.inbound_shipment_id) === shipmentId,
        ),
      )
    )
      throw new Error("PO edit changed a shipment charge");
    return {
      shipmentId,
      shipmentNumber: String(shipment.shipment_number),
      status: String(shipment.status),
      chargeCents,
      lines: before.shipmentLines
        .filter((line) => integer(line.inbound_shipment_id) === shipmentId)
        .map((line) => {
          const lineId = integer(line.id),
            next = newShipmentLines.get(lineId);
          if (!next || integer(next.qty_shipped) !== integer(line.qty_shipped))
            throw new Error("PO edit changed actual shipped quantity");
          return {
            lineId,
            purchaseOrderId:
              line.purchase_order_id == null
                ? null
                : integer(line.purchase_order_id),
            name: String(line.sku ?? `Line ${lineId}`),
            shippedPieces: integer(line.qty_shipped),
            allocatedCents: {
              before: integer(line.allocated_cost_cents ?? 0),
              after: integer(next.allocated_cost_cents ?? 0),
            },
            landedTotalCents: {
              before: oldSnapshots.get(lineId) ?? null,
              after: newSnapshots.get(lineId) ?? null,
            },
          };
        }),
    };
  });
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
  return poAmendmentImpactSchema.parse({
    quantities,
    shipments,
    lots,
    orderCosts,
    historicalCosts,
    applications,
  });
}
