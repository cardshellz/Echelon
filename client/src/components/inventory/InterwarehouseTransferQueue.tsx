import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, PackageCheck, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useInventoryCommand } from "@/lib/inventory-command";
import type { InterwarehouseTransferStatus, InterwarehouseTransferSummary } from "@shared/types/interwarehouse-transfer";

type Action = { kind: "receive" | "missing"; transfer: InterwarehouseTransferSummary } | null;

const statusLabel: Record<InterwarehouseTransferStatus, string> = {
  ready: "Ready",
  in_transit: "In transit",
  partially_received: "Partially received",
  exception: "Needs review",
  completed: "Completed",
  closed_with_variance: "Closed with variance",
  cancelled: "Cancelled",
};

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function statusClass(status: InterwarehouseTransferStatus): string {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "in_transit" || status === "partially_received") return "border-blue-200 bg-blue-50 text-blue-700";
  if (status === "exception" || status === "closed_with_variance") return "border-amber-200 bg-amber-50 text-amber-800";
  return "";
}

export function InterwarehouseTransferQueue({ compact = false }: { compact?: boolean }) {
  const inventoryCommand = useInventoryCommand();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [action, setAction] = useState<Action>(null);
  const [quantity, setQuantity] = useState("");
  const [damagedQuantity, setDamagedQuantity] = useState("0");
  const [notes, setNotes] = useState("");

  const query = useQuery<InterwarehouseTransferSummary[]>({
    queryKey: ["/api/inventory/interwarehouse-transfers"],
    refetchInterval: 10_000,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      if (!action) throw new Error("Choose a transfer action.");
      const qty = Number(quantity);
      if (action.kind === "receive") {
        const damaged = Number(damagedQuantity || 0);
        if (!Number.isSafeInteger(qty) || qty < 0 || !Number.isSafeInteger(damaged) || damaged < 0
          || qty + damaged <= 0 || qty + damaged > action.transfer.inTransitQuantity) {
          throw new Error(`Received plus damaged cannot exceed ${action.transfer.inTransitQuantity}.`);
        }
        return inventoryCommand<InterwarehouseTransferSummary>(`/api/inventory/interwarehouse-transfers/${action.transfer.id}/receive`, {
          quantity: qty,
          damagedQuantity: damaged,
          notes: notes.trim() || undefined,
        });
      }
      if (!Number.isSafeInteger(qty) || qty <= 0 || qty > action.transfer.inTransitQuantity) {
        throw new Error(`Enter a whole-number quantity from 1 to ${action.transfer.inTransitQuantity}.`);
      }
      if (!notes.trim()) throw new Error("Describe why the inventory is missing.");
      return inventoryCommand<InterwarehouseTransferSummary>(`/api/inventory/interwarehouse-transfers/${action.transfer.id}/reconcile`, {
        quantity: qty,
        reason: notes.trim(),
      });
    },
    onSuccess: (result: InterwarehouseTransferSummary) => {
      toast({
        title: action?.kind === "receive" ? "Receipt posted" : "Transit discrepancy recorded",
        description: result.followupPending
          ? `${result.transferNumber} was committed and has ${result.inTransitQuantity} unit(s) in transit. Notifications will retry automatically.`
          : `${result.transferNumber} now has ${result.inTransitQuantity} unit(s) in transit.`,
      });
      setAction(null);
      setNotes("");
      void queryClient.invalidateQueries({ queryKey: ["/api/inventory/interwarehouse-transfers"] });
      void queryClient.invalidateQueries({ predicate: (item) => String(item.queryKey[0] ?? "").startsWith("/api/inventory/") });
    },
    onError: (error: Error) => toast({ title: "Transfer action failed", description: error.message, variant: "destructive" }),
  });

  const openAction = (kind: "receive" | "missing", transfer: InterwarehouseTransferSummary) => {
    setAction({ kind, transfer });
    setQuantity(String(transfer.inTransitQuantity));
    setDamagedQuantity("0");
    setNotes("");
  };

  const transfers = query.data ?? [];
  const active = transfers.filter((transfer) => !["completed", "closed_with_variance", "cancelled"].includes(transfer.status));
  const closed = transfers.filter((transfer) => ["completed", "closed_with_variance", "cancelled"].includes(transfer.status));
  const visible = compact ? active.slice(0, 5) : [...active, ...closed].slice(0, 20);

  if (query.isLoading) return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  if (query.isError) return <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
    <p>Warehouse transfer orders could not be loaded. Inventory was not changed.</p>
    <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
  </div>;
  if (visible.length === 0) return <div className="py-8 text-center text-sm text-muted-foreground">
    {compact ? "No warehouse transfers are waiting to be received." : "No inter-warehouse transfers yet."}
  </div>;

  return <>
    <div className="space-y-3">
      {visible.map((transfer) => {
        const progress = transfer.dispatchedQuantity === 0 ? 0
          : Math.round(((transfer.receivedQuantity + transfer.damagedQuantity + transfer.lostQuantity) / transfer.dispatchedQuantity) * 100);
        return <div key={transfer.id} className="rounded-lg border bg-card p-4" data-testid={`interwarehouse-transfer-${transfer.id}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{transfer.transferNumber}</span>
                <Badge variant="outline" className={statusClass(transfer.status)}>{statusLabel[transfer.status]}</Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{transfer.sourceWarehouseCode} · {transfer.sourceLocationCode}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium">{transfer.destinationWarehouseCode} · {transfer.destinationLocationCode}</span>
              </div>
              <div className="text-sm"><span className="font-medium">{transfer.sku}</span> <span className="text-muted-foreground">× {transfer.requestedQuantity}</span></div>
              <div className="text-xs text-muted-foreground">Updated {dateTime.format(new Date(transfer.updatedAt))}</div>
            </div>
            {transfer.inTransitQuantity > 0 && <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => openAction("receive", transfer)} data-testid={`receive-transfer-${transfer.id}`}>
                <PackageCheck className="mr-1.5 h-4 w-4" />Receive
              </Button>
              <Button size="sm" variant="outline" onClick={() => openAction("missing", transfer)}>
                <AlertTriangle className="mr-1.5 h-4 w-4" />Report missing
              </Button>
            </div>}
          </div>
          <div className="mt-3 space-y-1.5">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{transfer.receivedQuantity} received · {transfer.inTransitQuantity} in transit</span>
              <span>{progress}% accounted</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min(100, progress)}%` }} />
            </div>
            {(transfer.damagedQuantity > 0 || transfer.lostQuantity > 0) && <p className="text-xs text-amber-700">
              {transfer.damagedQuantity} damaged · {transfer.lostQuantity} missing
            </p>}
            {transfer.exceptionNotes && <p className="whitespace-pre-line text-xs text-amber-800">{transfer.exceptionNotes}</p>}
          </div>
        </div>;
      })}
    </div>

    <Dialog open={!!action} onOpenChange={(open) => { if (!open && !mutation.isPending) setAction(null); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {action?.kind === "receive" ? <PackageCheck className="h-5 w-5" /> : <AlertTriangle className="h-5 w-5 text-amber-600" />}
            {action?.kind === "receive" ? "Receive warehouse transfer" : "Reconcile missing inventory"}
          </DialogTitle>
          <DialogDescription>
            {action?.kind === "receive"
              ? "Post only the quantity physically counted at the destination. This makes received units available there immediately."
              : "This writes off missing in-transit custody with an auditable reason. Use it only after investigating the shipment."}
          </DialogDescription>
        </DialogHeader>
        {action && <div className="space-y-4 py-2">
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium">{action.transfer.transferNumber} · {action.transfer.sku}</p>
            <p className="text-muted-foreground">{action.transfer.inTransitQuantity} unit(s) currently in transit</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="transfer-action-quantity">{action.kind === "receive" ? "Quantity accepted" : "Quantity missing"}</Label>
            <Input id="transfer-action-quantity" type="number" min={action.kind === "receive" ? 0 : 1} max={action.transfer.inTransitQuantity} step={1}
              value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={mutation.isPending} />
          </div>
          {action.kind === "receive" && <div className="space-y-2">
            <Label htmlFor="transfer-damaged-quantity">Damaged quantity</Label>
            <Input id="transfer-damaged-quantity" type="number" min={0} max={action.transfer.inTransitQuantity} step={1}
              value={damagedQuantity} onChange={(event) => setDamagedQuantity(event.target.value)} disabled={mutation.isPending} />
            <p className="text-xs text-muted-foreground">Damaged units are removed from sellable inventory and preserved in the audit trail.</p>
            <p className="text-xs font-medium">
              {Number.isSafeInteger(Number(quantity)) && Number.isSafeInteger(Number(damagedQuantity))
                ? `${Number(quantity) + Number(damagedQuantity)} accounted · ${action.transfer.inTransitQuantity - Number(quantity) - Number(damagedQuantity)} remain in transit`
                : "Enter whole-unit counts."}
            </p>
          </div>}
          <div className="space-y-2">
            <Label htmlFor="transfer-action-notes">{action.kind === "missing" ? "Investigation notes" : "Receiving notes (required for damage)"}</Label>
            <Textarea id="transfer-action-notes" rows={3} value={notes} onChange={(event) => setNotes(event.target.value)}
              placeholder={action.kind === "missing" ? "Carrier claim, count evidence, or investigation result…" : "Optional receiving details…"}
              disabled={mutation.isPending} />
          </div>
        </div>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setAction(null)} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending} variant={action?.kind === "missing" ? "destructive" : "default"}>
            {mutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              : action?.kind === "receive" ? <CheckCircle2 className="mr-2 h-4 w-4" /> : <Truck className="mr-2 h-4 w-4" />}
            {action?.kind === "receive" ? "Post receipt" : "Record discrepancy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
