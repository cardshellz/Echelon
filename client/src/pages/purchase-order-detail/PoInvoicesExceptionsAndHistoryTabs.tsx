import { Link } from "wouter";
import { format } from "date-fns";
import { Clock, DollarSign, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { ReceiptInvoiceApprovalHistory } from "@/features/purchasing/ReceiptInvoiceCosts";
import { FreightInvoiceApprovalHistory } from "@/features/purchasing/FreightInvoiceCosts";
import { SupplierReturnLink } from "@/features/purchasing/SupplierReturnLink";
import { SupplierCreditLink } from "@/features/purchasing/SupplierCreditLink";
import { PoVarianceApproval } from "@/features/purchasing/PoVarianceApproval";
import { PurchaseTaxApprovalHistory } from "@/features/purchasing/PurchaseTaxReview";
import { PoAmendmentHistory } from "@/features/purchasing/PoAmendmentHistory";
import { PurchaseCostOriginHistory } from "@/features/purchasing/PurchaseCostOriginHistory";
import type { usePoShipmentCosts } from "@/features/purchasing/use-po-shipment-costs";
import { formatPaymentAmount } from "@/lib/ap-payment-command";
import { getPoExceptionLinks } from "@/lib/po-exception-navigation";
import { formatPaymentCalendarDate } from "@shared/procurement/ap-payment-contract";
import {
  formatActor,
  formatCents,
  type RelatedUsersMap,
  STATUS_BADGES,
} from "./po-detail-types-and-helpers";

// ── ExceptionCard ────────────────────────────────────────────────────
// One open or acknowledged exception. Severity drives the left border
// color; status drives which actions render. Resolve and dismiss prompt
// for nonfinancial notes. Financial variances use a reviewed admin command.
export function ExceptionCard({
  ex,
  purchaseOrderId,
  childHref,
  onAcknowledge,
  onResolve,
  onDismiss,
  onVarianceApproved,
  busy,
  relatedUsers,
}: {
  ex: any;
  purchaseOrderId: number | null;
  childHref: (destination: string) => string;
  onAcknowledge: () => void;
  onResolve: (note: string) => void;
  onDismiss: (note: string) => void;
  onVarianceApproved: () => void;
  busy: boolean;
  relatedUsers?: RelatedUsersMap;
}) {
  const severity = (ex.severity ?? "warn") as "info" | "warn" | "error";
  const borderClass =
    severity === "error"
      ? "border-l-4 border-l-red-600"
      : severity === "info"
      ? "border-l-4 border-l-blue-600"
      : "border-l-4 border-l-amber-500";
  const iconColor =
    severity === "error"
      ? "text-red-600"
      : severity === "info"
      ? "text-blue-600"
      : "text-amber-600";
  const detectedLabel = (() => {
    if (!ex.detectedAt) return null;
    const dt = new Date(ex.detectedAt);
    return `${dt.toLocaleDateString()} ${dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  })();
  const isMatchMismatch = ex.kind === "match_mismatch";
  const links = getPoExceptionLinks(ex, purchaseOrderId);
  const reviewHref = links ? childHref(links.invoiceHref ?? links.purchaseOrderHref) : null;
  const handleResolve = () => {
    const note = window.prompt(
      isMatchMismatch
        ? "Acceptance reason (required). This acceptance applies only to the current PO, receipt, and invoice values; any edit requires a new acceptance."
        : "Resolution note (required) — what fixed this exception?",
      "",
    );
    if (note === null) return; // user cancelled
    if (!note.trim()) {
      window.alert("A resolution note is required.");
      return;
    }
    onResolve(note.trim());
  };
  const handleDismiss = () => {
    const note = window.prompt(
      "Optional reason for dismissing (e.g. 'false alarm', 'duplicate'):",
      "",
    );
    if (note === null) return; // user cancelled
    onDismiss(note.trim());
  };
  return (
    <Card className={borderClass}>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className={`text-xl leading-none ${iconColor}`} aria-hidden>
            ⚠
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-2 flex-wrap">
              <h3 className="text-sm font-semibold">{ex.title}</h3>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Status: {ex.status === "acknowledged" ? "Acknowledged" : "Open"}
                </span>
                {reviewHref && (
                  <Button asChild size="sm" variant="outline" className="min-h-10">
                    <Link href={reviewHref}>
                      <ExternalLink className="h-4 w-4 mr-2" aria-hidden="true" />
                      {links?.invoiceHref ? "Open invoice issues" : "View PO lines"}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
            {detectedLabel && (
              <div className="text-xs text-muted-foreground mt-0.5">
                Detected {detectedLabel}
                {ex.detectedBy ? ` by ${formatActor(ex.detectedBy, relatedUsers)}` : ""}
              </div>
            )}
            {ex.message && (
              <p className="text-sm mt-2">{ex.message}</p>
            )}
            {isMatchMismatch && links && !links.invoiceHref && (
              <p className="text-xs text-muted-foreground mt-2">
                Invoice link unavailable for this exception. Review the PO lines or open the invoice from the Invoices tab.
              </p>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              {links?.invoiceHref && (
                <Button asChild size="sm" variant="outline" className="min-h-10">
                  <Link href={childHref(links.purchaseOrderHref)}>View PO lines</Link>
                </Button>
              )}
              {ex.status === "open" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onAcknowledge}
                  disabled={busy}
                >
                  Acknowledge
                </Button>
              )}
              {isMatchMismatch ? (
                <PoVarianceApproval exceptionId={ex.id} disabled={busy} onSaved={onVarianceApproved} />
              ) : (
                <Button
                  size="sm"
                  onClick={handleResolve}
                  disabled={busy}
                  data-testid={`resolve-exception-${ex.id}`}
                >
                  Mark resolved
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleDismiss}
                disabled={busy}
                className="text-muted-foreground"
              >
                Dismiss
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function PoInvoicesTab(props: {
  po: any;
  canCreatePurchasing: boolean;
  onOpenCreateInvoiceDialog: () => Promise<void>;
  invoicesData: { invoices: any[] } | undefined;
  invoicesLoading: boolean;
  invoicesRefreshing: boolean;
  invoicesError: boolean;
  onRefetchInvoices: () => void;
  childHref: (destination: string) => string;
}) {
  const {
    po,
    canCreatePurchasing,
    onOpenCreateInvoiceDialog,
    invoicesData,
    invoicesLoading,
    invoicesRefreshing,
    invoicesError,
    onRefetchInvoices,
    childHref,
  } = props;

  return (
    <TabsContent value="invoices" className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <SupplierCreditLink purchaseOrderId={po.id} />
        <SupplierReturnLink vendorId={po.vendorId} purchaseOrderId={po.id} />
      </div>
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Linked vendor invoices. Amounts and balances cover each entire invoice, which may include other purchase orders.
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canCreatePurchasing &&
            ["approved", "sent", "acknowledged", "partially_received", "received", "closed"].includes(po.status) && (
            <Button variant="outline" size="sm" onClick={() => void onOpenCreateInvoiceDialog()}>
              Add invoice
            </Button>
          )}
          <a href="/ap-invoices" className="text-sm text-blue-600 hover:underline">
            Manage all invoices →
          </a>
        </div>
      </div>
      {invoicesLoading || invoicesRefreshing ? (
        <p role="status" className="text-sm text-muted-foreground">{invoicesData ? "Refreshing linked invoices…" : "Loading linked invoices…"}</p>
      ) : invoicesError || !invoicesData || !Array.isArray(invoicesData.invoices) ? (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 p-4">
          <p>Linked invoices could not be loaded. Their approval and payment status is unavailable.</p>
          <Button variant="outline" size="sm" onClick={onRefetchInvoices}>Reload linked invoices</Button>
        </div>
      ) : invoicesData.invoices.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <p className="text-sm">No invoices linked to this PO yet.</p>
            <p className="text-xs mt-1">Create an invoice in the AP Invoices section and link this PO.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Invoice Date</TableHead>
                  <TableHead>Due Date</TableHead>
                  <TableHead className="text-right">Entire invoice amount</TableHead>
                  <TableHead className="text-right">Entire invoice balance</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoicesData.invoices.map((inv: any) => (
                  <TableRow key={inv.id} className={inv.status === "voided" ? "opacity-40" : ""}>
                    <TableCell className={`font-mono font-medium ${inv.status === "voided" ? "line-through" : ""}`}>{inv.invoiceNumber}</TableCell>
                    <TableCell className="text-sm">{inv.invoiceDate ? format(new Date(inv.invoiceDate), "MMM d, yyyy") : "—"}</TableCell>
                    <TableCell className={`text-sm ${inv.dueDate && new Date(inv.dueDate) < new Date() && !["paid", "voided"].includes(inv.status) ? "text-red-600 font-medium" : ""}`}>
                      {inv.dueDate ? format(new Date(inv.dueDate), "MMM d, yyyy") : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatCents(inv.invoicedAmountCents)}</TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      {formatCents(inv.balanceCents)}
                      <div className="text-xs text-muted-foreground">Cash {formatPaymentAmount(inv.paidAmountCents)} · Credits {formatPaymentAmount(inv.creditedAmountCents)}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{inv.status === "paid" && inv.creditedAmountCents > 0 ? "settled" : inv.status?.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell>
                      <Link href={childHref(`/ap-invoices/${inv.id}`)} className="text-xs text-blue-600 hover:underline">View →</Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </TabsContent>
  );
}

export function PoPaymentsTab(props: {
  paymentsData: { payments: any[] } | undefined;
  paymentsLoading: boolean;
  paymentsRefreshing: boolean;
  paymentsError: boolean;
  onRefetchPayments: () => void;
}) {
  const {
    paymentsData,
    paymentsLoading,
    paymentsRefreshing,
    paymentsError,
    onRefetchPayments,
  } = props;

  return (
    <TabsContent value="payments" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Payments applied to entire linked invoices. These amounts are not payment allocations to this purchase order.
      </p>
      {paymentsLoading || paymentsRefreshing ? (
        <p role="status" className="text-sm text-muted-foreground">{paymentsData ? "Refreshing invoice payments…" : "Loading invoice payments…"}</p>
      ) : paymentsError || !paymentsData || !Array.isArray(paymentsData.payments) ? (
        <div role="alert" className="space-y-2 rounded-md border border-amber-300 p-4">
          <p>Linked invoice payments could not be loaded. Payment history is unavailable.</p>
          <Button variant="outline" size="sm" onClick={onRefetchPayments}>Reload invoice payments</Button>
        </div>
      ) : paymentsData.payments.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <DollarSign className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No completed payments recorded against linked invoices.</p>
            <p className="text-xs mt-1">
              Payments appear here once invoices are linked and payment is applied in the AP ledger.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Payment Date</TableHead>
                  <TableHead>Method</TableHead>
                  <TableHead className="text-right">Applied to entire invoice</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Reference</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paymentsData.payments.map((p: any) => (
                  <TableRow key={p.allocationId}>
                    <TableCell className="text-sm">
                      {formatPaymentCalendarDate(p)}
                    </TableCell>
                    <TableCell className="capitalize">
                      {(p.paymentMethod ?? "").replace(/_/g, " ") || "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono font-medium">
                      {formatCents(p.appliedAmountCents)}
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {p.invoiceNumber ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {p.referenceNumber || p.paymentNumber || "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </TabsContent>
  );
}

export function PoExceptionsTab(props: {
  poId: number | null;
  openExceptions: any[];
  closedExceptions: any[];
  showResolvedExceptions: boolean;
  setShowResolvedExceptions: (show: boolean) => void;
  childHref: (destination: string) => string;
  onAcknowledgeException: (id: number) => void;
  onResolveException: (id: number, resolutionNote: string) => void;
  onDismissException: (id: number, note: string) => void;
  exceptionBusy: boolean;
  relatedUsers?: RelatedUsersMap;
  onVarianceApproved: () => void;
  onRefetchExceptions: () => void;
}) {
  const {
    poId,
    openExceptions,
    closedExceptions,
    showResolvedExceptions,
    setShowResolvedExceptions,
    childHref,
    onAcknowledgeException,
    onResolveException,
    onDismissException,
    exceptionBusy,
    relatedUsers,
    onVarianceApproved,
    onRefetchExceptions,
  } = props;

  return (
    <TabsContent value="exceptions" className="space-y-3">
      {openExceptions.length === 0 && closedExceptions.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            No exceptions on this PO.
          </CardContent>
        </Card>
      )}

      {openExceptions.length > 0 && (
        <div className="space-y-2">
          {openExceptions.map((ex: any) => (
            <ExceptionCard
              key={ex.id}
              ex={ex}
              purchaseOrderId={poId}
              childHref={childHref}
              onAcknowledge={() => onAcknowledgeException(ex.id)}
              onResolve={(note) => onResolveException(ex.id, note)}
              onDismiss={(note) => onDismissException(ex.id, note)}
              busy={exceptionBusy}
              relatedUsers={relatedUsers}
              onVarianceApproved={onVarianceApproved}
            />
          ))}
        </div>
      )}

      {(closedExceptions.length > 0 || showResolvedExceptions) && (
        <div className="pt-2">
          {!showResolvedExceptions ? (
            <button
              type="button"
              onClick={() => setShowResolvedExceptions(true)}
              className="w-full text-center text-xs text-muted-foreground py-2 rounded-md hover:bg-muted"
              data-testid="show-resolved-exceptions"
            >
              ▸ Show resolved / dismissed exceptions
            </button>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
                <span>Resolved / dismissed</span>
                <button
                  type="button"
                  onClick={() => setShowResolvedExceptions(false)}
                  className="underline hover:text-foreground"
                >
                  Hide
                </button>
              </div>
              {closedExceptions.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-3">
                  None.
                </div>
              ) : (
                closedExceptions.map((ex: any) => (
                  <div
                    key={ex.id}
                    className="text-xs border rounded-md p-2 bg-muted/30"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">
                        {ex.status === "resolved" ? "✓" : "✕"} {ex.title}
                      </span>
                      <span className="text-muted-foreground">
                        {ex.status === "resolved" ? "resolved" : "dismissed"}{" "}
                        {ex.resolvedAt ? new Date(ex.resolvedAt).toLocaleDateString() : ""}
                        {ex.resolvedBy ? ` by ${formatActor(ex.resolvedBy, relatedUsers)}` : ""}
                      </span>
                    </div>
                    {ex.kind === "match_mismatch" && (
                      <PoVarianceApproval exceptionId={ex.id} resolved disabled={false} onSaved={onRefetchExceptions} />
                    )}
                    {ex.resolutionNote && (
                      <div className="mt-1 text-muted-foreground italic">
                        “{ex.resolutionNote}”
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </TabsContent>
  );
}

export function PoHistoryTab(props: {
  poId: number | null;
  shipmentCosts: ReturnType<typeof usePoShipmentCosts>;
  history: any[];
  relatedUsers?: RelatedUsersMap;
}) {
  const { poId, shipmentCosts, history, relatedUsers } = props;

  return (
    <TabsContent value="history" className="space-y-4">
      {poId !== null && <PoAmendmentHistory purchaseOrderId={poId} />}
      {poId !== null && <PurchaseTaxApprovalHistory purchaseOrderId={poId} />}
      {poId !== null && <ReceiptInvoiceApprovalHistory purchaseOrderId={poId} />}
      {poId !== null && <FreightInvoiceApprovalHistory purchaseOrderId={poId} />}
      {shipmentCosts.isPending && <p role="status">Loading cost approval history…</p>}
      {shipmentCosts.isError && (
        <p role="alert">
          Cost approval history could not be loaded.{" "}
          <Button variant="outline" onClick={() => void shipmentCosts.refetch()}>Reload cost history</Button>
        </p>
      )}
      {shipmentCosts.data?.supplierCosts && <PurchaseCostOriginHistory status={shipmentCosts.data.supplierCosts} />}
      {history.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-center text-muted-foreground">
            No status history.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {history.map((h: any, i: number) => (
            <Card key={h.id || i}>
              <CardContent className="p-3 flex items-start gap-3">
                <div className="mt-1">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {h.fromStatus && (
                      <>
                        <Badge variant="outline" className="text-xs">{h.fromStatus}</Badge>
                        <span className="text-xs text-muted-foreground">→</span>
                      </>
                    )}
                    <Badge variant={STATUS_BADGES[h.toStatus]?.variant || "secondary"} className={`text-xs ${STATUS_BADGES[h.toStatus]?.color || ""}`}>
                      {STATUS_BADGES[h.toStatus]?.label || h.toStatus}
                    </Badge>
                  </div>
                  {h.notes && <p className="text-sm mt-1">{h.notes}</p>}
                  <p className="text-xs text-muted-foreground mt-1">
                    {h.changedAt ? format(new Date(h.changedAt), "MMM d, yyyy h:mm a") : ""}
                    {h.changedBy && ` • ${formatActor(h.changedBy, relatedUsers)}`}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </TabsContent>
  );
}
