import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

interface SourceOrderSummary {
  omsOrderId: number;
  externalOrderNumber: string | null;
  externalOrderId: string;
  channelId: number;
  channelName: string;
  customerName: string | null;
  customerEmail: string | null;
  orderedAt: string;
  fulfillmentStatus: string | null;
  wmsPartitionCount: number;
}

interface SourceOrderItem {
  wmsOrderItemId: number;
  omsOrderLineId: number | null;
  externalLineItemId: string | null;
  sku: string;
  title: string;
  fulfilledQuantity: number;
  alreadyExpectedQuantity: number;
  returnableQuantity: number;
  unitPaidPriceCents: number;
}

interface SourceOrderDetail extends SourceOrderSummary {
  businessContext: "retail" | "dropship";
  vendorId: number | null;
  storeConnectionId: number | null;
  partitions: Array<{
    wmsOrderId: number;
    wmsOrderNumber: string;
    fulfillmentPartitionKey: string;
    warehouseStatus: string;
    items: SourceOrderItem[];
  }>;
}

interface OpenReturnCaseResult {
  caseId: number;
  caseNumber: string;
  wmsReturnId: number;
  replayed: boolean;
}

const REASONS = [
  ["buyer_return", "Buyer return"],
  ["damaged", "Damaged"],
  ["defective", "Defective"],
  ["incorrect_item", "Incorrect item"],
  ["not_as_described", "Not as described"],
  ["carrier_damage", "Carrier damage"],
  ["other", "Other"],
] as const;

