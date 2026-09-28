import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listingCatalogPageSchema,
  type ListingCatalogItem,
} from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { publicationRequest } from "./api";
import { errorMessage, MAX_DRAFT_ITEMS, money } from "./model";

interface Props {
  base: string;
  providerName: string;
  selectedIds: ReadonlySet<number>;
  onClose(): void;
  onAdd(items: ListingCatalogItem[]): void;
}
const PAGE_SIZE = 25;

export function ListingCatalogPicker({
  base,
  providerName,
  selectedIds,
  onClose,
  onAdd,
}: Props) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [chosen, setChosen] = useState<Map<number, ListingCatalogItem>>(
    new Map(),
  );
  const catalog = useQuery({
    queryKey: [base, "catalog", search, offset],
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/catalog?${new URLSearchParams({ q: search, offset: String(offset), limit: String(PAGE_SIZE) })}`,
        listingCatalogPageSchema,
      ),
  });
  const remaining = MAX_DRAFT_ITEMS - selectedIds.size;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add products to {providerName}</DialogTitle>
          <DialogDescription>
            Select exact packs and variants. Future products and variants remain
            unselected.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(input.trim());
            setOffset(0);
          }}
        >
          <Input
            aria-label="Search Echelon products or SKU"
            placeholder="Search products or SKU"
            value={input}
            maxLength={100}
            onChange={(event) => setInput(event.target.value)}
          />
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <p className="text-sm text-muted-foreground">
          {chosen.size} selected across pages · {remaining} spaces in this draft
        </p>
        {catalog.isFetching && (
          <p role="status" className="text-sm">
            Loading catalog…
          </p>
        )}
        {catalog.error && (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(catalog.error)}
          </p>
        )}
        <div className="divide-y">
          {catalog.data?.items.map((item) => {
            const included = selectedIds.has(item.variantId);
            const checked = included || chosen.has(item.variantId);
            const blocked =
              !item.eligible ||
              item.alreadyLinked ||
              included ||
              (!checked && chosen.size >= remaining);
            return (
              <label
                key={item.variantId}
                className="flex items-start gap-3 py-4"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  aria-label={`Select ${item.sku}`}
                  checked={checked}
                  disabled={blocked}
                  onChange={(event) =>
                    setChosen((previous) => {
                      const next = new Map(previous);
                      if (event.target.checked) next.set(item.variantId, item);
                      else next.delete(item.variantId);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{item.name}</span>
                  <span className="block text-sm">
                    {item.variantName} · {item.unitLabel}
                  </span>
                  <span className="block break-all font-mono text-xs text-muted-foreground">
                    {item.sku}
                  </span>
                  <span className="mt-1 block">
                    {included ? (
                      <Badge variant="secondary">In draft</Badge>
                    ) : item.alreadyLinked ? (
                      <Badge variant="secondary">Already linked</Badge>
                    ) : !item.eligible ? (
                      <Badge variant="secondary">Not eligible for sale</Badge>
                    ) : null}
                  </span>
                </span>
                <span className="shrink-0 text-sm">
                  {money(item.priceCents)}
                </span>
              </label>
            );
          })}
        </div>
        {catalog.data?.items.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No matching variants. Change your search.
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Button
            variant="outline"
            disabled={offset === 0 || catalog.isFetching}
            onClick={() =>
              setOffset((previous) => Math.max(0, previous - PAGE_SIZE))
            }
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {catalog.data
              ? `${Math.min(offset + 1, catalog.data.total)}–${Math.min(offset + PAGE_SIZE, catalog.data.total)} of ${catalog.data.total}`
              : ""}
          </span>
          <Button
            variant="outline"
            disabled={
              !catalog.data ||
              offset + PAGE_SIZE >= catalog.data.total ||
              catalog.isFetching
            }
            onClick={() => setOffset((previous) => previous + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={chosen.size === 0}
            onClick={() => onAdd([...chosen.values()])}
          >
            Add {chosen.size} to draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
