import { useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Eye, Package, Plus, ReceiptText, RotateCcw, Search, Trash2, Truck, Wallet } from "lucide-react";
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
  postJson,
  type DropshipOrderDetailLine,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
  type DropshipPortalReturnCreateResponse,
  type DropshipReturnDetail,
  type DropshipReturnDetailResponse,
  type DropshipReturnFaultCategory,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
} from "@/lib/dropship-ops-surface";
import type {
  DropshipVendorOrderDetail,
  DropshipVendorOrderDetailResponse,
} from "@shared/dropship/vendor-order-detail";
import { Textarea } from "@/components/ui/textarea";
import {
  vendorErrorMessage,
  vendorInspectionOutcomeLabel,
  vendorLedgerEntryLabel,
  vendorLedgerStatusLabel,
  vendorMarketplaceOrderLabel,
  vendorOrderStatusLabel,
  vendorPlatformName,
  vendorReturnFaultLabel,
  vendorReturnLabelSourceLabel,
  vendorReturnReasonLabel,
  vendorReturnStatusLabel,
} from "@/lib/dropship-vendor-labels";
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

let returnItemClientCounter = 0;

interface PortalReturnCreateFormState {
  intakeId: string;
  reasonCode: string;
  faultCategory: DropshipReturnFaultCategory | "none";
  labelSource: string;
  returnTrackingNumber: string;
  vendorNotes: string;
  items: PortalReturnCreateItemFormState[];
}

interface PortalReturnCreateItemFormState {
  clientId: string;
  orderLineIndex: string;
  productVariantId: string;
  quantity: string;
}

function createInitialReturnCreateForm(): PortalReturnCreateFormState {
  return {
    intakeId: "",
    reasonCode: "",
    faultCategory: "none",
    labelSource: "",
    returnTrackingNumber: "",
    vendorNotes: "",
    items: [createInitialReturnItem()],
  };
}

function createInitialReturnItem(): PortalReturnCreateItemFormState {
  return {
    clientId: `return-item-${returnItemClientCounter += 1}`,
    orderLineIndex: "",
    productVariantId: "",
    quantity: "",
  };
}

