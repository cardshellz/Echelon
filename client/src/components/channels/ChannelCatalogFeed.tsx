import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Link2, Loader2, Package, RefreshCw, Search } from "lucide-react";
import { channelCatalogVariantSchema, channelCatalogViewSchema, type ChannelCatalogMapping, type ChannelCatalogRow } from "@shared/types/channel-catalog";
import { apiRequest } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const statusLabels: Record<ChannelCatalogRow["mappingStatus"], string> = {
  linked: "Linked", matched: "Exact SKU match", unmatched: "Needs match", conflict: "Conflict", unavailable: "Unavailable",
};
export function ChannelCatalogFeed({ channelId, providerName, canEdit, onMappingsChanged }: {
  channelId: number; providerName: string; canEdit: boolean; onMappingsChanged?: () => Promise<void>;
}) {
  const base = `/api/channels/${channelId}/catalog`;
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const [sku, setSku] = useState("");
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [matching, setMatching] = useState<ChannelCatalogRow | null>(null);
  const [variantSearch, setVariantSearch] = useState("");
  const [message, setMessage] = useState("");
  const cursor = cursors[cursors.length - 1];
  const feed = useQuery({ queryKey: [base, cursor, sku],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (sku) params.set("sku", sku);
      return channelCatalogViewSchema.parse(await (await apiRequest("GET", `${base}?${params}`)).json());
    } });
  const variants = useQuery({ queryKey: [base, "variants", variantSearch],
    enabled: matching !== null && variantSearch.trim().length >= 2,
    queryFn: async () => channelCatalogVariantSchema.array().parse(await (await apiRequest("GET", `${base}/variants?q=${encodeURIComponent(variantSearch.trim())}`)).json()) });
  const link = useMutation({ mutationFn: async (mappings: ChannelCatalogMapping[]) => {
    return (await apiRequest("POST", `${base}/mappings`, { mappings })).json() as Promise<{ linked: number }>;
  }, onSuccess: async result => {
    setMessage(`${result.linked} listing${result.linked === 1 ? "" : "s"} linked.`); setSelected(new Set()); setMatching(null);
    await client.invalidateQueries({ queryKey: [base] });
    await onMappingsChanged?.();
  } });
  const matches = feed.data?.items.filter(item => item.mappingStatus === "matched" && item.variant) ?? [];
  const chosen = matches.filter(item => selected.has(item.sku));
  const changePage = (next: (string | null)[]) => { setCursors(next); setSelected(new Set()); setMessage(""); };
  return <Card>
    <CardHeader className="px-3 sm:px-6"><CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" />Listing Feed</CardTitle>
      <CardDescription>Browse {providerName} listings and their Echelon variants. Unique exact SKU matches are linked automatically when orders arrive.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4 px-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <form className="flex gap-2 flex-1 min-w-56" onSubmit={event => { event.preventDefault(); setSku(search.trim()); changePage([null]); }}>
          <Input aria-label={`Search ${providerName} SKU`} placeholder={`Search exact ${providerName} SKU`} value={search} onChange={event => setSearch(event.target.value)} />
          <Button type="submit" variant="outline" aria-label="Search listings"><Search className="h-4 w-4" /></Button>
        </form>
        {sku && <Button variant="ghost" onClick={() => { setSearch(""); setSku(""); changePage([null]); }}>Clear search</Button>}
        <Button variant="outline" disabled={feed.isFetching || link.isPending} onClick={() => { setSelected(new Set()); void feed.refetch(); }}>
          <RefreshCw className={`h-4 w-4 mr-2 ${feed.isFetching ? "animate-spin" : ""}`} />Refresh listings</Button>
        {canEdit && <Button disabled={!chosen.length || link.isPending} onClick={() => link.mutate(chosen.map(item => ({ sku: item.sku, productVariantId: item.variant!.id })))}>
          {link.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Link2 className="h-4 w-4 mr-2" />}Link selected ({chosen.length})</Button>}
      </div>
      {feed.error && <p role="alert" className="text-destructive">{feed.error.message}</p>}
      {link.error && <p role="alert" className="text-destructive">{link.error.message}</p>}
      {message && <p role="status" className="text-sm">{message}</p>}
      {feed.isLoading ? <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading listings…</p> : feed.data && <>
        <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
          <span>{feed.data.total ?? feed.data.items.length} listings{feed.data.total === null ? " on this page" : " in catalog"}</span>
          <span>{feed.data.items.filter(item => item.mappingStatus === "linked").length} linked on this page</span>
          <span>{matches.length} exact matches on this page</span>
        </div>
        <div className="overflow-x-auto rounded-md border"><Table><TableHeader><TableRow>
          {canEdit && <TableHead className="w-10"><input type="checkbox" aria-label="Select all exact matches" disabled={!matches.length || link.isPending}
            checked={matches.length > 0 && chosen.length === matches.length} onChange={event => setSelected(new Set(event.target.checked ? matches.map(item => item.sku) : []))} /></TableHead>}
          <TableHead>{providerName} listing</TableHead><TableHead>Listing status</TableHead><TableHead>Echelon variant</TableHead><TableHead>Mapping</TableHead>{canEdit && <TableHead>Action</TableHead>}
        </TableRow></TableHeader><TableBody>
          {feed.data.items.length === 0 && <TableRow><TableCell colSpan={canEdit ? 6 : 4} className="py-10 text-center text-muted-foreground">No listings found in this account.</TableCell></TableRow>}
          {feed.data.items.map(item => <TableRow key={item.sku}>
            {canEdit && <TableCell><input type="checkbox" aria-label={`Select ${item.sku}`} checked={selected.has(item.sku)}
              disabled={item.mappingStatus !== "matched" || link.isPending} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(item.sku); else next.delete(item.sku); return next; })} /></TableCell>}
            <TableCell><p className="font-medium min-w-40">{item.title}</p><p className="text-xs font-mono text-muted-foreground">{item.sku}</p></TableCell>
            <TableCell><Badge variant="outline">{item.publishedStatus}</Badge><p className="text-xs text-muted-foreground mt-1">{item.lifecycleStatus}</p></TableCell>
            <TableCell>{item.variant ? <><p>{item.variant.name}</p><p className="text-xs font-mono text-muted-foreground">{item.variant.sku}</p></> : <span className="text-muted-foreground">No match</span>}</TableCell>
            <TableCell><Badge variant={item.mappingStatus === "conflict" ? "destructive" : item.mappingStatus === "linked" ? "default" : "secondary"}>{statusLabels[item.mappingStatus]}</Badge>
              {item.message && <p className="text-xs max-w-64 mt-1">{item.message}</p>}</TableCell>
            {canEdit && <TableCell>{item.mappingStatus === "linked" ? <CheckCircle2 className="h-4 w-4 text-green-600" aria-label="Linked" />
              : ["matched", "unmatched"].includes(item.mappingStatus) && <Button variant="outline" size="sm" disabled={link.isPending} onClick={() => { setMatching(item); setVariantSearch(item.variant?.sku ?? item.sku); }}>Choose variant</Button>}</TableCell>}
          </TableRow>)}
        </TableBody></Table></div>
        <div className="flex justify-between items-center"><Button variant="outline" disabled={cursors.length === 1 || feed.isFetching || link.isPending} onClick={() => changePage(cursors.slice(0, -1))}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {cursors.length}</span>
          <Button variant="outline" disabled={!feed.data.nextCursor || feed.isFetching || link.isPending} onClick={() => changePage([...cursors, feed.data!.nextCursor])}>Next</Button></div>
      </>}
      <Dialog open={matching !== null} onOpenChange={open => { if (!open && !link.isPending) setMatching(null); }}><DialogContent>
        <DialogHeader><DialogTitle>Match listing to Echelon</DialogTitle><DialogDescription>{matching?.title} · {matching?.sku}</DialogDescription></DialogHeader>
        <Input aria-label="Find Echelon variant" placeholder="Search Echelon SKU or name" value={variantSearch} onChange={event => setVariantSearch(event.target.value)} />
        {variants.error && <p role="alert">{variants.error.message}</p>}
        {link.error && <p role="alert" className="text-destructive">{link.error.message}</p>}
        {variants.isFetching && <p>Searching…</p>}
        <div className="max-h-80 overflow-auto space-y-2">{variants.data?.map(variant => <div key={variant.id} className="flex items-center gap-3 rounded border p-3">
          <div className="flex-1"><p>{variant.name}</p><p className="text-xs font-mono">{variant.sku}</p></div>
          <Button size="sm" disabled={!variant.eligible || link.isPending} onClick={() => matching && link.mutate([{ sku: matching.sku, productVariantId: variant.id }])}>{variant.eligible ? "Link" : "Unavailable"}</Button>
        </div>)}</div>
        {variants.data?.length === 0 && <p className="text-sm text-muted-foreground">No Echelon variants match this search.</p>}
      </DialogContent></Dialog>
    </CardContent>
  </Card>;
}
