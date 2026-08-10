import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";

type ScopeKind = "global" | "business_context" | "channel_context" | "vendor_context" | "vendor_channel_context" | "store";
type BusinessContext = "retail" | "dropship";

interface ReturnPolicy {
  id: number;
  name: string;
  scopeKind: ScopeKind;
  scopeKey: string;
  businessContext: BusinessContext | null;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
  version: number;
  status: string;
  returnWindowDays: number;
  returnDestination: string;
  approvalAuthority: string;
  labelProvider: string;
  returnShippingPayer: string;
  inspectionRequirement: string;
  inspectionOwner: string;
  customerRefundAuthority: string;
  vendorSettlementTrigger: string;
  returnlessRefundAllowed: boolean;
  notes: string | null;
}

interface Overview {
  policies: ReturnPolicy[];
  channels: Array<{ id: number; name: string; provider: string; status: string }>;
  vendors: Array<{ id: number; memberId: string; businessName: string | null }>;
  stores: Array<{ id: number; vendorId: number; platform: string; displayName: string | null }>;
}

interface Draft {
  name: string;
  scopeKind: ScopeKind;
  businessContext: BusinessContext | null;
  channelId: number | null;
  vendorId: number | null;
  storeConnectionId: number | null;
  returnWindowDays: number;
  returnDestination: string;
  approvalAuthority: string;
  labelProvider: string;
  returnShippingPayer: string;
  inspectionRequirement: string;
  inspectionOwner: string;
  customerRefundAuthority: string;
  vendorSettlementTrigger: string;
  returnlessRefundAllowed: boolean;
  notes: string | null;
}

const SCOPE_LABELS: Record<ScopeKind, string> = {
  global: "Global fallback",
  business_context: "Business context",
  channel_context: "Channel within context",
  vendor_context: "Dropship vendor",
  vendor_channel_context: "Dropship vendor + channel",
  store: "Store connection",
};
const SCOPE_RANKS: Record<ScopeKind, number> = { global: 100, business_context: 200, channel_context: 300, vendor_context: 400, vendor_channel_context: 500, store: 600 };

const emptyDraft = (): Draft => ({
  name: "",
  scopeKind: "channel_context",
  businessContext: "retail",
  channelId: null,
  vendorId: null,
  storeConnectionId: null,
  returnWindowDays: 30,
  returnDestination: "card_shellz",
  approvalAuthority: "card_shellz",
  labelProvider: "shipstation",
  returnShippingPayer: "customer",
  inspectionRequirement: "required",
  inspectionOwner: "card_shellz",
  customerRefundAuthority: "card_shellz",
  vendorSettlementTrigger: "none",
  returnlessRefundAllowed: false,
  notes: null,
});

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body?.error?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

