import type { ReactNode } from "react";
import type { PoAmendmentImpact as Impact } from "@shared/procurement/po-amendment-impact";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { CompactPoLineTable } from "@/features/po-edit/CompactPoLineTable";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";

function Comparison({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <CompactPoLineTable aria-label={label} className="min-w-[480px]">
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead className="text-right">Before</TableHead>
          <TableHead className="text-right">After</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>{children}</TableBody>
    </CompactPoLineTable>
  );
}
function Row({
  name,
  before,
  after,
}: {
  name: string;
  before: string;
  after: string;
}) {
  return (
    <TableRow>
      <TableCell className="py-2">{name}</TableCell>
      <TableCell className="py-2 text-right font-mono">{before}</TableCell>
      <TableCell className="py-2 text-right font-mono">{after}</TableCell>
    </TableRow>
  );
}

/** Render the server's measured transaction result, including unresolved work.
 * This component never estimates a second set of financial effects. */
export function PoAmendmentImpact({
  impact,
  currency,
  purchaseOrderId,
}: {
  impact: Impact;
  currency: string;
  purchaseOrderId: number;
}) {
  const navigation = useProcurementNavigation();
  const amount = (value: number | null, places: 2 | 4 = 2) =>
    value === null
      ? "Not recorded"
      : `${exactMoneyAsInput(value, places)} ${currency}`;
  const changedLots = impact.lots.filter(
    (lot) => lot.unitCostMills.before !== lot.unitCostMills.after,
  );
  const changedOrders = impact.orderCosts.filter(
    (cost) => cost.totalMills.before !== cost.totalMills.after,
  );
  const issues = impact.applications.filter(
    (application) => application.status !== "applied",
  );
  return (
    <section
      aria-label="Dependent quantity and cost changes"
      className="space-y-3 border-t pt-3 text-sm"
    >
      <h3 className="font-semibold">Quantity balances and downstream costs</h3>
      {impact.quantities.map((line) => (
        <div key={line.lineId} className="space-y-1">
          <p className="font-medium">{line.name}</p>
          <p className="text-xs text-muted-foreground">
            Actual quantities: {line.received.toLocaleString()} received ·{" "}
            {line.shipped.toLocaleString()} shipped ·{" "}
            {line.invoiced.toLocaleString()} invoiced
          </p>
          <Comparison label="Remaining pieces">
            {(
              [
                ["To receive", line.remainingToReceive],
                ["Available for a new shipment", line.remainingToShip],
                ["To invoice", line.remainingToInvoice],
              ] as const
            ).map(([label, pair]) => (
              <Row
                key={label}
                name={label}
                before={pair.before?.toLocaleString() ?? "Needs review"}
                after={pair.after?.toLocaleString() ?? "Needs review"}
              />
            ))}
          </Comparison>
          {line.shipmentCapacityReview && (
            <p className="text-amber-800">
              {line.shipmentCapacityReview}{" "}
              <a
                className="underline"
                href={navigation.childHref(
                  `/purchase-orders/${purchaseOrderId}?tab=receipts`,
                )}
              >
                Review receiving records
              </a>
            </p>
          )}
        </div>
      ))}
      {impact.shipments.map((shipment) => (
        <details key={shipment.shipmentId} className="rounded border p-2">
          <summary className="cursor-pointer">
            {shipment.shipmentNumber} · shipment charges{" "}
            {amount(shipment.chargeCents)} · {shipment.lines.length} lines
            reviewed
          </summary>
          <p className="my-2 text-xs">
            The full shipment allocation is refreshed, including lines from
            other POs. Actual shipped quantities and the total charge are
            preserved.
          </p>
          <Comparison label="Shipment costs">
            {shipment.lines.flatMap((line) => [
              <Row
                key={`${line.lineId}:charges`}
                name={`${line.name} · allocated charges`}
                before={amount(line.allocatedCents.before)}
                after={amount(line.allocatedCents.after)}
              />,
              <Row
                key={`${line.lineId}:landed`}
                name={`${line.name} · product plus shipment`}
                before={amount(line.landedTotalCents.before)}
                after={amount(line.landedTotalCents.after)}
              />,
            ])}
          </Comparison>
        </details>
      ))}
      <p>
        {changedLots.length} inventory lot cost
        {changedLots.length === 1 ? "" : "s"} and {changedOrders.length}{" "}
        recorded order cost{changedOrders.length === 1 ? "" : "s"} change. Stock
        and sold quantities are preserved.
      </p>
      {(changedLots.length > 0 || changedOrders.length > 0) && (
        <details className="rounded border p-2">
          <summary className="cursor-pointer">
            Inventory and sold-cost changes
          </summary>
          <Comparison label="Cost record">
            {changedLots.map((lot) => (
              <Row
                key={`lot:${lot.lotId}`}
                name={`${lot.lotNumber} · cost per stock unit (${lot.onHandUnits.toLocaleString()} on hand)`}
                before={amount(lot.unitCostMills.before, 4)}
                after={amount(lot.unitCostMills.after, 4)}
              />
            ))}
            {changedOrders.map((cost) => (
              <Row
                key={`order:${cost.costId}`}
                name={`Order #${cost.orderId} · cost record #${cost.costId}`}
                before={amount(cost.totalMills.before, 4)}
                after={amount(cost.totalMills.after, 4)}
              />
            ))}
          </Comparison>
        </details>
      )}
      {impact.historicalCosts.length > 0 && (
        <details className="rounded border p-2">
          <summary className="cursor-pointer">
            Previously approved historical costs
          </summary>
          <p className="my-2 text-xs">
            Existing approval destinations are retained. Any cost change is
            recorded as a new adjustment.
          </p>
          <Comparison label="Historical cost balance">
            {impact.historicalCosts.map((cost, index) => (
              <Row
                key={index}
                name={`${cost.shipmentLineId ? `Shipment line #${cost.shipmentLineId}` : `PO line #${cost.purchaseOrderLineId}`} · ${cost.component} · ${cost.destination === "historical_cogs" ? "cost of goods sold" : "inventory expense"}`}
                before={amount(cost.totalMills.before, 4)}
                after={amount(cost.totalMills.after, 4)}
              />
            ))}
          </Comparison>
        </details>
      )}
      {issues.length > 0 && (
        <div className="rounded border border-amber-300 p-3">
          <p className="font-semibold">Remaining cost work</p>
          <p className="my-1">
            The PO edit can be saved. These costs still require the evidence
            described below.
          </p>
          {issues.map((application, index) => (
            <div className="mt-2" key={index}>
              <p className="font-medium">
                {application.shipmentId
                  ? (impact.shipments.find(
                      (shipment) =>
                        shipment.shipmentId === application.shipmentId,
                    )?.shipmentNumber ?? `Shipment #${application.shipmentId}`)
                  : (impact.quantities.find(
                      (line) => line.lineId === application.purchaseOrderLineId,
                    )?.name ?? `PO line #${application.purchaseOrderLineId}`)}
                {application.shipmentLineId
                  ? ` · line #${application.shipmentLineId}`
                  : ""}{" "}
                ·{" "}
                {
                  {
                    product: "Product cost",
                    packaging: "Packaging cost",
                    landed: "Shipment costs",
                  }[application.component]
                }
              </p>
              {application.issues.map((issue, issueIndex) => (
                <p key={issueIndex}>{issue.message}</p>
              ))}
              <a
                className="underline"
                href={
                  application.shipmentId
                    ? navigation.childHref(
                        `/shipments/${application.shipmentId}?tab=allocation`,
                      )
                    : `${navigation.childHref(`/purchase-orders/${purchaseOrderId}?tab=lines`)}&costReview=1`
                }
              >
                Open cost review
              </a>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
