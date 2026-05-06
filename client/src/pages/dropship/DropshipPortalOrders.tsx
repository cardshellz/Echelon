import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Eye,
  Fingerprint,
  History,
  Mail,
  MapPin,
  Package,
  ReceiptText,
  Search,
  Truck,
  Wallet,
  XCircle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  allDropshipOpsOrderIntakeStatuses,
  buildDropshipOrderAcceptInput,
  buildDropshipOrderRejectInput,
  buildQueryUrl,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
  type DropshipOrderAcceptResponse,
  type DropshipOrderDetail,
  type DropshipOrderDetailResponse,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
  type DropshipOrderRejectResponse,
} from "@/lib/dropship-ops-surface";
import { useDropshipAuth, type DropshipSensitiveAction } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingOrderAction =
  | "accept-send-code"
  | "accept-verify-code"
  | "accept-passkey-proof"
  | "accept"
  | "reject-send-code"
  | "reject-verify-code"
  | "reject-passkey-proof"
  | "reject"
  | null;

const statusOptions = ["all", ...allDropshipOpsOrderIntakeStatuses];

const orderAcceptanceAction: DropshipSensitiveAction = "high_risk_order_acceptance";
const acceptanceStatuses = new Set(["received", "retrying", "failed", "payment_hold", "processing"]);
const rejectionStatuses = new Set(["received", "retrying", "failed", "payment_hold"]);

