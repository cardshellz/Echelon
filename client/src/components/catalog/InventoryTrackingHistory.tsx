import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { inventoryTrackingHistoryListSchema } from "@shared/catalog/inventory-tracking-history";
import { formatDashboardMills } from "@/lib/cost-dashboard-money";
import { Button } from "@/components/ui/button";

export function InventoryTrackingHistory({ productId }: { productId: number }) {
  const [before, setBefore] = useState<string | undefined>();
  const endpoint = `/api/products/${productId}/inventory-tracking/history`;
  const history = useQuery({
    queryKey: [endpoint, before],
    queryFn: async () => {
      const response = await fetch(`${endpoint}${before ? `?before=${before}` : ""}`);
      if (!response.ok) throw new Error("Unable to load inventory tracking history.");
      return inventoryTrackingHistoryListSchema.parse(await response.json());
    },
  });
  if (history.isLoading) return <p className="text-xs text-muted-foreground">Loading inventory tracking history…</p>;
  if (history.isError) return <div role="alert" className="text-xs"><p>Unable to load inventory tracking history.</p>
    <Button size="sm" variant="outline" onClick={() => history.refetch()}>Retry history</Button></div>;
  if (!history.data?.records.length) return null;
  return <div className="space-y-2 text-xs border-t pt-3">
    <p className="font-medium">Previous inventory tracking</p>
    <p>Last recorded balances when tracking stopped. These are historical records, not current quantities or verified physical counts.</p>
    {history.data.records.map(record => <div className="border rounded p-2 space-y-1" key={record.id}>
      <p>Variant {record.variantId} · Stopped {record.stoppedAt} · {record.actor}</p>
      <p>Stock records: On hand {record.summary.onHand} · Reserved {record.summary.reserved} · Picked {record.summary.picked} · Packed {record.summary.packed}</p>
      <p>Lots: On hand {record.summary.lotOnHand} · Reserved {record.summary.lotReserved} · Picked {record.summary.lotPicked} · Packed {record.summary.lotPacked}</p>
      <p>Recorded on-hand lot value {formatDashboardMills(record.summary.recordedOnHandValueMills)}</p>
      <a href={`${endpoint}/${record.id}`} className="underline">Download original stock and lot records</a>
    </div>)}
    <div className="flex gap-2">
      {before && <Button variant="outline" size="sm" onClick={() => setBefore(undefined)}>Latest history</Button>}
      {history.data.hasMore && <Button variant="outline" size="sm" onClick={() => setBefore(history.data!.records.at(-1)!.id)}>Older history</Button>}
    </div>
  </div>;
}