export function OpenReturnCaseDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (result: OpenReturnCaseResult) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedWmsOrderId, setSelectedWmsOrderId] = useState<number | null>(null);
  const [selectedQuantities, setSelectedQuantities] = useState<Record<number, number>>({});
  const [reasonCode, setReasonCode] = useState("buyer_return");
  const [notes, setNotes] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => newIdempotencyKey());

  useEffect(() => {
    if (!open) return;
    setSearchInput("");
    setSearch("");
    setSelectedOrderId(null);
    setSelectedWmsOrderId(null);
    setSelectedQuantities({});
    setReasonCode("buyer_return");
    setNotes("");
    setIdempotencyKey(newIdempotencyKey());
  }, [open]);

  const searchUrl = useMemo(() => {
    const params = new URLSearchParams({ search, limit: "20" });
    return `/api/returns/admin/source-orders?${params.toString()}`;
  }, [search]);
  const searchQuery = useQuery<{ orders: SourceOrderSummary[] }>({
    queryKey: [searchUrl],
    queryFn: () => fetchJson(searchUrl),
    enabled: open,
  });
  const detailQuery = useQuery<SourceOrderDetail>({
    queryKey: ["/api/returns/admin/source-orders", selectedOrderId],
    queryFn: () => fetchJson(`/api/returns/admin/source-orders/${selectedOrderId}`),
    enabled: open && selectedOrderId !== null,
  });

  useEffect(() => {
    const partitions = detailQuery.data?.partitions ?? [];
    if (partitions.length === 1) {
      setSelectedWmsOrderId(partitions[0].wmsOrderId);
    } else if (!partitions.some((partition) => partition.wmsOrderId === selectedWmsOrderId)) {
      setSelectedWmsOrderId(null);
    }
    setSelectedQuantities({});
  }, [detailQuery.data?.omsOrderId, selectedWmsOrderId]);

  const selectedPartition = detailQuery.data?.partitions.find(
    (partition) => partition.wmsOrderId === selectedWmsOrderId,
  ) ?? null;
  const selectedItems = selectedPartition?.items.flatMap((item) => {
    const quantity = selectedQuantities[item.wmsOrderItemId] ?? 0;
    return quantity > 0 ? [{ wmsOrderItemId: item.wmsOrderItemId, quantity }] : [];
  }) ?? [];

  const openMutation = useMutation({
    mutationFn: () => fetchJson<OpenReturnCaseResult>("/api/returns/admin/cases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idempotencyKey,
        omsOrderId: selectedOrderId,
        wmsOrderId: selectedWmsOrderId,
        reasonCode,
        notes: notes.trim() || null,
        items: selectedItems,
      }),
    }),
    onSuccess: onCreated,
  });

  const selectOrder = (omsOrderId: number) => {
    setSelectedOrderId(omsOrderId);
    setSelectedWmsOrderId(null);
    setSelectedQuantities({});
    openMutation.reset();
  };
  const changePartition = (value: string) => {
    setSelectedWmsOrderId(Number(value));
    setSelectedQuantities({});
    openMutation.reset();
  };
  const toggleItem = (item: SourceOrderItem, selected: boolean) => {
    setSelectedQuantities((current) => {
      const next = { ...current };
      if (selected) next[item.wmsOrderItemId] = 1;
      else delete next[item.wmsOrderItemId];
      return next;
    });
    openMutation.reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Open return case</DialogTitle>
          <DialogDescription>
            Select the source order and fulfilled units. Channel and dropship ownership are inferred from the order.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">1. Source order</h3>
            <div className="flex gap-2">
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && setSearch(searchInput.trim())}
                placeholder="Order number, OMS ID, customer, or email"
              />
              <Button type="button" variant="outline" onClick={() => setSearch(searchInput.trim())}>
                <Search className="mr-2 h-4 w-4" />
                Search
              </Button>
            </div>
            {searchQuery.isLoading ? (
              <Message>Loading returnable orders...</Message>
            ) : searchQuery.isError ? (
              <Message error>Source orders could not be loaded.</Message>
            ) : searchQuery.data?.orders.length === 0 ? (
              <Message>No fulfilled, returnable orders match this search.</Message>
            ) : (
              <div className="max-h-52 overflow-y-auto border">
                {searchQuery.data?.orders.map((order) => (
                  <button
                    type="button"
                    key={order.omsOrderId}
                    onClick={() => selectOrder(order.omsOrderId)}
                    className={`grid w-full gap-1 border-b px-3 py-2 text-left last:border-b-0 sm:grid-cols-[1fr_1fr_150px] ${
                      selectedOrderId === order.omsOrderId ? "bg-muted" : "hover:bg-muted/50"
                    }`}
                  >
                    <span>
                      <span className="block font-medium">{order.externalOrderNumber || order.externalOrderId}</span>
                      <span className="block text-xs text-muted-foreground">OMS {order.omsOrderId} / {order.channelName}</span>
                    </span>
                    <span className="text-sm">{order.customerName || order.customerEmail || "Customer not provided"}</span>
                    <span className="text-xs text-muted-foreground">{formatDate(order.orderedAt)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {selectedOrderId !== null && (
            <section className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">2. Fulfillment and items</h3>
              {detailQuery.isLoading ? (
                <Message>Loading fulfillment details...</Message>
              ) : detailQuery.isError || !detailQuery.data ? (
                <Message error>Fulfillment details could not be loaded.</Message>
              ) : detailQuery.data.partitions.length === 0 ? (
                <Message error>This order has no fulfilled units available to return.</Message>
              ) : (
                <>
                  <div className="grid gap-2 text-sm sm:grid-cols-3">
                    <Reference label="Channel" value={detailQuery.data.channelName} />
                    <Reference label="Context" value={titleCase(detailQuery.data.businessContext)} />
                    <Reference
                      label="Customer"
                      value={detailQuery.data.customerName || detailQuery.data.customerEmail || "Not provided"}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-sm font-medium">Fulfillment partition</label>
                    <Select
                      value={selectedWmsOrderId === null ? undefined : String(selectedWmsOrderId)}
                      onValueChange={changePartition}
                    >
                      <SelectTrigger><SelectValue placeholder="Choose the returned shipment" /></SelectTrigger>
                      <SelectContent>
                        {detailQuery.data.partitions.map((partition) => (
                          <SelectItem key={partition.wmsOrderId} value={String(partition.wmsOrderId)}>
                            WMS {partition.wmsOrderNumber} / {partition.fulfillmentPartitionKey}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {detailQuery.data.partitions.length > 1 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        This order was split. Select the shipment containing the returned items.
                      </p>
                    )}
                  </div>
                  {selectedPartition && (
                    <div className="overflow-x-auto border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-12">Return</TableHead>
                            <TableHead>Item</TableHead>
                            <TableHead>SKU</TableHead>
                            <TableHead className="text-right">Available</TableHead>
                            <TableHead className="w-28">Quantity</TableHead>
                            <TableHead className="text-right">Unit paid</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {selectedPartition.items.map((item) => {
                            const quantity = selectedQuantities[item.wmsOrderItemId] ?? 0;
                            return (
                              <TableRow key={item.wmsOrderItemId}>
                                <TableCell>
                                  <Checkbox
                                    checked={quantity > 0}
                                    onCheckedChange={(checked) => toggleItem(item, checked === true)}
                                    aria-label={`Return ${item.title}`}
                                  />
                                </TableCell>
                                <TableCell>{item.title}</TableCell>
                                <TableCell>{item.sku}</TableCell>
                                <TableCell className="text-right">{item.returnableQuantity}</TableCell>
                                <TableCell>
                                  <Input
                                    type="number"
                                    min={1}
                                    max={item.returnableQuantity}
                                    disabled={quantity === 0}
                                    value={quantity === 0 ? "" : quantity}
                                    onChange={(event) => {
                                      const next = Number(event.target.value);
                                      setSelectedQuantities((current) => ({
                                        ...current,
                                        [item.wmsOrderItemId]: next,
                                      }));
                                      openMutation.reset();
                                    }}
                                  />
                                </TableCell>
                                <TableCell className="text-right">{formatCents(item.unitPaidPriceCents)}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          {selectedPartition && (
            <section className="space-y-3 border-t pt-4">
              <h3 className="text-sm font-semibold">3. Request details</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-sm font-medium">Return reason</label>
                  <Select value={reasonCode} onValueChange={(value) => { setReasonCode(value); openMutation.reset(); }}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {REASONS.map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium">Internal notes</label>
                  <Textarea
                    value={notes}
                    onChange={(event) => { setNotes(event.target.value); openMutation.reset(); }}
                    maxLength={2_000}
                    placeholder="Optional operational context"
                  />
                </div>
              </div>
            </section>
          )}
          {openMutation.isError && <Message error>{errorMessage(openMutation.error)}</Message>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            type="button"
            disabled={
              openMutation.isPending ||
              selectedOrderId === null ||
              selectedWmsOrderId === null ||
              selectedItems.length === 0 ||
              selectedItems.some((item) => {
                const sourceItem = selectedPartition?.items.find(
                  (candidate) => candidate.wmsOrderItemId === item.wmsOrderItemId,
                );
                return !Number.isSafeInteger(item.quantity) ||
                  item.quantity <= 0 ||
                  !sourceItem ||
                  item.quantity > sourceItem.returnableQuantity;
              })
            }
            onClick={() => openMutation.mutate()}
          >
            {openMutation.isPending ? "Opening..." : "Open return case"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Message({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`border p-3 text-sm ${error ? "border-destructive text-destructive" : "text-muted-foreground"}`}>{children}</div>;
}

function Reference({ label, value }: { label: string; value: string }) {
  return <div className="border px-3 py-2"><div className="text-xs text-muted-foreground">{label}</div><div>{value}</div></div>;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "include", ...init });
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body ? body.error?.message : null;
    throw new Error(message || `Request failed (${response.status}).`);
  }
  return body as T;
}

function newIdempotencyKey(): string {
  return `returns-admin:${crypto.randomUUID()}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Return case could not be opened.";
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCents(cents: number): string {
  const dollars = Math.floor(cents / 100).toLocaleString();
  return `$${dollars}.${String(cents % 100).padStart(2, "0")}`;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
