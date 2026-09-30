import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  listingDraftItemSchema,
  listingProviderFieldsSchema,
  listingRequirementsSchema,
  listingTaxonomySchema,
  type ListingCatalogItem,
  type ListingDraftItem,
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { publicationRequest } from "./api";
import { dollarsToCents, errorMessage, money } from "./model";
import { SchemaFields } from "./SchemaFields";
import { ListingProductTypePicker } from "./ListingProductTypePicker";
import { selectListingProductType } from "./product-type-model";

interface Props {
  base: string;
  item: ListingDraftItem;
  catalog?: ListingCatalogItem;
  canEdit: boolean;
  onClose(): void;
  onSave(item: ListingDraftItem): void;
}

export function ListingItemEditor({
  base,
  item,
  catalog,
  canEdit,
  onClose,
  onSave,
}: Props) {
  const prefix = useId();
  const [draft, setDraft] = useState(item);
  const [override, setOverride] = useState(
    item.priceOverrideCents === null
      ? ""
      : money(item.priceOverrideCents).slice(1),
  );
  const [images, setImages] = useState(item.images?.join("\n") ?? "");
  const [advanced, setAdvanced] = useState(
    JSON.stringify(item.attributes, null, 2),
  );
  const [error, setError] = useState("");
  const taxonomy = useQuery({
    queryKey: [base, "taxonomy"],
    queryFn: () =>
      publicationRequest("GET", `${base}/taxonomy`, listingTaxonomySchema),
  });
  const requirements = useQuery({
    queryKey: [base, "requirements", draft.productType, draft.method],
    enabled: draft.method === "match" || draft.productType.trim().length > 0,
    queryFn: () =>
      publicationRequest(
        "GET",
        `${base}/requirements?${new URLSearchParams({ productType: draft.productType, method: draft.method })}`,
        listingRequirementsSchema,
      ),
  });
  function attributes(value: Record<string, unknown>) {
    setDraft((previous) => ({ ...previous, attributes: value }));
    setAdvanced(JSON.stringify(value, null, 2));
  }
  function save() {
    const cents = override.trim() ? dollarsToCents(override) : null;
    if (override.trim() && cents === null) {
      setError("Enter a positive fixed price with at most two decimal places.");
      return;
    }
    const parsed = listingDraftItemSchema.safeParse({
      ...draft,
      priceOverrideCents: cents,
      images: images.trim()
        ? images
            .split(/\r?\n/)
            .map((url) => url.trim())
            .filter(Boolean)
        : null,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .slice(0, 5)
          .join("; "),
      );
      return;
    }
    onSave(parsed.data);
  }
  const selectClass =
    "min-h-10 w-full rounded-md border bg-background px-3 py-2 text-sm";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {catalog?.name ?? `Variant ${item.variantId}`}
          </DialogTitle>
          <DialogDescription>
            {catalog
              ? `${catalog.sku} · ${catalog.unitLabel}`
              : "Edit this selected variant’s Walmart listing details."}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={!canEdit} className="space-y-5 min-w-0">
          <div className="sm:max-w-sm">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-method`}>Listing method</Label>
              <select
                id={`${prefix}-method`}
                className={selectClass}
                value={draft.method}
                onChange={(event) => {
                  setDraft((previous) => ({
                    ...previous,
                    method: event.target.value as ListingDraftItem["method"],
                    attributes: {},
                  }));
                  setAdvanced("{}");
                }}
              >
                <option value="create">Create product on Walmart</option>
                <option value="match">
                  Match existing Walmart catalog product
                </option>
              </select>
            </div>
          </div>
          <ListingProductTypePicker
            label="Walmart product type"
            value={draft.productType}
            taxonomy={taxonomy.data}
            loading={taxonomy.isFetching}
            error={taxonomy.error ? errorMessage(taxonomy.error) : undefined}
            disabled={!canEdit}
            onRetry={() => void taxonomy.refetch()}
            onSelect={(productType) => {
              if (!canEdit || !taxonomy.data) return;
              try {
                const next = selectListingProductType(
                  draft,
                  productType,
                  taxonomy.data,
                );
                if (next !== draft) {
                  setDraft(next);
                  setAdvanced("{}");
                }
              } catch (failure) {
                setError(errorMessage(failure));
              }
            }}
          />
          <p className="text-xs text-muted-foreground">
            Changing the listing method or product type resets its provider
            attributes. Walmart validates catalog matches using the exact
            product identifier.
          </p>
          <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-identifier-type`}>
                Identifier type
              </Label>
              <select
                id={`${prefix}-identifier-type`}
                className={selectClass}
                value={draft.identifier?.type ?? "GTIN"}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    identifier: {
                      type: event.target.value as NonNullable<
                        ListingDraftItem["identifier"]
                      >["type"],
                      value: previous.identifier?.value ?? "",
                    },
                  }))
                }
              >
                {["GTIN", "UPC", "EAN", "ISBN"].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`${prefix}-identifier`}>
                Identifier for this selling unit
              </Label>
              <Input
                id={`${prefix}-identifier`}
                value={draft.identifier?.value ?? ""}
                maxLength={32}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    identifier: event.target.value
                      ? {
                          type: previous.identifier?.type ?? "GTIN",
                          value: event.target.value,
                        }
                      : null,
                  }))
                }
              />
            </div>
          </div>
          {draft.method === "create" && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-title`}>Walmart title</Label>
                <Input
                  id={`${prefix}-title`}
                  maxLength={500}
                  value={draft.title ?? ""}
                  placeholder={catalog?.title ?? "Use catalog title"}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      title: event.target.value || null,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-description`}>Description</Label>
                <Textarea
                  id={`${prefix}-description`}
                  rows={4}
                  maxLength={30_000}
                  value={draft.description ?? ""}
                  placeholder={
                    catalog?.description ?? "Use catalog description"
                  }
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      description: event.target.value || null,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-brand`}>Brand</Label>
                <Input
                  id={`${prefix}-brand`}
                  maxLength={200}
                  value={draft.brand ?? ""}
                  placeholder={catalog?.brand ?? "Use catalog brand"}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      brand: event.target.value || null,
                    }))
                  }
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-images`}>Image URLs</Label>
                <Textarea
                  id={`${prefix}-images`}
                  rows={3}
                  value={images}
                  placeholder={
                    catalog?.images.join("\n") || "Use catalog images"
                  }
                  onChange={(event) => setImages(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  One URL per line, up to 20. Leave content fields empty to
                  inherit their catalog values.
                </p>
              </div>
            </>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${prefix}-price`}>Fixed Walmart price (USD)</Label>
            <Input
              id={`${prefix}-price`}
              inputMode="decimal"
              value={override}
              placeholder="Inherit pricing rules"
              onChange={(event) => setOverride(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Leave empty to inherit. Current resolved price:{" "}
              {money(catalog?.priceCents ?? null)}.
            </p>
          </div>
          <div className="space-y-3">
            <h3 className="font-medium">Required listing information</h3>
            {requirements.isFetching && (
              <p role="status" className="text-sm text-muted-foreground">
                Loading Walmart requirements…
              </p>
            )}
            {requirements.error && (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(requirements.error)}
              </p>
            )}
            {!draft.productType && draft.method === "create" && (
              <p className="text-sm text-muted-foreground">
                Choose a product type to load its attributes.
              </p>
            )}
            {requirements.data && (
              <>
                <SchemaFields
                  schema={requirements.data.schema}
                  value={draft.attributes}
                  onChange={attributes}
                  disabled={!canEdit}
                />
                <p className="text-xs text-muted-foreground">
                  Walmart schema {requirements.data.version}. Review checks all
                  conditional requirements before submission.
                </p>
              </>
            )}
          </div>
          <details className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm">
              Advanced attributes
            </summary>
            <div className="mt-3 space-y-3">
              <Label htmlFor={`${prefix}-advanced`}>
                Provider attributes (JSON)
              </Label>
              <Textarea
                id={`${prefix}-advanced`}
                rows={8}
                className="font-mono text-xs"
                value={advanced}
                onChange={(event) => setAdvanced(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  try {
                    attributes(
                      listingProviderFieldsSchema.parse(JSON.parse(advanced)),
                    );
                    setError("");
                  } catch {
                    setError(
                      "Advanced attributes must be a valid JSON object within the size limit.",
                    );
                  }
                }}
              >
                Apply advanced attributes
              </Button>
            </div>
          </details>
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {canEdit && <Button onClick={save}>Update draft item</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