export default function DropshipPortalOrders() {
  const queryClient = useQueryClient();
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingOrderAction, setPendingOrderAction] = useState<PendingOrderAction>(null);
  const [actingIntakeId, setActingIntakeId] = useState<number | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DropshipOrderListItem | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [selectedIntakeId, setSelectedIntakeId] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const ordersUrl = useMemo(() => buildQueryUrl("/api/dropship/orders", {
    search: applied.search,
    statuses: applied.status === "all" ? undefined : applied.status,
    page: 1,
    limit: 50,
  }), [applied]);
  const ordersQuery = useQuery<DropshipOrderListResponse>({
    queryKey: [ordersUrl],
    queryFn: () => fetchJson<DropshipOrderListResponse>(ordersUrl),
  });
  const orderDetailQuery = useQuery<DropshipOrderDetailResponse>({
    queryKey: ["dropship-order-detail", selectedIntakeId],
    queryFn: () => fetchJson<DropshipOrderDetailResponse>(`/api/dropship/orders/${selectedIntakeId}`),
    enabled: selectedIntakeId !== null,
  });
  const hasActiveProof = (action: DropshipSensitiveAction) => {
    const proof = sensitiveProofs[action];
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  };

  async function acceptOrder(order: DropshipOrderListItem) {
    if (!await ensureOrderSensitiveProof({
      intakeId: order.intakeId,
      passkeyAction: "accept-passkey-proof",
      sendCodeAction: "accept-send-code",
      verifyCodeAction: "accept-verify-code",
      sentMessage: "Verification code sent. Enter it below, then retry Accept.",
      codeRequiredMessage: "Enter the 6-digit verification code before accepting the order.",
    })) return;

    await runOrderAction("accept", order.intakeId, async () => {
      const response = await postJson<DropshipOrderAcceptResponse>(
        `/api/dropship/orders/${order.intakeId}/accept`,
        buildDropshipOrderAcceptInput({
          idempotencyKey: createDropshipIdempotencyKey(`order-accept:${order.intakeId}`),
        }),
      );
      await Promise.all([
        ordersQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["dropship-order-detail", order.intakeId] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/wallet?limit=50"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setEmailCodeSent(false);
      setVerificationCode("");
      setMessage(orderAcceptanceMessage(response.result));
    });
  }

  async function rejectOrder() {
    if (!rejectTarget) return;
    const order = rejectTarget;
    if (!await ensureOrderSensitiveProof({
      intakeId: order.intakeId,
      passkeyAction: "reject-passkey-proof",
      sendCodeAction: "reject-send-code",
      verifyCodeAction: "reject-verify-code",
      sentMessage: "Verification code sent. Enter it below, then retry Reject.",
      codeRequiredMessage: "Enter the 6-digit verification code before rejecting the order.",
    })) return;

    await runOrderAction("reject", order.intakeId, async () => {
      const response = await postJson<DropshipOrderRejectResponse>(
        `/api/dropship/orders/${order.intakeId}/reject`,
        buildDropshipOrderRejectInput({
          idempotencyKey: createDropshipIdempotencyKey(`order-reject:${order.intakeId}`),
          reason: rejectReason,
        }),
      );
      await Promise.all([
        ordersQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["dropship-order-detail", order.intakeId] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/onboarding/state"] }),
      ]);
      setEmailCodeSent(false);
      setVerificationCode("");
      setRejectTarget(null);
      setRejectReason("");
      setMessage(orderRejectionMessage(response.result));
    });
  }

  async function ensureOrderSensitiveProof(input: {
    intakeId: number;
    passkeyAction: PendingOrderAction;
    sendCodeAction: PendingOrderAction;
    verifyCodeAction: PendingOrderAction;
    sentMessage: string;
    codeRequiredMessage: string;
  }): Promise<boolean> {
    if (hasActiveProof(orderAcceptanceAction)) {
      setEmailCodeSent(false);
      setVerificationCode("");
      return true;
    }
    if (principal?.hasPasskey) {
      return runOrderAction(input.passkeyAction, input.intakeId, async () => {
        await verifyPasskeyStepUp(orderAcceptanceAction);
      });
    }
    if (!emailCodeSent) {
      await runOrderAction(input.sendCodeAction, input.intakeId, async () => {
        await startEmailStepUp(orderAcceptanceAction);
        setEmailCodeSent(true);
        setVerificationCode("");
        setMessage(input.sentMessage);
      });
      return false;
    }
    if (verificationCode.length !== 6) {
      setError(input.codeRequiredMessage);
      return false;
    }

    const verified = await runOrderAction(input.verifyCodeAction, input.intakeId, async () => {
      await verifyEmailStepUp({
        action: orderAcceptanceAction,
        verificationCode,
      });
    });
    if (verified) {
      setEmailCodeSent(false);
      setVerificationCode("");
    }
    return verified;
  }

  async function runOrderAction(
    action: PendingOrderAction,
    intakeId: number | null,
    task: () => Promise<void>,
  ): Promise<boolean> {
    setPendingOrderAction(action);
    setActingIntakeId(intakeId);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Dropship order request failed.");
      return false;
    } finally {
      setPendingOrderAction(null);
      setActingIntakeId(null);
    }
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <ClipboardList className="h-6 w-6 text-[#C060E0]" />
              Orders
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Marketplace intake, acceptance, payment holds, and fulfillment handoff status.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search orders" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : formatStatus(option)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, status })}>
              Apply
            </Button>
          </div>
        </div>

        {ordersQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(ordersQuery.error, "Unable to load dropship orders.")}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        {emailCodeSent && (
          <SensitiveActionVerificationPanel
            pendingOrderAction={pendingOrderAction}
            verificationCode={verificationCode}
            onVerificationCodeChange={setVerificationCode}
          />
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {ordersQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : ordersQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Orders unavailable</EmptyTitle>
                <EmptyDescription>The orders API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : ordersQuery.data?.items.length ? (
            <OrdersTable
              actingIntakeId={actingIntakeId}
              emailCodeSent={emailCodeSent}
              orders={ordersQuery.data.items}
              pendingOrderAction={pendingOrderAction}
              total={ordersQuery.data.total}
              verificationCode={verificationCode}
              onAccept={acceptOrder}
              onReject={(order) => {
                setRejectTarget(order);
                setRejectReason("");
                setEmailCodeSent(false);
                setVerificationCode("");
                setError("");
                setMessage("");
              }}
              onView={(order) => setSelectedIntakeId(order.intakeId)}
            />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No orders</EmptyTitle>
                <EmptyDescription>No dropship orders match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <OrderDetailSheet
          error={orderDetailQuery.error}
          isLoading={orderDetailQuery.isLoading}
          order={orderDetailQuery.data?.order ?? null}
          open={selectedIntakeId !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedIntakeId(null);
          }}
        />
        <RejectOrderDialog
          emailCodeSent={emailCodeSent}
          order={rejectTarget}
          pendingOrderAction={pendingOrderAction}
          reason={rejectReason}
          verificationCode={verificationCode}
          onOpenChange={(open) => {
            if (!open && pendingOrderAction === null) {
              setRejectTarget(null);
              setRejectReason("");
            }
          }}
          onReasonChange={setRejectReason}
          onReject={rejectOrder}
        />
      </div>
    </DropshipPortalShell>
  );
}

function OrderDetailSheet({
  error,
  isLoading,
  onOpenChange,
  open,
  order,
}: {
  error: unknown;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  order: DropshipOrderDetail | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{order ? order.externalOrderNumber || order.externalOrderId : "Order details"}</SheetTitle>
          <SheetDescription>
            {order ? `${formatStatus(order.platform)} intake ${order.intakeId}` : "Marketplace intake detail"}
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="mt-6 space-y-3">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : error ? (
          <Alert variant="destructive" className="mt-6">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{queryErrorMessage(error, "Unable to load order detail.")}</AlertDescription>
          </Alert>
        ) : order ? (
          <div className="mt-6 space-y-6">
            <section className="grid gap-3 text-sm sm:grid-cols-2">
              <DetailField label="Status" value={formatStatus(order.status)} />
              <DetailField label="Store" value={order.storeConnection.externalDisplayName || formatStatus(order.storeConnection.platform)} />
              <DetailField label="External ID" value={order.externalOrderId} />
              <DetailField label="OMS order" value={order.omsOrderId ? String(order.omsOrderId) : "Not created"} />
              <DetailField label="Received" value={formatDateTime(order.receivedAt)} />
              <DetailField label="Accepted" value={formatDateTime(order.acceptedAt)} />
              <DetailField label="Marketplace status" value={order.marketplaceStatus || "Not recorded"} />
              <DetailField label="Payment hold" value={formatDateTime(order.paymentHoldExpiresAt)} />
            </section>

            <Separator />

            <OrderDetailSection icon={<Package className="h-4 w-4" />} title="Lines">
              <div className="rounded-md border border-zinc-200">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Retail</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {order.lines.map((line) => (
                      <TableRow key={`${line.lineIndex}:${line.externalLineItemId ?? line.sku ?? "line"}`}>
                        <TableCell>
                          <div className="font-medium">{line.title || "Untitled line"}</div>
                          <div className="text-xs text-zinc-500">
                            {line.productVariantId ? `Variant ${line.productVariantId}` : "Variant not linked"}
                          </div>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{line.sku || "None"}</TableCell>
                        <TableCell className="text-right font-mono">{line.quantity}</TableCell>
                        <TableCell className="text-right">
                          {line.lineRetailTotalCents === null ? "Not recorded" : formatCents(line.lineRetailTotalCents)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </OrderDetailSection>

            <OrderDetailSection icon={<MapPin className="h-4 w-4" />} title="Ship To">
              <div className="space-y-1 text-sm text-zinc-700">
                {shipToAddressLines(order).map((line) => <div key={line}>{line}</div>)}
              </div>
            </OrderDetailSection>

            <OrderDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Marketplace Totals">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Retail subtotal" value={formatNullableCents(order.totals?.retailSubtotalCents)} />
                <DetailField label="Shipping paid" value={formatNullableCents(order.totals?.shippingPaidCents)} />
                <DetailField label="Tax" value={formatNullableCents(order.totals?.taxCents)} />
                <DetailField label="Grand total" value={formatNullableCents(order.totals?.grandTotalCents)} />
              </div>
            </OrderDetailSection>

            <OrderDetailSection icon={<Wallet className="h-4 w-4" />} title="Acceptance Economics">
              {order.economicsSnapshot ? (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <DetailField label="Wholesale" value={formatCents(order.economicsSnapshot.wholesaleSubtotalCents)} />
                  <DetailField label="Shipping" value={formatCents(order.economicsSnapshot.shippingCents)} />
                  <DetailField label="Insurance pool" value={formatCents(order.economicsSnapshot.insurancePoolCents)} />
                  <DetailField label="Total debit" value={formatCents(order.economicsSnapshot.totalDebitCents)} />
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No accepted economics snapshot.</p>
              )}
            </OrderDetailSection>

            <OrderDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Shipping Quote">
              {order.shippingQuoteSnapshot ? (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <DetailField label="Quote" value={String(order.shippingQuoteSnapshot.quoteSnapshotId)} />
                  <DetailField label="Warehouse" value={String(order.shippingQuoteSnapshot.warehouseId)} />
                  <DetailField label="Packages" value={String(order.shippingQuoteSnapshot.packageCount)} />
                  <DetailField label="Total shipping" value={formatCents(order.shippingQuoteSnapshot.totalShippingCents)} />
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No shipping quote snapshot recorded.</p>
              )}
            </OrderDetailSection>

            <OrderDetailSection icon={<Truck className="h-4 w-4" />} title="Marketplace Tracking">
              {(order.trackingPushes ?? []).length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Shipment</TableHead>
                        <TableHead>Tracking</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Updated</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(order.trackingPushes ?? []).map((push) => (
                        <TableRow key={push.pushId}>
                          <TableCell>
                            <div className="font-medium">
                              {push.wmsShipmentId ? `Shipment ${push.wmsShipmentId}` : "Order shipment"}
                            </div>
                            <div className="text-xs text-zinc-500">{formatStatus(push.platform)} push {push.pushId}</div>
                          </TableCell>
                          <TableCell>
                            <div className="font-medium">{push.carrier}</div>
                            <div className="font-mono text-xs text-zinc-600">{push.trackingNumber}</div>
                            {push.externalFulfillmentId && (
                              <div className="mt-1 max-w-60 truncate text-xs text-zinc-500">
                                Fulfillment {push.externalFulfillmentId}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={statusTone(push.status)}>{formatStatus(push.status)}</Badge>
                            {push.lastErrorMessage && (
                              <div className="mt-1 max-w-60 text-xs text-rose-700">{push.lastErrorMessage}</div>
                            )}
                            {push.status === "failed" && push.retryable === false && (
                              <div className="mt-1 text-xs text-zinc-500">Manual review required</div>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-sm text-zinc-500">
                            <div>{formatDateTime(push.updatedAt)}</div>
                            <div className="text-xs">Shipped {formatDateTime(push.shippedAt)}</div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No marketplace tracking pushes recorded.</p>
              )}
            </OrderDetailSection>

            <OrderDetailSection icon={<Wallet className="h-4 w-4" />} title="Wallet Debit">
              {order.walletLedgerEntry ? (
                <div className="grid gap-2 text-sm sm:grid-cols-2">
                  <DetailField label="Ledger entry" value={String(order.walletLedgerEntry.walletLedgerEntryId)} />
                  <DetailField label="Status" value={formatStatus(order.walletLedgerEntry.status)} />
                  <DetailField label="Amount" value={formatCents(order.walletLedgerEntry.amountCents)} />
                  <DetailField label="Balance after" value={formatNullableCents(order.walletLedgerEntry.availableBalanceAfterCents)} />
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No wallet debit recorded.</p>
              )}
            </OrderDetailSection>

            <OrderDetailSection icon={<History className="h-4 w-4" />} title="Audit">
              <div className="space-y-3">
                {order.auditEvents.length ? order.auditEvents.map((event) => (
                  <div key={`${event.createdAt}:${event.eventType}`} className="border-l-2 border-zinc-200 pl-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{formatStatus(event.eventType)}</span>
                      <Badge variant="outline" className={statusTone(event.severity)}>{formatStatus(event.severity)}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-zinc-500">
                      {formatDateTime(event.createdAt)} by {formatStatus(event.actorType)}
                      {event.actorId ? ` ${event.actorId}` : ""}
                    </div>
                    {auditPayloadSummary(event.payload) && (
                      <div className="mt-1 text-xs text-zinc-600">{auditPayloadSummary(event.payload)}</div>
                    )}
                  </div>
                )) : (
                  <p className="text-sm text-zinc-500">No audit events recorded.</p>
                )}
              </div>
            </OrderDetailSection>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function OrdersTable({
  actingIntakeId,
  emailCodeSent,
  onAccept,
  onReject,
  onView,
  orders,
  pendingOrderAction,
  total,
  verificationCode,
}: {
  actingIntakeId: number | null;
  emailCodeSent: boolean;
  onAccept: (order: DropshipOrderListItem) => void;
  onReject: (order: DropshipOrderListItem) => void;
  onView: (order: DropshipOrderListItem) => void;
  orders: DropshipOrderListItem[];
  pendingOrderAction: PendingOrderAction;
  total: number;
  verificationCode: string;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} order{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Marketplace order</TableHead>
            <TableHead>Store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ship to</TableHead>
            <TableHead>Lines</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => {
            const canAccept = canAcceptOrder(order);
            const canReject = canRejectOrder(order);
            const actionDisabled = pendingOrderAction !== null
              || (emailCodeSent && verificationCode.length !== 6);
            return (
              <TableRow key={order.intakeId}>
                <TableCell>
                  <div className="font-medium">{order.externalOrderNumber || order.externalOrderId}</div>
                  <div className="text-xs text-zinc-500">{formatStatus(order.platform)} intake {order.intakeId}</div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">{order.storeConnection.externalDisplayName || formatStatus(order.storeConnection.platform)}</div>
                  <div className="text-xs text-zinc-500">{order.storeConnection.shopDomain || formatStatus(order.storeConnection.status)}</div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className={statusTone(order.status)}>{formatStatus(order.status)}</Badge>
                  {order.rejectionReason && <div className="mt-1 max-w-60 truncate text-xs text-zinc-500">{order.rejectionReason}</div>}
                </TableCell>
                <TableCell>{shipToLabel(order)}</TableCell>
                <TableCell className="font-mono">{order.lineCount} / {order.totalQuantity}</TableCell>
                <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(order.updatedAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-9 gap-2"
                      onClick={() => onView(order)}
                    >
                      <Eye className="h-4 w-4" />
                      Details
                    </Button>
                    {canAccept ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 gap-2"
                        disabled={actionDisabled}
                        onClick={() => onAccept(order)}
                      >
                        {acceptButtonIcon(order, actingIntakeId, emailCodeSent, pendingOrderAction)}
                        {acceptButtonLabel(order, actingIntakeId, emailCodeSent, pendingOrderAction)}
                      </Button>
                    ) : (
                      <span className="text-sm text-zinc-500">{acceptanceStateLabel(order)}</span>
                    )}
                    {canReject ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 gap-2 border-rose-200 text-rose-700 hover:bg-rose-50"
                        disabled={actionDisabled}
                        onClick={() => onReject(order)}
                      >
                        <XCircle className="h-4 w-4" />
                        Reject
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}

function RejectOrderDialog({
  emailCodeSent,
  onOpenChange,
  onReasonChange,
  onReject,
  order,
  pendingOrderAction,
  reason,
  verificationCode,
}: {
  emailCodeSent: boolean;
  onOpenChange: (open: boolean) => void;
  onReasonChange: (value: string) => void;
  onReject: () => void;
  order: DropshipOrderListItem | null;
  pendingOrderAction: PendingOrderAction;
  reason: string;
  verificationCode: string;
}) {
  const pending = pendingOrderAction !== null;
  const confirmDisabled = pending
    || reason.trim().length < 3
    || (emailCodeSent && verificationCode.length !== 6);

  return (
    <Dialog open={order !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Reject order</DialogTitle>
          <DialogDescription>
            {order
              ? `${order.externalOrderNumber || order.externalOrderId} will be marked rejected and queued for marketplace cancellation.`
              : "Reject this dropship order."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="dropship-order-reject-reason">Reason</Label>
          <Textarea
            id="dropship-order-reject-reason"
            value={reason}
            onChange={(event) => onReasonChange(event.target.value)}
            maxLength={1000}
            rows={4}
            placeholder="Why this order cannot be fulfilled"
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-2 bg-rose-600 hover:bg-rose-700"
            disabled={confirmDisabled}
            onClick={onReject}
          >
            {pendingOrderAction === "reject-passkey-proof" ? <Fingerprint className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {rejectButtonLabel(pendingOrderAction)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OrderDetailSection({
  children,
  icon,
  title,
}: {
  children: ReactNode;
  icon: ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-1 break-words text-zinc-900">{value}</div>
    </div>
  );
}

function shipToAddressLines(order: DropshipOrderDetail): string[] {
  const shipTo = order.shipTo;
  if (!shipTo) return ["No ship-to address recorded."];
  const lines = [
    shipTo.name,
    shipTo.company,
    shipTo.address1,
    shipTo.address2,
    [shipTo.city, shipTo.region, shipTo.postalCode].filter(Boolean).join(", "),
    shipTo.country,
    shipTo.phone ? `Phone: ${shipTo.phone}` : null,
    shipTo.email ? `Email: ${shipTo.email}` : null,
  ].filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  return lines.length ? lines : ["No ship-to address recorded."];
}

function formatNullableCents(value: number | null | undefined): string {
  return typeof value === "number" ? formatCents(value) : "Not recorded";
}

function auditPayloadSummary(payload: Record<string, unknown>): string {
  const keys = [
    "errorCode",
    "errorMessage",
    "reason",
    "shippingQuoteSnapshotId",
    "omsOrderId",
    "walletLedgerEntryId",
    "totalDebitCents",
    "availableBalanceCents",
    "paymentHoldExpiresAt",
  ];
  const parts = keys.flatMap((key) => {
    const value = payload[key];
    if (value === null || value === undefined || value === "") return [];
    if (key.endsWith("Cents") && typeof value === "number") {
      return [`${formatStatus(key)}: ${formatCents(value)}`];
    }
    return [`${formatStatus(key)}: ${String(value)}`];
  });
  return parts.join(" | ");
}

function SensitiveActionVerificationPanel({
  onVerificationCodeChange,
  pendingOrderAction,
  verificationCode,
}: {
  onVerificationCodeChange: (value: string) => void;
  pendingOrderAction: PendingOrderAction;
  verificationCode: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="max-w-sm space-y-2">
        <Label>Verification code</Label>
        <InputOTP
          maxLength={6}
          value={verificationCode}
          onChange={onVerificationCodeChange}
          containerClassName="justify-between"
          disabled={pendingOrderAction !== null}
        >
          <InputOTPGroup>
            {Array.from({ length: 6 }).map((_, index) => (
              <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
            ))}
          </InputOTPGroup>
        </InputOTP>
      </div>
    </section>
  );
}

function shipToLabel(order: DropshipOrderListItem): string {
  const shipTo = order.shipTo;
  if (!shipTo) return "None";
  const locality = [shipTo.city, shipTo.region, shipTo.postalCode].filter(Boolean).join(", ");
  return locality || shipTo.country || shipTo.name || "Available";
}

function canAcceptOrder(order: DropshipOrderListItem): boolean {
  return acceptanceStatuses.has(order.status) && order.storeConnection.status === "connected";
}

function canRejectOrder(order: DropshipOrderListItem): boolean {
  return rejectionStatuses.has(order.status) && order.storeConnection.status === "connected" && order.omsOrderId === null;
}

function orderAcceptanceMessage(result: DropshipOrderAcceptResponse["result"]): string {
  if (result.outcome === "payment_hold") {
    return `Order intake ${result.intakeId} placed on payment hold for ${formatCents(result.totalDebitCents)}.`;
  }
  return `Order intake ${result.intakeId} accepted for ${formatCents(result.totalDebitCents)}.`;
}

function orderRejectionMessage(result: DropshipOrderRejectResponse["result"]): string {
  if (result.status === "cancelled") {
    return `Order intake ${result.intakeId} was already rejected and cancelled.`;
  }
  return `Order intake ${result.intakeId} rejected and queued for marketplace cancellation.`;
}

function acceptanceStateLabel(order: DropshipOrderListItem): string {
  if (order.status === "accepted") return "Accepted";
  if (order.status === "cancelled") return "Cancelled";
  if (order.status === "rejected") return "Rejected";
  if (order.storeConnection.status !== "connected") return "Store blocked";
  return "Not available";
}

function acceptButtonLabel(
  order: DropshipOrderListItem,
  acceptingIntakeId: number | null,
  emailCodeSent: boolean,
  pendingOrderAction: PendingOrderAction,
): string {
  if (acceptingIntakeId !== order.intakeId) return emailCodeSent ? "Verify and accept" : "Accept";
  if (pendingOrderAction === "accept-send-code") return "Sending code";
  if (pendingOrderAction === "accept-verify-code") return "Verifying code";
  if (pendingOrderAction === "accept-passkey-proof") return "Waiting for passkey";
  if (pendingOrderAction === "accept") return "Accepting";
  return emailCodeSent ? "Verify and accept" : "Accept";
}

function acceptButtonIcon(
  order: DropshipOrderListItem,
  acceptingIntakeId: number | null,
  emailCodeSent: boolean,
  pendingOrderAction: PendingOrderAction,
) {
  if (acceptingIntakeId === order.intakeId && pendingOrderAction === "accept-passkey-proof") {
    return <Fingerprint className="h-4 w-4" />;
  }
  if (
    acceptingIntakeId === order.intakeId
    && (pendingOrderAction === "accept-send-code" || pendingOrderAction === "accept-verify-code")
  ) {
    return <Mail className="h-4 w-4" />;
  }
  if (emailCodeSent) return <Mail className="h-4 w-4" />;
  return <CheckCircle2 className="h-4 w-4" />;
}

function rejectButtonLabel(pendingOrderAction: PendingOrderAction): string {
  if (pendingOrderAction === "reject-send-code") return "Sending code";
  if (pendingOrderAction === "reject-verify-code") return "Verifying code";
  if (pendingOrderAction === "reject-passkey-proof") return "Waiting for passkey";
  if (pendingOrderAction === "reject") return "Rejecting";
  return "Reject order";
}

function statusTone(status: string): string {
  if (status === "accepted" || status === "processing" || status === "succeeded") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "payment_hold" || status === "retrying" || status === "queued") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "failed" || status === "exception" || status === "rejected") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
