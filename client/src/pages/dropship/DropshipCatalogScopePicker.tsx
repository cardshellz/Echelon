import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { catalogTargetsResponseSchema, CATALOG_TARGET_PAGE_SIZE } from "@shared/dropship/catalog-scope";
import type { CatalogScope } from "@shared/dropship/catalog-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
const selectClass = "h-9 w-full rounded-md border bg-white px-2 text-sm text-zinc-900";
function Field({ label, children }: { label: string; children: import("react").ReactNode }) {
  return <label className="block space-y-1 text-xs text-zinc-600"><span>{label}</span>{children}</label>;
}
type Scope = CatalogScope;
export function DropshipCatalogScopePicker({ endpoint, value, onChange, disabled }: { endpoint: string; value: Scope; onChange: (value: Scope) => void; disabled: boolean }) {
  const [search, setSearch] = useState("");
  const [queryText, setQueryText] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => { const timer = setTimeout(() => { setQueryText(search); setPage(0); }, 300); return () => clearTimeout(timer); }, [search]);
  const query = useQuery({ queryKey: [endpoint, "targets", value.type, queryText, page], retry: false,
    queryFn: async () => catalogTargetsResponseSchema.parse(await fetchJson(`${endpoint}/targets?type=${value.type}&search=${encodeURIComponent(queryText)}&page=${page}`)) });
  const selected = value.type === "category" ? [value.category] : value.type === "product_line" ? [String(value.productLineId)]
    : value.type === "product" ? [String(value.productId)] : value.productVariantIds.map(String);
  function choose(id: string) {
    if (value.type === "category") onChange({ type: "category", category: id });
    else if (value.type === "product_line") onChange({ type: "product_line", productLineId: Number(id) });
    else if (value.type === "product") onChange({ type: "product", productId: Number(id) });
    else onChange({ type: "listings", productVariantIds: selected.includes(id) ? value.productVariantIds.filter((item) => item !== Number(id)) : [...value.productVariantIds, Number(id)] });
  }
  return <div className="space-y-2"><div className="grid gap-3 sm:grid-cols-2">
    <Field label="Applies to"><select className={selectClass} value={value.type} onChange={(event) => {
      setPage(0); setSearch(""); setQueryText(""); const type = event.target.value;
      onChange(type === "category" ? { type, category: "" } : type === "product_line" ? { type, productLineId: 0 }
        : type === "product" ? { type, productId: 0 } : { type: "listings", productVariantIds: [] });
    }}><option value="category">Category</option><option value="product_line">Product line</option><option value="product">Product</option><option value="listings">Named listing group</option></select></Field>
    <Field label="Search selected catalog"><Input value={search} maxLength={100} onChange={(event) => setSearch(event.target.value)} /></Field></div>
    <div className="max-h-36 overflow-auto overscroll-contain rounded border p-2">
      {query.isPending ? <p className="text-xs">Loading choices…</p> : query.error ? <div role="alert" className="text-xs text-rose-700">{queryErrorMessage(query.error, "Choices unavailable.")}
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => void query.refetch()}>Retry choices</Button></div>
        : query.data?.rows.map((row) => <label key={row.id} className="flex items-start gap-2 py-1 text-xs"><input type="checkbox" disabled={disabled}
          checked={selected.includes(row.id)} onChange={() => choose(row.id)} /><span>{row.name}</span></label>)}
      {query.data?.rows.length === 0 && <p className="text-xs text-zinc-500">No matching selected catalog items.</p>}
    </div>
    <div className="flex items-center justify-between text-xs text-zinc-500"><span>{selected.filter((id) => id !== "" && id !== "0").length} selected across searches</span>
      <div className="flex gap-2"><Button type="button" size="sm" variant="ghost" disabled={disabled || page === 0} onClick={() => setPage(page - 1)}>Previous choices</Button>
        <Button type="button" size="sm" variant="ghost" disabled={disabled || !query.data || (page + 1) * CATALOG_TARGET_PAGE_SIZE >= query.data.total} onClick={() => setPage(page + 1)}>Next choices</Button></div></div>
  </div>;
}
