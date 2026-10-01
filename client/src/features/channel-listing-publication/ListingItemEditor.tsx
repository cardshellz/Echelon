import { useId, useRef, useState } from "react";
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
import { InheritedContentField } from "./InheritedContentField";
import { normalizeListingContent } from "./content-inheritance";
import { assertListingDraftItemUnchanged } from "./draft-item-snapshot";

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
  const sourceItem = useRef(item);
  const [draft, setDraft] = useState(item);
  const [override, setOverride] = useState(
    item.priceOverrideCents === null
      ? ""
      : money(item.priceOverrideCents).slice(1),
  );
  const [images, setImages] = useState<string | null>(
    item.images?.join("\n") ?? null,
  );
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
    if (!canEdit) return;
    setDraft((previous) => ({ ...previous, attributes: value }));
    setAdvanced(JSON.stringify(value, null, 2));
  }
  function save() {
    if (!canEdit) return;
    // Polling can update the parent revision while this editor still holds an
    // older item. Never merge those older fields into the newer revision.
    try {
      assertListingDraftItemUnchanged(sourceItem.current, item);
    } catch (failure) {
      setError(errorMessage(failure));
      return;
    }
    const cents = override.trim() ? dollarsToCents(override) : null;
    if (override.trim() && cents === null) {
      setError("Enter a positive fixed price with at most two decimal places.");
      return;
    }
    const parsed = listingDraftItemSchema.safeParse({
      ...normalizeListingContent(draft, images),
      priceOverrideCents: cents,
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
  const sections = [
    "Setup",
    "Required details",
    ...(draft.method === "create" ? ["Content"] : []),
    "Pricing",
    "Advanced",
  ];
  const sectionId = (label: string) =>
    `${prefix}-${label.replace(/\s+/g, "-")}`;
  function jumpTo(section: string) {
    const heading = document.getElementById(sectionId(section));
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "start" });
  }
  function sectionHeading(label: string, help: string) {
    return (
      <div className="space-y-1">
        <h3
          id={sectionId(label)}
          tabIndex={-1}
          className="scroll-mt-4 text-base font-semibold outline-none"
        >
          {label}
        </h3>
        <p className="text-sm text-muted-foreground">{help}</p>
      </div>
    );
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-5 pb-3 pt-5 pr-12">
          <DialogTitle>
            {catalog?.name ?? `Variant ${item.variantId}`}
          </DialogTitle>
          <DialogDescription>
            {catalog
              ? `${catalog.sku} · ${catalog.unitLabel}`
              : "Edit this selected variant’s Walmart listing details."}
          </DialogDescription>
        </DialogHeader>
        <nav
          aria-label="Listing editor sections"
          className="flex shrink-0 flex-wrap gap-2 border-b px-5 pb-3"
        >
          {sections.map((section) => (
            <Button
              key={section}
              type="button"
              variant="outline"
              size="sm"
              aria-label={`Jump to ${section.toLowerCase()}`}
              onClick={() => jumpTo(section)}
            >
              {section}
            </Button>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto px-5 py-5">
          <fieldset disabled={!canEdit} className="min-w-0 space-y-8">
            <section className="space-y-5" aria-labelledby={sectionId("Setup")}>
              {sectionHeading(
                "Setup",
                "Choose the listing method, product type, and exact selling-unit identifier.",
              )}
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
                        method: event.target
                          .value as ListingDraftItem["method"],
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
                error={
                  taxonomy.error ? errorMessage(taxonomy.error) : undefined
                }
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
              <p className="text-xs text-muted-foreground">
                {draft.method === "match"
                  ? "Catalog matching selected"
                  : draft.productType
                    ? "Product type selected"
                    : "Product type still needed"}{" "}
                ·{" "}
                {draft.identifier?.value.trim()
                  ? "Identifier entered"
                  : "Identifier still needed"}
                . Review validates these details before publication.
              </p>
            </section>
            <section
              className="space-y-3 border-t pt-6"
              aria-labelledby={sectionId("Required details")}
            >
              {sectionHeading(
                "Required details",
                "Complete the required and conditional fields for this product type.",
              )}
              {requirements.isFetching && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading Walmart requirements…
                </p>
              )}
              {requirements.error && (
                <div className="space-y-2">
                  <p role="alert" className="text-sm text-destructive">
                    {errorMessage(requirements.error)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={requirements.isFetching}
                    onClick={() => void requirements.refetch()}
                  >
                    Retry required details
                  </Button>
                </div>
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
                    Walmart schema {requirements.data.version}. Publication
                    review checks all conditional requirements.
                  </p>
                </>
              )}
            </section>
            {draft.method === "create" && (
              <section
                className="space-y-5 border-t pt-6"
                aria-labelledby={sectionId("Content")}
              >
                {sectionHeading(
                  "Content",
                  "Catalog values are shown below. Custom values apply only to this listing.",
                )}
                {!catalog && (
                  <p className="text-sm text-muted-foreground">
                    Catalog details are unavailable for this variant. Existing
                    custom content is preserved.
                  </p>
                )}
                <InheritedContentField
                  id={`${prefix}-title`}
                  label="Walmart title"
                  resetLabel="Use catalog title"
                  value={draft.title}
                  catalogValue={catalog?.title}
                  maxLength={500}
                  disabled={!canEdit}
                  onChange={(value) =>
                    setDraft((previous) => ({ ...previous, title: value }))
                  }
                />
                <InheritedContentField
                  id={`${prefix}-description`}
                  label="Description"
                  resetLabel="Use catalog description"
                  value={draft.description}
                  catalogValue={
                    catalog ? (catalog.description ?? "") : undefined
                  }
                  rows={4}
                  maxLength={30_000}
                  disabled={!canEdit}
                  onChange={(value) =>
                    setDraft((previous) => ({
                      ...previous,
                      description: value,
                    }))
                  }
                />
                <InheritedContentField
                  id={`${prefix}-brand`}
                  label="Brand"
                  resetLabel="Use catalog brand"
                  value={draft.brand}
                  catalogValue={catalog ? (catalog.brand ?? "") : undefined}
                  maxLength={200}
                  disabled={!canEdit}
                  onChange={(value) =>
                    setDraft((previous) => ({ ...previous, brand: value }))
                  }
                />
                <InheritedContentField
                  id={`${prefix}-images`}
                  label="Image URLs"
                  resetLabel="Use catalog images"
                  value={images}
                  catalogValue={catalog?.images.join("\n")}
                  rows={3}
                  disabled={!canEdit}
                  onChange={setImages}
                  help="One URL per line, up to 20. Clearing this field uses the catalog images when you update the draft."
                />
              </section>
            )}
            <section
              className="space-y-3 border-t pt-6"
              aria-labelledby={sectionId("Pricing")}
            >
              {sectionHeading(
                "Pricing",
                "Inherit the channel pricing rules or set a price for this item.",
              )}
              <div className="space-y-1.5">
                <Label htmlFor={`${prefix}-price`}>
                  Fixed Walmart price (USD)
                </Label>
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
            </section>
            <section
              className="space-y-3 border-t pt-6"
              aria-labelledby={sectionId("Advanced")}
            >
              {sectionHeading(
                "Advanced",
                "Edit provider attributes as JSON when needed.",
              )}
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
                          listingProviderFieldsSchema.parse(
                            JSON.parse(advanced),
                          ),
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
            </section>
          </fieldset>
        </div>
        <div className="shrink-0 space-y-3 border-t bg-background p-4">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
