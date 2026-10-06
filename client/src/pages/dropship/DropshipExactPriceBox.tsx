import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { catalogTargetsResponseSchema } from "@shared/dropship/catalog-scope";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { DropshipListingPriceEditor } from "./DropshipListingPriceEditor";
import type { ListingPriceSaveCallbacks } from "./DropshipListingPreview";
import { NotSavedBadge, useLeaveGuard, useUnsavedDraft } from "./catalog/UnsavedChangesGuard";

/** Wait after the last key before searching, so typing a SKU sends one request rather than one per key. */
const SEARCH_DELAY_MS = 300;

interface ChosenSize { productVariantId: number; name: string }

/**
 * Type an exact price for one size on Listing settings, without a listing
 * preview (plan item 203). The search goes through the pricing targets route,
 * which covers the whole selected catalog rather than the preview's first 500
 * sizes, and the price saves through the per-size price route the preview uses.
 */
export function DropshipExactPriceBox({ storeConnectionId, callbacks }: {
  storeConnectionId: number; callbacks: ListingPriceSaveCallbacks;
}) {
  const endpoint = `/api/dropship/listings/stores/${storeConnectionId}/pricing-rules/targets`;
  const [search, setSearch] = useState("");
  const [searchText, setSearchText] = useState("");
  const [chosen, setChosen] = useState<ChosenSize | null>(null);
  const [dirty, setDirty] = useState(false);
  const leaveGuard = useLeaveGuard();
  useUnsavedDraft(`exact-price:${storeConnectionId}`, "Exact price for one size", dirty);
  useEffect(() => {
    const timer = setTimeout(() => setSearchText(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const results = useQuery({ queryKey: [endpoint, "listings", searchText], enabled: !chosen && searchText.length > 0, retry: false,
    queryFn: async () => catalogTargetsResponseSchema.parse(await fetchJson(
      `${endpoint}?type=listings&search=${encodeURIComponent(searchText)}&page=0`)) });

  function choose(id: string, name: string): void {
    const productVariantId = Number(id);
    // The targets route returns size ids as text; never act on one that is not a positive integer.
    if (!Number.isSafeInteger(productVariantId) || productVariantId <= 0) return;
    setChosen({ productVariantId, name });
  }

  return (
    <section aria-label="Exact price for one size" className="space-y-3 border-t pt-4">
      <div>
        <h3 className="flex flex-wrap items-center gap-2 font-medium">Exact price for one size{dirty && <NotSavedBadge />}</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Type the price you want for one size, for example 14.99. An exact price stays the same when your cost changes.
          Pricing rules don&apos;t change it unless you tick &ldquo;Replace existing fixed prices&rdquo; when you review them.
        </p>
      </div>
      {chosen ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">{chosen.name}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => leaveGuard(() => setChosen(null))}>Choose another size</Button>
          </div>
          <DropshipListingPriceEditor storeConnectionId={storeConnectionId} productVariantId={chosen.productVariantId}
            context="settings" onDirtyChange={setDirty} disabled={callbacks.disabled} onSaveStarted={callbacks.onSaveStarted}
            onSaveSettled={callbacks.onSaveSettled} onSaved={callbacks.onSaved} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="max-w-md space-y-1">
            <Label htmlFor={`exact-price-search-${storeConnectionId}`}>Find a size by name or SKU</Label>
            <Input id={`exact-price-search-${storeConnectionId}`} value={search} maxLength={100} autoComplete="off"
              onChange={(event) => setSearch(event.target.value)} />
          </div>
          <SearchResults searchText={searchText} query={results} onChoose={choose} />
        </div>
      )}
    </section>
  );
}

function SearchResults({ searchText, query, onChoose }: {
  searchText: string;
  query: { data?: { total: number; rows: Array<{ id: string; name: string }> }; error: unknown };
  onChoose: (id: string, name: string) => void;
}) {
  if (!searchText) return null;
  if (query.error) return <p role="alert" className="text-sm text-amber-800">{queryErrorMessage(query.error, "Sizes could not be searched. Try again.")}</p>;
  if (!query.data) return <p role="status" className="text-sm text-zinc-500">Searching…</p>;
  if (query.data.rows.length === 0) return <p role="status" className="text-sm text-zinc-500">No selected size matches &ldquo;{searchText}&rdquo;.</p>;
  return (
    <div className="space-y-1">
      <ul className="max-h-64 divide-y overflow-auto overscroll-contain rounded border">
        {query.data.rows.map((row) => (
          <li key={row.id}>
            <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-50" onClick={() => onChoose(row.id, row.name)}>
              {row.name}
            </button>
          </li>
        ))}
      </ul>
      {query.data.total > query.data.rows.length && (
        <p className="text-xs text-zinc-500">
          Showing the first {query.data.rows.length} of {query.data.total.toLocaleString()}. Type more of the name or SKU to narrow it.
        </p>
      )}
    </div>
  );
}
