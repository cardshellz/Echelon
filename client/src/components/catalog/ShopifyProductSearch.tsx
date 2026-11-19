import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Search } from "lucide-react";
import { shopifyProductSearchResultSchema, shopifyProductSearchTermSchema, type ShopifyProductSearchResult } from "@shared/catalog/shopify-product-connection";
import { shopifyProductFetch } from "@/lib/shopify-product-connection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// This only distinguishes direct references from search text. The server still
// validates the ID and selected store before reading any remote product.
export function isShopifyProductReference(value: string): boolean {
  return /^(?:[1-9][0-9]*|gid:\/\/shopify\/Product\/[1-9][0-9]*)$/.test(value.trim()) || /^https?:\/\//i.test(value.trim());
}

type Product = ShopifyProductSearchResult["products"][number];
const statusLabels: Record<Product["status"], string> = { ACTIVE: "Active", DRAFT: "Draft", ARCHIVED: "Archived", UNLISTED: "Unlisted" };

export function ShopifyProductSearch(props: {
  productId: number; channelId: number; value: string; selectedReference: string; disabled: boolean;
  onChange: (value: string, asSearch?: boolean) => void; onSelect: (product: Product) => void;
}) {
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [page, setPage] = useState(0);
  const query = props.value.trim();
  const directReference = isShopifyProductReference(query);
  const canSearch = shopifyProductSearchTermSchema.safeParse(query).success && !/^(?:https?:|gid:)\/\//i.test(query);
  const active = submittedQuery === query && !props.selectedReference;
  const params = new URLSearchParams({ channelId: String(props.channelId), query: submittedQuery ?? "" });
  const cursor = cursors[page];
  if (cursor) params.set("cursor", cursor);
  const url = `/api/products/${props.productId}/shopify-connection/search?${params}`;
  const results = useQuery({
    queryKey: [url], queryFn: () => shopifyProductFetch(url, undefined, shopifyProductSearchResultSchema),
    enabled: active && canSearch && !props.disabled, retry: false, refetchOnWindowFocus: false,
  });

  function search() {
    if (!canSearch || props.disabled || results.isFetching) return;
    props.onChange(props.value, true); // Explicitly discard any previous product review.
    setCursors([null]); setPage(0); setSubmittedQuery(query);
    if (active && page === 0) void results.refetch();
  }

  return <div className="space-y-2">
    <Label htmlFor="shopify-product-reference">Search Shopify products</Label>
    <div className="flex gap-2">
      <Input id="shopify-product-reference" value={props.value} disabled={props.disabled} maxLength={500}
        placeholder="Search by name or SKU, or paste a product URL or ID"
        aria-describedby="shopify-product-search-help"
        onChange={event => { setSubmittedQuery(null); setPage(0); setCursors([null]); props.onChange(event.target.value); }}
        onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); search(); } }} />
      <Button type="button" variant="outline" disabled={props.disabled || !canSearch || results.isFetching} onClick={search}>
        {active && results.isFetching ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}Search
      </Button>
    </div>
    <p id="shopify-product-search-help" className="text-xs text-muted-foreground">
      {directReference ? "Product reference entered. Review the Shopify connection below." : "Search this Shopify store by name or SKU (at least 2 characters). Draft products are included."}
    </p>
    {!canSearch && !directReference && query.length >= 2 && <p className="text-sm text-destructive">Use up to 200 characters of plain text for a product search.</p>}
    {props.selectedReference && !directReference && <p className="text-sm" role="status">Selected: {props.value} · {props.selectedReference}. Review the connection below.</p>}
    {active && <div aria-live="polite" className="space-y-2">
      {results.isFetching && <p className="text-sm">Searching Shopify…</p>}
      {results.isError && <p role="alert" className="text-sm text-destructive">Shopify products could not be loaded. Try searching again.</p>}
      {results.data && !results.isError && <>
        {!results.data.products.length && <p className="text-sm">No Shopify products found. Try another name or SKU.</p>}
        {results.data.products.length > 0 && <ul className="max-h-64 overflow-y-auto rounded border divide-y" aria-label="Shopify product search results">
          {results.data.products.map(product => <li key={product.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <div className="min-w-0"><p className="break-words font-medium">{product.title}</p>
              <p className="text-xs text-muted-foreground">{statusLabels[product.status]} · {product.id}</p>
              {product.status === "ARCHIVED" && <p className="text-xs">Restore this product in Shopify before linking.</p>}
              {product.status === "UNLISTED" && <p className="text-xs">Linking unlisted products is not supported here.</p>}
            </div>
            <Button type="button" size="sm" variant="outline" aria-label={`Select ${product.title} (${product.id})`}
              disabled={props.disabled || results.isFetching || !["ACTIVE", "DRAFT"].includes(product.status)}
              onClick={() => { setSubmittedQuery(null); props.onSelect(product); }}>Select</Button>
          </li>)}
        </ul>}
        {(page > 0 || results.data.nextCursor) && <div className="flex items-center justify-between gap-2">
          <Button type="button" size="sm" variant="outline" disabled={props.disabled || results.isFetching || page === 0} onClick={() => setPage(current => current - 1)}>Previous results</Button>
          <span className="text-xs">Page {page + 1}</span>
          <Button type="button" size="sm" variant="outline" disabled={props.disabled || results.isFetching || !results.data.nextCursor}
            onClick={() => { setCursors(current => [...current.slice(0, page + 1), results.data!.nextCursor]); setPage(current => current + 1); }}>Next results</Button>
        </div>}
      </>}
    </div>}
  </div>;
}