function humanize(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function scopeSummary(policy: ReturnPolicy, overview: Overview): string {
  const channel = overview.channels.find((item) => item.id === policy.channelId)?.name;
  const vendor = overview.vendors.find((item) => item.id === policy.vendorId);
  const store = overview.stores.find((item) => item.id === policy.storeConnectionId)?.displayName;
  return [policy.businessContext && humanize(policy.businessContext), channel, vendor && (vendor.businessName || vendor.memberId), store].filter(Boolean).join(" / ") || "All returns";
}

function policyToDraft(policy: ReturnPolicy): Draft {
  return {
    name: policy.name,
    scopeKind: policy.scopeKind,
    businessContext: policy.businessContext,
    channelId: policy.channelId,
    vendorId: policy.vendorId,
    storeConnectionId: policy.storeConnectionId,
    returnWindowDays: policy.returnWindowDays,
    returnDestination: policy.returnDestination,
    approvalAuthority: policy.approvalAuthority,
    labelProvider: policy.labelProvider,
    returnShippingPayer: policy.returnShippingPayer,
    inspectionRequirement: policy.inspectionRequirement,
    inspectionOwner: policy.inspectionOwner,
    customerRefundAuthority: policy.customerRefundAuthority,
    vendorSettlementTrigger: policy.vendorSettlementTrigger,
    returnlessRefundAllowed: policy.returnlessRefundAllowed,
    notes: policy.notes,
  };
}

export default function ReturnPolicies() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scopeLocked, setScopeLocked] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [resolution, setResolution] = useState({ businessContext: "retail" as BusinessContext, channelId: null as number | null, vendorId: null as number | null, storeConnectionId: null as number | null });

  const overviewQuery = useQuery<Overview>({ queryKey: ["/api/returns/admin/policies"] });
  const overview = overviewQuery.data;

  const createMutation = useMutation({
    mutationFn: async (input: Draft) => readJson<{ policy: ReturnPolicy }>(await fetch("/api/returns/admin/policies/versions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(input),
    })),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/returns/admin/policies"] });
      setDialogOpen(false);
      toast({ title: "Return policy version created", description: "The prior version for this exact scope was retired atomically." });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: "Policy not saved", description: error.message }),
  });

  const resolutionMutation = useMutation({
    mutationFn: async () => readJson<{ winner: ReturnPolicy; matched: Array<{ policy: ReturnPolicy; rank: number; reason: string }> }>(await fetch("/api/returns/admin/policies/resolve", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolution),
    })),
    onError: (error: Error) => toast({ variant: "destructive", title: "Policy could not be resolved", description: error.message }),
  });

  const openNew = () => {
    const next = emptyDraft();
    next.channelId = overview?.channels.find((channel) => channel.status === "active" && channel.provider.toLowerCase() === "shopify")?.id ?? null;
    setDraft(next);
    setScopeLocked(false);
    setDialogOpen(true);
  };

  const openVersion = (policy: ReturnPolicy) => {
    setDraft(policyToDraft(policy));
    setScopeLocked(true);
    setDialogOpen(true);
  };

  const sortedPolicies = useMemo(() => [...(overview?.policies ?? [])].sort((a, b) => SCOPE_RANKS[b.scopeKind] - SCOPE_RANKS[a.scopeKind] || a.scopeKey.localeCompare(b.scopeKey)), [overview?.policies]);

  if (overviewQuery.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading return policies...</div>;
  if (!overview) return <div className="p-8 text-sm text-destructive">Return policies could not be loaded.</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><ShieldCheck className="h-6 w-6" /><h1 className="text-2xl font-semibold">Return Policies</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">One policy engine for retail and dropship returns. The most specific matching scope wins.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => overviewQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
          <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New policy</Button>
        </div>
      </div>

      <Tabs defaultValue="policies">
        <TabsList><TabsTrigger value="policies">Policies</TabsTrigger><TabsTrigger value="preview">Resolution preview</TabsTrigger></TabsList>
        <TabsContent value="policies" className="mt-4">
          <Card>
            <CardHeader><CardTitle>Active policy versions</CardTitle><CardDescription>Creating a version retires the prior active version for only the same scope. Specificity is fixed by scope and cannot be manually reordered.</CardDescription></CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Policy</TableHead><TableHead>Scope</TableHead><TableHead>Context</TableHead><TableHead>Core decisions</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
                <TableBody>
                  {sortedPolicies.map((policy) => (
                    <TableRow key={policy.id}>
                      <TableCell><div className="font-medium">{policy.name}</div><div className="text-xs text-muted-foreground">v{policy.version} / #{policy.id}</div></TableCell>
                      <TableCell><Badge variant="outline">{SCOPE_LABELS[policy.scopeKind]}</Badge><div className="mt-1 text-xs text-muted-foreground">Specificity {SCOPE_RANKS[policy.scopeKind]}</div></TableCell>
                      <TableCell>{scopeSummary(policy, overview)}</TableCell>
                      <TableCell className="text-sm"><div>{policy.returnWindowDays} days / {humanize(policy.returnDestination)}</div><div className="text-muted-foreground">Approval: {humanize(policy.approvalAuthority)} / Label: {humanize(policy.labelProvider)}</div></TableCell>
                      <TableCell className="text-right"><Button variant="outline" size="sm" onClick={() => openVersion(policy)}><FileText className="mr-2 h-4 w-4" />New version</Button></TableCell>
                    </TableRow>
                  ))}
                  {sortedPolicies.length === 0 && <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No active return policies. Create the Shopify direct policy first.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="preview" className="mt-4 space-y-4">
          <ResolutionPreview overview={overview} value={resolution} onChange={setResolution} onResolve={() => resolutionMutation.mutate()} loading={resolutionMutation.isPending} result={resolutionMutation.data} />
        </TabsContent>
      </Tabs>

      <PolicyDialog open={dialogOpen} onOpenChange={setDialogOpen} overview={overview} draft={draft} onDraft={setDraft} scopeLocked={scopeLocked} saving={createMutation.isPending} onSave={() => createMutation.mutate(draft)} />
    </div>
  );
}

