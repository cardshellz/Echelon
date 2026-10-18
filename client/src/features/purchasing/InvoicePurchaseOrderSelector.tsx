import { centsToDollarString } from "@shared/utils/money";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { purchaseOrderWorkListPageSchema } from "@shared/procurement/purchase-order-work-list";
import { WorkListPagination } from "./WorkListPagination";

export function InvoicePurchaseOrderSelector({ vendorId, selectedId, onSelect, purpose, excludeIds = [] }: {
  vendorId: number; selectedId: string; onSelect: (id: string) => void;
  purpose: "invoice-create" | "invoice-link"; excludeIds?: number[];
}) {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selectedLabel, setSelectedLabel] = useState("");
  const params = new URLSearchParams({ vendorId: String(vendorId), purpose, search, limit: "20", offset: String(offset) });
  if (excludeIds.length) params.set("excludeIds", [...excludeIds].sort((a, b) => a - b).join(","));
  const url = `/api/purchase-orders/work-list?${params}`;
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: [url],
    staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(url, { credentials: "include", signal });
      if (!response.ok) throw new Error("Unable to load purchase orders");
      return purchaseOrderWorkListPageSchema.parse(await response.json());
    },
  });
  return <div className="space-y-2">
    <Input aria-label="Search purchase orders" placeholder="Filter by PO number…" value={search} onChange={event => { setSearch(event.target.value); setOffset(0); }} />
    {selectedId && <p className="text-sm">Selected: {selectedLabel || `PO ${selectedId}`} <Button type="button" variant="link" size="sm" onClick={() => { onSelect(""); setSelectedLabel(""); }}>Clear PO</Button></p>}
    {isError ? <div role="alert">Unable to load purchase orders. <Button type="button" variant="link" onClick={() => void refetch()}>Retry purchase orders</Button></div>
      : isLoading ? <p role="status">Loading purchase orders…</p>
      : <div className="max-h-48 overflow-y-auto border rounded-md" aria-label="Available purchase orders">
        {data?.items.length === 0 ? <p className="p-3 text-sm text-muted-foreground">No available purchase orders match this vendor and search.</p> : data?.items.map(po => <button
          key={po.id} type="button" aria-pressed={String(po.id) === selectedId}
          className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center justify-between gap-2 ${String(po.id) === selectedId ? "bg-primary/10" : ""}`}
          onClick={() => { onSelect(String(po.id)); setSelectedLabel(po.poNumber); }}>
          <span className="font-mono">{po.poNumber}</span><span>{po.totalCents < 0 ? "-" : ""}${centsToDollarString(Math.abs(po.totalCents))} · {po.status}</span>
        </button>)}
      </div>}
    {!isError && <WorkListPagination page={data} busy={isFetching} onOffset={setOffset} label="purchase orders" />}
  </div>;
}
