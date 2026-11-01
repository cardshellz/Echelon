import { receiptInvoiceApprovalHistorySchema } from "@shared/procurement/receipt-invoice-costs";
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  receiptInvoiceApprovalRequestSchema,
  receiptInvoiceContextSchema,
  receiptInvoicePreviewSchema,
  receiptInvoiceResultSchema,
  receiptInvoiceChangeSchema,
  type ReceiptInvoiceAllocation,
} from "@shared/procurement/receipt-invoice-costs";
import { canonicalJson } from "@shared/utils/canonical-json";
import {
  financialCommandFetchJson,
  financialCommandNeedsRecovery,
  FinancialCommandRequestError,
  shouldRetryFinancialCommand,
  financialCommandRetryDelay,
} from "@/lib/financial-command";
import { exactMoneyAsInput } from "@/lib/exact-money-input";
import { invalidatePurchaseCosts } from "@/lib/invalidate-purchase-costs";
import { useAuth } from "@/lib/auth";
import { useProcurementNavigation } from "@/hooks/use-procurement-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const intentSchema = z
  .object({
    key: z.string().uuid(),
    body: receiptInvoiceApprovalRequestSchema,
    preview: receiptInvoicePreviewSchema,
  })
  .strict();
type Intent = z.infer<typeof intentSchema>;
type Context = z.infer<typeof receiptInvoiceContextSchema>;
type Preview = z.infer<typeof receiptInvoicePreviewSchema>;
const money = (value: number | null) =>
  value === null
    ? "Not verified"
    : `$${exactMoneyAsInput(value, 4).replace(/(\.\d{2})00$/, "$1")}`;
const endpoint = "/api/purchasing/receipt-invoice-costs";

