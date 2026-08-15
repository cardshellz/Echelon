import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FileText, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
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
import {
  deriveReturnPolicyResolutionInput,
  isSameReturnPolicyResolutionInput,
  snapshotReturnPolicyResolutionInput,
  type ReturnPolicyResolutionInput,
} from "@/lib/return-policy-resolution";

type InternalScopeKind = "global" | "business_context" | "channel_context" | "vendor_context" | "vendor_channel_context" | "store";
type AppliesTo = "all_orders" | "channel" | "vendor" | "store";

interface ReturnPolicy {
  id: number;
  name: string;
  scopeKind: InternalScopeKind;
  scopeKey: string;
  businessContext: "retail" | "dropship" | null;
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

interface ChannelReference {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}

interface VendorReference {
  id: number;
  memberId: string;
  businessName: string | null;
  email: string | null;
  status: string;
}

interface StoreReference {
  id: number;
  vendorId: number;
  platform: string;
  displayName: string | null;
  shopDomain: string | null;
  status: string;
}

interface Overview {
  policies: ReturnPolicy[];
  channels: ChannelReference[];
  referencedVendors: VendorReference[];
  referencedStores: StoreReference[];
  dropshipOmsChannelId: number;
}

interface Draft {
  name: string;
  appliesTo: AppliesTo;
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

type ResolutionInput = ReturnPolicyResolutionInput;

interface ResolutionResult {
  input: ResolutionInput;
  winner: ReturnPolicy;
  matched: Array<{ policy: ReturnPolicy; reason: string }>;
}

const APPLIES_TO_LABELS: Record<AppliesTo, string> = {
  all_orders: "All orders",
  channel: "One sales channel",
  vendor: "One dropship vendor",
  store: "One dropship store",
};

const emptyDraft = (): Draft => ({
  name: "",
  appliesTo: "channel",
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
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
  }
  return body as T;
}

function humanize(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function publicScope(policy: ReturnPolicy): AppliesTo | null {
  switch (policy.scopeKind) {
    case "global": return "all_orders";
    case "channel_context": return "channel";
    case "vendor_context": return "vendor";
    case "store": return "store";
    default: return null;
  }
}

function policyToDraft(policy: ReturnPolicy): Draft | null {
  const appliesTo = publicScope(policy);
  if (!appliesTo) return null;
  return {
    name: policy.name,
    appliesTo,
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

function vendorLabel(vendor: VendorReference): string {
  return vendor.businessName || vendor.email || "Dropship vendor";
}

function vendorDetail(vendor: VendorReference): string {
  return [vendor.email, vendor.businessName ? null : vendor.memberId].filter(Boolean).join(" / ");
}

function storeLabel(store: StoreReference): string {
  return store.displayName || store.shopDomain || `${humanize(store.platform)} store`;
}

function storeDetail(store: StoreReference): string {
  return [humanize(store.platform), store.shopDomain].filter(Boolean).join(" / ");
}

function scopeSummary(policy: ReturnPolicy, overview: Overview): string {
  const appliesTo = publicScope(policy);
  if (!appliesTo) return "Created with the retired scope model";
  if (appliesTo === "all_orders") return "Every order without a more specific policy";
  if (appliesTo === "channel") return overview.channels.find((item) => item.id === policy.channelId)?.name ?? "Unavailable sales channel";
  const vendor = overview.referencedVendors.find((item) => item.id === policy.vendorId);
  if (appliesTo === "vendor") return vendor ? vendorLabel(vendor) : "Unavailable dropship vendor";
  const store = overview.referencedStores.find((item) => item.id === policy.storeConnectionId);
  return store ? `${storeLabel(store)}${vendor ? ` / ${vendorLabel(vendor)}` : ""}` : "Unavailable dropship store";
}

export default function ReturnPolicies() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [scopeLocked, setScopeLocked] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());
  const [resolution, setResolution] = useState<ResolutionInput>({ channelId: null, vendorId: null, storeConnectionId: null });

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
      toast({ title: "Return policy version created", description: "The previous version for this target was retired atomically." });
    },
    onError: (error: Error) => toast({ variant: "destructive", title: "Policy not saved", description: error.message }),
  });