function ResolutionPreview({ overview, value, onChange, onResolve, loading, result }: { overview: Overview; value: { businessContext: BusinessContext; channelId: number | null; vendorId: number | null; storeConnectionId: number | null }; onChange: (value: { businessContext: BusinessContext; channelId: number | null; vendorId: number | null; storeConnectionId: number | null }) => void; onResolve: () => void; loading: boolean; result?: { winner: ReturnPolicy; matched: Array<{ policy: ReturnPolicy; rank: number; reason: string }> } }) {
  const stores = overview.stores.filter((store) => store.vendorId === value.vendorId);
  return <>
    <Card><CardHeader><CardTitle>Resolve a return policy</CardTitle><CardDescription>Preview the exact policy stack before wiring a channel flow. Shopify direct uses Retail plus the actual Shopify channel row.</CardDescription></CardHeader><CardContent className="grid gap-4 md:grid-cols-4">
      <SelectField label="Business context" value={value.businessContext} options={[{ value: "retail", label: "Retail / Card Shellz direct" }, { value: "dropship", label: "Dropship vendor order" }]} onChange={(businessContext) => onChange({ businessContext: businessContext as BusinessContext, channelId: null, vendorId: null, storeConnectionId: null })} />
      <SelectField label="Channel" value={value.channelId?.toString() ?? "none"} options={overview.channels.filter((item) => item.status === "active").map((item) => ({ value: item.id.toString(), label: `${item.name} (${item.provider})` }))} onChange={(channelId) => onChange({ ...value, channelId: Number(channelId) })} />
      {value.businessContext === "dropship" && <SelectField label="Vendor" value={value.vendorId?.toString() ?? "none"} options={overview.vendors.map((item) => ({ value: item.id.toString(), label: item.businessName || item.memberId }))} onChange={(vendorId) => onChange({ ...value, vendorId: Number(vendorId), storeConnectionId: null })} />}
      {value.businessContext === "dropship" && <SelectField label="Store (optional)" value={value.storeConnectionId?.toString() ?? "none"} allowNone options={stores.map((item) => ({ value: item.id.toString(), label: item.displayName || `${item.platform} store ${item.id}` }))} onChange={(storeConnectionId) => onChange({ ...value, storeConnectionId: storeConnectionId === "none" ? null : Number(storeConnectionId) })} />}
      <div className="flex items-end"><Button className="w-full" disabled={!value.channelId || (value.businessContext === "dropship" && !value.vendorId) || loading} onClick={onResolve}>Resolve policy</Button></div>
    </CardContent></Card>
    {result && <Card><CardHeader><CardTitle>Winner: {result.winner.name} v{result.winner.version}</CardTitle><CardDescription>{SCOPE_LABELS[result.winner.scopeKind]} won at specificity {SCOPE_RANKS[result.winner.scopeKind]}.</CardDescription></CardHeader><CardContent className="space-y-2">{result.matched.map((match) => <div key={match.policy.id} className={`flex items-center justify-between border p-3 ${match.policy.id === result.winner.id ? "border-green-500 bg-green-50" : ""}`}><div><div className="font-medium">{match.policy.name} v{match.policy.version}</div><div className="text-sm text-muted-foreground">{match.reason}</div></div><Badge variant="outline">{match.rank}</Badge></div>)}</CardContent></Card>}
  </>;
}

