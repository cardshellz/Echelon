import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  quantityCorrectionContextSchema,
  quantityCorrectionInputSchema,
  shipmentQuantityEditInputSchema,
  type QuantityCorrectionPurpose,
  quantityCorrectionPreviewSchema,
  type QuantityCorrectionContext,
  type QuantityCorrectionPreview,
  type QuantityCorrectionSummary,
} from "@shared/procurement/receipt-shipment-quantity-correction";
import { createQuantityCorrectionClient } from "@/lib/receipt-shipment-quantity-correction";
import {
  financialCommandFetchJson,
  FinancialCommandRequestError,
} from "@/lib/financial-command";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { formatIntegerCents } from "@shared/utils/format-integer-cents";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PoShipmentCostReview } from "./PoShipmentCostReview";
import { poShipmentCostsSchema } from "@shared/procurement/po-shipment-costs";

type Entry =
  | { receiptLineId: number; shipmentLines?: never }
  | {
      shipmentLines: readonly {
        id: number;
        sku: string | null;
        productName?: string | null;
      }[];
      receiptLineId?: never;
    };
const get = async (path: string) =>
  financialCommandFetchJson(path, { method: "GET", credentials: "include" });

export function ReceiptShipmentQuantityCorrection(props: {
  receiptLineId: number;
  onSaved?: () => void;
}) {
  return <QuantityCorrectionDialog {...props} />;
}
export function ShipmentQuantityEditor(props: {
  shipmentLines: readonly {
    id: number;
    sku: string | null;
    productName?: string | null;
  }[];
  onSaved?: () => void;
}) {
  return <QuantityCorrectionDialog {...props} />;
}
function QuantityCorrectionDialog(props: Entry & { onSaved?: () => void }) {
  const purpose = props.receiptLineId === undefined ? "shipment" : "receipt";
  const [open, setOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="whitespace-normal"
        onClick={() => setOpen(true)}
      >
        {purpose === "shipment"
          ? "Edit shipment"
          : "Correct received quantities"}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!locked) setOpen(value);
        }}
      >
        <DialogContent
          className="w-[calc(100vw-1rem)] sm:max-w-4xl max-h-[92dvh] flex flex-col overflow-hidden"
          onEscapeKeyDown={(event) => {
            if (locked) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (locked) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {purpose === "shipment"
                ? "Edit shipment"
                : "Correct receipt and shipment"}
            </DialogTitle>
            <DialogDescription>
              {purpose === "shipment"
                ? "Edit the shipped pieces, review receiving and cost changes, then approve."
                : "Set the recorded pieces, review the cost impact, then approve one correction for the linked records."}
            </DialogDescription>
          </DialogHeader>
          {open && (
            <CorrectionEntry
              {...props}
              onClose={() => setOpen(false)}
              onLock={setLocked}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
function CorrectionEntry(
  props: Entry & {
    onClose: () => void;
    onLock: (value: boolean) => void;
    onSaved?: () => void;
  },
) {
  const purpose: QuantityCorrectionPurpose =
    props.receiptLineId === undefined ? "shipment" : "receipt";
  const [selected, setSelected] = useState<number | null>(
    props.shipmentLines?.[0]?.id ?? null,
  );
  const [locked, setLocked] = useState(false);
  const onLock = useCallback(
    (value: boolean) => {
      setLocked(value);
      props.onLock(value);
    },
    [props.onLock],
  );
  const path =
    selected !== null
      ? `/api/shipment-lines/${selected}/shipment-edit`
      : `/api/receiving-lines/${props.receiptLineId}/quantity-correction`;
  const query = useQuery({
    queryKey: [path],
    enabled: selected !== null || props.receiptLineId !== undefined,
    refetchOnWindowFocus: false,
    queryFn: async () => quantityCorrectionContextSchema.parse(await get(path)),
  });
  return (
    <>
      {props.shipmentLines && props.shipmentLines.length > 1 && (
        <div className="space-y-1">
          <Label>Shipment line</Label>
          <Select
            disabled={locked}
            value={selected === null ? "" : String(selected)}
            onValueChange={(value) => setSelected(Number(value))}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select the shipment to correct" />
            </SelectTrigger>
            <SelectContent>
              {props.shipmentLines.map((row) => (
                <SelectItem key={row.id} value={String(row.id)}>
                  {row.sku || row.productName || `Line ${row.id}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {query.isFetching && !query.data && (
        <p role="status">
          Reading the linked receipt, shipment and cost history…
        </p>
      )}
      {query.isError && (
        <p role="alert">
          {query.error.message}{" "}
          <Button variant="outline" onClick={() => void query.refetch()}>
            Reload
          </Button>
        </p>
      )}
      {query.data && (
        <CorrectionForm
          key={query.data.shipmentLineId}
          initial={query.data}
          purpose={purpose}
          onClose={props.onClose}
          onLock={onLock}
          onSaved={props.onSaved}
          onReload={async () => {
            const result = await query.refetch();
            return result.data;
          }}
        />
      )}
    </>
  );
}
const number = (value: number) => value.toLocaleString();
const money = (value: number | null) =>
  value === null ? "Needs cost evidence" : formatIntegerCents(value, "USD");
export function QuantityCorrectionSummary({
  summary,
}: {
  summary: QuantityCorrectionSummary;
}) {
  const rows: Array<[string, string, string]> = [
    [
      "Shipment pieces",
      number(summary.shipmentPieces.before),
      number(summary.shipmentPieces.after),
    ],
    ...summary.receipts.map(
      (row) =>
        [
          `Receipt ${row.receiptNumber} pieces`,
          number(row.receivedPieces),
          number(row.afterPieces),
        ] as [string, string, string],
    ),
    ...(summary.pendingReceipts ?? []).map(
      (row) =>
        [
          `Expected units · ${row.receiptNumber}`,
          number(row.expectedUnits),
          number(row.afterExpectedUnits),
        ] as [string, string, string],
    ),
    ...summary.receipts.map(
      (row) =>
        [
          `Pieces per received unit · ${row.receiptNumber}`,
          number(row.piecesPerUnit),
          number(row.afterPiecesPerUnit),
        ] as [string, string, string],
    ),
    [
      "PO received pieces",
      number(summary.poReceivedPieces.before),
      number(summary.poReceivedPieces.after),
    ],
    [
      "PO pieces still to receive",
      number(summary.poRemainingPieces.before),
      number(summary.poRemainingPieces.after),
    ],
    [
      "Shipment charges",
      money(summary.shipmentChargeCents.before),
      money(summary.shipmentChargeCents.after),
    ],
    [
      "Charges allocated to this line",
      money(summary.allocatedChargeCents.before),
      money(summary.allocatedChargeCents.after),
    ],
    [
      "Shipment charge per piece",
      `$${summary.chargePerPiece.before}`,
      `$${summary.chargePerPiece.after}`,
    ],
    [
      "Total landed cost for this line",
      money(summary.landedCostCents.before),
      money(summary.landedCostCents.after),
    ],
    [
      "Landed cost per piece",
      summary.landedCostPerPiece.before === null
        ? "Needs cost evidence"
        : `$${summary.landedCostPerPiece.before}`,
      summary.landedCostPerPiece.after === null
        ? "Needs cost evidence"
        : `$${summary.landedCostPerPiece.after}`,
    ],
    [
      "Historical expense already posted",
      `$${exactMoneyAsInput(summary.historicalCost.beforeMills, 4)}`,
      `$${exactMoneyAsInput(summary.historicalCost.afterMills, 4)}`,
    ],
    ...(summary.physicalTotals
      ? ([
          [
            "Net weight (kg)",
            summary.physicalTotals.netWeightKg.before ?? "—",
            summary.physicalTotals.netWeightKg.after ?? "—",
          ],
          [
            "Volume (CBM)",
            summary.physicalTotals.volumeCbm.before ?? "—",
            summary.physicalTotals.volumeCbm.after ?? "—",
          ],
        ] as Array<[string, string, string]>)
      : []),
  ];
  return (
    <div className="space-y-3">
      <table className="w-full text-sm">
        <caption className="text-left font-semibold py-2">
          Before and after
        </caption>
        <thead>
          <tr className="border-b">
            <th className="text-left py-2">What changes</th>
            <th className="text-right">Before</th>
            <th className="text-right">After approval</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr className="border-b" key={label}>
              <td className="py-2 pr-2">{label}</td>
              <td className="text-right tabular-nums">{before}</td>
              <td className="text-right tabular-nums font-medium">{after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-sm">
        Stock movement: <strong>0 units</strong>.{" "}
        {summary.purpose === "shipment"
          ? "Posted receipt counts are preserved. Open receipt expectations and shipment-dependent costs are refreshed."
          : "This corrects the piece conversion of the existing receipt."}{" "}
        Ordered quantities, supplier invoices, payments and shipping carton
        counts stay unchanged.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">
          Inventory and sold-item cost impact
        </summary>
        <ul className="text-sm space-y-2 pt-2">
          {summary.costResults.map((result, index) => (
            <li key={index}>
              <strong className="capitalize">
                {result.component === "landed"
                  ? "Shipment costs"
                  : result.component}
              </strong>
              : {result.lotsUpdated} lots updated; {result.orderCostsUpdated}{" "}
              sold-item cost records updated; order cost change{" "}
              {money(result.orderCostDeltaCents)}.
              {result.issues.map((issue, i) => (
                <p key={i} className="text-amber-800 dark:text-amber-300">
                  {issue.message}
                </p>
              ))}
            </li>
          ))}
        </ul>
      </details>
      {summary.historicalCost.blockedReason && (
        <p role="status" className="text-sm text-amber-800">
          {summary.historicalCost.blockedReason}
        </p>
      )}
    </div>
  );
}
function CorrectionForm({
  initial,
  onClose,
  onLock,
  onReload,
  onSaved,
  purpose,
}: {
  initial: QuantityCorrectionContext;
  onClose: () => void;
  onLock: (value: boolean) => void;
  onReload: () => Promise<QuantityCorrectionContext | undefined>;
  onSaved?: () => void;
  purpose: QuantityCorrectionPurpose;
}) {
  const [data, setData] = useState(initial);
  const [pieces, setPieces] = useState(String(initial.shippedPieces));
  const [receiptPieces, setReceiptPieces] = useState<Record<number, string>>(
    Object.fromEntries(
      initial.receipts.map((row) => [
        row.receiptLineId,
        String(row.receivedPieces),
      ]),
    ),
  );
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [destination, setDestination] = useState<
    "historical_cogs" | "inventory_variance" | null
  >(null);
  const [preview, setPreview] = useState<QuantityCorrectionPreview | null>(
    null,
  );
  const [saved, setSaved] = useState<QuantityCorrectionContext | null>(null);
  const [attempt, setAttempt] = useState<unknown>(null);
  const [client] = useState(() =>
    createQuantityCorrectionClient(() => crypto.randomUUID(), purpose),
  );
  const queryClient = useQueryClient();
  const path = `/api/shipment-lines/${data.shipmentLineId}/${purpose === "shipment" ? "shipment-edit" : "quantity-correction"}`;
  const revision = useRef(0);
  function changed(action: () => void) {
    revision.current++;
    setPreview(null);
    action();
  }
  function request() {
    const parse = (value: string) =>
      /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    const parsed = (
      purpose === "shipment"
        ? shipmentQuantityEditInputSchema
        : quantityCorrectionInputSchema
    ).safeParse({
      sourceVersion: data.sourceVersion,
      shippedPieces: parse(pieces),
      ...(purpose === "receipt"
        ? {
            receipts: data.receipts.map((row) => ({
              receiptLineId: row.receiptLineId,
              receivedPieces: parse(receiptPieces[row.receiptLineId]),
            })),
          }
        : {}),
      historicalCostDestination: destination,
      reason,
      evidenceConfirmed: confirmed,
    });
    if (!parsed.success)
      throw new Error(
        "Enter positive whole piece quantities, confirm the source documents, and provide a reason between 10 and 2,000 characters.",
      );
    return parsed.data;
  }
  const review = useMutation({
    mutationFn: async () => {
      const version = revision.current;
      const result = quantityCorrectionPreviewSchema.parse(
        await financialCommandFetchJson(`${path}/preview`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request()),
        }),
      );
      if (version === revision.current) setPreview(result);
    },
  });
  const approval = useMutation({
    mutationFn: async () => {
      if (!preview && !attempt)
        throw new Error("Review the current before and after first.");
      const body = attempt ?? {
        ...request(),
        previewVersion: preview!.previewVersion,
      };
      setAttempt(body);
      try {
        const result = await client.approve(data.shipmentLineId, body);
        setSaved(result);
        setAttempt(null);
        onSaved?.();
      } catch (error) {
        if (
          !(error instanceof FinancialCommandRequestError) ||
          !error.ambiguous
        )
          setAttempt(null);
        throw error;
      } finally {
        await invalidatePurchaseCosts(queryClient);
      }
    },
  });
  const locked = approval.isPending || attempt !== null;
  useEffect(() => {
    onLock(locked);
    return () => onLock(false);
  }, [locked, onLock]);
  const pendingIssues = saved?.history[0]?.summary.costResults.some(
    (result) => result.status === "review_required",
  );
  const costs = useQuery({
    queryKey: [`/api/purchase-orders/${data.purchaseOrderId}/shipment-costs`],
    enabled: !!saved && !!pendingIssues,
    queryFn: async () =>
      poShipmentCostsSchema.parse(
        await get(
          `/api/purchase-orders/${data.purchaseOrderId}/shipment-costs`,
        ),
      ),
  });
  async function reload() {
    const updated = await onReload();
    if (!updated) return;
    setData(updated);
    setPieces(String(updated.shippedPieces));
    setReceiptPieces(
      Object.fromEntries(
        updated.receipts.map((row) => [
          row.receiptLineId,
          String(row.receivedPieces),
        ]),
      ),
    );
    setPreview(null);
    review.reset();
    approval.reset();
  }
  return (
    <>
      <div className="overflow-y-auto min-h-0 space-y-4 pr-1">
        <div className="text-sm">
          <strong>{data.productName || data.sku}</strong>
          <p>
            {data.purchaseOrderNumber} · Shipment {data.shipmentNumber}
          </p>
        </div>
        {saved ? (
          <div className="space-y-3">
            <div
              className="rounded-md border border-green-600 bg-green-50 dark:bg-green-950 p-3"
              role="status"
            >
              <strong>
                {purpose === "shipment"
                  ? "Shipment edit approved and saved"
                  : "Quantity correction approved and saved"}
              </strong>
              <p className="text-sm">
                {saved.history[0].approvedBy} ·{" "}
                {new Date(saved.history[0].approvedAt).toLocaleString()}
              </p>
              <p className="text-sm">{saved.history[0].reason}</p>
            </div>
            <QuantityCorrectionSummary summary={saved.history[0].summary} />
            {pendingIssues && (
              <div className="space-y-2">
                <h3 className="font-semibold">Remaining cost work</h3>
                <p className="text-sm">
                  The quantities are saved. These cost records still need the
                  evidence or accounting decision shown below.
                </p>
                {costs.isPending && (
                  <p role="status">Loading current cost actions…</p>
                )}
                {costs.isError && (
                  <p role="alert">
                    {costs.error.message}{" "}
                    <Button onClick={() => void costs.refetch()}>
                      Retry cost details
                    </Button>
                  </p>
                )}
                {costs.data && (
                  <PoShipmentCostReview
                    purchaseOrderId={data.purchaseOrderId}
                    costs={costs.data}
                  />
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {data.blockedReason && (
              <div role="alert" className="rounded border p-3 space-y-2">
                <p>{data.blockedReason}</p>
                {purpose === "shipment" &&
                  data.receivingLinks?.map((row) => (
                    <a
                      key={row.receiptId}
                      className="block underline text-sm"
                      href={`/receiving?open=${row.receiptId}`}
                    >
                      Review receipt {row.receiptNumber}
                    </a>
                  ))}
              </div>
            )}
            {!preview && (
              <fieldset
                disabled={locked || review.isPending || !!data.blockedReason}
                className="space-y-3"
              >
                <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_6rem] sm:grid-cols-[minmax(0,1fr)_7rem_8rem] items-center gap-2 text-sm">
                  <span className="font-medium">Document</span>
                  <span className="text-right">Saved pieces</span>
                  <span>Correct pieces</span>
                  <Label htmlFor="correct-shipment">
                    Shipment {data.shipmentNumber}
                  </Label>
                  <span className="text-right tabular-nums">
                    {number(data.shippedPieces)}
                  </span>
                  <Input
                    id="correct-shipment"
                    inputMode="numeric"
                    value={pieces}
                    onChange={(event) =>
                      changed(() => setPieces(event.target.value))
                    }
                  />
                  {purpose === "receipt" &&
                    data.receipts.map((row) => (
                      <ReceiptQuantityRow
                        key={row.receiptLineId}
                        row={row}
                        value={receiptPieces[row.receiptLineId]}
                        onChange={(value) =>
                          changed(() =>
                            setReceiptPieces({
                              ...receiptPieces,
                              [row.receiptLineId]: value,
                            }),
                          )
                        }
                      />
                    ))}
                </div>
                {purpose === "shipment" && (
                  <div className="rounded border p-3 text-sm space-y-2">
                    <strong>Receiving</strong>
                    {data.receipts.map((row) => (
                      <p key={row.receiptLineId}>
                        <a
                          className="underline"
                          href={`/receiving?open=${row.receiptId}`}
                        >
                          {row.receiptNumber}
                        </a>
                        {" · "}
                        {number(row.receivedPieces)} pieces received (saved).
                      </p>
                    ))}
                    {(data.pendingReceipts ?? []).map((row) => (
                      <p key={row.receiptLineId}>
                        <a
                          className="underline"
                          href={`/receiving?open=${row.receiptId}`}
                        >
                          {row.receiptNumber}
                        </a>
                        {" · "}Open receipt: {number(row.receivedUnits)} units
                        counted. Its expected quantity will be recalculated from
                        the shipment.
                      </p>
                    ))}
                    {!data.receipts.length && !data.pendingReceipts?.length && (
                      <p>
                        No receipts recorded. Future receiving will use the
                        edited shipment quantity.
                      </p>
                    )}
                    <p className="text-muted-foreground">
                      Correct an actual received count from its receipt.
                      Shipment edits preserve received counts.
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  {purpose === "shipment"
                    ? "Enter the pieces on the packing list. Review changes shows the receiving expectations, shipment costs, and inventory cost impact."
                    : "Enter pieces from the receiving documents. The handled receiving units and stock movements are preserved; the pieces per unit will be corrected."}
                </p>
                <Label htmlFor="quantity-reason">
                  Reason / document reference
                </Label>
                <Textarea
                  id="quantity-reason"
                  value={reason}
                  onChange={(event) =>
                    changed(() => setReason(event.target.value))
                  }
                  placeholder="Explain the quantity correction and its source."
                />
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={confirmed}
                    onChange={(event) =>
                      changed(() => setConfirmed(event.target.checked))
                    }
                  />
                  {purpose === "shipment"
                    ? "I checked the shipped quantity against the packing list."
                    : "I checked the receipt and shipment quantities against the source documents."}
                </label>
              </fieldset>
            )}
            {preview && <QuantityCorrectionSummary summary={preview.summary} />}
            {(preview?.summary.historicalCost.requiresDecision ||
              destination !== null) && (
              <fieldset
                disabled={locked}
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <legend className="font-semibold px-1">
                  Where does the unlinked historical cost belong?
                </legend>
                <p>
                  The recorded stock is depleted but its destination is missing.
                  Choose only the destination supported by your records, then
                  update the preview.
                </p>
                <label className="flex gap-2">
                  <input
                    type="radio"
                    name="quantity-destination"
                    checked={destination === "historical_cogs"}
                    onChange={() =>
                      changed(() => setDestination("historical_cogs"))
                    }
                  />
                  Cost of goods already sold — I have evidence of the sale.
                </label>
                <label className="flex gap-2">
                  <input
                    type="radio"
                    name="quantity-destination"
                    checked={destination === "inventory_variance"}
                    onChange={() =>
                      changed(() => setDestination("inventory_variance"))
                    }
                  />
                  Historical inventory expense — the movements cannot be
                  attributed to sales.
                </label>
              </fieldset>
            )}
            {(review.error || approval.error) && (
              <div role="alert" className="text-sm text-destructive">
                {review.error?.message || approval.error?.message}
                {!locked && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-2"
                    onClick={() => void reload()}
                  >
                    Reload current records
                  </Button>
                )}
              </div>
            )}
            {data.history.length > 0 && (
              <details>
                <summary className="cursor-pointer">
                  Previous corrections and approvals ({data.history.length})
                </summary>
                {data.history.map((item) => (
                  <div
                    key={item.id}
                    className="border rounded p-3 my-2 text-sm"
                  >
                    <strong>Approved by {item.approvedBy}</strong> ·{" "}
                    {new Date(item.approvedAt).toLocaleString()}
                    <p>{item.reason}</p>
                    <QuantityCorrectionSummary summary={item.summary} />
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </div>
      <div className="border-t pt-3 flex justify-end flex-wrap gap-2 shrink-0">
        <Button variant="outline" disabled={locked} onClick={onClose}>
          {saved ? "Done" : "Close"}
        </Button>
        {!saved && preview && !attempt && (
          <Button
            variant="outline"
            disabled={locked}
            onClick={() => setPreview(null)}
          >
            Edit quantities
          </Button>
        )}
        {!saved &&
          (!preview ||
            !confirmed ||
            preview.summary.historicalCost.requiresDecision) &&
          !attempt && (
            <Button
              onClick={() => review.mutate()}
              disabled={
                review.isPending ||
                !!data.blockedReason ||
                !confirmed ||
                reason.trim().length < 10
              }
            >
              {review.isPending ? "Calculating impact…" : "Review changes"}
            </Button>
          )}
        {!saved &&
          !!(preview || attempt) &&
          !preview?.summary.historicalCost.requiresDecision && (
            <Button
              className="bg-green-700 hover:bg-green-800 text-white"
              onClick={() => approval.mutate()}
              disabled={
                approval.isPending || review.isPending || !!data.blockedReason
              }
            >
              {approval.isPending
                ? "Saving correction…"
                : attempt
                  ? "Retry same approval"
                  : purpose === "shipment"
                    ? "Approve shipment edit"
                    : "Approve correction"}
            </Button>
          )}
      </div>
    </>
  );
}
function ReceiptQuantityRow({
  row,
  value,
  onChange,
}: {
  row: QuantityCorrectionContext["receipts"][number];
  value: string;
  onChange: (value: string) => void;
}) {
  const valid =
    /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) % row.receivedUnits === 0;
  return (
    <>
      <Label htmlFor={`receipt-quantity-${row.receiptLineId}`}>
        {row.receiptNumber}
        <span className="block font-normal text-xs text-muted-foreground">
          {number(row.receivedUnits)} received units
          {valid
            ? ` × ${number(Number(value) / row.receivedUnits)} pieces`
            : ""}
        </span>
      </Label>
      <span className="text-right tabular-nums">
        {number(row.receivedPieces)}
      </span>
      <Input
        id={`receipt-quantity-${row.receiptLineId}`}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </>
  );
}
