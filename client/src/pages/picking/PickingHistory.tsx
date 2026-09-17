import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { PICKING_HISTORY_PAGE_SIZE, pickingHistoryPageSchema, type PickingHistoryOrder } from "@shared/picking-history";

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not recorded";
}

/** Historical viewing must never reuse queue cards with claim/release actions. */
export default function PickingHistory({ search, provider }: { search: string; provider: string }) {
  const [debouncedSearch, setDebouncedSearch] = useState(search.trim());
  useEffect(() => {
    const timeout = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timeout);
  }, [search]);
  const scope = JSON.stringify([debouncedSearch, provider]);
  const [pagination, setPagination] = useState({ scope, offset: 0 });
  // Derive page zero synchronously on scope changes: no request can use the
  // previous store/search's offset, even before React runs effects.
  const offset = pagination.scope === scope ? pagination.offset : 0;
  const [selected, setSelected] = useState<PickingHistoryOrder | null>(null);
  const history = useQuery({
    queryKey: ["picking-history", debouncedSearch, provider, offset],
    meta: { handlesLoadError: true },
    staleTime: 0,
    gcTime: 0, // Browsing years of pages must not retain years of data in the tab.
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({ limit: String(PICKING_HISTORY_PAGE_SIZE), offset: String(offset) });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (provider !== "all") params.set("provider", provider);
      const response = await fetch(`/api/picking/history?${params}`, { signal, credentials: "include" });
      if (!response.ok) throw new Error("Failed to load picking history");
      return pickingHistoryPageSchema.parse(await response.json());
    },
  });
  const page = history.data;
  useEffect(() => {
    if (page && offset > 0 && offset >= page.total) {
      const lastOffset = Math.max(0, Math.ceil(page.total / PICKING_HISTORY_PAGE_SIZE) - 1) * PICKING_HISTORY_PAGE_SIZE;
      setPagination({ scope, offset: lastOffset });
    }
  }, [page, offset, scope]);

  return <section aria-label="Picking history" className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <h2 className="font-semibold">Picking history — all dates</h2>
        <p className="text-sm text-muted-foreground">Newest orders first. Search all history by order number, customer or SKU.</p>
      </div>
      <Button variant="outline" disabled={history.isFetching} onClick={() => void history.refetch()}>Refresh history</Button>
    </div>
    {history.isError && <QueryLoadError subject="picking history" retry={() => void history.refetch()} refreshing={history.isFetching} stale={history.dataUpdatedAt > 0} />}
    {history.isPending && <p role="status">Loading picking history…</p>}
    {history.isFetching && !history.isPending && <p role="status">Updating picking history…</p>}
    {page && <>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {page.total === 0 ? "No picking history matches your search." : `${offset + 1}–${Math.min(offset + page.orders.length, page.total)} of ${page.total} orders`}
      </p>
      {page.orders.map(order => <Card key={order.id}>
        <CardContent className="p-0">
          <button className="w-full p-4 text-left hover:bg-muted/50 rounded-lg" onClick={() => setSelected(order)} data-testid={`history-order-${order.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{order.orderNumber}</span>
              <Badge variant="secondary">{order.warehouseStatus.replaceAll("_", " ")}</Badge>
            </div>
            <p className="text-sm break-words">{order.customerName}</p>
            <p className="text-sm text-muted-foreground">{order.channelName ?? "Channel not recorded"}{order.warehouseId !== null ? ` · Warehouse ${order.warehouseId}` : ""}</p>
            <p className="text-sm mt-2">Last pick activity: {dateLabel(order.lastPickAt)}</p>
            {order.lastPickerName && <p className="text-sm">Last recorded picker: {order.lastPickerName}</p>}
            <p className="text-sm">Recorded completion: {dateLabel(order.completedAt)}</p>
            <p className="text-sm text-muted-foreground">{order.items.length} shipping lines · View details</p>
          </button>
        </CardContent>
      </Card>)}
      {page.total > PICKING_HISTORY_PAGE_SIZE && <nav aria-label="Picking history pages" className="flex items-center justify-between gap-2">
        <Button variant="outline" disabled={offset === 0 || history.isFetching} onClick={() => setPagination({ scope, offset: Math.max(0, offset - PICKING_HISTORY_PAGE_SIZE) })}>Previous</Button>
        <span className="text-sm">Page {Math.floor(offset / PICKING_HISTORY_PAGE_SIZE) + 1} of {Math.ceil(page.total / PICKING_HISTORY_PAGE_SIZE)}</span>
        <Button variant="outline" disabled={offset + PICKING_HISTORY_PAGE_SIZE >= page.total || history.isFetching} onClick={() => setPagination({ scope, offset: offset + PICKING_HISTORY_PAGE_SIZE })}>Next</Button>
      </nav>}
    </>}
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) setSelected(null); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto max-w-xl">
        <DialogHeader>
          <DialogTitle>Picking history: {selected?.orderNumber}</DialogTitle>
          <DialogDescription>Read-only record. Item quantities below reflect the latest saved pick state, not shipment confirmation.</DialogDescription>
        </DialogHeader>
        {selected && <>
          <p>{selected.customerName}</p>
          <p className="text-sm">Last pick activity: {dateLabel(selected.lastPickAt)} · {selected.lastPickerName ?? "Picker not recorded"}</p>
          <p className="text-sm">Recorded completion: {dateLabel(selected.completedAt)}</p>
          {!selected.lastPickAt && <p className="text-sm text-muted-foreground">No detailed pick activity is recorded. Completion or shipment status alone does not prove an item was scanned.</p>}
          <ul className="space-y-3">
            {selected.items.map(item => <li key={item.id} className="border rounded-md p-3 text-sm">
              <p className="font-medium break-words">{item.name}</p>
              <p className="font-mono break-all">{item.sku}</p>
              <p>Picked now: {item.pickedQuantity} / {item.quantity} ordered · {item.status.replaceAll("_", " ")}</p>
              <p className="text-muted-foreground">Item pick time: {dateLabel(item.pickedAt)}</p>
            </li>)}
          </ul>
        </>}
      </DialogContent>
    </Dialog>
  </section>;
}
