import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Eye, History, Package, Plus, ReceiptText, RotateCcw, Search, Truck, Wallet } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
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
  allDropshipRmaStatuses,
  buildQueryUrl,
  buildPortalReturnCreateInput,
  createDropshipIdempotencyKey,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
  type DropshipOrderDetail,
  type DropshipOrderDetailLine,
  type DropshipOrderDetailResponse,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
  type DropshipPortalReturnCreateResponse,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnFaultCategory,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
} from "@/lib/dropship-ops-surface";
import { Textarea } from "@/components/ui/textarea";
import { DropshipPortalShell } from "./DropshipPortalShell";

const statuses = ["all", ...allDropshipRmaStatuses];
const returnFaultOptions: Array<DropshipReturnFaultCategory | "none"> = [
  "none",
  "card_shellz",
  "vendor",
  "customer",
  "marketplace",
  "carrier",
];

const initialReturnCreateForm: PortalReturnCreateFormState = {
  rmaNumber: "",
  intakeId: "",
  reasonCode: "",
  faultCategory: "none",
  labelSource: "",
  returnTrackingNumber: "",
  vendorNotes: "",
  orderLineIndex: "",
  productVariantId: "",
  quantity: "",
  requestedCreditAmount: "",
};

interface PortalReturnCreateFormState {
  rmaNumber: string;
  intakeId: string;
  reasonCode: string;
  faultCategory: DropshipReturnFaultCategory | "none";
  labelSource: string;
  returnTrackingNumber: string;
  vendorNotes: string;
  orderLineIndex: string;
  productVariantId: string;
  quantity: string;
  requestedCreditAmount: string;
}

