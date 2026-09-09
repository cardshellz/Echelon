import { useMemo } from "react";
import { SupplierReportHistory } from "./SupplierReportHistory";
import { Link } from "wouter";
import {
  formatPipelineMills,
  type PurchasePipelineCost,
  type PurchasePipelineRow,
} from "@shared/procurement/purchase-pipeline";
import { purchaseWorkspaceInspectHref } from "@/lib/purchase-workspace-selection";
import {
  formatPipelineCurrency,
  formatPipelinePieces,
  summarizePipelineCosts,
  type PipelineMoneySummary,
  type PipelinePurchaseGroup,
} from "./purchase-pipeline-presentation";

const components = [
  { key: "product", label: "Product cost" },
  { key: "packaging", label: "Packaging" },
  { key: "landed", label: "Freight & other" },
] as const;

const costSources: Record<PurchasePipelineCost["source"], string> = {
  purchase_order: "PO line total",
  purchase_quote: "Purchase quote",
  recorded_revision: "Cost revision",
  missing: "Not recorded",
};

function hasKnownAmount(cost: PurchasePipelineCost): boolean {
  return (
    cost.amountMills !== null &&
    (cost.evidence === "confirmed" || cost.evidence === "estimated")
  );
}

function CostAmount({
  cost,
  currency,
}: {
  cost: PurchasePipelineCost | undefined;
  currency: string | null;
}) {
  if (!cost || !hasKnownAmount(cost)) {
    return (
      <span className="text-xs font-normal text-muted-foreground">
        {cost?.evidence === "review_required" ? "Needs review" : "Not recorded"}
      </span>
    );
  }
  return (
    <span
      data-pipeline-money
      className="whitespace-nowrap"
      title={formatPipelineMills(cost.amountMills!, currency)}
    >
      {formatPipelineCurrency(cost.amountMills!, currency)}
    </span>
  );
}

function KnownAmount({ cost }: { cost: PipelineMoneySummary | undefined }) {
  if (!cost || cost.confirmedComponents + cost.estimatedComponents === 0) {
    return (
      <span className="text-xs font-normal text-muted-foreground">
        Not recorded
      </span>
    );
  }
  return (
    <span data-pipeline-money className="whitespace-nowrap">
      {formatPipelineCurrency(cost.knownMills, cost.currency)}
    </span>
  );
}

function ShipmentLink({ row }: { row: PurchasePipelineRow }) {
  if (row.shipmentId === null) return null;
  return (
    <Link
      className="block text-xs text-primary hover:underline"
      href={purchaseWorkspaceInspectHref(
        `/purchase-orders/${row.purchaseOrderId}`,
        "",
        { kind: "shipment", id: row.shipmentId },
      )}
    >
      {row.shipmentNumber ?? `Shipment #${row.shipmentId}`}
    </Link>
  );
}

function LineArrival({ row }: { row: PurchasePipelineRow }) {
  if (row.arrivalBucket === "arrived")
    return (
      <span>
        Delivered
        <span className="block text-xs text-muted-foreground">
          Receipt pending
        </span>
      </span>
    );
  if (row.arrivalDate === null)
    return <span className="text-xs text-muted-foreground">Not scheduled</span>;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(row.arrivalDate));
  return (
    <span
      className={
        row.arrivalBucket === "overdue"
          ? "text-amber-700 dark:text-amber-400"
          : undefined
      }
    >
      {formatted}
      <span className="block text-xs text-muted-foreground">
        {row.arrivalBucket === "overdue" && "Past due · "}
        {row.arrivalDestination === "shipment_destination"
          ? "Shipment ETA"
          : row.arrivalDestination === "warehouse"
            ? "Warehouse ETA"
            : "Arrival estimate"}
      </span>
    </span>
  );
}

type StageLabels = Record<PurchasePipelineRow["stage"], string>;

