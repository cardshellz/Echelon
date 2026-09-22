import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { walmartVerifiedAccountSchema, type WalmartChannelStatus } from "@shared/types/walmart-channel";

type Account = { partnerId: string; partnerName: string; nodes: { shipNode: string; shipNodeName: string }[] };
export default function WalmartConnectionPanel({ channelId, status, warehouses, onConnected }: {
  channelId: number; status: WalmartChannelStatus | null;
  warehouses: { id: number; code: string; name: string }[]; onConnected: () => Promise<void>;
}) {
  const base = `/api/channels/${channelId}/walmart`;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [environment, setEnvironment] = useState<"production" | "sandbox">(status?.environment ?? "production");
  const [account, setAccount] = useState<Account | null>(null);
  const [shipNode, setShipNode] = useState(status?.shipNodeId ?? "");
  const [warehouse, setWarehouse] = useState(status ? String(status.warehouseId) : "");
  const [since, setSince] = useState("");
  const action = useMutation({ mutationFn: async (operation: "verify" | "connect") => {
    if (operation === "verify") {
      setAccount(null);
      const verified = walmartVerifiedAccountSchema.parse(await (await apiRequest("POST", `${base}/verify`, { clientId, clientSecret, environment })).json());
      if (status && verified.partnerId !== status.partnerId) throw new Error("Reconnect with credentials for the same Walmart account.");
      setAccount(verified);
      setShipNode(status?.shipNodeId ?? (verified.nodes.length === 1 ? verified.nodes[0].shipNode : ""));
      return;
    }
    if (!account) throw new Error("Verify the account first");
    await apiRequest("POST", `${base}/connect`, { clientId, clientSecret, environment, expectedPartnerId: account.partnerId,
      shipNodeId: status?.shipNodeId ?? shipNode, warehouseId: status?.warehouseId ?? Number(warehouse),
      importSince: status?.importSince ?? new Date(since).toISOString() });
    setClientSecret(""); setClientId(""); setAccount(null);
    await onConnected();
  } });
  return <fieldset disabled={action.isPending} className="space-y-3">
    <p className="text-sm text-muted-foreground">Enter your Walmart Developer Portal Client ID and Client Secret. Credentials are encrypted after saving.</p>
    {!status && <><Label htmlFor="walmart-environment">Environment</Label>
      <select id="walmart-environment" className="w-full border rounded p-2" value={environment} onChange={event => { setEnvironment(event.target.value as "production" | "sandbox"); setAccount(null); }}>
        <option value="production">Production</option><option value="sandbox">Sandbox</option>
      </select></>}
    <Label htmlFor="walmart-client-id">Client ID</Label><Input id="walmart-client-id" value={clientId} autoComplete="off" onChange={event => { setClientId(event.target.value); setAccount(null); }} />
    <Label htmlFor="walmart-client-secret">Client Secret</Label><Input id="walmart-client-secret" type="password" value={clientSecret} autoComplete="new-password" onChange={event => { setClientSecret(event.target.value); setAccount(null); }} />
    <Button variant="outline" disabled={action.isPending || !clientId || !clientSecret} onClick={() => action.mutate("verify")}>Verify account</Button>
    {account && <div className="space-y-3">
      <p>Verified: <strong>{account.partnerName}</strong> ({account.partnerId})</p>
      {!status && <>
        <Label htmlFor="walmart-node">Walmart fulfillment center</Label><select id="walmart-node" className="w-full border rounded p-2" value={shipNode} disabled={!account.nodes.length} onChange={event => setShipNode(event.target.value)}>
          <option value="">Select a fulfillment center</option>{account.nodes.map(node => <option key={node.shipNode} value={node.shipNode}>{node.shipNodeName} ({node.shipNode})</option>)}
        </select>
        {!account.nodes.length && <p role="alert">No supported active fulfillment centers were returned for this account.</p>}
        <Label htmlFor="walmart-warehouse">Echelon warehouse</Label><select id="walmart-warehouse" className="w-full border rounded p-2" value={warehouse} onChange={event => setWarehouse(event.target.value)}>
          <option value="">Select a warehouse</option>{warehouses.map(location => <option key={location.id} value={location.id}>{location.code} — {location.name}</option>)}
        </select>
        <Label htmlFor="walmart-since">Import orders from (your local time)</Label><Input id="walmart-since" type="datetime-local" value={since} onChange={event => setSince(event.target.value)} />
      </>}
      <Button disabled={action.isPending || (!status && (!shipNode || !warehouse || !since))} onClick={() => action.mutate("connect")}>
        {action.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}{status ? "Reconnect Walmart" : "Connect Walmart"}
      </Button>
    </div>}
    {action.error && <p role="alert" className="text-sm text-destructive">{action.error.message}</p>}
  </fieldset>;
}
