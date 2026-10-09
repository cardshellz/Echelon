import { useCallback, useEffect, useId, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, Package, Plus, Search } from "lucide-react";
import type { OrderEditVariant } from "@shared/order-edits/order-edit.contract";
import type { OrderEditCatalogProduct } from "@shared/order-edits/order-edit-catalog";
import { MemberProductPrice } from "@/components/MemberProductPrice";
import { orderEditCatalogSearchSchema } from "@shared/order-edits/order-edit-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useDebounce } from "@/hooks/use-debounce";
import { ORDER_EDITS_API, type OrderEditTransport } from "@/lib/order-edits";

// Cache discovery briefly when returning to the picker. Financial review always re-reads Shopify.
const CATALOG_STALE_MS = 30_000;
const SEARCH_DEBOUNCE_MS = 250;
type PickerProps = {
  api: OrderEditTransport;
  connectionId: number;
  staffId: string;
  omsOrderId: number;
  expectedRevision: string;
  enabled: boolean;
  includedVariantIds: ReadonlySet<string>;
  onAdd(variant: OrderEditVariant): void;
};

export function OrderEditProductPicker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open && props.enabled} onOpenChange={setOpen}>
      <div className="space-y-2">
        <p className="text-sm font-medium">Add products</p>
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={!props.enabled}
            className="h-auto min-h-11 w-full justify-start gap-2 whitespace-normal py-3 text-left"
          >
            <Search className="h-4 w-4 shrink-0" aria-hidden="true" />
            Search or browse products
          </Button>
        </DialogTrigger>
        <p className="text-xs text-muted-foreground">
          Find a product by name or SKU, or browse categories and pack sizes.
        </p>
      </div>
      {open && props.enabled && (
        <DialogContent className="flex max-h-[90dvh] max-w-4xl flex-col overflow-hidden p-4 sm:p-6">
          <DialogHeader className="shrink-0 pr-6 text-left">
            <DialogTitle>Add products</DialogTitle>
            <DialogDescription>
              Choose a category, then a product and its pack, box or case SKU.
            </DialogDescription>
          </DialogHeader>
          <CatalogBrowser {...props} />
          <div className="flex shrink-0 items-center justify-between gap-3 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              Prices include this customer's applicable club pricing. Review
              changes verifies coupons, rewards, shipping and tax.
            </p>
            <DialogClose asChild>
              <Button type="button">Done</Button>
            </DialogClose>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}

function CatalogBrowser(props: PickerProps) {
  const id = useId();
  const [text, setText] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [unavailableProducts, setUnavailableProducts] = useState<
    ReadonlySet<string>
  >(new Set());
  const hideUnavailableProduct = useCallback((productId: string) => {
    setUnavailableProducts((current) => new Set([...current, productId]));
  }, []);
  const search = useDebounce(text.trim(), SEARCH_DEBOUNCE_MS);
  const currentSearch = search === text.trim();
  const validSearch = orderEditCatalogSearchSchema.safeParse(search).success;
  const queryKey = [
    ORDER_EDITS_API,
    props.staffId,
    "catalog",
    props.connectionId,
  ];
  const categories = useInfiniteQuery({
    queryKey: [...queryKey, "categories"],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      props.api.catalogCategories(
        props.connectionId,
        { after: pageParam },
        signal,
      ),
    getNextPageParam: (last) =>
      last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  const products = useInfiniteQuery({
    queryKey: [...queryKey, "products", category, search],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      props.api.catalogProducts(
        props.connectionId,
        { search, category, after: pageParam },
        signal,
      ),
    getNextPageParam: (last) =>
      last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined,
    enabled: currentSearch && validSearch,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  const categoryNames = [
    ...new Set(categories.data?.pages.flatMap((page) => page.categories) ?? []),
  ].sort((a, b) => a.localeCompare(b, "en"));
  const matches = [
    ...new Map(
      products.data?.pages
        .flatMap((page) => page.products)
        .map((product) => [product.productId, product]) ?? [],
    ).values(),
  ].filter((product) => !unavailableProducts.has(product.productId));
  return (
    <>
      <div className="shrink-0 space-y-2">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-search`}>Product name or SKU</Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id={`${id}-search`}
                autoFocus
                className="pl-9"
                maxLength={100}
                placeholder="e.g. toploader, binder, SHLZ-…"
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setExpanded(null);
                }}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-category`}>Category</Label>
            <select
              id={`${id}-category`}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={category ?? ""}
              onChange={(event) => {
                setCategory(event.target.value || null);
                setExpanded(null);
              }}
            >
              <option value="">All categories</option>
              {categoryNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        </div>
        {categories.isError && (
          <CatalogError
            error={categories.error}
            onRetry={() =>
              void (categories.isFetchNextPageError
                ? categories.fetchNextPage()
                : categories.refetch())
            }
            label="Retry categories"
          />
        )}
        {categories.hasNextPage && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={categories.isFetching}
            onClick={() => void categories.fetchNextPage()}
          >
            Load more categories
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          {category ?? "All categories"} <span aria-hidden="true">›</span>{" "}
          Products <span aria-hidden="true">›</span> Pack sizes and SKUs
        </p>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto rounded-md border"
        aria-label="Product results"
        aria-busy={!currentSearch || products.isFetching}
      >
        {!currentSearch || (validSearch && products.isPending) ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Searching products…
          </p>
        ) : !validSearch ? (
          <p className="p-4 text-sm">Enter a product name or SKU.</p>
        ) : (
          <>
            {products.isError && (
              <CatalogError
                error={products.error}
                onRetry={() =>
                  void (products.isFetchNextPageError
                    ? products.fetchNextPage()
                    : products.refetch())
                }
                label="Retry products"
              />
            )}
            {products.isSuccess && matches.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                No matching products. Try another name or SKU, or choose All
                categories.
              </p>
            )}
            {matches.map((product) => (
              <ProductOptions
                key={product.productId}
                {...props}
                product={product}
                expanded={expanded === product.productId}
                onUnavailable={hideUnavailableProduct}
                onToggle={() =>
                  setExpanded((current) =>
                    current === product.productId ? null : product.productId,
                  )
                }
              />
            ))}
            {products.hasNextPage && (
              <div className="p-3">
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={products.isFetching}
                  onClick={() => void products.fetchNextPage()}
                >
                  {products.isFetchingNextPage
                    ? "Loading products…"
                    : "Load more products"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

function ProductOptions(
  props: PickerProps & {
    product: OrderEditCatalogProduct;
    expanded: boolean;
    onToggle(): void;
    onUnavailable(productId: string): void;
  },
) {
  const id = useId();
  return (
    <section
      className="border-b last:border-b-0"
      aria-label={props.product.title}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        aria-expanded={props.expanded}
        aria-controls={`${id}-options`}
        onClick={props.onToggle}
      >
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded border bg-muted/20">
          {props.product.imageUrl ? (
            <img
              src={props.product.imageUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-full w-full rounded object-contain"
            />
          ) : (
            <Package
              className="h-5 w-5 text-muted-foreground"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">
            {props.product.title}
          </p>
          <p className="text-xs text-muted-foreground">
            {props.product.category ?? "Other products"} · Choose pack size /
            SKU
          </p>
        </div>
        <ChevronDown
          className={`h-4 w-4 shrink-0 ${props.expanded ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
      </button>
      <div id={`${id}-options`} hidden={!props.expanded}>
        {props.expanded && <VariantOptions {...props} />}
      </div>
    </section>
  );
}

function VariantOptions(
  props: PickerProps & {
    product: OrderEditCatalogProduct;
    onUnavailable(productId: string): void;
  },
) {
  const variants = useInfiniteQuery({
    queryKey: [
      ORDER_EDITS_API,
      props.staffId,
      "catalog",
      props.connectionId,
      props.omsOrderId,
      props.expectedRevision,
      "variants",
      props.product.productId,
    ],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      props.api.catalogVariants(
        props.connectionId,
        {
          productId: props.product.productId,
          after: pageParam,
          omsOrderId: props.omsOrderId,
          expectedRevision: props.expectedRevision,
        },
        signal,
      ),
    getNextPageParam: (last) =>
      last.pageInfo.hasNextPage ? last.pageInfo.endCursor : undefined,
    staleTime: CATALOG_STALE_MS,
    retry: false,
  });
  const options = [
    ...new Map(
      variants.data?.pages.flatMap((page) =>
        page.variants
          .filter((variant) => variant.available)
          .map(
            (variant) =>
              [
                variant.variantId,
                { variant, plan: page.memberPlan ?? null },
              ] as const,
          ),
      ) ?? [],
    ).values(),
  ];
  const noAvailableOptions =
    variants.isSuccess &&
    !variants.isFetching &&
    !variants.hasNextPage &&
    options.length === 0;
  useEffect(() => {
    if (noAvailableOptions) props.onUnavailable(props.product.productId);
  }, [noAvailableOptions, props.onUnavailable, props.product.productId]);
  return (
    <div
      className="space-y-2 border-t bg-muted/20 p-3 sm:pl-[4.5rem]"
      aria-busy={variants.isFetching}
    >
      {variants.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          Loading pack sizes…
        </p>
      )}
      {variants.isError && (
        <CatalogError
          error={variants.error}
          onRetry={() =>
            void (variants.isFetchNextPageError
              ? variants.fetchNextPage()
              : variants.refetch())
          }
          label="Retry pack sizes"
        />
      )}
      {variants.isSuccess && options.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No eligible pack sizes on this page.
        </p>
      )}
      {(variants.isError ? [] : options).map(({ variant, plan }) => {
        const included = props.includedVariantIds.has(variant.variantId);
        const label = [variant.variantTitle ?? "Standard option", variant.sku]
          .filter(Boolean)
          .join(" · ");
        return (
          <div
            key={variant.variantId}
            className="flex flex-wrap items-center gap-3 rounded-md border bg-background p-3"
          >
            <div className="min-w-0 basis-36 flex-1">
              <p className="break-words text-sm font-medium">
                {variant.variantTitle ?? "Standard option"}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {variant.sku ? `SKU: ${variant.sku}` : "SKU not assigned"}
              </p>
            </div>
            <MemberProductPrice
              priceCents={variant.priceCents}
              retailPriceCents={variant.retailPriceCents}
              plan={plan}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={
                included ? `${label} already in order` : `Add ${label}`
              }
              disabled={!props.enabled || included || !variant.available}
              onClick={() => props.onAdd(variant)}
            >
              {included ? (
                "Added / in order"
              ) : (
                <>
                  <Plus className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
                  Add
                </>
              )}
            </Button>
          </div>
        );
      })}
      {variants.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={variants.isFetching}
          onClick={() => void variants.fetchNextPage()}
        >
          {variants.isFetchingNextPage
            ? "Loading pack sizes…"
            : "Load more pack sizes"}
        </Button>
      )}
    </div>
  );
}

function CatalogError({
  error,
  onRetry,
  label,
}: {
  error: unknown;
  onRetry(): void;
  label: string;
}) {
  return (
    <div role="alert" className="space-y-2 p-3 text-sm">
      <p>
        {error instanceof Error
          ? error.message
          : "Products could not be loaded."}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        {label}
      </Button>
    </div>
  );
}
