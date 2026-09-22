import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { WalmartChannelStatus } from "@shared/types/walmart-channel";

type Account = { partnerId: string; partnerName: string; nodes: { shipNode: string; shipNodeName: string }[] };
type Variant = { id: number; sku: string; name: string };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: "include", method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "Walmart request failed");
  return result as T;
}

export default function WalmartConnectionPanel({ channelId, canEdit, warehouses }: {
  channelId: number; canEdit: boolean; warehouses: { id: number; code: string; name: string }[];
}) {
  const base = `/api/channels/${channelId}/walmart`;
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: [base], queryFn: () => request<WalmartChannelStatus | null>(base) });
  const mappings = useQuery({ queryKey: [base, "mappings"], queryFn: () => request<{ product_variant_id: number; channel_sku: string }[]>(`${base}/mappings`), enabled: !!status.data });
  const exceptions = useQuery({ queryKey: [base, "exceptions"], queryFn: () => request<{ purchaseOrderId: string; errorCode: string; observedAt: string }[]>(`${base}/exceptions`), enabled: !!status.data });
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [environment, setEnvironment] = useState<"production" | "sandbox">("production");
  const [account, setAccount] = useState<Account | null>(null);
  const [shipNode, setShipNode] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [since, setSince] = useState("");
  const [sku, setSku] = useState("");
  const [search, setSearch] = useState("");
  const [variantId, setVariantId] = useState("");
  const [message, setMessage] = useState("");
  const variants = useQuery({ queryKey: [base, "catalog", search], enabled: search.trim().length >= 2,
    queryFn: () => request<Variant[]>(`${base}/catalog?q=${encodeURIComponent(search)}`) });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: [base] });
    await queryClient.invalidateQueries({ queryKey: ["/api/channels"] });
  };
  const action = useMutation({ mutationFn: async (operation: "verify" | "connect" | "control" | "poll" | "map") => {
    setMessage("");
    if (operation === "verify") {
      const verified = await request<Account>(`${base}/verify`, { clientId, clientSecret, environment });
      setAccount(verified); setShipNode(status.data?.shipNodeId ?? ""); return;
    }
    if (operation === "connect") {
      if (!account) throw new Error("Verify the account first");
      await request(base + "/connect", { clientId, clientSecret, environment, expectedPartnerId: account.partnerId,
        shipNodeId: status.data?.shipNodeId ?? shipNode, warehouseId: status.data?.warehouseId ?? Number(warehouse),
        importSince: status.data?.importSince ?? new Date(since).toISOString() });
      setClientSecret(""); setClientId(""); setAccount(null); setMessage("Account saved. Order intake remains under its existing control.");
    } else if (operation === "control") {
      await request(base + "/control", { ordersEnabled: !status.data?.ordersEnabled, expectedRevision: status.data?.revision });
    } else if (operation === "poll") {
      const result = await request<{ observed: number; processed: number }>(base + "/poll", {});
      setMessage(`Checked ${result.observed} orders; processed ${result.processed}.`);
    } else {
      await request(base + "/mappings", { productVariantId: Number(variantId), sku });
      setSku(""); setVariantId(""); setMessage("SKU linked.");
    }
    await refresh();
  } });
  const disabled = !canEdit || action.isPending;
  const invalidateVerification = () => setAccount(null);
  if (status.isLoading) return <p>Loading Walmart connection…</p>;
  if (status.error) return <p role="alert">{status.error.message}</p>;
  return <div className="space-y-5">
    <div><h3 className="font-semibold">Walmart US · Seller fulfilled</h3>
      <p className="text-sm text-muted-foreground">Connect your Walmart account, link existing SKUs, and receive orders for your warehouse to fulfill. Listings and prices stay managed in Seller Center.</p></div>
    <p className="text-sm rounded border p-3">Initial release: one unit per order line. Multi-unit lines, replacements, refunds, discounts, and tracking amendments require review. Live operation requires deployment acceptance before intake can be enabled.</p>
    {status.data && <div className="space-y-2 rounded border p-3">
      <p><strong>{status.data.partnerName}</strong> · {status.data.environment}</p>
      <p className="text-sm">Account {status.data.partnerId} · Walmart fulfillment center {status.data.shipNodeId}</p>
      <p className="text-sm">Order intake: {status.data.ordersEnabled ? "Enabled" : "Paused"} · {status.data.mappedSkus} linked SKUs</p>
      <p className="text-sm">Import from {new Date(status.data.importSince).toLocaleString()}</p>
      <p className="text-sm">Last successful check: {status.data.lastSuccessAt ? new Date(status.data.lastSuccessAt).toLocaleString() : "None"}</p>
      {status.data.lastErrorCode && <p role="alert">Attention required: {status.data.lastErrorCode}</p>}
      {exceptions.data?.map(issue => <p key={issue.purchaseOrderId} className="text-sm">Order {issue.purchaseOrderId}: {issue.errorCode}</p>)}
      {exceptions.error && <p role="alert">Could not load orders requiring attention: {exceptions.error.message}</p>}
      <div className="flex gap-2"><Button disabled={disabled} onClick={() => action.mutate("control")}>{status.data.ordersEnabled ? "Pause order intake" : "Enable order intake"}</Button>
        <Button variant="outline" disabled={disabled || !status.data.ordersEnabled} onClick={() => action.mutate("poll")}>Check orders now</Button></div>
      <p className="text-sm">Stock publication is configured separately in Channel Inventory, where quantities can be previewed before enabling updates.</p>
    </div>}
    <fieldset disabled={disabled} className="space-y-3">
      <legend className="font-medium">{status.data ? "Replace account credentials" : "Connect account"}</legend>
      <p className="text-sm">Use your own-account Client ID and Client Secret from the Walmart Developer Portal. Credentials are encrypted and never displayed after saving.</p>
      <Label htmlFor="walmart-environment">Environment</Label>
      <select id="walmart-environment" className="w-full border rounded p-2" value={environment} onChange={event => { setEnvironment(event.target.value as "production" | "sandbox"); invalidateVerification(); }}>
        <option value="production">Production</option><option value="sandbox">Sandbox (test environment only)</option>
      </select>
      <Label htmlFor="walmart-client-id">Client ID</Label><Input id="walmart-client-id" value={clientId} autoComplete="off" onChange={event => { setClientId(event.target.value); invalidateVerification(); }} />
      <Label htmlFor="walmart-client-secret">Client Secret</Label><Input id="walmart-client-secret" type="password" value={clientSecret} autoComplete="new-password" onChange={event => { setClientSecret(event.target.value); invalidateVerification(); }} />
      <Button variant="outline" disabled={disabled || !clientId || !clientSecret} onClick={() => action.mutate("verify")}>Verify account</Button>
      {account && <div className="space-y-3">
        <p>Verified: <strong>{account.partnerName}</strong> ({account.partnerId})</p>
        {!status.data && <>
          <Label htmlFor="walmart-node">Walmart fulfillment center</Label><select id="walmart-node" className="w-full border rounded p-2" value={shipNode} disabled={account.nodes.length === 0} aria-describedby={account.nodes.length === 0 ? "walmart-no-centers" : undefined} onChange={event => setShipNode(event.target.value)}>
            <option value="">Select a fulfillment center</option>{account.nodes.map(node => <option key={node.shipNode} value={node.shipNode}>{node.shipNodeName} ({node.shipNode})</option>)}
          </select>
          {account.nodes.length === 0 && <p id="walmart-no-centers" role="alert" className="text-sm text-destructive">
            No supported active fulfillment centers were returned for this account and environment. Check your fulfillment centers in Walmart Seller Center, then verify the account again.
          </p>}
          <Label htmlFor="walmart-warehouse">Echelon warehouse</Label><select id="walmart-warehouse" className="w-full border rounded p-2" value={warehouse} onChange={event => setWarehouse(event.target.value)}>
            <option value="">Select a warehouse</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} — {warehouse.name}</option>)}
          </select>
          <Label htmlFor="walmart-since">Import orders placed or updated from (your local time)</Label><Input id="walmart-since" type="datetime-local" value={since} onChange={event => setSince(event.target.value)} />
        </>}
        <Button disabled={disabled || (!status.data && (!shipNode || !warehouse || !since))} onClick={() => action.mutate("connect")}>{status.data ? "Save replacement credentials" : "Save connection with intake paused"}</Button>
      </div>}
    </fieldset>
    {status.data && <fieldset disabled={disabled} className="space-y-3">
      <legend className="font-medium">Link Walmart SKUs</legend>
      <Label htmlFor="walmart-sku">Walmart listing SKU</Label><Input id="walmart-sku" value={sku} onChange={event => setSku(event.target.value)} />
      <Label htmlFor="walmart-search">Find Echelon SKU</Label><Input id="walmart-search" value={search} onChange={event => { setSearch(event.target.value); setVariantId(""); }} />
      {variants.error && <p role="alert">{variants.error.message}</p>}
      <Label htmlFor="walmart-variant">Echelon variant</Label><select id="walmart-variant" className="w-full border rounded p-2" value={variantId} onChange={event => setVariantId(event.target.value)}>
        <option value="">Select an exact variant</option>{variants.data?.map(variant => <option key={variant.id} value={variant.id}>{variant.sku} — {variant.name}</option>)}
      </select>
      <Button disabled={disabled || !sku || !variantId} onClick={() => action.mutate("map")}>Verify and link SKU</Button>
      {mappings.error && <p role="alert">{mappings.error.message}</p>}
      {mappings.data?.map(mapping => <p className="text-sm" key={mapping.product_variant_id}>{mapping.channel_sku} → Echelon variant {mapping.product_variant_id}</p>)}
    </fieldset>}
    {action.error && <p role="alert" className="text-destructive">{action.error.message}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
