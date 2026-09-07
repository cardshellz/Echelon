import { useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ImageOff, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ebayListingPolicyQueryKey } from "@/lib/dropship-ebay-listing-query-sync";
import { formatCents, formatStatus, type DropshipEbayListingPolicyOverrideResponse,
  type DropshipListingPreviewResult, type DropshipListingPreviewRow } from "@/lib/dropship-ops-surface";
import { formatListingPreviewIssue, listingPreviewStatusTone, pageListingPreviews, safeListingImageUrl } from "@/lib/dropship-listing-preview";
import { DropshipListingShippingEstimate } from "./DropshipListingShippingEstimate";
import { DropshipListingPriceEditor } from "./DropshipListingPriceEditor";

type PolicyOptions = DropshipEbayListingPolicyOverrideResponse["options"];

const PRODUCT_COST_SOURCE_LABELS = {
  variant_fixed_price: "your Shellz Club .ops price list (fixed product price)",
  variant_percent: "your Shellz Club .ops price list (product-specific discount)",
  plan_percent: "your Shellz Club .ops price list (plan discount)",
  retail: "catalog retail (.ops discount excluded or not applicable)",
} as const;

export interface ListingPriceSaveCallbacks {
  disabled?: boolean;
  onSaveStarted: () => void;
  onSaveSettled: () => void;
  onSaved: () => Promise<void>;
}

