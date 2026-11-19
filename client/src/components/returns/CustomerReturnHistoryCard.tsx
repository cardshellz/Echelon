import { Package } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { z } from "zod";
import type { customerReturnCustomerHistoryItemSchema } from "@shared/returns/customer-return-customer.contract";

type HistoryItem = z.infer<typeof customerReturnCustomerHistoryItemSchema>;

export function CustomerReturnHistoryCard({ item, busy, onOpen, onDownload }: {
  item: HistoryItem;
  busy: boolean;
  onOpen: () => void;
  onDownload: () => void;
}) {
  const progress = item.progress;
  const labelReady = progress?.status.code === "label_ready";
  return <article className="csz-return-history-card" aria-label={`Return ${item.authorizationNumber}`}>
    <div className="csz-return-history-heading">
      <div><h3>{item.orderReference ? `Order #${item.orderReference.replace(/^#\s*/, "")}` : `Return ${item.authorizationNumber}`}</h3>
        <p className="csz-return-secondary">Return {item.authorizationNumber} · Started {new Date(item.createdAt).toLocaleDateString()}</p></div>
      {progress && <span className="csz-return-history-badge">{progress.status.label}</span>}
    </div>
    <div className="csz-return-history-body">
      {progress && <>
        <div className="csz-return-history-items"><Package size={22} aria-hidden="true" /><p>{progress.quantity} {progress.quantity === 1 ? "item" : "items"}
          {progress.parcels.length > 0 && <> · {progress.parcels.length} {progress.parcels.length === 1 ? "box" : "boxes"}</>}</p></div>
        {labelReady && <div className="csz-return-history-next"><strong>Ready to send back</strong><p>Print your label, attach it to your box, and drop it off with the carrier.</p></div>}
        {!["not_started", "not_required"].includes(progress.refund.code) && <p className="csz-return-history-refund">{progress.refund.label}</p>}
      </>}
      <div className="csz-return-history-actions">
        {labelReady ? <><Button disabled={busy} onClick={onDownload}>{progress.parcels.length === 1 ? "Download label" : "View labels"}</Button>
          <Button variant="link" disabled={busy} onClick={onOpen}>View return</Button></>
          : <Button variant="outline" disabled={busy} onClick={onOpen}>View return</Button>}
      </div>
    </div>
  </article>;
}
