import { buildCostDestinationImpact } from "./cost-change-impact";
import {
  poAmendmentImpactSchema,
  type PoAmendmentImpact,
} from "@shared/procurement/po-amendment-impact";
import { costInteger } from "../inventory/infrastructure/cost-evidence-values";
import {
  moneyToSafeNumber,
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
  const destinations = buildCostDestinationImpact(before, after);
  return poAmendmentImpactSchema.parse({
    quantities,
    shipments,
    ...destinations,
    applications,
  });
}