export default function DropshipPortalReturns() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const [selectedRmaId, setSelectedRmaId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<PortalReturnCreateFormState>(() => createInitialReturnCreateForm());
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
    statuses: "accepted",
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
  const createOrderDetailQuery = useQuery<DropshipVendorOrderDetailResponse>({
    queryKey: ["dropship-return-order-detail", selectedCreateIntakeId],
    queryFn: () => {
      if (selectedCreateIntakeId === null) throw new Error("Missing selected order.");
      return fetchJson<DropshipVendorOrderDetailResponse>(`/api/dropship/orders/${selectedCreateIntakeId}`);
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
      const items = createForm.items
        .filter((item) => !returnItemFormIsBlank(item))
        .map((item) => ({
          productVariantId: item.productVariantId,
          quantity: item.quantity,
          status: "requested",
        }));
      const input = buildPortalReturnCreateInput({
        idempotencyKey: createDropshipIdempotencyKey("portal-rma-create"),
        intakeId: createForm.intakeId,
        reasonCode: createForm.reasonCode,
        faultCategory: createForm.faultCategory,
        labelSource: createForm.labelSource,
        returnTrackingNumber: createForm.returnTrackingNumber,
        vendorNotes: createForm.vendorNotes,
        items,
      });
      const response = await postJson<DropshipPortalReturnCreateResponse>("/api/dropship/returns", input);
      setCreateForm(createInitialReturnCreateForm());
      setCreateOpen(false);
      setMessage(`Return ${response.rma.rmaNumber} submitted.`);
      setSelectedRmaId(response.rma.rmaId);
      await Promise.all([
        returnsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["dropship-return-detail", response.rma.rmaId] }),
      ]);
    } catch (submitError) {
      setError(vendorErrorMessage(submitError, "We couldn't submit your return. Check the order and quantities, then try again."));
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

  function updateCreateReturnItem<K extends keyof PortalReturnCreateItemFormState>(
    clientId: string,
    key: K,
    value: PortalReturnCreateItemFormState[K],
  ) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.map((item) => (
        item.clientId === clientId ? { ...item, [key]: value } : item
      )),
    }));
  }

  function patchCreateReturnItem(clientId: string, patch: Partial<PortalReturnCreateItemFormState>) {
    setCreateForm((current) => ({
      ...current,
      items: current.items.map((item) => (
        item.clientId === clientId ? { ...item, ...patch, clientId: item.clientId } : item
      )),
    }));
  }

  function addCreateReturnItem() {
    setCreateForm((current) => ({
      ...current,
      items: [...current.items, createInitialReturnItem()],
    }));
  }

  function removeCreateReturnItem(clientId: string) {
    setCreateForm((current) => {
      const nextItems = current.items.filter((item) => item.clientId !== clientId);
      return {
        ...current,
        items: nextItems.length > 0 ? nextItems : [createInitialReturnItem()],
      };
    });
  }

  function resetCreateReturnItems() {
    setCreateForm((current) => ({
      ...current,
      items: [createInitialReturnItem()],
    }));
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
            <p className="mt-1 text-sm text-zinc-500">Your returns, where they are, and what you're credited.</p>
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
              Start a return
            </Button>
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search returns" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : vendorReturnStatusLabel(option)}</SelectItem>
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
              {vendorErrorMessage(returnsQuery.error, "We couldn't load your returns. Reload the page to try again.")}
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
                <EmptyDescription>We couldn't load your returns. Reload the page to try again.</EmptyDescription>
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
                <EmptyDescription>No returns match these filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
        <CreateReturnSheet
          form={createForm}
          isSubmitting={isSubmitting}
          isOrderDetailLoading={createOrderDetailQuery.isLoading}
          isOrdersLoading={orderPickerQuery.isLoading}
          onAddItem={addCreateReturnItem}
          onChange={updateCreateForm}
          onItemChange={updateCreateReturnItem}
          onItemPatch={patchCreateReturnItem}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open && !isSubmitting) {
              setError("");
            }
          }}
          onRemoveItem={removeCreateReturnItem}
          onResetItems={resetCreateReturnItems}
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
  onAddItem,
  onChange,
  onItemChange,
  onItemPatch,
  onOpenChange,
  onRemoveItem,
  onResetItems,
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
  onAddItem: () => void;
  onChange: <K extends keyof PortalReturnCreateFormState>(key: K, value: PortalReturnCreateFormState[K]) => void;
  onItemChange: <K extends keyof PortalReturnCreateItemFormState>(
    clientId: string,
    key: K,
    value: PortalReturnCreateItemFormState[K],
  ) => void;
  onItemPatch: (clientId: string, patch: Partial<PortalReturnCreateItemFormState>) => void;
  onOpenChange: (open: boolean) => void;
  onRemoveItem: (clientId: string) => void;
  onResetItems: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  orderDetail: DropshipVendorOrderDetail | null;
  orderDetailError: unknown;
  orders: DropshipOrderListItem[];
  ordersError: unknown;
  open: boolean;
}) {
  const selectableLines = orderDetail?.lines.filter((line) => line.productVariantId !== null) ?? [];
  const selectedLineIndexes = new Set(form.items.map((item) => item.orderLineIndex).filter(Boolean));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Start a return</SheetTitle>
          <SheetDescription>Tell us which order and items are coming back.</SheetDescription>
        </SheetHeader>

        <form className="mt-6 space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor="portal-rma-order">Order</Label>
            <Select
              value={form.intakeId || undefined}
              onValueChange={(value) => {
                onChange("intakeId", value);
                onResetItems();
              }}
              disabled={isOrdersLoading}
            >
              <SelectTrigger id="portal-rma-order">
                <SelectValue placeholder={isOrdersLoading ? "Loading orders" : "Select accepted order"} />
              </SelectTrigger>
              <SelectContent>
                {orders.map((order) => (
                  <SelectItem key={order.intakeId} value={String(order.intakeId)}>
                    {orderOptionLabel(order)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ordersError ? (
              <p className="text-sm text-rose-700">{vendorErrorMessage(ordersError, "We couldn't load your orders. Reload the page to try again.")}</p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Return number</Label>
              <div className="flex min-h-10 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground">
                Assigned automatically when submitted
              </div>
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
              <Label htmlFor="portal-rma-reason">Reason</Label>
              <Input
                id="portal-rma-reason"
                value={form.reasonCode}
                onChange={(event) => onChange("reasonCode", event.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="portal-rma-fault">Whose fault</Label>
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
                      {option === "none" ? "Not sure yet" : vendorReturnFaultLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="portal-rma-label-source">Who provides the return label</Label>
              <Input
                id="portal-rma-label-source"
                value={form.labelSource}
                onChange={(event) => onChange("labelSource", event.target.value)}
                maxLength={255}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <Label>Return items</Label>
                <p className="mt-1 text-sm text-zinc-500">Add each item from the order that's coming back.</p>
              </div>
              <Button type="button" variant="outline" className="gap-2" onClick={onAddItem}>
                <Plus className="h-4 w-4" />
                Add line
              </Button>
            </div>
            {orderDetailError ? (
              <p className="text-sm text-rose-700">{vendorErrorMessage(orderDetailError, "We couldn't load this order's items. Reload the page to try again.")}</p>
            ) : null}
            {form.intakeId && !isOrderDetailLoading && selectableLines.length === 0 && !orderDetailError ? (
              <p className="text-sm text-zinc-500">This order has no items that can be returned here.</p>
            ) : null}
            {form.items.map((item, index) => {
              const availableLines = selectableLines.filter((line) => {
                const lineIndex = String(line.lineIndex);
                return item.orderLineIndex === lineIndex || !selectedLineIndexes.has(lineIndex);
              });
              return (
                <div key={item.clientId} className="rounded-md border border-zinc-200 bg-zinc-50 p-3">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-zinc-700">Item {index + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Remove item"
                      aria-label="Remove item"
                      onClick={() => onRemoveItem(item.clientId)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor={`portal-rma-line-${item.clientId}`}>Item</Label>
                      <Select
                        value={item.orderLineIndex || "none"}
                        onValueChange={(value) => {
                          if (value === "none") {
                            onItemPatch(item.clientId, {
                              orderLineIndex: "",
                              productVariantId: "",
                              quantity: "",
                            });
                            return;
                          }
                          const line = selectableLines.find((candidate) => String(candidate.lineIndex) === value);
                          onItemPatch(item.clientId, {
                            orderLineIndex: value,
                            productVariantId: line?.productVariantId !== null && line?.productVariantId !== undefined
                              ? String(line.productVariantId)
                              : "",
                            quantity: typeof line?.quantity === "number" ? String(line.quantity) : "",
                          });
                        }}
                        disabled={!form.intakeId || isOrderDetailLoading || selectableLines.length === 0}
                      >
                        <SelectTrigger id={`portal-rma-line-${item.clientId}`}>
                          <SelectValue placeholder={isOrderDetailLoading ? "Loading items" : "Choose an item"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No item chosen</SelectItem>
                          {availableLines.map((line) => (
                            <SelectItem key={`${item.clientId}-${line.lineIndex}`} value={String(line.lineIndex)}>
                              {orderLineOptionLabel(line)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor={`portal-rma-quantity-${item.clientId}`}>Qty</Label>
                      <Input
                        id={`portal-rma-quantity-${item.clientId}`}
                        inputMode="numeric"
                        value={item.quantity}
                        onChange={(event) => onItemChange(item.clientId, "quantity", event.target.value)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
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
              {isSubmitting ? "Submitting..." : "Submit return"}
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
            {rma ? `${vendorReturnStatusLabel(rma.status)} · Return #${rma.rmaId}` : "Return details"}
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
            <AlertDescription>{vendorErrorMessage(error, "We couldn't load this return. Reload the page to try again.")}</AlertDescription>
          </Alert>
        ) : rma ? (
          <div className="mt-6 space-y-6">
            <section className="grid gap-3 text-sm sm:grid-cols-2">
              <DetailField label="Status" value={vendorReturnStatusLabel(rma.status)} />
              <DetailField label="Whose fault" value={rma.faultCategory ? vendorReturnFaultLabel(rma.faultCategory) : "Not decided yet"} />
              <DetailField label="Reason" value={rma.reasonCode ? vendorReturnReasonLabel(rma.reasonCode) : "Not given"} />
              <DetailField label="Return window" value={`${rma.returnWindowDays} days`} />
              <DetailField label="Marketplace" value={rma.platform ? vendorPlatformName(rma.platform) : "Not known"} />
              <DetailField label="Return label from" value={rma.labelSource ? vendorReturnLabelSourceLabel(rma.labelSource) : "Not known"} />
              <DetailField label="Requested" value={formatDateTime(rma.requestedAt)} />
              <DetailField label="Received" value={formatDateTime(rma.receivedAt)} />
              <DetailField label="Inspected" value={formatDateTime(rma.inspectedAt)} />
              <DetailField label="Credited" value={formatDateTime(rma.creditedAt)} />
            </section>

            {rma.vendorNotes && (
              <>
                <Separator />
                <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Your notes">
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
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.items.map((item, index) => (
                        <TableRow key={item.rmaItemId}>
                          <TableCell>
                            <div className="font-medium">Item {index + 1}</div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(item.status)}>{vendorReturnStatusLabel(item.status)}</Badge></TableCell>
                          <TableCell className="text-right font-mono">{item.quantity}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No return items recorded.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Truck className="h-4 w-4" />} title="Return tracking">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <DetailField label="Tracking number" value={rma.returnTrackingNumber || "None"} />
                <DetailField label="Updated" value={formatDateTime(rma.updatedAt)} />
              </div>
            </ReturnDetailSection>

            <ReturnDetailSection icon={<ReceiptText className="h-4 w-4" />} title="Checks">
              {rma.inspections.length ? (
                <div className="space-y-3">
                  {rma.inspections.map((inspection, index) => (
                    <div key={inspection.rmaInspectionId} className="rounded-md border border-zinc-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">Check {index + 1}</span>
                          <Badge variant="outline" className={statusTone(inspection.outcome)}>{vendorInspectionOutcomeLabel(inspection.outcome)}</Badge>
                        </div>
                        <span className="text-xs text-zinc-500">{formatDateTime(inspection.createdAt)}</span>
                      </div>
                      <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                        <DetailField label="Whose fault" value={inspection.faultCategory ? vendorReturnFaultLabel(inspection.faultCategory) : "Not decided"} />
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
                <p className="text-sm text-zinc-500">Card Shellz hasn't checked this return yet.</p>
              )}
            </ReturnDetailSection>

            <ReturnDetailSection icon={<Wallet className="h-4 w-4" />} title="Wallet">
              {rma.walletLedger.length ? (
                <div className="rounded-md border border-zinc-200">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>What</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                        <TableHead className="text-right">Balance after</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rma.walletLedger.map((entry) => (
                        <TableRow key={entry.ledgerEntryId}>
                          <TableCell>
                            <div className="font-medium">{vendorLedgerEntryLabel(entry)}</div>
                            <div className="text-xs text-zinc-500">{formatDateTime(entry.createdAt)}</div>
                          </TableCell>
                          <TableCell><Badge variant="outline" className={statusTone(entry.status)}>{vendorLedgerStatusLabel(entry.status)}</Badge></TableCell>
                          <TableCell className="text-right">{formatCents(entry.amountCents)}</TableCell>
                          <TableCell className="text-right">{formatNullableCents(entry.availableBalanceAfterCents)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-zinc-500">No wallet credits or fees for this return yet.</p>
              )}
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
            <TableHead>Return</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Whose fault</TableHead>
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
                <div className="text-xs text-zinc-500">{rma.reasonCode ? vendorReturnReasonLabel(rma.reasonCode) : "No reason given"}</div>
              </TableCell>
              <TableCell><Badge variant="outline">{vendorReturnStatusLabel(rma.status)}</Badge></TableCell>
              <TableCell>{rma.faultCategory ? vendorReturnFaultLabel(rma.faultCategory) : "Not decided yet"}</TableCell>
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
  return `${vendorMarketplaceOrderLabel(order)} - ${vendorOrderStatusLabel(order.status)} - ${formatDateTime(order.receivedAt)}`;
}

function orderLineOptionLabel(line: DropshipOrderDetailLine): string {
  const label = line.title || line.sku || "Item";
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
  return typeof value === "number" ? formatCents(value) : "Not available";
}

function returnItemFormIsBlank(item: PortalReturnCreateItemFormState): boolean {
  return !item.productVariantId.trim()
    && !item.quantity.trim();
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