function PolicyDialog({ open, onOpenChange, overview, draft, onDraft, scopeLocked, saving, onSave }: { open: boolean; onOpenChange: (open: boolean) => void; overview: Overview; draft: Draft; onDraft: (draft: Draft) => void; scopeLocked: boolean; saving: boolean; onSave: () => void }) {
  const needsContext = draft.scopeKind !== "global";
  const needsChannel = ["channel_context", "vendor_channel_context", "store"].includes(draft.scopeKind);
  const needsVendor = ["vendor_context", "vendor_channel_context", "store"].includes(draft.scopeKind);
  const needsStore = draft.scopeKind === "store";
  const stores = overview.stores.filter((store) => store.vendorId === draft.vendorId);
  const valid = Boolean(draft.name.trim() && (!needsContext || draft.businessContext) && (!needsChannel || draft.channelId) && (!needsVendor || draft.vendorId) && (!needsStore || draft.storeConnectionId));
  const updateScope = (scopeKind: ScopeKind) => onDraft({ ...draft, scopeKind, businessContext: scopeKind === "global" ? null : scopeKind.startsWith("vendor") || scopeKind === "store" ? "dropship" : draft.businessContext ?? "retail", channelId: ["channel_context", "vendor_channel_context", "store"].includes(scopeKind) ? draft.channelId : null, vendorId: ["vendor_context", "vendor_channel_context", "store"].includes(scopeKind) ? draft.vendorId : null, storeConnectionId: scopeKind === "store" ? draft.storeConnectionId : null });
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto"><DialogHeader><DialogTitle>{scopeLocked ? "Create immutable policy version" : "Create return policy"}</DialogTitle><DialogDescription>{scopeLocked ? "The scope is fixed. Saving retires the current version and activates this one in the same transaction." : "Choose the narrowest scope that owns a genuinely different return decision."}</DialogDescription></DialogHeader>
    <div className="grid gap-5 py-2">
      <div className="grid gap-4 md:grid-cols-2"><TextField label="Policy name" value={draft.name} onChange={(name) => onDraft({ ...draft, name })} /><SelectField label="Scope" value={draft.scopeKind} disabled={scopeLocked} options={Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label: `${label} (${SCOPE_RANKS[value as ScopeKind]})` }))} onChange={(value) => updateScope(value as ScopeKind)} /></div>
      <div className="grid gap-4 md:grid-cols-3">
        {needsContext && <SelectField label="Business context" value={draft.businessContext ?? "none"} disabled={scopeLocked || needsVendor} options={[{ value: "retail", label: "Retail / direct" }, { value: "dropship", label: "Dropship" }]} onChange={(businessContext) => onDraft({ ...draft, businessContext: businessContext as BusinessContext })} />}
        {needsChannel && <SelectField label="Channel" value={draft.channelId?.toString() ?? "none"} disabled={scopeLocked} options={overview.channels.filter((item) => item.status === "active").map((item) => ({ value: item.id.toString(), label: `${item.name} (${item.provider})` }))} onChange={(channelId) => onDraft({ ...draft, channelId: Number(channelId) })} />}
        {needsVendor && <SelectField label="Vendor" value={draft.vendorId?.toString() ?? "none"} disabled={scopeLocked} options={overview.vendors.map((item) => ({ value: item.id.toString(), label: item.businessName || item.memberId }))} onChange={(vendorId) => onDraft({ ...draft, vendorId: Number(vendorId), storeConnectionId: null })} />}
        {needsStore && <SelectField label="Store connection" value={draft.storeConnectionId?.toString() ?? "none"} disabled={scopeLocked} options={stores.map((item) => ({ value: item.id.toString(), label: item.displayName || `${item.platform} store ${item.id}` }))} onChange={(storeConnectionId) => onDraft({ ...draft, storeConnectionId: Number(storeConnectionId) })} />}
      </div>
      <div className="border-t pt-4"><h3 className="mb-3 font-medium">Return decisions</h3><div className="grid gap-4 md:grid-cols-3">
        <NumberField label="Return window (days)" value={draft.returnWindowDays} onChange={(returnWindowDays) => onDraft({ ...draft, returnWindowDays })} />
        <EnumField label="Physical return destination" value={draft.returnDestination} values={["card_shellz", "vendor", "marketplace"]} onChange={(returnDestination) => onDraft({ ...draft, returnDestination })} />
        <EnumField label="Approval authority" value={draft.approvalAuthority} values={["card_shellz", "marketplace", "vendor"]} onChange={(approvalAuthority) => onDraft({ ...draft, approvalAuthority })} />
        <EnumField label="Label provider" value={draft.labelProvider} values={["shipstation", "marketplace", "vendor", "none"]} onChange={(labelProvider) => onDraft({ ...draft, labelProvider })} />
        <EnumField label="Return shipping payer" value={draft.returnShippingPayer} values={["card_shellz", "vendor", "customer", "marketplace", "carrier"]} onChange={(returnShippingPayer) => onDraft({ ...draft, returnShippingPayer })} />
        <EnumField label="Inspection requirement" value={draft.inspectionRequirement} values={["required", "conditional", "none"]} onChange={(inspectionRequirement) => onDraft({ ...draft, inspectionRequirement })} />
        <EnumField label="Inspection owner" value={draft.inspectionOwner} values={["card_shellz", "vendor", "marketplace"]} onChange={(inspectionOwner) => onDraft({ ...draft, inspectionOwner })} />
        <EnumField label="Customer refund authority" value={draft.customerRefundAuthority} values={["card_shellz", "marketplace", "vendor"]} onChange={(customerRefundAuthority) => onDraft({ ...draft, customerRefundAuthority })} />
        <EnumField label="Vendor settlement trigger" value={draft.vendorSettlementTrigger} values={["inspection_approved", "customer_refunded", "carrier_claim_paid", "none"]} onChange={(vendorSettlementTrigger) => onDraft({ ...draft, vendorSettlementTrigger })} />
      </div></div>
      <div className="flex items-center justify-between border p-3"><div><Label>Allow returnless refunds</Label><p className="text-xs text-muted-foreground">Allows the refund authority to resolve eligible cases without physical receipt.</p></div><Switch checked={draft.returnlessRefundAllowed} onCheckedChange={(returnlessRefundAllowed) => onDraft({ ...draft, returnlessRefundAllowed })} /></div>
      <div><Label htmlFor="return-policy-notes">Internal notes</Label><Textarea id="return-policy-notes" className="mt-2" value={draft.notes ?? ""} onChange={(event) => onDraft({ ...draft, notes: event.target.value || null })} /></div>
    </div>
    <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={!valid || saving} onClick={onSave}>{saving ? "Saving..." : "Create version"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <div><Label>{label}</Label><Input className="mt-2" value={value} onChange={(event) => onChange(event.target.value)} /></div>; }
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <div><Label>{label}</Label><Input className="mt-2" type="number" min={0} max={3650} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>; }
function EnumField({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) { return <SelectField label={label} value={value} options={values.map((item) => ({ value: item, label: humanize(item) }))} onChange={onChange} />; }
function SelectField({ label, value, options, onChange, disabled = false, allowNone = false }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean; allowNone?: boolean }) { return <div><Label>{label}</Label><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger className="mt-2"><SelectValue placeholder="Select..." /></SelectTrigger><SelectContent>{allowNone && <SelectItem value="none">None</SelectItem>}{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>; }