export function DropshipListingPreview({ preview, priceSaveCallbacks, stale = false }: {
  preview: DropshipListingPreviewResult;
  priceSaveCallbacks?: ListingPriceSaveCallbacks;
  stale?: boolean;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [openVariantId, setOpenVariantId] = useState<number | null>(null);
  const [inlineVariantId, setInlineVariantId] = useState<number | null>(null);
  const current = pageListingPreviews(preview.rows, search, page);
  const activeRow = preview.rows.find((row) => row.productVariantId === openVariantId);
  const inlineRow = current.rows.find((row) => row.productVariantId === inlineVariantId);
  const inlineEditing = Boolean(inlineRow && priceSaveCallbacks);
  useEffect(() => {
    if (inlineVariantId !== null && !preview.rows.some((row) => row.productVariantId === inlineVariantId)) {
      setInlineVariantId(null);
    }
  }, [inlineVariantId, preview.rows]);
  // Names only enrich exact IDs from the preview; cached assignments never change its authority.
  const policyOptions = queryClient.getQueryData<DropshipEbayListingPolicyOverrideResponse>(
    ebayListingPolicyQueryKey(preview.storeConnectionId))?.options;
  return <div className="mt-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-zinc-500">Product costs are for one sellable pack. Edit the listing price here, or open a preview for details, images, and shipping estimates.</p>
      {preview.rows.length > 1 && <div className="relative w-full sm:w-72">
        <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-zinc-400" />
        <Input aria-label="Search listing previews" placeholder="Search listing, variant, or SKU" className="pl-9" value={search} disabled={inlineEditing}
          onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
      </div>}
    </div>
    <div className="max-h-[28rem] overflow-auto rounded-md border border-zinc-200">
      <ListingPreviewTable rows={current.rows} onOpen={setOpenVariantId}
        priceEditing={priceSaveCallbacks ? {
          variantId: inlineRow?.productVariantId ?? null,
          disabled: inlineEditing || Boolean(activeRow) || Boolean(priceSaveCallbacks.disabled),
          onEdit: setInlineVariantId,
          editor: inlineRow && <DropshipListingPriceEditor compact
            storeConnectionId={preview.storeConnectionId} productVariantId={inlineRow.productVariantId}
            onCancel={() => setInlineVariantId(null)} {...priceSaveCallbacks} />,
        } : undefined} />
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
      <span>{current.start}–{current.end} of {current.total} previews · Page {current.page} of {current.pages}</span>
      {inlineEditing && <span>Finish or cancel the price edit before changing rows or pages.</span>}
      {current.pages > 1 && <nav aria-label="Listing preview pages" className="flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled={inlineEditing || current.page === 1} onClick={() => setPage(current.page - 1)}>Previous</Button>
        <Button type="button" variant="outline" size="sm" disabled={inlineEditing || current.page === current.pages} onClick={() => setPage(current.page + 1)}>Next</Button>
      </nav>}
    </div>
    <Sheet open={Boolean(activeRow)} onOpenChange={(open) => { if (!open) setOpenVariantId(null); }}>
      {activeRow && <SheetContent className="w-full overflow-y-auto overscroll-contain p-5 sm:max-w-3xl sm:p-6">
        <SheetHeader className="mb-6 pr-6">
          <SheetTitle>Listing preview</SheetTitle>
          <SheetDescription>Review what will be sent and your Card Shellz costs. This does not publish a listing.</SheetDescription>
        </SheetHeader>
        {stale && <div role="status" className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          This preview needs refreshing. Queueing is disabled until a fresh preview is generated.
        </div>}
        <ListingPreviewDetailsContent row={activeRow} generatedAt={preview.generatedAt} policyOptions={policyOptions}
          priceEditor={priceSaveCallbacks && <DropshipListingPriceEditor
            storeConnectionId={preview.storeConnectionId} productVariantId={activeRow.productVariantId}
            {...priceSaveCallbacks} />}
          shippingEstimate={<DropshipListingShippingEstimate key={`${preview.storeConnectionId}:${activeRow.productVariantId}:${preview.generatedAt}`}
            storeConnectionId={preview.storeConnectionId} productVariantId={activeRow.productVariantId}
            variantName={activeRow.presentation?.variantName ?? activeRow.sku ?? "sellable pack"} />} />
      </SheetContent>}
    </Sheet>
  </div>;
}

export function ListingPreviewTable({ rows, onOpen, priceEditing }: {
  rows: readonly DropshipListingPreviewRow[]; onOpen: (variantId: number) => void;
  priceEditing?: { variantId: number | null; disabled: boolean; onEdit: (variantId: number) => void; editor: ReactNode };
}) {
  return <Table>
    <TableHeader className="sticky top-0 z-10 bg-white"><TableRow>
      <TableHead>Listing</TableHead><TableHead>Your product cost</TableHead><TableHead>Listing price</TableHead>
      <TableHead>Available</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Action</TableHead>
    </TableRow></TableHeader>
    <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={6} className="py-8 text-center text-zinc-500">No matching previews.</TableCell></TableRow>
      : rows.map((row) => {
        const image = row.presentation?.images.find((item) => item.publicationStatus === "included" && safeListingImageUrl(item.url));
        return <TableRow key={row.productVariantId}>
          <TableCell><div className="flex min-w-52 items-center gap-3">
            <PreviewImage key={image?.url ?? "missing"} url={image?.url} alt={image?.altText ?? row.title} className="h-12 w-12 shrink-0 rounded border object-contain" />
            <div><div className="line-clamp-2 font-medium">{row.presentation?.title ?? row.title}</div>
              <div className="text-xs text-zinc-500">{row.presentation?.variantName}{row.presentation?.variantName && " · "}{row.sku || `Variant ${row.productVariantId}`}</div>
            </div>
          </div></TableCell>
          <TableCell className="whitespace-nowrap">{moneyOrUnavailable(row.economics?.vendorProductCostCents)}</TableCell>
          <TableCell className="whitespace-nowrap">{priceEditing?.variantId === row.productVariantId
            ? priceEditing.editor
            : <div className="flex items-center gap-2"><span>{moneyOrUnavailable(row.priceCents)}</span>
              {priceEditing && <Button type="button" size="sm" variant="ghost" className="h-8 px-2"
                aria-label={`Edit listing price for ${row.sku || row.title}`} disabled={priceEditing.disabled}
                onClick={() => priceEditing.onEdit(row.productVariantId)}>Edit price</Button>}
            </div>}</TableCell>
          <TableCell className="font-mono">{row.marketplaceQuantity}</TableCell>
          <TableCell><PreviewStatus row={row} /></TableCell>
          <TableCell className="text-right"><Button type="button" size="sm" variant="outline"
            aria-label={`View preview for ${row.title}`} disabled={priceEditing?.disabled}
            onClick={() => onOpen(row.productVariantId)}>View preview</Button></TableCell>
        </TableRow>;
      })}</TableBody>
  </Table>;
}