  const resolutionMutation = useMutation<ResolutionResult, Error, ResolutionInput>({
    mutationFn: async (input) => {
      const requestInput = snapshotReturnPolicyResolutionInput(input);
      const result = await readJson<Omit<ResolutionResult, "input">>(await fetch("/api/returns/admin/policies/resolve", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestInput),
      }));
      return { input: requestInput, ...result };
    },
    onError: (error: Error) => toast({ variant: "destructive", title: "Policy could not be resolved", description: error.message }),
  });

  const changeResolution = (next: ResolutionInput) => {
    resolutionMutation.reset();
    setResolution(next);
  };
  const visibleResolution = resolutionMutation.data
    && isSameReturnPolicyResolutionInput(resolutionMutation.data.input, resolution)
    ? resolutionMutation.data
    : undefined;

  const openNew = () => {
    const next = emptyDraft();
    next.channelId = overview?.channels.find((channel) => channel.status === "active" && channel.id !== overview.dropshipOmsChannelId)?.id ?? null;
    setDraft(next);
    setScopeLocked(false);
    setDialogOpen(true);
  };

  const openVersion = (policy: ReturnPolicy) => {
    const next = policyToDraft(policy);
    if (!next) return;
    setDraft(next);
    setScopeLocked(true);
    setDialogOpen(true);
  };

  const sortedPolicies = useMemo(
    () =>
      [...(overview?.policies ?? [])]
        .filter((policy) => policy.status === "active")
        .sort((a, b) => a.name.localeCompare(b.name) || b.version - a.version),
    [overview?.policies],
  );

  if (overviewQuery.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading return policies...</div>;
  if (!overview) return <div className="p-8 text-sm text-destructive">Return policies could not be loaded.</div>;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2"><ShieldCheck className="h-6 w-6" /><h1 className="text-2xl font-semibold">Return Policies</h1></div>
          <p className="mt-1 text-sm text-muted-foreground">Set the default return rules, then add narrower channel, vendor, or store policies only when needed.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => overviewQuery.refetch()}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
          <Button onClick={openNew}><Plus className="mr-2 h-4 w-4" />New policy</Button>
        </div>
      </div>

      <Tabs defaultValue="policies">
        <TabsList><TabsTrigger value="policies">Policies</TabsTrigger><TabsTrigger value="preview">Test a policy</TabsTrigger></TabsList>
        <TabsContent value="policies" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Active policy versions</CardTitle>
              <CardDescription>The closest matching policy applies: store, then vendor, then sales channel, then all orders.</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader><TableRow><TableHead>Policy</TableHead><TableHead>Applies to</TableHead><TableHead>Target</TableHead><TableHead>Return decisions</TableHead><TableHead className="text-right">Action</TableHead></TableRow></TableHeader>
                <TableBody>
                  {sortedPolicies.map((policy) => {
                    const appliesTo = publicScope(policy);
                    return (
                      <TableRow key={policy.id}>
                        <TableCell><div className="font-medium">{policy.name}</div><div className="text-xs text-muted-foreground">Version {policy.version}</div></TableCell>
                        <TableCell><Badge variant="outline">{appliesTo ? APPLIES_TO_LABELS[appliesTo] : "Legacy scope"}</Badge></TableCell>
                        <TableCell><div className="max-w-xs text-sm">{scopeSummary(policy, overview)}</div></TableCell>
                        <TableCell className="text-sm"><div>{policy.returnWindowDays} days / {humanize(policy.returnDestination)}</div><div className="text-muted-foreground">Approval: {humanize(policy.approvalAuthority)} / Label: {humanize(policy.labelProvider)}</div></TableCell>
                        <TableCell className="text-right">
                          <Button variant="outline" size="sm" disabled={!appliesTo} title={appliesTo ? undefined : "Legacy policies must be replaced with a new simplified policy."} onClick={() => openVersion(policy)}><FileText className="mr-2 h-4 w-4" />New version</Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {sortedPolicies.length === 0 && <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">No active return policies. Start with an all-orders policy.</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="preview" className="mt-4">
          <ResolutionPreview overview={overview} value={resolution} onChange={changeResolution} onResolve={(input) => resolutionMutation.mutate(input)} loading={resolutionMutation.isPending} result={visibleResolution} />
        </TabsContent>
      </Tabs>

      <PolicyDialog open={dialogOpen} onOpenChange={setDialogOpen} overview={overview} draft={draft} onDraft={setDraft} scopeLocked={scopeLocked} saving={createMutation.isPending} onSave={() => createMutation.mutate(draft)} />
    </div>
  );
}

function ResolutionPreview({ overview, value, onChange, onResolve, loading, result }: {
  overview: Overview;
  value: ResolutionInput;
  onChange: (value: ResolutionInput) => void;
  onResolve: (input: ResolutionInput) => void;
  loading: boolean;
  result?: ResolutionResult;
}) {
  const dropship = value.channelId === overview.dropshipOmsChannelId;
  const [vendor, setVendor] = useState<VendorReference | null>(null);
  const [store, setStore] = useState<StoreReference | null>(null);
  const currentInput = deriveReturnPolicyResolutionInput({
    channelId: value.channelId,
    dropshipOmsChannelId: overview.dropshipOmsChannelId,
    selectedVendorId: vendor?.id ?? null,
    selectedStoreConnectionId: store?.id ?? null,
  });
  return <div className="space-y-4">
    <Card>
      <CardHeader><CardTitle>Test which policy applies</CardTitle><CardDescription>Select the order channel. Dropship orders can then be narrowed to a vendor or store.</CardDescription></CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-4">
        <SelectField label="Sales channel" value={value.channelId?.toString() ?? "none"} options={overview.channels.filter((item) => item.status === "active").map((item) => ({ value: item.id.toString(), label: item.name }))} onChange={(channelId) => { const id = Number(channelId); setVendor(null); setStore(null); onChange({ channelId: id, vendorId: null, storeConnectionId: null }); }} />
        {dropship && <VendorPicker label="Dropship vendor (optional)" selected={vendor} onSelect={(next) => { setVendor(next); setStore(null); onChange(deriveReturnPolicyResolutionInput({ channelId: value.channelId, dropshipOmsChannelId: overview.dropshipOmsChannelId, selectedVendorId: next?.id ?? null, selectedStoreConnectionId: null })); }} />}
        {dropship && vendor && <StorePicker label="Dropship store (optional)" vendorId={vendor.id} selected={store} onSelect={(next) => { setStore(next); onChange(deriveReturnPolicyResolutionInput({ channelId: value.channelId, dropshipOmsChannelId: overview.dropshipOmsChannelId, selectedVendorId: vendor.id, selectedStoreConnectionId: next?.id ?? null })); }} />}
        <div className="flex items-end"><Button className="w-full" disabled={!currentInput.channelId || loading} onClick={() => onResolve(snapshotReturnPolicyResolutionInput(currentInput))}>{loading ? "Testing..." : "Test policy"}</Button></div>
      </CardContent>
    </Card>
    {result && <Card><CardHeader><CardTitle>Applies: {result.winner.name}</CardTitle><CardDescription>Version {result.winner.version} is the closest policy for this order.</CardDescription></CardHeader><CardContent className="space-y-2">{result.matched.map((match) => <div key={match.policy.id} className={`border p-3 ${match.policy.id === result.winner.id ? "border-green-500 bg-green-50" : ""}`}><div className="font-medium">{match.policy.name} / Version {match.policy.version}</div><div className="text-sm text-muted-foreground">{match.reason}</div></div>)}</CardContent></Card>}
  </div>;
}

function PolicyDialog({ open, onOpenChange, overview, draft, onDraft, scopeLocked, saving, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  overview: Overview;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  scopeLocked: boolean;
  saving: boolean;
  onSave: () => void;
}) {
  const [vendor, setVendor] = useState<VendorReference | null>(null);
  const [store, setStore] = useState<StoreReference | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open && !wasOpen.current) {
      setVendor(overview.referencedVendors.find((item) => item.id === draft.vendorId) ?? null);
      setStore(overview.referencedStores.find((item) => item.id === draft.storeConnectionId) ?? null);
    }
    if (!open && wasOpen.current) {
      setVendor(null);
      setStore(null);
    }
    wasOpen.current = open;
  }, [open, draft.vendorId, draft.storeConnectionId, overview.referencedVendors, overview.referencedStores]);

  const validTarget = draft.appliesTo === "all_orders"
    || (draft.appliesTo === "channel" && draft.channelId !== null)
    || (draft.appliesTo === "vendor" && draft.vendorId !== null)
    || (draft.appliesTo === "store" && draft.vendorId !== null && draft.storeConnectionId !== null);
  const valid = draft.name.trim().length > 0 && Number.isInteger(draft.returnWindowDays) && draft.returnWindowDays >= 0 && validTarget;

  const updateAppliesTo = (appliesTo: AppliesTo) => {
    setVendor(null);
    setStore(null);
    onDraft({
      ...draft,
      appliesTo,
      channelId: appliesTo === "channel" ? draft.channelId : null,
      vendorId: null,
      storeConnectionId: null,
    });
  };

  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
    <DialogHeader><DialogTitle>{scopeLocked ? "Create policy version" : "Create return policy"}</DialogTitle><DialogDescription>{scopeLocked ? "Who this policy applies to is fixed. Saving retires the current version and activates this one atomically." : "Start broad. Add a channel, vendor, or store policy only when its return decisions differ."}</DialogDescription></DialogHeader>
    <div className="grid gap-5 py-2">
      <div className="grid gap-4 md:grid-cols-2">
        <TextField label="Policy name" value={draft.name} onChange={(name) => onDraft({ ...draft, name })} />
        <SelectField label="Applies to" value={draft.appliesTo} disabled={scopeLocked} options={(Object.entries(APPLIES_TO_LABELS) as Array<[AppliesTo, string]>).map(([value, label]) => ({ value, label }))} onChange={(value) => updateAppliesTo(value as AppliesTo)} />
      </div>

      {draft.appliesTo === "channel" && <SelectField label="Sales channel" value={draft.channelId?.toString() ?? "none"} disabled={scopeLocked} options={overview.channels.filter((item) => item.status === "active").map((item) => ({ value: item.id.toString(), label: item.name }))} onChange={(channelId) => onDraft({ ...draft, channelId: Number(channelId) })} />}
      {(draft.appliesTo === "vendor" || draft.appliesTo === "store") && <VendorPicker label="Dropship vendor" disabled={scopeLocked} selected={vendor} onSelect={(next) => { setVendor(next); setStore(null); onDraft({ ...draft, vendorId: next?.id ?? null, storeConnectionId: null }); }} />}
      {draft.appliesTo === "store" && vendor && <StorePicker label="Dropship store" disabled={scopeLocked} vendorId={vendor.id} selected={store} onSelect={(next) => { setStore(next); onDraft({ ...draft, storeConnectionId: next?.id ?? null }); }} />}

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

function VendorPicker({ label, selected, onSelect, disabled = false }: { label: string; selected: VendorReference | null; onSelect: (vendor: VendorReference | null) => void; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const query = useQuery<{ vendors: VendorReference[] }>({
    queryKey: ["return-policy-vendors", search],
    queryFn: async () => readJson(await fetch(`/api/returns/admin/policies/vendors?search=${encodeURIComponent(search)}&limit=20`, { credentials: "include" })),
    enabled: !disabled && !selected,
  });
  return <ReferencePicker label={label} search={search} onSearch={setSearch} selected={selected ? { label: vendorLabel(selected), detail: vendorDetail(selected) } : null} results={(query.data?.vendors ?? []).map((item) => ({ key: item.id, label: vendorLabel(item), detail: vendorDetail(item), value: item }))} onSelect={onSelect} onClear={() => { onSelect(null); setSearch(""); }} disabled={disabled} loading={query.isFetching} emptyText="No vendors match this search." />;
}

function StorePicker({ label, vendorId, selected, onSelect, disabled = false }: { label: string; vendorId: number; selected: StoreReference | null; onSelect: (store: StoreReference | null) => void; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const query = useQuery<{ stores: StoreReference[] }>({
    queryKey: ["return-policy-stores", vendorId, search],
    queryFn: async () => readJson(await fetch(`/api/returns/admin/policies/stores?vendorId=${vendorId}&search=${encodeURIComponent(search)}&limit=20`, { credentials: "include" })),
    enabled: !disabled && !selected && vendorId > 0,
  });
  return <ReferencePicker label={label} search={search} onSearch={setSearch} selected={selected ? { label: storeLabel(selected), detail: storeDetail(selected) } : null} results={(query.data?.stores ?? []).map((item) => ({ key: item.id, label: storeLabel(item), detail: storeDetail(item), value: item }))} onSelect={onSelect} onClear={() => { onSelect(null); setSearch(""); }} disabled={disabled} loading={query.isFetching} emptyText="No stores for this vendor match the search." />;
}

function ReferencePicker<T>({ label, search, onSearch, selected, results, onSelect, onClear, disabled, loading, emptyText }: {
  label: string;
  search: string;
  onSearch: (value: string) => void;
  selected: { label: string; detail: string } | null;
  results: Array<{ key: number; label: string; detail: string; value: T }>;
  onSelect: (value: T) => void;
  onClear: () => void;
  disabled: boolean;
  loading: boolean;
  emptyText: string;
}) {
  return <div className="space-y-2"><Label>{label}</Label>
    {selected ? <div className="flex min-h-10 items-center justify-between border px-3 py-2"><div><div className="text-sm font-medium">{selected.label}</div>{selected.detail && <div className="text-xs text-muted-foreground">{selected.detail}</div>}</div>{!disabled && <Button type="button" variant="ghost" size="icon" title="Change selection" onClick={onClear}><X className="h-4 w-4" /></Button>}</div>
      : <><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" value={search} disabled={disabled} placeholder={`Search ${label.toLowerCase()}`} onChange={(event) => onSearch(event.target.value)} /></div>
        {!disabled && <div className="max-h-44 overflow-y-auto border">{loading ? <div className="p-3 text-sm text-muted-foreground">Searching...</div> : results.length === 0 ? <div className="p-3 text-sm text-muted-foreground">{emptyText}</div> : results.map((result) => <button key={result.key} type="button" className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted" onClick={() => onSelect(result.value)}><div className="text-sm font-medium">{result.label}</div>{result.detail && <div className="text-xs text-muted-foreground">{result.detail}</div>}</button>)}</div>}
      </>}
  </div>;
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) { return <div><Label>{label}</Label><Input className="mt-2" value={value} onChange={(event) => onChange(event.target.value)} /></div>; }
function NumberField({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) { return <div><Label>{label}</Label><Input className="mt-2" type="number" min={0} max={3650} value={value} onChange={(event) => onChange(Number(event.target.value))} /></div>; }
function EnumField({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) { return <SelectField label={label} value={value} options={values.map((item) => ({ value: item, label: humanize(item) }))} onChange={onChange} />; }
function SelectField({ label, value, options, onChange, disabled = false }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void; disabled?: boolean }) { return <div><Label>{label}</Label><Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger className="mt-2"><SelectValue placeholder="Select..." /></SelectTrigger><SelectContent>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></div>; }
