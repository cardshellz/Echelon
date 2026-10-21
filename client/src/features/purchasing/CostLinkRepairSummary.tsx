import type { CostLinkRepairSummary as Summary } from "@shared/procurement/cost-link-repair";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";

const units = (value: number) => value.toLocaleString();
const mills = (value: number) => `$${exactMoneyAsInput(value, 4)}`;

export function CostLinkRepairSummary({
  summary,
  approved = false,
}: {
  summary: Summary;
  approved?: boolean;
}) {
  return (
    <section
      className="space-y-3 text-sm"
      aria-label="Transfer and repacking cost repair"
    >
      <h3 className="font-semibold">
        {approved
          ? "Cost links restored"
          : "Transfer and repacking links to restore"}
      </h3>
      <p>
        {approved
          ? "The approval below records these links."
          : "Check that these records describe the same goods, including the pieces in each case or pack. Approving saves these links with the quantity correction."}
      </p>
      {summary.originsRestored.map((root) => (
        <p key={root.lotId}>
          <strong>{root.lotNumber}</strong>: connect the original receipt of{" "}
          {units(root.receivedUnits)} units × {units(root.piecesPerUnit)} pieces
          to this shipment.
        </p>
      ))}
      <ol className="space-y-2 list-decimal pl-5">
        {summary.operations.map((operation) => (
          <li key={operation.key} className="rounded border p-2">
            <strong>{operation.description}</strong>
            <p>
              {operation.sourceLotNumber}: {units(operation.sourceUnits)}{" "}
              {operation.sourceSku} units ×{" "}
              {units(operation.sourcePiecesPerUnit)} pieces
            </p>
            {operation.outputs.map((output) => (
              <p key={output.lotId}>
                → {output.lotNumber}: {units(output.units)} {output.sku} units ×{" "}
                {units(output.piecesPerUnit)} pieces
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              Recorded {operation.occurredAt} · Movements{" "}
              {operation.movementIds.map((id) => `#${id}`).join(", ")}
            </p>
            <p className="text-xs">
              Cost connection: missing →{" "}
              {approved ? "restored" : "will be restored"}
            </p>
          </li>
        ))}
      </ol>
      <details>
        <summary className="cursor-pointer font-medium">
          Cost before and after for {summary.lots.length} lots
        </summary>
        <p className="my-2">
          Amounts below cover each lot's original quantity. A transfer carries
          the same cost forward, so these rows must not be added together. Only
          orders with recorded shipment evidence receive cost changes. Other
          orders keep their existing costs for review.
        </p>
        <div className="space-y-2">
          {summary.lots.map((lot) => (
            <div key={lot.lotId} className="border rounded p-2">
              <strong>
                {lot.lotNumber} · {lot.sku}
              </strong>
              <p>
                {units(lot.onHandUnits)} units on hand · Stock quantity change:
                0
              </p>
              <table className="w-full text-right tabular-nums">
                <thead>
                  <tr>
                    <th className="text-left">Cost</th>
                    <th>Before</th>
                    <th>{approved ? "Saved" : "After approval"}</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Product", lot.productMills],
                      ["Packaging", lot.packagingMills],
                      ["Shipment charges", lot.shipmentMills],
                    ] as const
                  ).map(([label, values]) => (
                    <tr key={label}>
                      <td className="text-left">{label}</td>
                      <td>{mills(values.before)}</td>
                      <td>{mills(values.after)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="text-left">
                      Linked order costs ({lot.linkedOrderRows} records)
                    </td>
                    <td>
                      {formatIntegerCents(lot.orderCostCents.before, "USD")}
                    </td>
                    <td>
                      {formatIntegerCents(lot.orderCostCents.after, "USD")}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </details>
      <p>
        New expense postings: <strong>0</strong>. Stock counts and recorded
        sales are preserved.
      </p>
      {summary.remainingIssues.length > 0 && (
        <div className="rounded border border-amber-500 p-3 space-y-2">
          <strong>History still requiring evidence</strong>
          <p>
            These quantities are separate from the links above. Approval does
            not classify them as sold or lost.
          </p>
          <ul className="list-disc pl-5">
            {summary.remainingIssues.map((issue, index) => (
              <li key={index}>{issue}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