export function ListingPreviewDetailsContent({ row, generatedAt, shippingEstimate, policyOptions, priceEditor }: {
  row: DropshipListingPreviewRow; generatedAt: string; shippingEstimate?: ReactNode; policyOptions?: PolicyOptions; priceEditor?: ReactNode;
}) {
  const content = row.presentation;
  const economics = row.economics;
  return <div className="space-y-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-xl font-semibold">{content?.title ?? row.title}</h3>
        <p className="mt-1 text-sm text-zinc-500">{content?.variantName}{content?.variantName && " · "}{row.sku ?? "SKU unavailable"}</p>
        {content?.unitsPerVariant != null && <p className="mt-1 text-xs text-zinc-500">{content.unitsPerVariant} product unit(s) per sellable pack</p>}
      </div><PreviewStatus row={row} />
    </div>
    {!content && <Notice>Detailed content was not returned. Generate a new listing preview.</Notice>}
    {content?.source === "catalog_fallback" && <Notice>Catalog content only: resolve the listing blockers and generate a new preview to review the publishable content.</Notice>}
    <ListingImageGallery key={row.previewHash} images={content?.images ?? []} title={content?.title ?? row.title} />
    <section className="rounded-lg border border-violet-200 bg-violet-50/40 p-4" aria-label="Your product costs">
      <h4 className="font-semibold">Your product costs</h4>
      <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <MoneyDetail label="Your product cost" cents={economics?.vendorProductCostCents} />
        <MoneyDetail label={priceEditor ? "Preview listing price" : "Your listing price"} cents={row.priceCents} />
        <MoneyDetail label="Catalog reference retail" cents={economics?.referenceRetailPriceCents} />
      </div>
      <p className="mt-3 text-xs text-zinc-600">Per sellable pack, before Card Shellz shipping. Marketplace fees are not included.</p>
      {economics?.productCostSource && <p className="mt-1 text-xs text-zinc-600">Source: {PRODUCT_COST_SOURCE_LABELS[economics.productCostSource]}.</p>}
      <p className="mt-1 text-xs text-zinc-500">These are current reference costs, not a locked order quote. Catalog reference retail is not a suggested price.</p>
      <IssueList issues={economics?.issues ?? []} />
    </section>
    {priceEditor}
    {shippingEstimate}
    <section aria-label="Listing details"><h4 className="mb-3 font-semibold">Listing details</h4>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <Detail label="Listing mode" value={formatStatus(row.listingMode ?? row.platform)} />
        <Detail label="Available to list" value={`${row.marketplaceQuantity} sellable packs`} />
        <Detail label="Condition" value={content?.condition} /><Detail label="Brand" value={content?.brand} />
        <Detail label="Marketplace category" value={row.marketplaceCategoryName ?? row.marketplaceCategoryId} />
        <Detail label="Your Store categories" value={row.storeCategoryNames.join(" · ") || "Store default"} />
      </dl>
      {row.businessPolicySelection && <div className="mt-4 border-t pt-3"><h5 className="mb-2 text-sm font-medium">Effective listing policies</h5>
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          {([['fulfillmentPolicyId', 'Fulfillment', 'fulfillmentPolicies'], ['returnPolicyId', 'Returns', 'returnPolicies'], ['paymentPolicyId', 'Payment', 'paymentPolicies']] as const).map(([field, label, optionsKey]) => {
            const id = row.businessPolicySelection?.[field];
            const name = policyOptions?.[optionsKey].find((option) => option.id === id)?.name;
            return <div key={field}><dt className="text-xs text-zinc-500">{label}</dt><dd className="mt-1 break-words">{name ?? (id ? `Policy ${id}` : "Not configured")}</dd>
              <dd className="mt-1 text-xs text-zinc-500">{row.businessPolicySelection?.overriddenFields.includes(field) ? "Listing override" : "Store default"}</dd></div>;
          })}
        </dl>
      </div>}
    </section>
    <section aria-label="Listing description"><h4 className="mb-2 font-semibold">Description</h4>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-700">{content?.descriptionText || "No description available."}</p>
      <p className="mt-2 text-xs text-zinc-500">Text preview; marketplace formatting may differ.</p>
    </section>
    {Boolean(content?.itemSpecifics.length) && <section><h4 className="mb-2 font-semibold">Item specifics</h4><dl className="grid gap-3 text-sm sm:grid-cols-2">
      {content?.itemSpecifics.map((item) => <Detail key={item.name} label={item.name} value={item.values.join(", ")} />)}
    </dl></section>}
    <section><h4 className="mb-2 font-semibold">Readiness checks</h4>
      {row.blockers.length === 0 && row.warnings.length === 0 ? <p className="text-sm text-emerald-800">No listing blockers or warnings.</p>
        : <IssueList issues={[...row.blockers, ...row.warnings]} />}
      <IssueList issues={content?.issues ?? []} />
    </section>
    <p className="border-t pt-3 text-xs text-zinc-500">Preview generated {new Date(generatedAt).toLocaleString()}. Viewing this preview or estimating shipping does not queue listings.</p>
  </div>;
}

