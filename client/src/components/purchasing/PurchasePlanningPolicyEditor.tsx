import type { PurchaseReplacementForecast } from "@shared/procurement/purchase-replacement-forecast";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { purchasePlanningPolicySchema, type PurchasePlanningPolicy, type PurchaseProductPlanningPolicy } from "@shared/procurement/purchase-planning-policy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";

type PolicyRecord = { revision: number; policy: PurchasePlanningPolicy; products?: ProductChoice[] };
type ProductChoice = { id: number; sku: string | null; name: string };
type HistoryItem = { revision: number; actorId: string; changedAt: string; after: PurchasePlanningPolicy };

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Unable to load purchasing planning data");
  return response.json();
}

export function PurchasePlanningPolicyEditor() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const policyQuery = useQuery<PolicyRecord>({ queryKey: ["/api/purchasing/planning-policy"], queryFn: () => readJson("/api/purchasing/planning-policy") });
  const historyQuery = useQuery<{ changes: HistoryItem[] }>({ queryKey: ["/api/purchasing/planning-policy/history"], queryFn: () => readJson("/api/purchasing/planning-policy/history") });
  const [draft, setDraft] = useState<PolicyRecord | null>(null);
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [productNames, setProductNames] = useState<Record<number, string>>({});
  const submission = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);
  useEffect(() => {
    if (!draft && policyQuery.data) setDraft(policyQuery.data);
  }, [draft, policyQuery.data]);
  useEffect(() => {
    if (policyQuery.data?.products) {
      const loadedNames = Object.fromEntries(policyQuery.data.products.map((product) => [product.id, `${product.sku ?? ""} · ${product.name}`]));
      setProductNames((current) => ({ ...current, ...loadedNames }));
    }
  }, [policyQuery.data]);
  useEffect(() => { const timer = window.setTimeout(() => setSearchTerm(search.trim()), 250); return () => window.clearTimeout(timer); }, [search]);
  const productQuery = useQuery<{ items: ProductChoice[] }>({
    queryKey: ["/api/purchasing/planning-policy/products", searchTerm],
    queryFn: () => readJson(`/api/purchasing/planning-policy/products?search=${encodeURIComponent(searchTerm)}`),
    enabled: searchTerm.length >= 2,
  });
  const save = useMutation({
    mutationFn: async (record: PolicyRecord) => {
      const result = purchasePlanningPolicySchema.safeParse(record.policy);
      if (!result.success) throw new Error(result.error.issues.map((issue) => issue.message).join("; "));
      const fingerprint = JSON.stringify({ revision: record.revision, policy: result.data });
      if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, idempotencyKey: crypto.randomUUID() };
      const response = await fetch("/api/purchasing/planning-policy", {
        method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedRevision: record.revision, policy: result.data, idempotencyKey: submission.current.idempotencyKey }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Unable to save planning policy");
      return body as PolicyRecord;
    },
    onSuccess: (record) => {
      submission.current = null;
      setDraft(record);
      queryClient.setQueryData(["/api/purchasing/planning-policy"], record);
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/planning-policy/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/auto-draft-settings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/purchasing/reorder-analysis"] });
      toast({ title: "Planning policy saved", description: `Revision ${record.revision}. Refresh analysis to review the resulting proposals.` });
    },
    onError: (error: Error) => toast({ title: "Policy was not saved", description: error.message, variant: "destructive" }),
  });
  const patch = (change: Partial<PurchasePlanningPolicy>) => setDraft((current) => current ? { ...current, policy: { ...current.policy, ...change } } : current);
  const patchProduct = (productId: number, change: Partial<PurchaseProductPlanningPolicy>) => setDraft((current) => current ? {
    ...current, policy: { ...current.policy, products: current.policy.products.map((product) => product.productId === productId ? { ...product, ...change } : product) },
  } : current);
  const patchForecast = (index: number, change: Partial<PurchaseReplacementForecast>) => patch({
    replacementForecasts: (draft?.policy.replacementForecasts ?? []).map((range, rangeIndex) => rangeIndex === index ? { ...range, ...change } : range),
  });
  const addProduct = (product: ProductChoice) => {
    if (!draft || draft.policy.products.some((row) => row.productId === product.id)) return;
    patch({ products: [...draft.policy.products, { productId: product.id, essential: false, minimumStockPieces: 0, targetCoverDays: null, leadTimeStages: null }] });
    setProductNames((names) => ({ ...names, [product.id]: `${product.sku ?? ""} · ${product.name}` }));
    setSearch("");
  };
  if (policyQuery.isLoading) return <div role="status" className="text-sm">Loading stock and growth policy…</div>;
  if (policyQuery.isError || !draft) return <div role="alert" className="text-sm text-destructive">Stock and growth policy could not be loaded.</div>;
  return <section className="space-y-4 rounded-lg border p-4" aria-labelledby="purchase-planning-policy-title">
    <div>
      <h3 id="purchase-planning-policy-title" className="font-semibold">Stock targets and growth plan</h3>
      <p className="text-xs text-muted-foreground">Revision {draft.revision}. Targets use base pieces. Forecast events in Demand Planner add lumpy demand separately.</p>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs">Uniform growth adjustment (%)
        <Input aria-label="Uniform growth adjustment (%)" type="number" min={-100} max={1000} step={1} value={Number.isFinite(draft.policy.growthPercent) ? draft.policy.growthPercent : ""} onChange={(event) => patch({ growthPercent: event.target.value === "" ? Number.NaN : Number(event.target.value) })} />
        <span className="text-muted-foreground">Applied to historical daily demand. 0 keeps the historical forecast.</span>
      </label>
      <label className="text-xs">Default order-up-to cover (days)
        <Input aria-label="Default order-up-to cover (days)" type="number" min={0} max={730} step={1} placeholder="Lead time + safety" value={draft.policy.targetCoverDays ?? ""} onChange={(event) => patch({ targetCoverDays: event.target.value === "" ? null : Number(event.target.value) })} />
        <span className="text-muted-foreground">Includes lead time; cannot reduce the lead and safety floor. Blank uses the existing policy.</span>
      </label>
    </div>
    <label className="block text-xs">Find a product to set an essential-item target or staged lead time
      <Input aria-label="Find product planning policy" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search SKU or product name" />
    </label>
    {searchTerm.length >= 2 && <div className="max-h-48 overflow-y-auto rounded border">
      {productQuery.isLoading ? <p className="p-2 text-xs">Searching…</p> : productQuery.isError ? <p role="alert" className="p-2 text-xs text-destructive">Product search failed.</p> : (productQuery.data?.items ?? []).map((product) => <button key={product.id} type="button" className="block w-full border-b p-2 text-left text-xs hover:bg-muted disabled:opacity-50" disabled={draft.policy.products.some((row) => row.productId === product.id)} onClick={() => addProduct(product)}>{product.sku} · {product.name}</button>)}
      {productQuery.data?.items.length === 0 && <p className="p-2 text-xs">No matching products.</p>}
      {productQuery.data?.items.length === 50 && <p className="p-2 text-xs text-muted-foreground">Showing the first 50 matches. Refine the search for other products.</p>}
    </div>}
    {draft.policy.products.map((product) => <fieldset key={product.productId} className="space-y-3 rounded border p-3">
      <legend className="max-w-full px-1 text-xs font-semibold">{productNames[product.productId] ?? `Product #${product.productId}`}</legend>
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs"><Switch checked={product.essential} onCheckedChange={(essential) => patchProduct(product.productId, { essential })} />Essential item</label>
        <Button type="button" variant="ghost" size="sm" onClick={() => patch({ products: draft.policy.products.filter((row) => row.productId !== product.productId), replacementForecasts: (draft.policy.replacementForecasts ?? []).filter((range) => range.productId !== product.productId) })}>Remove product policy</Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs">Minimum stock buffer (pieces)<Input type="number" min={0} step={1} value={Number.isFinite(product.minimumStockPieces) ? product.minimumStockPieces : ""} onChange={(event) => patchProduct(product.productId, { minimumStockPieces: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
        <label className="text-xs">Order-up-to cover (days)<Input type="number" min={0} max={730} value={product.targetCoverDays ?? ""} placeholder="Use default" onChange={(event) => patchProduct(product.productId, { targetCoverDays: event.target.value === "" ? null : Number(event.target.value) })} /></label>
      </div>
      <label className="flex items-center gap-2 text-xs"><Switch checked={product.leadTimeStages !== null} onCheckedChange={(enabled) => patchProduct(product.productId, { leadTimeStages: enabled ? { rfqDays: 0, productionDays: 0, transitDays: 0, receivingDays: 0 } : null })} />Use an explicit lead-time breakdown</label>
      {product.leadTimeStages && <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{([['rfqDays', 'RFQ'], ['productionDays', 'Production'], ['transitDays', 'Transit'], ['receivingDays', 'Receiving / putaway']] as const).map(([key, label]) => <label key={key} className="text-xs">{label} days<Input type="number" min={0} max={730} value={Number.isFinite(product.leadTimeStages![key]) ? product.leadTimeStages![key] : ""} onChange={(event) => patchProduct(product.productId, { leadTimeStages: { ...product.leadTimeStages!, [key]: event.target.value === "" ? Number.NaN : Number(event.target.value) } })} /></label>)}</div>}
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs font-medium">Replacement forecasts for specific dates</p>
        <p className="text-xs text-muted-foreground">Enter the total demand for the inclusive date range. It replaces the historical growth forecast during those dates. Demand Planner events still add separately. Zero explicitly means no baseline demand.</p>
        {(draft.policy.replacementForecasts ?? []).map((range, index) => range.productId !== product.productId ? null : <div key={index} className="space-y-2 rounded border p-2">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-xs">Forecast start date<Input type="date" value={range.startDate} onChange={(event) => patchForecast(index, { startDate: event.target.value })} /></label>
            <label className="text-xs">Forecast end date<Input type="date" value={range.endDate} onChange={(event) => patchForecast(index, { endDate: event.target.value })} /></label>
            <label className="text-xs">Total forecast pieces<Input type="number" min={0} step={1} value={Number.isFinite(range.totalPieces) ? range.totalPieces : ""} onChange={(event) => patchForecast(index, { totalPieces: event.target.value === "" ? Number.NaN : Number(event.target.value) })} /></label>
            <label className="text-xs">Forecast reference<Input value={range.reference} onChange={(event) => patchForecast(index, { reference: event.target.value })} placeholder="Monthly growth plan or customer forecast" /></label>
          </div>
          <Button type="button" size="sm" variant="ghost" onClick={() => patch({ replacementForecasts: (draft.policy.replacementForecasts ?? []).filter((_range, rangeIndex) => rangeIndex !== index) })}>Remove forecast range</Button>
        </div>)}
        <Button type="button" size="sm" variant="outline" onClick={() => {
          const today = new Date().toISOString().slice(0, 10);
          patch({ replacementForecasts: [...(draft.policy.replacementForecasts ?? []), { productId: product.productId, startDate: today, endDate: today, totalPieces: Number.NaN, reference: "" }] });
        }}>Add replacement forecast</Button>
      </div>
      <p className="text-xs text-muted-foreground">Essential marks priority and requires a target. It does not claim guaranteed availability. Staged lead time replaces the supplier/product total only when enabled.</p>
    </fieldset>)}
    {!purchasePlanningPolicySchema.safeParse(draft.policy).success && <p role="alert" className="text-xs text-destructive">Enter valid quantities and days. Essential products need a stock buffer or cover target; explicit stages must total 1 to 1460 days. Replacement forecasts need a reference and valid nonoverlapping dates.</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" disabled={save.isPending || !purchasePlanningPolicySchema.safeParse(draft.policy).success} onClick={() => save.mutate(draft)}>{save.isPending ? "Saving…" : "Save stock and growth policy"}</Button>
      <Button type="button" variant="outline" disabled={save.isPending} onClick={async () => { const result = await policyQuery.refetch(); if (result.data) { setDraft(result.data); submission.current = null; } }}>Reload current policy</Button>
    </div>
    <details className="text-xs"><summary className="cursor-pointer">Policy history</summary>
      {historyQuery.isError ? <p role="alert">History could not be loaded.</p> : (historyQuery.data?.changes ?? []).map((change) => <div key={change.revision} className="border-b py-2">Revision {change.revision} · {new Date(change.changedAt).toLocaleString()} · {change.actorId}<div className="text-muted-foreground">Growth {change.after.growthPercent}% · {change.after.products.length} product policies</div></div>)}
      {historyQuery.data?.changes.length === 0 && <p className="py-2">The default policy has not been changed.</p>}
    </details>
  </section>;
}
