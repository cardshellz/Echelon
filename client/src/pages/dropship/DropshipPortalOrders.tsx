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
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  buildDropshipOrderAcceptInput,
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
} from "@/lib/dropship-ops-surface";
import { useDropshipAuth, type DropshipSensitiveAction } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingOrderAction = "send-code" | "verify-code" | "passkey-proof" | "accept" | null;

const statusOptions = [
  "all",
  "received",
  "processing",
  "accepted",
  "payment_hold",
  "failed",
  "exception",
  "rejected",
  "cancelled",
];

const orderAcceptanceAction: DropshipSensitiveAction = "high_risk_order_acceptance";
const acceptanceStatuses = new Set(["received", "retrying", "failed", "payment_hold", "processing"]);

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
  const [acceptingIntakeId, setAcceptingIntakeId] = useState<number | null>(null);
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
    if (!await ensureOrderSensitiveProof(order.intakeId)) return;

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

  async function ensureOrderSensitiveProof(intakeId: number): Promise<boolean> {
    if (hasActiveProof(orderAcceptanceAction)) return true;
    if (principal?.hasPasskey) {
      return runOrderAction("passkey-proof", intakeId, async () => {
        await verifyPasskeyStepUp(orderAcceptanceAction);
      });
    }
    if (!emailCodeSent) {
      await runOrderAction("send-code", intakeId, async () => {
        await startEmailStepUp(orderAcceptanceAction);
        setEmailCodeSent(true);
        setMessage("Verification code sent. Enter it below, then retry Accept.");
      });
      return false;
    }
    return runOrderAction("verify-code", intakeId, async () => {
      await verifyEmailStepUp({
        action: orderAcceptanceAction,
        verificationCode,
      });
    });
  }

  async function runOrderAction(
    action: PendingOrderAction,
    intakeId: number | null,
    task: () => Promise<void>,
  ): Promise<boolean> {
    setPendingOrderAction(action);
    setAcceptingIntakeId(intakeId);
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
      setAcceptingIntakeId(null);
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
              acceptingIntakeId={acceptingIntakeId}
              emailCodeSent={emailCodeSent}
              orders={ordersQuery.data.items}
              pendingOrderAction={pendingOrderAction}
              total={ordersQuery.data.total}
              verificationCode={verificationCode}
              onAccept={acceptOrder}
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
  acceptingIntakeId,
  emailCodeSent,
  onAccept,
  onView,
  orders,
  pendingOrderAction,
  total,
  verificationCode,
}: {
  acceptingIntakeId: number | null;
  emailCodeSent: boolean;
  onAccept: (order: DropshipOrderListItem) => void;
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
            const disabled = !canAccept
              || pendingOrderAction !== null
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
                        disabled={disabled}
                        onClick={() => onAccept(order)}
                      >
                        {acceptButtonIcon(order, acceptingIntakeId, emailCodeSent, pendingOrderAction)}
                        {acceptButtonLabel(order, acceptingIntakeId, emailCodeSent, pendingOrderAction)}
                      </Button>
                    ) : (
                      <span className="text-sm text-zinc-500">{acceptanceStateLabel(order)}</span>
                    )}
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

function orderAcceptanceMessage(result: DropshipOrderAcceptResponse["result"]): string {
  if (result.outcome === "payment_hold") {
    return `Order intake ${result.intakeId} placed on payment hold for ${formatCents(result.totalDebitCents)}.`;
  }
  return `Order intake ${result.intakeId} accepted for ${formatCents(result.totalDebitCents)}.`;
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
  if (pendingOrderAction === "send-code") return "Sending code";
  if (pendingOrderAction === "verify-code") return "Verifying code";
  if (pendingOrderAction === "passkey-proof") return "Waiting for passkey";
  if (pendingOrderAction === "accept") return "Accepting";
  return emailCodeSent ? "Verify and accept" : "Accept";
}

function acceptButtonIcon(
  order: DropshipOrderListItem,
  acceptingIntakeId: number | null,
  emailCodeSent: boolean,
  pendingOrderAction: PendingOrderAction,
) {
  if (acceptingIntakeId === order.intakeId && pendingOrderAction === "passkey-proof") {
    return <Fingerprint className="h-4 w-4" />;
  }
  if (
    acceptingIntakeId === order.intakeId
    && (pendingOrderAction === "send-code" || pendingOrderAction === "verify-code")
  ) {
    return <Mail className="h-4 w-4" />;
  }
  if (emailCodeSent) return <Mail className="h-4 w-4" />;
  return <CheckCircle2 className="h-4 w-4" />;
}

function statusTone(status: string): string {
  if (status === "accepted" || status === "processing") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "payment_hold" || status === "retrying") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "failed" || status === "exception" || status === "rejected") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