function ListingImageGallery({ images, title }: { images: NonNullable<DropshipListingPreviewRow["presentation"]>["images"]; title: string }) {
  const [index, setIndex] = useState(0);
  const image = images[index];
  return <section aria-label="Product images">
    <h4 className="mb-3 font-semibold">Product images <span className="text-xs font-normal text-zinc-500">{images.filter((item) => item.publicationStatus === "included").length} included in listing</span></h4>
    <div className="flex justify-center rounded-lg border bg-white p-3">
      <PreviewImage key={image?.url ?? index} url={image?.url} alt={image?.altText ?? title} className="h-56 w-full rounded object-contain sm:h-64" />
    </div>
    {image && <p className={`mt-2 text-xs ${image.publicationStatus === "included" ? "text-zinc-500" : "text-amber-800"}`}>
      {image.publicationStatus === "included" ? "Included in the listing payload." : "Catalog image only — not included in the listing payload."}
      {image.reason && ` ${formatListingPreviewIssue(image.reason)}`}
    </p>}
    {images.length > 1 && <div className="mt-3 flex max-h-28 gap-2 overflow-auto pb-2">
      {images.map((item, itemIndex) => <button type="button" key={`${item.assetId ?? "external"}:${itemIndex}`} aria-label={`View product image ${itemIndex + 1}`}
        aria-pressed={itemIndex === index} onClick={() => setIndex(itemIndex)}
        className={`shrink-0 rounded border-2 p-1 ${itemIndex === index ? "border-violet-500" : "border-transparent"}`}>
        <PreviewImage url={item.url} alt={item.altText ?? `Product image ${itemIndex + 1}`} className="h-14 w-14 rounded border object-contain" />
      </button>)}
    </div>}
  </section>;
}

function PreviewImage({ url, alt, className }: { url?: string | null; alt: string; className: string }) {
  const [failed, setFailed] = useState(false);
  const safeUrl = safeListingImageUrl(url);
  return !safeUrl || failed
    ? <div className={`flex items-center justify-center bg-zinc-50 text-zinc-400 ${className}`} role="img" aria-label={failed ? "Image could not be loaded" : "No image available"}><ImageOff aria-hidden="true" className="h-6 w-6" /></div>
    : <img src={safeUrl} alt={alt} className={className} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}
function PreviewStatus({ row }: { row: DropshipListingPreviewRow }) {
  return <Badge variant="outline" className={listingPreviewStatusTone(row.previewStatus)}>{formatStatus(row.previewStatus)}</Badge>;
}
function moneyOrUnavailable(cents: number | null | undefined): string {
  return cents != null && Number.isSafeInteger(cents) && cents >= 0 ? formatCents(cents) : "Unavailable";
}
function MoneyDetail({ label, cents }: { label: string; cents: number | null | undefined }) {
  return <div><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 text-lg font-semibold">{moneyOrUnavailable(cents)}</div></div>;
}
function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><dt className="text-xs text-zinc-500">{label}</dt><dd className="mt-1 break-words">{value || "Not provided"}</dd></div>;
}
function Notice({ children }: { children: ReactNode }) {
  return <p role="status" className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{children}</p>;
}
function IssueList({ issues }: { issues: readonly string[] }) {
  return issues.length ? <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-amber-900">{[...new Set(issues)].map((issue) => <li key={issue}>{formatListingPreviewIssue(issue)}</li>)}</ul> : null;
}
