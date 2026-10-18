import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  originRepairContextSchema,
  originRepairPreviewRequestSchema,
  originRepairPreviewSchema,
  type OriginRepairContext,
  type OriginRepairSummary,
} from "@shared/procurement/cost-origin-repair";
import {
  reconciliationDestinations,
  type ReconciliationDestination,
} from "@shared/procurement/cost-reconciliation";
import { formatShipmentExceptionAmount } from "@shared/procurement/shipment-cost-exception";
import { createOriginRepairClient } from "@/lib/cost-origin-repair";
import {
  financialCommandFetchJson,
  FinancialCommandRequestError,
} from "@/lib/financial-command";
import {
  exactMoneyAsInput,
  parseExactMoneyInput,
} from "@/lib/exact-money-input";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const money = (mills: number) => formatShipmentExceptionAmount(mills, "USD");
export function CostOriginRepair({
  lotId,
  repaired = false,
}: {
  lotId: number;
  repaired?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {repaired
          ? "View origin repair and approval"
          : "Repair historical cost origin"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] flex flex-col overflow-hidden">
          {open && (
            <OriginReview lotId={lotId} onClose={() => setOpen(false)} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function OriginReview({
  lotId,
  onClose,
}: {
  lotId: number;
  onClose: () => void;
}) {
  const path = `/api/inventory-lots/${lotId}/cost-origin-repair`;
  const context = useQuery({
    queryKey: [path],
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const data = originRepairContextSchema.parse(
        await financialCommandFetchJson(path, {
          method: "GET",
          credentials: "include",
        }),
      );
      if (data.lotId !== lotId)
        throw new Error("This review belongs to another lot.");
      return data;
    },
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {context.data?.approval
            ? "Cost origin repaired"
            : "Repair historical cost origin"}
        </DialogTitle>
        <DialogDescription>
          Confirm the receipt and supplier amounts, then review the cost impact
          before administrator approval.
        </DialogDescription>
      </DialogHeader>
      {context.isPending && (
        <p role="status">Loading receipt and cost evidence…</p>
      )}
      {context.isError && (
        <p role="alert">
          {context.error.message}{" "}
          <Button variant="outline" onClick={() => void context.refetch()}>
            Reload review
          </Button>
        </p>
      )}
      {context.data && (
        <RepairForm
          key={context.data.sourceVersion}
          data={context.data}
          onClose={onClose}
          onReload={() => void context.refetch()}
        />
      )}
    </>
  );
}
function Summary({ summary }: { summary: OriginRepairSummary }) {
  return (
    <div className="space-y-3">
      <p>
        Receipt source:{" "}
        <strong>
          {summary.receivedUnits.toLocaleString()} cases ={" "}
          {summary.basePieces.toLocaleString()} pieces
        </strong>
      </p>
      <table className="w-full text-sm">
        <caption className="text-left font-semibold py-2">
          Historical cost posting
        </caption>
        <thead>
          <tr className="border-b">
            <th className="py-2 text-left">Cost</th>
            <th className="text-right">Before</th>
            <th className="text-right">After approval</th>
          </tr>
        </thead>
        <tbody>
          {summary.components.map((row) => (
            <tr className="border-b" key={row.component}>
              <td className="py-2 capitalize">
                {row.component === "landed"
                  ? "Shipment charges"
                  : row.component}
              </td>
              <td className="text-right">{money(row.historicalBeforeMills)}</td>
              <td className="text-right font-semibold">
                {money(row.historicalAfterMills)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <details>
        <summary className="cursor-pointer">
          Lot values and downstream cost changes
        </summary>
        <ul className="space-y-2 py-2 text-sm">
          {summary.components.map((row) => (
            <li key={row.component}>
              <span className="capitalize">{row.component}</span>: lot value{" "}
              {money(row.lotBeforeMills)} → {money(row.lotAfterMills)}.{" "}
              {row.lotsUpdated} linked lots updated; recorded order cost change
              ${exactMoneyAsInput(row.orderCostDeltaCents, 2)}.
            </li>
          ))}
        </ul>
      </details>
      <p className="text-sm">
        Stock quantity change: <strong>0</strong>. PO and invoice totals and
        payments stay unchanged. Existing shipment-charge approvals keep their
        cost destination.
      </p>
    </div>
  );
}
function RepairForm({
  data,
  onClose,
  onReload,
}: {
  data: OriginRepairContext;
  onClose: () => void;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const [units, setUnits] = useState(String(data.suggested.unitsPerCase ?? ""));
  const [product, setProduct] = useState(
    exactMoneyAsInput(data.suggested.productMills, 4),
  );
  const [packaging, setPackaging] = useState(
    exactMoneyAsInput(data.suggested.packagingMills, 4),
  );
  const [destination, setDestination] =
    useState<ReconciliationDestination>("historical_cogs");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [client] = useState(() =>
    createOriginRepairClient(() => crypto.randomUUID()),
  );
  const [attempt, setAttempt] = useState<unknown>(null);
  const [saved, setSaved] = useState<OriginRepairContext | null>(null);
  const path = `/api/inventory-lots/${data.lotId}/cost-origin-repair`;
  const preview = useMutation({
    mutationFn: async () => {
      if (!/^\d+$/.test(units))
        throw new Error("Enter a whole number of pieces per case.");
      const request = originRepairPreviewRequestSchema.parse({
        sourceVersion: data.sourceVersion,
        unitsPerCase: Number(units),
        productMills: parseExactMoneyInput(product, 4),
        packagingMills: parseExactMoneyInput(packaging, 4),
        destination,
        reason,
        evidenceConfirmed: confirmed,
      });
      const result = originRepairPreviewSchema.parse(
        await financialCommandFetchJson(`${path}/preview`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request),
        }),
      );
      return { request, result };
    },
  });
  const save = useMutation({
    mutationFn: (input: unknown) => client.approve(data.lotId, input),
    onSuccess: (result) => setSaved(result),
    onSettled: () => invalidatePurchaseCosts(queryClient),
  });
  const approval = saved?.approval ?? data.approval;
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The short approval step replaces a potentially scrolled input form.
    // Start at the named lot and summary instead of retaining the form offset.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [preview.data, approval]);
  const ambiguous =
    save.error instanceof FinancialCommandRequestError && save.error.ambiguous;
  const locked = preview.isPending || save.isPending || ambiguous;
  const change = (setter: (value: string) => void, value: string) => {
    setter(value);
    preview.reset();
    save.reset();
  };
  return (
    <>
      <div
        ref={bodyRef}
        className="overflow-y-auto min-h-0 space-y-4 pr-2 text-sm"
      >
        <p>
          <strong>
            {data.sku} · {data.lotNumber}
          </strong>
          <br />
          {data.receiptNumber} · {data.receivedUnits} received cases ·{" "}
          {data.onHandUnits} on hand
        </p>
        {approval ? (
          <>
            <p
              role="status"
              className="rounded border border-green-600 bg-green-50 p-3 text-green-900"
            >
              Origin repaired. Supplier costs posted to{" "}
              {reconciliationDestinations[approval.destination].toLowerCase()}.
            </p>
            <p>
              Approved by <strong>{approval.actorName}</strong> ·{" "}
              {new Date(approval.recordedAt).toLocaleString()}
              <br />
              {approval.reason}
            </p>
            <p>
              These are the values posted by this approval. Later cost changes
              are shown in the current cost status and posting history.
            </p>
            <Summary summary={approval.summary} />
          </>
        ) : data.blockedReason ? (
          <p role="alert">{data.blockedReason}</p>
        ) : (
          <>
            {!preview.data && (
              <>
                <p>
                  The original receipt is missing its cost link and saved pieces
                  per case. Saved supplier and PO values are suggested below.
                  Confirm them against your records. No individual sales order
                  is recorded for this depleted lot.
                </p>
                <fieldset
                  disabled={locked || !!preview.data}
                  className="space-y-3"
                >
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div>
                      <Label htmlFor="origin-units">Pieces per case</Label>
                      <Input
                        id="origin-units"
                        value={units}
                        onChange={(e) => change(setUnits, e.target.value)}
                        inputMode="numeric"
                      />
                    </div>
                    <div>
                      <Label htmlFor="origin-product">
                        Invoice product amount ($)
                      </Label>
                      <Input
                        id="origin-product"
                        value={product}
                        onChange={(e) => change(setProduct, e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                    <div>
                      <Label htmlFor="origin-packaging">
                        Invoice packaging amount ($)
                      </Label>
                      <Input
                        id="origin-packaging"
                        value={packaging}
                        onChange={(e) => change(setPackaging, e.target.value)}
                        inputMode="decimal"
                      />
                    </div>
                  </div>
                  <p>
                    Complete supplier invoice line:{" "}
                    <strong>
                      {data.invoice
                        ? money(data.invoice.amountMills)
                        : "Unavailable"}
                    </strong>
                    . Product plus packaging must equal this amount.
                  </p>
                  <Label htmlFor="origin-destination">
                    Where do the historical costs belong?
                  </Label>
                  <select
                    id="origin-destination"
                    className="w-full rounded border bg-background p-2"
                    value={destination}
                    onChange={(e) => {
                      setDestination(
                        e.target.value as ReconciliationDestination,
                      );
                      preview.reset();
                    }}
                  >
                    <option value="historical_cogs">
                      Cost of goods already sold
                    </option>
                    <option value="inventory_variance">
                      Historical inventory expense adjustment
                    </option>
                  </select>
                  <Label htmlFor="origin-reason">
                    Reason / supporting reference
                  </Label>
                  <Textarea
                    id="origin-reason"
                    value={reason}
                    onChange={(e) => change(setReason, e.target.value)}
                  />
                  <label className="flex gap-2 items-start">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => {
                        setConfirmed(e.target.checked);
                        preview.reset();
                      }}
                    />
                    I verified the receipt units, supplier amounts and cost
                    destination. These historical costs are not already recorded
                    against sales elsewhere.
                  </label>
                </fieldset>
              </>
            )}
            {preview.data && (
              <>
                <p>
                  Post supplier costs to{" "}
                  <strong>
                    {reconciliationDestinations[
                      preview.data.request.destination
                    ].toLowerCase()}
                  </strong>
                  .
                </p>
                <Summary summary={preview.data.result.summary} />
                <p className="text-muted-foreground">
                  Confirmed invoice split: product{" "}
                  {money(preview.data.request.productMills)} · packaging{" "}
                  {money(preview.data.request.packagingMills)}.
                </p>
                <p>
                  <strong>Supporting reason:</strong>{" "}
                  {preview.data.request.reason}
                </p>
              </>
            )}
          </>
        )}
        {(preview.isError || save.isError) && (
          <p role="alert" className="text-destructive">
            {save.error?.message ?? preview.error?.message}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t pt-3 shrink-0">
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          Close review
        </Button>
        {!approval && !data.blockedReason && (
          <>
            {preview.data && !ambiguous && (
              <Button
                variant="outline"
                onClick={() => {
                  preview.reset();
                  save.reset();
                }}
                disabled={locked}
              >
                Edit details
              </Button>
            )}
            {preview.data || ambiguous ? (
              <Button
                className="bg-green-700 hover:bg-green-800 text-white"
                disabled={save.isPending}
                onClick={() => {
                  const input = ambiguous
                    ? attempt
                    : {
                        ...preview.data!.request,
                        previewVersion: preview.data!.result.previewVersion,
                      };
                  setAttempt(input);
                  save.mutate(input);
                }}
              >
                {save.isPending
                  ? "Posting…"
                  : ambiguous
                    ? "Retry same approval"
                    : "Approve repair & post costs"}
              </Button>
            ) : (
              <Button
                disabled={locked || !confirmed || reason.trim().length < 10}
                onClick={() => preview.mutate()}
              >
                {preview.isPending ? "Calculating…" : "Review before and after"}
              </Button>
            )}
          </>
        )}
        {(preview.isError || save.isError) && !locked && (
          <Button variant="outline" onClick={onReload}>
            Reload saved review
          </Button>
        )}
      </div>
    </>
  );
}
