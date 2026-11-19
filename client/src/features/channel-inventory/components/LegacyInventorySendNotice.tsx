import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { inventoryStockSendRequestSchema } from "@shared/types/inventory-stock-send";
import { Button } from "@/components/ui/button";
import { stockSendProgress } from "../stock-send-api";
import { stockSendState } from "../stock-send-presentation";

export function LegacyDeliveryNotice({ productId, actor }: { productId: number; actor: string }) {
  const [saved] = useState(() => {
    const keys = new Set<string>();
    let unreadable = false;
    try {
      const prefix = `inventory-stock-send:v1:${actor}:${productId}:`;
      for (let index = 0; index < sessionStorage.length; index++) {
        const key = sessionStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        try {
          const command = inventoryStockSendRequestSchema.parse(JSON.parse(sessionStorage.getItem(key)!));
          if (command.productId !== productId) throw new Error("Legacy scope differs.");
          keys.add(command.idempotencyKey);
        } catch { unreadable = true; }
      }
    } catch { unreadable = true; }
    return { keys: [...keys], unreadable };
  });
  const [expanded, setExpanded] = useState(false);
  if (saved.keys.length === 0 && !saved.unreadable) return null;
  return <aside className="rounded border p-3 text-sm" aria-label="Previous inventory send">
    <p>A previous Shopify inventory request is saved in this browser. Its outcome may still be pending. This ATP sync does not retry that request.</p>
    {saved.unreadable && <p className="mt-1 text-destructive">Some saved request details could not be read. Check their history in <a href="/channels/inventory" className="underline">Channel Inventory</a>.</p>}
    {saved.keys.length > 0 && <Button type="button" variant="link" className="h-auto px-0" onClick={() => setExpanded(value => !value)}>{expanded ? "Hide previous delivery status" : "View previous delivery status"}</Button>}
    {expanded && saved.keys.map(key => <LegacyDelivery key={key} commandKey={key} productId={productId} actor={actor} />)}
  </aside>;
}

function LegacyDelivery({ commandKey, productId, actor }: { commandKey: string; productId: number; actor: string }) {
  const query = useQuery({ queryKey: ["inventory-stock-send-legacy-progress", commandKey, actor], queryFn: async () => {
    const result = await stockSendProgress(commandKey);
    if (result.receipt.productId !== productId || result.receipt.requestedBy !== actor) throw new Error("Previous inventory send scope could not be confirmed.");
    return result;
  }, retry: false });
  return <div className="mt-2 border-t pt-2">
    {query.isFetching && <p>Checking previous delivery…</p>}
    {query.error && <p role="alert">Previous delivery status could not be confirmed. Check Channel Inventory history before retrying it.</p>}
    {query.data && <><p>{query.data.receipt.channelName} · {query.data.receipt.location}</p>
      {query.data.rows.map(row => {
        const expected = query.data!.receipt.rows.find(candidate => candidate.outboxId === row.outboxId)!;
        return <p key={row.outboxId}>{expected.sku ?? `SKU #${row.productVariantId}`} · {stockSendState(row, expected.quantity).label}</p>;
      })}</>}
    <Button type="button" variant="link" className="h-auto px-0" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh previous status</Button>
  </div>;
}