export default function DropshipPortalReturns() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const [selectedRmaId, setSelectedRmaId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<PortalReturnCreateFormState>(initialReturnCreateForm);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const returnsUrl = useMemo(() => buildQueryUrl("/api/dropship/returns", {
    search: applied.search,
    statuses: applied.status === "all" ? undefined : applied.status,
    page: 1,
    limit: 50,
  }), [applied]);
  const orderPickerUrl = useMemo(() => buildQueryUrl("/api/dropship/orders", {
    page: 1,
    limit: 50,
  }), []);
  const selectedCreateIntakeId = useMemo(() => {
    if (!createForm.intakeId.trim()) return null;
    const parsed = Number(createForm.intakeId);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [createForm.intakeId]);
  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });
  const orderPickerQuery = useQuery<DropshipOrderListResponse>({
    queryKey: ["dropship-return-order-picker", orderPickerUrl],
    queryFn: () => fetchJson<DropshipOrderListResponse>(orderPickerUrl),
    enabled: createOpen,
  });
  const createOrderDetailQuery = useQuery<DropshipOrderDetailResponse>({
    queryKey: ["dropship-return-order-detail", selectedCreateIntakeId],
    queryFn: () => {
      if (selectedCreateIntakeId === null) throw new Error("Missing selected order.");
      return fetchJson<DropshipOrderDetailResponse>(`/api/dropship/orders/${selectedCreateIntakeId}`);
    },
    enabled: createOpen && selectedCreateIntakeId !== null,
  });
  const returnDetailQuery = useQuery<DropshipReturnDetailResponse>({
    queryKey: ["dropship-return-detail", selectedRmaId],
    queryFn: () => {
      if (selectedRmaId === null) throw new Error("Missing selected RMA.");
      return fetchJson<DropshipReturnDetailResponse>(`/api/dropship/returns/${selectedRmaId}`);
    },
    enabled: selectedRmaId !== null,
  });

  async function submitReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");
    try {
      const hasItem = !returnItemFormIsBlank(createForm);
      const input = buildPortalReturnCreateInput({
        idempotencyKey: createDropshipIdempotencyKey("portal-rma-create"),
        rmaNumber: createForm.rmaNumber,
        intakeId: createForm.intakeId,
        reasonCode: createForm.reasonCode,
        faultCategory: createForm.faultCategory,
        labelSource: createForm.labelSource,
        returnTrackingNumber: createForm.returnTrackingNumber,
        vendorNotes: createForm.vendorNotes,
        items: hasItem
          ? [{
              productVariantId: createForm.productVariantId,
              quantity: createForm.quantity,
              status: "requested",
              requestedCreditAmount: createForm.requestedCreditAmount,
            }]
          : [],
      });
      const response = await postJson<DropshipPortalReturnCreateResponse>("/api/dropship/returns", input);
      setCreateForm(initialReturnCreateForm);
      setCreateOpen(false);
      setMessage(`RMA ${response.rma.rmaNumber} submitted.`);
      setSelectedRmaId(response.rma.rmaId);
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["dropship-return-detail", response.rma.rmaId] }),
      ]);
    } catch (submitError) {
      setError(queryErrorMessage(submitError, "Unable to submit return."));
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateCreateForm<K extends keyof PortalReturnCreateFormState>(
    key: K,
    value: PortalReturnCreateFormState[K],
  ) {
    setCreateForm((current) => ({ ...current, [key]: value }));
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <RotateCcw className="h-6 w-6 text-[#C060E0]" />
              Returns
            </h1>
            <p className="mt-1 text-sm text-zinc-500">RMA status, inspection progress, and final credit outcomes.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={() => {
                setCreateOpen(true);
                setError("");
                setMessage("");
              }}
            >
              <Plus className="h-4 w-4" />
              Submit RMA
            </Button>
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search RMAs" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : formatStatus(option)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, status })}>
              Apply
            </Button>
          </div>
        </div>

        {message && (
          <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
            <ReceiptText className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {returnsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(returnsQuery.error, "Unable to load dropship returns.")}
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {returnsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : returnsQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Returns unavailable</EmptyTitle>
                <EmptyDescription>The returns API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : returnsQuery.data?.items.length ? (
            <ReturnsTable
              returns={returnsQuery.data.items}
              total={returnsQuery.data.total}
              onView={(rma) => setSelectedRmaId(rma.rmaId)}
            />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><RotateCcw /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No returns</EmptyTitle>
                <EmptyDescription>No dropship RMAs match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <CreateReturnSheet
          form={createForm}
          isSubmitting={isSubmitting}
          isOrderDetailLoading={createOrderDetailQuery.isLoading}
          isOrdersLoading={orderPickerQuery.isLoading}
          onChange={updateCreateForm}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open && !isSubmitting) {
              setError("");
            }
          }}
          onSubmit={submitReturn}
          orderDetail={createOrderDetailQuery.data?.order ?? null}
          orderDetailError={createOrderDetailQuery.error}
          orders={orderPickerQuery.data?.items ?? []}
          ordersError={orderPickerQuery.error}
          open={createOpen}
        />
        <ReturnDetailSheet
          error={returnDetailQuery.error}
          isLoading={returnDetailQuery.isLoading}
          open={selectedRmaId !== null}
          rma={returnDetailQuery.data?.rma ?? null}
          onOpenChange={(open) => {
            if (!open) setSelectedRmaId(null);
          }}
        />
      </div>
    </DropshipPortalShell>
  );
}

function CreateReturnSheet({
  form,
  isSubmitting,
  isOrderDetailLoading,
  isOrdersLoading,
  onChange,
  onOpenChange,
  onSubmit,
  orderDetail,
  orderDetailError,
  orders,
  ordersError,
  open,
}: {
  form: PortalReturnCreateFormState;
  isSubmitting: boolean;
  isOrderDetailLoading: boolean;
  isOrdersLoading: boolean;
  onChange: <K extends keyof PortalReturnCreateFormState>(key: K, value: PortalReturnCreateFormState[K]) => void;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  orderDetail: DropshipOrderDetail | null;
  orderDetailError: unknown;
  orders: DropshipOrderListItem[];
  ordersError: unknown;
  open: boolean;
}) {
  const selectableLines = orderDetail?.lines.filter((line) => line.productVariantId !== null) ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Submit RMA</SheetTitle>
          <SheetDescription>Vendor RMA submission</SheetDescription>
        </SheetHeader>

        <form className="mt-6 space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="portal-rma-order">Order</Label>
            <Select
              value={form.intakeId || "none"}
              onValueChange={(value) => {
                onChange("intakeId", value === "none" ? "" : value);
                onChange("orderLineIndex", "");
                onChange("productVariantId", "");
                onChange("quantity", "");
              }}
              disabled={isOrdersLoading}
            >
              <SelectTrigger id="portal-rma-order">
                <SelectValue placeholder={isOrdersLoading ? "Loading orders" : "Select order"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No linked order</SelectItem>
                {orders.map((order) => (
                  <SelectItem key={order.intakeId} value={String(order.intakeId)}>
                    {orderOptionLabel(order)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ordersError ? (
              <p className="text-sm text-rose-700">{queryErrorMessage(ordersError, "Unable to load orders.")}</p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="portal-rma-number">RMA number</Label>
              <Input
                id="portal-rma-number"
                value={form.rmaNumber}
                onChange={(event) => onChange("rmaNumber", event.target.value)}
                maxLength={80}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-return-tracking">Return tracking</Label>
              <Input
                id="portal-return-tracking"
                value={form.returnTrackingNumber}
                onChange={(event) => onChange("returnTrackingNumber", event.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-rma-reason">Reason code</Label>
              <Input
                id="portal-rma-reason"
                value={form.reasonCode}
                onChange={(event) => onChange("reasonCode", event.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-rma-fault">Fault</Label>
              <Select
                value={form.faultCategory}
                onValueChange={(value) => onChange("faultCategory", value as DropshipReturnFaultCategory | "none")}
              >
                <SelectTrigger id="portal-rma-fault">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {returnFaultOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "none" ? "Pending" : formatStatus(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="portal-rma-label-source">Label source</Label>
              <Input
                id="portal-rma-label-source"
                value={form.labelSource}
                onChange={(event) => onChange("labelSource", event.target.value)}
                maxLength={255}
              />
            </div>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-2">
              <Label htmlFor="portal-rma-line">Order line</Label>
              <Select
                value={form.orderLineIndex || "none"}
                onValueChange={(value) => {
                  if (value === "none") {
                    onChange("orderLineIndex", "");
                    onChange("productVariantId", "");
                    onChange("quantity", "");
                    return;
                  }
                  const line = selectableLines.find((candidate) => String(candidate.lineIndex) === value);
                  onChange("orderLineIndex", value);
                  onChange("productVariantId", line?.productVariantId ? String(line.productVariantId) : "");
                  onChange("quantity", line?.quantity ? String(line.quantity) : "");
                }}
                disabled={!form.intakeId || isOrderDetailLoading || selectableLines.length === 0}
              >
                <SelectTrigger id="portal-rma-line">
                  <SelectValue placeholder={isOrderDetailLoading ? "Loading lines" : "Select line"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No linked line</SelectItem>
                  {selectableLines.map((line) => (
                    <SelectItem key={line.lineIndex} value={String(line.lineIndex)}>
                      {orderLineOptionLabel(line)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {orderDetailError ? (
                <p className="text-sm text-rose-700">{queryErrorMessage(orderDetailError, "Unable to load order lines.")}</p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-rma-quantity">Qty</Label>
              <Input
                id="portal-rma-quantity"
                inputMode="numeric"
                value={form.quantity}
                onChange={(event) => onChange("quantity", event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-rma-credit">Requested credit</Label>
              <Input
                id="portal-rma-credit"
                inputMode="decimal"
                value={form.requestedCreditAmount}
                onChange={(event) => onChange("requestedCreditAmount", event.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="portal-rma-notes">Notes</Label>
            <Textarea
              id="portal-rma-notes"
              value={form.vendorNotes}
              onChange={(event) => onChange("vendorNotes", event.target.value)}
              maxLength={5000}
              rows={5}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" className="bg-[#C060E0] hover:bg-[#a94bc9]" disabled={isSubmitting}>
              {isSubmitting ? "Submitting..." : "Submit RMA"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ReturnDetailSheet({
  error,
  isLoading,
  onOpenChange,
  open,
  rma,
}: {
  error: unknown;
  isLoading: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  rma: DropshipReturnDetail | null;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{rma ? rma.rmaNumber : "Return details"}</SheetTitle>
          <SheetDescription>
            {rma ? `${formatStatus(rma.status)} RMA ${rma.rmaId}` : "Dropship return detail"}
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
            <AlertDescription>{queryErrorMessage(error, "Unable to load return detail.")}</AlertDescription>
          </Alert>
        ) : rma ? (
          <div className="mt-6 space-y-6">
            <section className="grid gap-3 text-sm sm:grid-cols-2">
              <DetailField label="Status" value={formatStatus(rma.status)} />
              <DetailField label="Fault" value={rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"} />
              <DetailField label="Reason" value={rma.reasonCode ? formatStatus(rma.reasonCode) : "Not recorded"} />
              <DetailField label="Return window" value={`${rma.returnWindowDays} days`} />
              <DetailField label="Platform" value={rma.platform ? formatStatus(rma.platform) : "Not recorded"} />
              <DetailField label="Label source" value={rma.labelSource ? formatStatus(rma.labelSource) : "Not recorded"} />
              <DetailField label="Intake" value={rma.intakeId ? String(rma.intakeId) : "Not linked"} />
              <DetailField label="OMS order" value={rma.omsOrderId ? String(rma.omsOrderId) : "Not linked"} />
              <DetailField label="Requested" value={formatDateTime(rma.requestedAt)} />
              <DetailField label="Received" value={formatDateTime(rma.receivedAt)} />
              <DetailField label="Inspected" value={formatDateTime(rma.inspectedAt)} />
              <DetailField label="Credited" value={formatDateTime(rma.creditedAt)} />
            </section>

            {rma.vendorNotes && (
              <>
                <Separator />
                <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Vendor Notes">
                  <p className="whitespace-pre-wrap text-sm text-zinc-700">{rma.vendorNotes}</p>
                </ReturnDetailSection>
              </>
            )}

            <Separator />

            <ReturnDetailSection icon={<Package className="h-4 w-4" />} title="Items">
              {rma.items.length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Requested</TableHead>
                        <TableHead className="text-right">Final</TableHead>
                        <TableHead className="text-right">Fee</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.items.map((item) => (
                        <TableRow key={item.rmaItemId}>
                          <TableCell>
                            <div className="font-medium">RMA item {item.rmaItemId}</div>
                            <div className="text-xs text-zinc-500">
                              {item.productVariantId ? `Variant ${item.productVariantId}` : "Variant not linked"}
                            </div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(item.status)}>{formatStatus(item.status)}</Badge></TableCell>
                          <TableCell className="text-right font-mono">{item.quantity}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.requestedCreditCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.finalCreditCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(item.feeCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No return items recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Truck className="h-4 w-4" />} title="Return Tracking">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Tracking number" value={rma.returnTrackingNumber || "None"} />
                <DetailField label="Updated" value={formatDateTime(rma.updatedAt)} />
              </div>
            </ReturnDetailSection>

            <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Inspections">
              {rma.inspections.length ? (
                <div className="space-y-3">
                  {rma.inspections.map((inspection) => (
                    <div key={inspection.rmaInspectionId} className="rounded-md border border-zinc-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">Inspection {inspection.rmaInspectionId}</span>
                          <Badge variant="outline" className={statusTone(inspection.outcome)}>{formatStatus(inspection.outcome)}</Badge>
                        </div>
                        <span className="text-xs text-zinc-500">{formatDateTime(inspection.createdAt)}</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                        <DetailField label="Fault" value={inspection.faultCategory ? formatStatus(inspection.faultCategory) : "Not recorded"} />
                        <DetailField label="Inspected by" value={inspection.inspectedBy || "Not recorded"} />
                        <DetailField label="Credit" value={formatCents(inspection.creditCents)} />
                        <DetailField label="Fee" value={formatCents(inspection.feeCents)} />
                        <DetailField label="Photos" value={String(inspection.photos.length)} />
                      </div>
                      {inspection.notes && (
                        <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-700">{inspection.notes}</p>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No inspections recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Wallet className="h-4 w-4" />} title="Wallet Ledger">
              {rma.walletLedger.length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Entry</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Balance After</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.walletLedger.map((entry) => (
                        <TableRow key={entry.ledgerEntryId}>
                          <TableCell>
                            <div className="font-medium">{formatStatus(entry.type)}</div>
                            <div className="text-xs text-zinc-500">Ledger {entry.ledgerEntryId}</div>
                            <div className="text-xs text-zinc-500">{formatDateTime(entry.createdAt)}</div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(entry.status)}>{formatStatus(entry.status)}</Badge></TableCell>
                          <TableCell className="text-right">{formatCents(entry.amountCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(entry.availableBalanceAfterCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No wallet return adjustments recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<History className="h-4 w-4" />} title="Audit References">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Idempotency key" value={rma.idempotencyKey || "Not recorded"} />
                <DetailField label="Request hash" value={rma.requestHash || "Not recorded"} />
              </div>
            </ReturnDetailSection>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ReturnsTable({
  onView,
  returns,
  total,
}: {
  onView: (rma: DropshipReturnListItem) => void;
  returns: DropshipReturnListItem[];
  total: number;
}) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} return{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>RMA</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fault</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {returns.map((rma) => (
            <TableRow key={rma.rmaId}>
              <TableCell>
                <div className="font-medium">{rma.rmaNumber}</div>
                <div className="text-xs text-zinc-500">{rma.reasonCode ? formatStatus(rma.reasonCode) : "No reason"}</div>
              </TableCell>
              <TableCell><Badge variant="outline">{formatStatus(rma.status)}</Badge></TableCell>
              <TableCell>{rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"}</TableCell>
              <TableCell className="font-mono">{rma.itemCount} / {rma.totalQuantity}</TableCell>
              <TableCell className="font-mono text-xs">{rma.returnTrackingNumber || "None"}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(rma.updatedAt)}</TableCell>
              <TableCell className="text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-2"
                  onClick={() => onView(rma)}
                >
                  <Eye className="h-4 w-4" />
                  Details
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function ReturnDetailSection({
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

function orderOptionLabel(order: DropshipOrderListItem): string {
  const orderNumber = order.externalOrderNumber || order.externalOrderId;
  return `${formatStatus(order.platform)} ${orderNumber} - ${formatStatus(order.status)} - ${formatDateTime(order.receivedAt)}`;
}

function orderLineOptionLabel(line: DropshipOrderDetailLine): string {
  const label = line.title || line.sku || `Variant ${line.productVariantId}`;
  const price = typeof line.unitRetailPriceCents === "number"
    ? ` - ${formatCents(line.unitRetailPriceCents)} each`
    : "";
  return `${label} - Qty ${line.quantity}${price}`;
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-1 break-words text-zinc-900">{value}</div>
    </div>
  );
}

function formatNullableCents(value: number | null | undefined): string {
  return typeof value === "number" ? formatCents(value) : "Not recorded";
}

function returnItemFormIsBlank(form: PortalReturnCreateFormState): boolean {
  return !form.productVariantId.trim()
    && !form.quantity.trim()
    && !form.requestedCreditAmount.trim();
}

function statusTone(status: string): string {
  if (
    status === "approved"
    || status === "credited"
    || status === "closed"
    || status === "settled"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "requested"
    || status === "in_transit"
    || status === "received"
    || status === "inspecting"
    || status === "pending"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "rejected" || status === "failed" || status === "voided") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
