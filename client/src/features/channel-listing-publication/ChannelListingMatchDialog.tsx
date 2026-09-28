import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { catalogMapping, type useChannelCatalog } from "./useChannelCatalog";

export function ChannelListingMatchDialog({
  catalog,
  canEdit,
}: {
  catalog: ReturnType<typeof useChannelCatalog>;
  canEdit: boolean;
}) {
  const { matching, variants, link, locked } = catalog;
  return (
    <Dialog
      open={matching !== null}
      onOpenChange={(open) => {
        if (!open) catalog.closeMatching();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Match listing to Echelon</DialogTitle>
          <DialogDescription>
            {matching?.title} · {matching?.sku}. Linking connects this existing
            listing to an exact Echelon variant.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Find Echelon variant"
          placeholder="Search Echelon SKU or name"
          maxLength={100}
          disabled={locked}
          value={catalog.variantSearch}
          onChange={(event) => catalog.setVariantSearch(event.target.value)}
        />
        {variants.error && (
          <p role="alert" className="text-sm text-destructive">
            {variants.error.message}
          </p>
        )}
        {link.error && (
          <p role="alert" className="text-sm text-destructive">
            {link.error.message}
          </p>
        )}
        {variants.isFetching && (
          <p role="status" className="text-sm">
            Searching…
          </p>
        )}
        {catalog.variantSearch.trim().length < 2 && (
          <p className="text-sm text-muted-foreground">
            Enter at least two characters to find a variant.
          </p>
        )}
        <div className="max-h-80 space-y-2 overflow-auto">
          {variants.data?.map((variant) => (
            <div
              key={variant.id}
              className="flex items-center gap-3 rounded border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words">{variant.name}</p>
                <p className="break-all font-mono text-xs">{variant.sku}</p>
              </div>
              <Button
                size="sm"
                disabled={
                  !canEdit || !variant.eligible || locked || variants.isFetching
                }
                onClick={() =>
                  matching &&
                  catalog.linkMappings([catalogMapping(matching, variant.id)])
                }
              >
                {variant.eligible ? "Link" : "Unavailable"}
              </Button>
            </div>
          ))}
        </div>
        {!variants.isFetching && variants.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No Echelon variants match this search.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
