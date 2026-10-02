import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChannelWorkspaceHeader } from "@/components/channels/ChannelWorkspaceHeader";
import WalmartConnectionPanel from "@/components/WalmartConnectionPanel";
import { walmartStatusSchema } from "@shared/types/walmart-channel";
import { ChannelListingPublicationWorkspace } from "@/features/channel-listing-publication/ChannelListingPublicationWorkspace";

export default function WalmartChannelPage() {
  const [location] = useLocation();
  const channelId = Number(/^\/channels\/walmart\/(\d+)(?:\/listings\/bulk)?$/.exec(location)?.[1]);
  if (!Number.isSafeInteger(channelId) || channelId <= 0) return <p role="alert" className="p-6">Select a valid Walmart channel.</p>;
  return <WalmartChannelWorkspace key={channelId} channelId={channelId} />;
}
/** Retain only unsaved sessions across same-document navigation. A hidden
 * session keeps raw cell buffers mounted, with all owner polling disabled. */
export function WalmartChannelRouteHost({ navigationDocumentId }: { navigationDocumentId?: string } = {}) {
  // History entries survive reloads. Keep entropy at this explicit boundary;
  // the navigation guard itself derives deterministic generations from it.
  const [documentId] = useState(() => navigationDocumentId ?? crypto.randomUUID());
  const [location] = useLocation();
  const { user } = useAuth();
  const activeId = Number(/^\/channels\/walmart\/([1-9]\d*)(?:\/listings\/bulk)?$/.exec(location)?.[1]);
  const [retained, setRetained] = useState<ReadonlySet<number>>(new Set());
  if (!user || !["admin", "lead"].includes(user.role)) return null;
  const ids = new Set(retained);
  if (Number.isSafeInteger(activeId) && activeId > 0) ids.add(activeId);
  return <>{[...ids].map(channelId => <div key={channelId} hidden={channelId !== activeId} className={location.endsWith("/listings/bulk") && channelId === activeId ? "h-full min-h-0" : undefined}>
    <WalmartChannelWorkspace channelId={channelId} navigationDocumentId={documentId} active={channelId === activeId} onRetainChange={retain => setRetained(previous => {
      if (previous.has(channelId) === retain) return previous;
      const next = new Set(previous); if (retain) next.add(channelId); else next.delete(channelId); return next;
    })} />
  </div>)}</>;
}
export function WalmartChannelWorkspace({ channelId, navigationDocumentId, active = true, onRetainChange }: { channelId: number; navigationDocumentId?: string; active?: boolean; onRetainChange?(retain: boolean): void }) {
  const [documentId] = useState(() => navigationDocumentId ?? crypto.randomUUID());
  const [location] = useLocation();
  const workbench = location === `/channels/walmart/${channelId}/listings/bulk`;
  const { hasPermission } = useAuth();
  const canView = hasPermission("channels", "view");
  const canEdit = canView && hasPermission("channels", "edit");
  const client = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const base = `/api/channels/${channelId}/walmart`;
  const status = useQuery({ queryKey: [base], enabled: canView && active, queryFn: async () => walmartStatusSchema.nullable().parse(await (await apiRequest("GET", base)).json()), refetchInterval: active ? 30_000 : false });
  const warehouses = useQuery<{ id: number; code: string; name: string; isActive?: number; warehouseType?: string }[]>({ queryKey: ["/api/warehouses"],
    enabled: canView && active && !workbench, queryFn: async () => (await apiRequest("GET", "/api/warehouses")).json() });
  const exceptions = useQuery<{ purchaseOrderId: string; errorCode: string; observedAt: string }[]>({ queryKey: [base, "exceptions"], enabled: canView && active && !workbench && !!status.data,
    queryFn: async () => (await apiRequest("GET", `${base}/exceptions`)).json(), refetchInterval: active && !workbench ? 30_000 : false });
  const connected = async () => {
    await client.invalidateQueries({ queryKey: [base] });
    await client.invalidateQueries({ queryKey: ["/api/channels"] });
    await client.invalidateQueries({ queryKey: [`/api/channels/${channelId}/catalog`] });
    setConnecting(false);
  };
  if (!canView) return <p role="alert" className="p-6">You do not have permission to view this channel.</p>;
  const warehouse = warehouses.data?.find(location => location.id === status.data?.warehouseId);
  return <div className={workbench ? "h-dvh min-h-0 w-full [[data-app-scroll-container]_&]:h-full" : "p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6 max-w-6xl mx-auto"}>
    {workbench && !status.data && <div className="space-y-3 p-6"><h1 className="text-lg font-semibold">Edit Walmart listings</h1><p role={status.isLoading ? "status" : "alert"}>{status.isLoading ? "Loading Walmart connection…" : status.error ? status.error.message : "Connect this Walmart channel before editing listings."}</p><a className="underline" href={`/channels/walmart/${channelId}`}>Back to channel setup</a></div>}
    <div hidden={workbench} className="space-y-4 sm:space-y-6">
    <ChannelWorkspaceHeader name="Walmart" description="Store setup, listing feed, pricing, and publication activity" />
    <Card><CardHeader className="px-3 sm:px-6"><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-5 w-5" />Store Setup</CardTitle>
      <CardDescription>Walmart US account and seller fulfillment location</CardDescription></CardHeader>
      <CardContent className="space-y-5 px-3 sm:px-6">
        {status.isLoading ? <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading connection" /> : status.error ? <p role="alert" className="text-destructive">{status.error.message}</p> : <>
          <div className="flex flex-wrap items-center gap-3"><Badge variant={status.data ? "default" : "secondary"} className={status.data ? "bg-green-600 gap-1.5" : ""}>
            {status.data && <CheckCircle2 className="h-3.5 w-3.5" />}{status.data ? "Connected" : "Not connected"}</Badge>
            {status.data && <><strong className="flex-1">{status.data.partnerName}</strong><Badge variant="outline">{status.data.environment}</Badge></>}
            {canEdit && <Button variant="outline" size="sm" onClick={() => setConnecting(true)}>{status.data ? "Reconnect" : "Connect Walmart"}</Button>}
          </div>
          {status.data && <>
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              <div><dt className="text-muted-foreground">Walmart account</dt><dd>{status.data.partnerId}</dd></div>
              <div><dt className="text-muted-foreground">Fulfillment center</dt><dd>{status.data.shipNodeId}</dd></div>
              <div><dt className="text-muted-foreground">Echelon warehouse</dt><dd>{warehouse ? `${warehouse.code} — ${warehouse.name}` : `Warehouse ${status.data.warehouseId}`}</dd></div>
              <div><dt className="text-muted-foreground">Order sync</dt><dd>{status.data.orderSyncBlockedReason ? "Disabled on server" : status.data.ordersEnabled ? "Automatic while this channel is active" : "Paused with the channel"}</dd></div>
              <div><dt className="text-muted-foreground">Import from</dt><dd>{new Date(status.data.importSince).toLocaleString()}</dd></div>
              <div><dt className="text-muted-foreground">Last successful order sync</dt><dd>{status.data.lastSuccessAt ? new Date(status.data.lastSuccessAt).toLocaleString() : "Waiting for first sync"}</dd></div>
            </dl>
            {status.data.lastErrorCode && <p role="alert" className="text-sm text-destructive">Order sync needs attention: {status.data.lastErrorCode}</p>}
            {status.data.orderSyncBlockedReason && <p role="alert" className="text-sm text-destructive">{status.data.orderSyncBlockedReason}</p>}
            <p className="text-sm text-muted-foreground">Choose products and prepare Walmart listings below. Inventory quantities use <a className="underline" href="/channels/inventory">Channel Inventory</a>; the publish review checks listing and stock readiness.</p>
          </>}
        </>}
      </CardContent>
    </Card>
    </div>
    {status.data && <ChannelListingPublicationWorkspace navigationDocumentId={documentId} channelId={channelId} connectionId={status.data.connectionId} canEdit={canEdit} providerName="Walmart" active={active} onRetainChange={onRetainChange}
      onMappingsChanged={() => client.invalidateQueries({ queryKey: [base] })} />}
    {!workbench && (exceptions.error || !!exceptions.data?.length) && <Card><CardHeader><CardTitle>Orders needing attention</CardTitle></CardHeader><CardContent>
      {exceptions.error && <p role="alert">{exceptions.error.message}</p>}
      {exceptions.data?.map(issue => <div key={issue.purchaseOrderId} className="flex flex-wrap justify-between gap-2 border-b py-3 text-sm"><span>{issue.purchaseOrderId}</span><span className="text-destructive">{issue.errorCode}</span><time>{new Date(issue.observedAt).toLocaleString()}</time></div>)}
    </CardContent></Card>}
    <Dialog open={connecting} onOpenChange={setConnecting}><DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{status.data ? "Reconnect Walmart" : "Connect Walmart"}</DialogTitle><DialogDescription>{status.data ? "Update credentials for the connected account." : "Connect your account to receive orders for your warehouse."}</DialogDescription></DialogHeader>
      {warehouses.error ? <p role="alert">{warehouses.error.message}</p> : warehouses.isLoading ? <p>Loading warehouses…</p> : <WalmartConnectionPanel channelId={channelId} status={status.data ?? null}
        warehouses={(warehouses.data ?? []).filter(location => location.isActive !== 0 && location.warehouseType !== "3pl")} onConnected={connected} />}
    </DialogContent></Dialog>
  </div>;
}