function CostChanges({ preview, saved }: { preview: Preview; saved: boolean }) {
  return (
    <section className="space-y-3" aria-label="Receipt cost changes">
      <h3 className="font-semibold">
        {saved ? "Approved receipt costs" : "What changes"}
      </h3>
      {preview.after.map((after) => {
        const before = preview.before.find(
          (row) => row.receivingLineId === after.receivingLineId,
        );
        return (
          <div className="rounded border p-3" key={after.receivingLineId}>
            <h4 className="font-medium">
              {after.receiptNumber} · {after.pieces.toLocaleString()} pieces
            </h4>
            <table
              className="w-full text-sm [&_th:not(:first-child)]:pl-3 [&_td:not(:first-child)]:pl-3 [&_td:not(:first-child)]:whitespace-nowrap [&_td:not(:first-child)]:tabular-nums"
              aria-label={`${after.receiptNumber} before and after`}
            >
              <thead>
                <tr>
                  <th className="text-left">Supplier cost</th>
                  <th className="text-right">Before</th>
                  <th className="text-right">After</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Product, packaging and included tax</td>
                  <td className="text-right">
                    {money(before?.supplierMills ?? null)}
                  </td>
                  <td className="text-right font-medium">
                    {money(after.supplierMills)}
                  </td>
                </tr>
                <tr>
                  <td>Pieces at invoice cost</td>
                  <td className="text-right">
                    {before?.confirmedPieces.toLocaleString() ?? "—"}
                  </td>
                  <td className="text-right">
                    {after.confirmedPieces.toLocaleString()}
                  </td>
                </tr>
                <tr>
                  <td>Pieces at provisional PO cost</td>
                  <td className="text-right">
                    {before?.provisionalPieces.toLocaleString() ?? "—"}
                  </td>
                  <td className="text-right">
                    {after.provisionalPieces.toLocaleString()}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      })}
      {preview.inventoryValues
        .filter((row) => row.beforeMills !== row.afterMills)
        .map((row) => (
          <p className="text-sm" key={row.lotId}>
            {row.lotNumber} · {row.onHandUnits.toLocaleString()} units on hand:{" "}
            {money(row.beforeMills)} → <strong>{money(row.afterMills)}</strong>
          </p>
        ))}
      {preview.impact.orderCosts
        .filter((row) => row.totalMills.before !== row.totalMills.after)
        .map((row) => (
          <p className="text-sm" key={row.costId}>
            Order #{row.orderId} · cost basis: {money(row.totalMills.before)} →{" "}
            <strong>{money(row.totalMills.after)}</strong>
          </p>
        ))}
      {preview.impact.historicalCosts
        .filter((row) => row.totalMills.before !== row.totalMills.after)
        .map((row, index) => (
          <p className="text-sm" key={index}>
            Previously approved{" "}
            {row.destination === "historical_cogs"
              ? "cost of goods sold"
              : "inventory adjustment"}
            : {money(row.totalMills.before)} →{" "}
            <strong>{money(row.totalMills.after)}</strong>
          </p>
        ))}
      {preview.unassignedInvoicePieces > 0 && (
        <p className="rounded bg-muted p-3 text-sm">
          {preview.unassignedInvoicePieces.toLocaleString()} invoiced pieces are
          not assigned to a receipt. Their invoice cost will not be applied to
          other goods. Receive them, then assign their invoice here.
        </p>
      )}
      {preview.issues.length > 0 && (
        <div role="status" className="rounded border border-amber-300 p-3">
          <strong>Cost items still needing attention</strong>
          <ul className="list-disc pl-4">
            {preview.issues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Received quantities, stock counts, shipments, supplier bills and
        payments do not change. Freight keeps its separate saved allocation.
        Order cost basis does not establish a sale or create a new expense.
      </p>
    </section>
  );
}

function Editor({
  loaded,
  storageKey,
  close,
  reload,
  setBusy,
}: {
  loaded: Context;
  storageKey: string;
  close: () => void;
  reload: () => void;
  setBusy: (busy: boolean) => void;
}) {
  const [context] = useState(loaded),
    client = useQueryClient(),
    navigation = useProcurementNavigation();
  const [recovery] = useState(() => {
    try {
      const raw = sessionStorage.getItem(storageKey),
        intent = raw ? intentSchema.parse(JSON.parse(raw)) : null;
      if (
        intent &&
        (intent.body.change.purchaseOrderLineId !==
          context.purchaseOrderLineId ||
          canonicalJson(intent.body.change) !==
            canonicalJson(intent.preview.change) ||
          intent.body.sourceVersion !== intent.preview.sourceVersion ||
          intent.body.previewVersion !== intent.preview.previewVersion)
      )
        throw new Error("Saved scope differs");
      return { intent, error: null };
    } catch {
      return {
        intent: null,
        error:
          "The browser's saved approval cannot be read. Verify its outcome before creating another approval.",
      };
    }
  });
  const [pending, setPending] = useState(recovery.intent),
    active = useRef(recovery.intent);
  const [rows, setRows] = useState<ReceiptInvoiceAllocation[]>(
    context.allocations,
  );
  const [review, setReview] = useState<Preview | null>(null),
    [saved, setSaved] = useState<z.infer<
      typeof receiptInvoiceResultSchema
    > | null>(null);
  const [reason, setReason] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [stale, setStale] = useState(false),
    [error, setError] = useState<string | null>(recovery.error);
  const preview = useMutation<Preview, Error>({
    mutationFn: async () => {
      const change = receiptInvoiceChangeSchema.parse({
        purchaseOrderLineId: context.purchaseOrderLineId,
        allocations: rows,
      });
      const result = receiptInvoicePreviewSchema.parse(
        await financialCommandFetchJson(`${endpoint}/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceVersion: context.sourceVersion,
            change,
          }),
        }),
      );
      if (
        result.sourceVersion !== context.sourceVersion ||
        canonicalJson(result.change) !== canonicalJson(change)
      )
        throw new Error(
          "The cost preview does not match these assignments. Reload it.",
        );
      return result;
    },
    onMutate: () => setBusy(true),
    onSuccess: (result) => {
      setReview(result);
      setConfirmed(false);
      setError(null);
    },
    onError: (failure) => {
      setError(failure.message);
      if (
        failure instanceof FinancialCommandRequestError &&
        failure.code === "RECEIPT_INVOICE_STALE"
      )
        setStale(true);
    },
    onSettled: () => setBusy(false),
  });
  const approval = useMutation<
    z.infer<typeof receiptInvoiceResultSchema>,
    Error,
    Intent
  >({
    mutationFn: async (intent: Intent) => {
      const result = receiptInvoiceResultSchema.safeParse(
        await financialCommandFetchJson(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": intent.key,
          },
          body: JSON.stringify(intent.body),
        }),
      );
      if (
        !result.success ||
        canonicalJson(result.data.preview) !== canonicalJson(intent.preview)
      )
        throw new FinancialCommandRequestError(
          "The approval may have saved. Retry it to verify the result.",
          {
            status: 200,
            ambiguous: true,
            retryable: true,
            code: "RECEIPT_INVOICE_RESULT_UNVERIFIED",
          },
        );
      return result.data;
    },
    retry: shouldRetryFinancialCommand,
    retryDelay: financialCommandRetryDelay,
    onMutate: () => setBusy(true),
    onSuccess: (result) => {
      setSaved(result);
      setPending(null);
      active.current = null;
      setStale(false);
      setError(null);
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        setError(
          "Costs saved. Reopening will verify the same approval if the browser retains it.",
        );
      }
    },
    onError: (failure) => {
      setError(failure.message);
      if (!financialCommandNeedsRecovery(failure)) {
        try {
          sessionStorage.removeItem(storageKey);
          setPending(null);
          active.current = null;
          setStale(true);
        } catch {
          setError(
            "The approval was rejected. Browser recovery could not be cleared; reload before creating a new approval.",
          );
        }
      }
    },
    onSettled: () => {
      setBusy(false);
      void invalidatePurchaseCosts(client);
    },
  });
  const locked =
    preview.isPending ||
    approval.isPending ||
    pending !== null ||
    saved !== null ||
    stale ||
    recovery.error !== null;
  const impact = saved?.preview ?? pending?.preview ?? review;
  function suggestion(): ReceiptInvoiceAllocation | null {
    if (
      rows.some(
        (row) =>
          ![row.pieces, row.receiptStartPiece, row.invoiceStartPiece].every(
            Number.isSafeInteger,
          ),
      )
    )
      return null;
    for (const receipt of context.receipts) {
      const receiptStartPiece = Math.max(
        0,
        ...rows
          .filter((row) => row.receivingLineId === receipt.receivingLineId)
          .map((row) => row.receiptStartPiece + row.pieces),
      );
      if (receiptStartPiece >= receipt.pieces) continue;
      for (const invoice of context.invoices.filter((row) => row.ready)) {
        const invoiceStartPiece = Math.max(
          0,
          ...rows
            .filter((row) => row.invoiceLineId === invoice.id)
            .map((row) => row.invoiceStartPiece + row.pieces),
        );
        if (invoiceStartPiece >= invoice.pieces) continue;
        return {
          receivingLineId: receipt.receivingLineId,
          invoiceLineId: invoice.id,
          receiptStartPiece,
          invoiceStartPiece,
          pieces: Math.min(
            receipt.pieces - receiptStartPiece,
            invoice.pieces - invoiceStartPiece,
          ),
        };
      }
    }
    return null;
  }
  function add() {
    const next = suggestion();
    if (next) setRows([...rows, next]);
  }
  function approve() {
    if (!review || active.current || !confirmed || !context.canApprove) return;
    try {
      const intent = intentSchema.parse({
        key: crypto.randomUUID(),
        body: {
          sourceVersion: context.sourceVersion,
          change: review.change,
          previewVersion: review.previewVersion,
          reason,
          approvalConfirmed: true,
        },
        preview: review,
      });
      sessionStorage.setItem(storageKey, JSON.stringify(intent));
      active.current = intent;
      setPending(intent);
      approval.mutate(intent);
    } catch {
      setError(
        "Enter a reason of at least 10 characters. Browser recovery must be available before approving.",
      );
    }
  }
  const changed =
    !context.enabled ||
    canonicalJson(rows) !== canonicalJson(context.allocations);
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto space-y-4 pr-1">
        <h3 className="font-medium">{context.label}</h3>
        {!context.canApprove && (
          <p>
            An Administrator with purchasing approval permission must approve
            changes.
          </p>
        )}
        {!impact && (
          <>
            <p className="text-sm">
              Choose which received pieces each approved invoice covers. Other
              pieces keep their provisional PO cost.
            </p>
            {context.receipts.length === 0 && (
              <p>
                Complete receiving before assigning invoice costs. No received
                pieces with proven cost origins are available yet.
              </p>
            )}
            {context.invoices.some((invoice) => !invoice.ready) && (
              <p>
                Some invoices need their product, packaging or tax amounts
                reviewed before they can be assigned.
              </p>
            )}
            {rows.map((row, index) => (
              <div key={index} className="rounded border p-3 space-y-2">
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="text-sm">
                    Receipt
                    <select
                      aria-label={`Receipt ${index + 1}`}
                      className="w-full rounded border p-2 bg-background"
                      disabled={locked}
                      value={row.receivingLineId}
                      onChange={(event) =>
                        setRows(
                          rows.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  receivingLineId: Number(event.target.value),
                                  receiptStartPiece: 0,
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      {context.receipts.map((receipt) => (
                        <option
                          key={receipt.receivingLineId}
                          value={receipt.receivingLineId}
                        >
                          {receipt.receiptNumber} ·{" "}
                          {receipt.pieces.toLocaleString()} pieces
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Supplier invoice
                    <select
                      aria-label={`Invoice ${index + 1}`}
                      className="w-full rounded border p-2 bg-background"
                      disabled={locked}
                      value={row.invoiceLineId}
                      onChange={(event) =>
                        setRows(
                          rows.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  invoiceLineId: Number(event.target.value),
                                  invoiceStartPiece: 0,
                                }
                              : item,
                          ),
                        )
                      }
                    >
                      {context.invoices.map((invoice) => (
                        <option
                          key={invoice.id}
                          value={invoice.id}
                          disabled={!invoice.ready}
                        >
                          {invoice.invoiceNumber} ·{" "}
                          {invoice.pieces.toLocaleString()} pieces
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm">
                    Pieces covered
                    <Input
                      aria-label={`Pieces covered ${index + 1}`}
                      type="number"
                      min="1"
                      step="1"
                      disabled={locked}
                      value={Number.isFinite(row.pieces) ? row.pieces : ""}
                      onChange={(event) =>
                        setRows(
                          rows.map((item, i) =>
                            i === index
                              ? {
                                  ...item,
                                  pieces:
                                    event.target.value === ""
                                      ? Number.NaN
                                      : Number(event.target.value),
                                }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                </div>
                <details className="text-sm">
                  <summary>Assign part of a receipt or invoice</summary>
                  <div className="grid gap-2 sm:grid-cols-2 mt-2">
                    {(
                      [
                        ["First piece on receipt", "receiptStartPiece"],
                        ["First piece on invoice", "invoiceStartPiece"],
                      ] as const
                    ).map(([label, field]) => (
                      <label key={field}>
                        {label}
                        <Input
                          aria-label={`${label} ${index + 1}`}
                          type="number"
                          min="1"
                          step="1"
                          disabled={locked}
                          value={row[field] + 1}
                          onChange={(event) =>
                            setRows(
                              rows.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      [field]: Number(event.target.value) - 1,
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                </details>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={locked}
                  onClick={() => setRows(rows.filter((_, i) => i !== index))}
                >
                  Remove assignment
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              disabled={
                locked ||
                !context.receipts.length ||
                !context.invoices.some((row) => row.ready) ||
                suggestion() === null ||
                rows.length >= 500
              }
              onClick={add}
            >
              Add invoice assignment
            </Button>
            {context.enabled && !changed && (
              <p className="text-green-800 dark:text-green-300">
                These are the saved receipt assignments. Edit an assignment to
                review a change.
              </p>
            )}
            <div className="text-sm space-y-2">
              {context.costs.map((row) => (
                <p key={row.receivingLineId}>
                  <a
                    className="underline"
                    href={navigation.childHref(
                      `/receiving?open=${row.receiptId}`,
                    )}
                  >
                    {row.receiptNumber}
                  </a>
                  : {money(row.supplierMills)} ·{" "}
                  {row.confirmedPieces.toLocaleString()} pieces at invoice cost
                  · {row.provisionalPieces.toLocaleString()} provisional
                </p>
              ))}
            </div>
          </>
        )}
        {impact && <CostChanges preview={impact} saved={saved !== null} />}
        {impact && !saved && (
          <>
            <label className="block text-sm">
              Reason / supplier reference
              <textarea
                aria-label="Reason / supplier reference"
                className="w-full rounded border bg-background p-2"
                value={reason}
                disabled={locked}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                disabled={locked}
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I checked these receipts and supplier invoices and approve the
              cost changes.
            </label>
          </>
        )}
        {saved && (
          <p role="status" className="text-green-800 dark:text-green-300">
            Assignment approved and saved.{" "}
            {saved.preview.issues.length
              ? "The remaining cost issues are listed above."
              : "The cost update completed."}{" "}
            Approval #{saved.auditEventId}.
          </p>
        )}
        {context.approvals.length > 0 && (
          <details>
            <summary>Previous approvals (latest 20)</summary>
            <ul className="mt-2 text-sm space-y-2">
              {context.approvals.map((entry, index) => (
                <li key={index}>
                  <details>
                    <summary>
                      {entry.actorName} ·{" "}
                      {new Date(entry.approvedAt).toLocaleString()}
                    </summary>
                    <p>{entry.reason}</p>
                    <CostChanges preview={entry.preview} saved />
                  </details>
                </li>
              ))}
            </ul>
          </details>
        )}
        {(error || preview.error || approval.error) && (
          <p role="alert" className="text-destructive">
            {error ?? preview.error?.message ?? approval.error?.message}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t pt-3">
        <Button
          variant="outline"
          disabled={preview.isPending || approval.isPending}
          onClick={close}
        >
          {saved ? "Done" : "Close"}
        </Button>
        {stale && !pending && (
          <Button onClick={reload}>Reload cost review</Button>
        )}
        {pending ? (
          <Button
            disabled={approval.isPending}
            onClick={() => approval.mutate(pending)}
          >
            Retry saved approval
          </Button>
        ) : (
          !saved &&
          !stale &&
          (review ? (
            <>
              <Button variant="outline" onClick={() => setReview(null)}>
                Edit assignments
              </Button>
              <Button
                disabled={
                  locked ||
                  !confirmed ||
                  reason.trim().length < 10 ||
                  !context.canApprove
                }
                onClick={approve}
              >
                Approve &amp; update costs
              </Button>
            </>
          ) : (
            <Button
              disabled={
                locked ||
                !changed ||
                !context.canApprove ||
                (!context.enabled && rows.length === 0)
              }
              onClick={() => preview.mutate()}
            >
              Review changes
            </Button>
          ))
        )}
      </div>
    </>
  );
}

export function ReceiptInvoiceCosts({
  purchaseOrderLineId,
  label = "Receipt invoice costs",
}: {
  purchaseOrderLineId: number;
  label?: string;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [epoch, setEpoch] = useState(0),
    [requestId, setRequestId] = useState("");
  const url = `${endpoint}/${purchaseOrderLineId}`;
  const query = useQuery({
    queryKey: [url, user?.id, requestId, epoch],
    enabled: open && !!user?.id,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const result = receiptInvoiceContextSchema.parse(
        await financialCommandFetchJson(url, { method: "GET" }),
      );
      if (result.purchaseOrderLineId !== purchaseOrderLineId)
        throw new Error("The receipt cost source does not match this PO line.");
      return result;
    },
  });
  function changeOpen(next: boolean) {
    if (busy) return;
    if (next) setRequestId(crypto.randomUUID());
    setOpen(next);
    if (!next) setEpoch((value) => value + 1);
  }
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => changeOpen(true)}>
        {label}
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent
          className="flex max-h-[92dvh] flex-col overflow-hidden sm:max-w-2xl"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Assign invoice costs to receipts</DialogTitle>
            <DialogDescription>
              Keep each received batch at its own invoice cost. Review the
              before and after, then approve one update.
            </DialogDescription>
          </DialogHeader>
          {query.isPending && (
            <p>Loading receipts, approved invoices and current costs…</p>
          )}
          {query.error && <p role="alert">{query.error.message}</p>}
          {query.data && (
            <Editor
              key={epoch}
              loaded={query.data}
              storageKey={`receipt-invoice-costs:${user?.id}:${purchaseOrderLineId}`}
              close={() => changeOpen(false)}
              reload={() => setEpoch((value) => value + 1)}
              setBusy={setBusy}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Read-only immutable approval history; no current cost graph or new approval. */
export function ReceiptInvoiceApprovalHistory({
  purchaseOrderId,
}: {
  purchaseOrderId: number;
}) {
  const url = `/api/purchase-orders/${purchaseOrderId}/receipt-invoice-cost-approvals`;
  const entries = useQuery({
    queryKey: [url],
    queryFn: async () =>
      receiptInvoiceApprovalHistorySchema.parse(
        await financialCommandFetchJson(url, { method: "GET" }),
      ),
  });
  if (entries.isPending) return <p>Loading receipt cost approvals…</p>;
  if (entries.error)
    return (
      <div role="alert">
        Receipt cost approvals could not be loaded.{" "}
        <Button variant="outline" onClick={() => void entries.refetch()}>
          Reload approvals
        </Button>
      </div>
    );
  if (!entries.data?.length) return null;
  return (
    <section
      role="region"
      aria-label="Approved receipt invoice costs"
      className="space-y-3 rounded border p-3"
    >
      <h3 className="font-semibold">Receipt cost approvals (latest 20)</h3>
      {entries.data.map((entry, index) => (
        <details key={index}>
          <summary className="cursor-pointer">
            {entry.label} · {entry.actorName} ·{" "}
            {new Date(entry.approvedAt).toLocaleString()}
          </summary>
          <p className="py-2 text-sm">{entry.reason}</p>
          <CostChanges preview={entry.preview} saved />
        </details>
      ))}
    </section>
  );
}