function CostSourcesAndNotes({
  lines,
  labels,
}: {
  lines: PurchasePipelineRow[][];
  labels: StageLabels;
}) {
  return (
    <details className="border-t px-2 py-2 text-xs">
      <summary className="w-fit cursor-pointer font-medium text-muted-foreground hover:text-foreground">
        Cost sources and notes
      </summary>
      <p className="mt-3 text-muted-foreground">
        Exact values below apply to the outstanding quantities in each row. PO
        line totals and quotes are estimates; recorded revisions retain their
        stated evidence.
      </p>
      {lines.map((rows) => {
        const first = rows[0];
        const issues = [...new Set(rows.flatMap((row) => row.issues))];
        return (
          <div key={first.purchaseOrderLineId} className="mt-4 space-y-2">
            <p className="font-semibold">
              {first.sku ?? first.productName ?? "Product"}
              <span className="ml-2 font-normal text-muted-foreground">
                Line #{first.purchaseOrderLineId}
              </span>
            </p>
            {first.productName && (
              <p className="text-muted-foreground">{first.productName}</p>
            )}
            <div
              className="overflow-x-auto"
              role="region"
              aria-label={`Cost evidence for line ${first.purchaseOrderLineId}`}
              tabIndex={0}
            >
              <table className="w-full min-w-[660px] text-left">
                <thead className="border-b text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Stage / shipment
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Component
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Exact amount
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      Source
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.flatMap((row) =>
                    row.costs.map((cost) => (
                      <tr
                        key={`${row.key}:${cost.component}`}
                        className="border-b last:border-0"
                      >
                        <td className="py-1.5 pr-3 align-top">
                          {labels[row.stage]}
                          {row.shipmentNumber && (
                            <span className="block text-muted-foreground">
                              {row.shipmentNumber}
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 align-top">
                          {
                            components.find(
                              (component) => component.key === cost.component,
                            )?.label
                          }
                        </td>
                        <td className="py-1.5 pr-3 align-top tabular-nums">
                          {hasKnownAmount(cost)
                            ? formatPipelineMills(
                                cost.amountMills!,
                                row.currency,
                              )
                            : cost.evidence === "review_required"
                              ? "Needs review"
                              : "Not recorded"}
                        </td>
                        <td className="py-1.5 align-top">
                          {costSources[cost.source]}
                          {cost.evidence !== "unknown" && (
                            <span className="ml-1 text-muted-foreground">
                              · {cost.evidence.replaceAll("_", " ")}
                            </span>
                          )}
                          {cost.sourceRevisionId !== null && (
                            <Link
                              className="ml-1 text-primary hover:underline"
                              href={purchaseWorkspaceInspectHref(
                                `/purchase-orders/${row.purchaseOrderId}`,
                                "",
                                { kind: "purchase", id: row.purchaseOrderId },
                              )}
                            >
                              Source #{cost.sourceRevisionId}
                            </Link>
                          )}
                          {cost.reference && (
                            <span className="block text-muted-foreground">
                              {cost.reference}
                            </span>
                          )}
                          {cost.recordedAt && (
                            <span className="block text-muted-foreground">
                              Recorded {cost.recordedAt}
                            </span>
                          )}
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            {rows.some(
              (row) => row.arrivalDestination === "shipment_destination",
            ) && (
              <p className="text-muted-foreground">
                Arrival is at the shipment destination; warehouse arrival not
                confirmed.
              </p>
            )}
            {first.progress.report && (
              <p className="text-muted-foreground">
                Supplier report: {first.progress.report.reference} ·{" "}
                {first.progress.report.asOf} ·{" "}
                {formatPipelinePieces(
                  String(first.progress.report.startedPieces),
                )}{" "}
                started /{" "}
                {formatPipelinePieces(
                  String(first.progress.report.completedPieces),
                )}{" "}
                completed
                {first.progress.report.notes &&
                  ` · ${first.progress.report.notes}`}
              </p>
            )}
            {first.progress.revision > 0 && (
              <SupplierReportHistory
                purchaseOrderLineId={first.purchaseOrderLineId}
              />
            )}
            {issues.length > 0 && (
              <ul className="list-disc space-y-1 pl-4 text-amber-700 dark:text-amber-400">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </details>
  );
}

export function PurchasePipelineLines({
  purchase,
  labels,
}: {
  purchase: PipelinePurchaseGroup;
  labels: StageLabels;
}) {
  const { lines, componentTotals } = useMemo(() => {
    const grouped = new Map<number, PurchasePipelineRow[]>();
    for (const row of purchase.rows) {
      const rows = grouped.get(row.purchaseOrderLineId) ?? [];
      rows.push(row);
      grouped.set(row.purchaseOrderLineId, rows);
    }
    return {
      lines: [...grouped.values()],
      componentTotals: components.map((component) => ({
        key: component.key,
        costs: summarizePipelineCosts(purchase.rows, component.key),
      })),
    };
  }, [purchase.rows]);
  return (
    <div className="min-w-0 overflow-hidden rounded-md border bg-background">
      <div
        role="region"
        aria-label={`Scroll line items for ${purchase.poNumber}`}
        tabIndex={0}
        className="overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <table
          aria-label={`Line items for ${purchase.poNumber}`}
          className="w-full min-w-[920px] table-auto text-left text-sm"
        >
          <caption className="sr-only">
            Outstanding quantities and their costs. Split shipments have
            separate rows under the same product.
          </caption>
          {/* Currency cells keep their intrinsic width, including bold totals.
              Product text uses the remaining space; wide values scroll inside
              this table instead of overlapping adjacent financial columns. */}
          <colgroup>
            <col className="w-[21%]" />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
            <col />
          </colgroup>
          <thead className="border-b bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Product
              </th>
              <th scope="col" className="px-2 py-2.5 text-right font-medium">
                Qty (pieces)
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Stage / shipment
              </th>
              <th scope="col" className="px-2 py-2.5 font-medium">
                Arrival
              </th>
              {components.map((component) => (
                <th
                  key={component.key}
                  scope="col"
                  className="px-2 py-2.5 text-right font-medium"
                >
                  {component.label}
                </th>
              ))}
              <th scope="col" className="px-2 py-2.5 text-right font-medium">
                Known total
              </th>
            </tr>
          </thead>
          {lines.map((rows) => (
            <tbody key={rows[0].purchaseOrderLineId}>
              {rows.map((row, index) => (
                <tr
                  key={row.key}
                  data-pipeline-row={row.key}
                  className={`border-b last:border-0 ${index === 0 ? "border-t" : "border-t border-dashed"}`}
                >
                  {index === 0 && (
                    <th
                      scope="rowgroup"
                      rowSpan={rows.length}
                      className="break-words px-2 py-2 align-top font-normal"
                    >
                      <span className="block font-medium">
                        {row.sku ?? "Product line"}
                      </span>
                      <span
                        title={row.productName ?? undefined}
                        className="mt-0.5 line-clamp-2 text-xs text-muted-foreground"
                      >
                        {row.productName ?? "Name not recorded"}
                      </span>
                    </th>
                  )}
                  <td className="break-words px-2 py-2 text-right align-top tabular-nums">
                    {row.quantityPieces === null ? (
                      <span className="text-xs text-amber-700 dark:text-amber-400">
                        Needs review
                      </span>
                    ) : (
                      formatPipelinePieces(String(row.quantityPieces))
                    )}
                  </td>
                  <td className="break-words px-2 py-2 align-top">
                    <span className="text-xs">{labels[row.stage]}</span>
                    <ShipmentLink row={row} />
                  </td>
                  <td className="break-words px-2 py-2 align-top text-xs">
                    <LineArrival row={row} />
                  </td>
                  {components.map((component) => (
                    <td
                      key={component.key}
                      className="break-words px-2 py-2 text-right align-top tabular-nums"
                    >
                      <CostAmount
                        cost={row.costs.find(
                          (cost) => cost.component === component.key,
                        )}
                        currency={row.currency}
                      />
                    </td>
                  ))}
                  <td className="break-words px-2 py-2 text-right align-top font-semibold tabular-nums">
                    <KnownAmount cost={summarizePipelineCosts([row])[0]} />
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
          <tfoot className="border-t bg-muted/40 font-semibold">
            {purchase.costs.map((cost) => (
              <tr key={cost.currency ?? "unknown"}>
                <th scope="row" colSpan={4} className="px-2 py-2.5 text-xs">
                  Known costs · {cost.currency ?? "currency unknown"}
                </th>
                {componentTotals.map((component) => (
                  <td
                    key={component.key}
                    className="break-words px-2 py-2.5 text-right tabular-nums"
                  >
                    <KnownAmount
                      cost={component.costs.find(
                        (summary) => summary.currency === cost.currency,
                      )}
                    />
                  </td>
                ))}
                <td className="break-words px-2 py-2.5 text-right tabular-nums">
                  <KnownAmount cost={cost} />
                </td>
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      <p className="border-t px-2 py-2 text-xs text-muted-foreground">
        Product, packaging and allocated freight for outstanding quantities.
        Totals exclude taxes, discounts and unallocated charges; PO values are
        estimates.
      </p>
      <CostSourcesAndNotes lines={lines} labels={labels} />
    </div>
  );
}
