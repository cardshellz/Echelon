import { useCallback, useEffect, useId, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, Package, Plus, Search } from "lucide-react";
import type {
  OrderEditCatalogProduct,
  OrderEditCatalogVariant,
} from "@shared/order-edits/order-edit-catalog";
import type { MemberPlanPresentation } from "@shared/membership/member-plan-presentation";
import { MemberProductPrice } from "@/components/MemberProductPrice";
import { orderEditCatalogSelectionNotice } from "@/lib/order-edit-catalog-selection";
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
  beforeOpen?: () => Promise<boolean>;
  includedVariantIds: ReadonlySet<string>;
  onAdd(
    variant: OrderEditCatalogVariant,
    plan: MemberPlanPresentation | null,
  ): void;
};
type CatalogBrowserProps = PickerProps & {
  onSelectionNotice(message: string): void;
};

export function OrderEditProductPicker(props: PickerProps) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  async function changeOpen(value: boolean) {
    if (opening) return;
    setNotice(null);
    if (!value || !props.beforeOpen) {
      setOpen(value);
      return;
    }
    setOpening(true);
    try {
      if (await props.beforeOpen()) setOpen(true);
    } finally {
      setOpening(false);
    }
  }
  return (
    <Dialog
      open={open && props.enabled}
      onOpenChange={(value) => {
        void changeOpen(value);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={!props.enabled || opening}
          className="gap-2"
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add products
        </Button>
      </DialogTrigger>
      {open && props.enabled && (
        <DialogContent className="oe-picker">
          <DialogHeader className="oe-picker-heading">
            <DialogTitle>Add products</DialogTitle>
            <DialogDescription>
              Find a product, then choose a pack size.
            </DialogDescription>
          </DialogHeader>
          {notice && (
            <p
              role="alert"
              className="shrink-0 rounded-md border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900"
            >
              {notice}
            </p>
          )}
          <CatalogBrowser {...props} onSelectionNotice={setNotice} />
          <div className="oe-picker-footer">
            <p className="text-xs text-muted-foreground">
              Prices shown for your account. Final totals are verified when you
              apply changes.
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

function CatalogBrowser(props: CatalogBrowserProps) {
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
      <div className="oe-picker-search">
        <div className="oe-picker-filters">
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
      </div>
      <div
        className="oe-picker-results"
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
  props: CatalogBrowserProps & {
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
        className="oe-product-toggle"
        aria-expanded={props.expanded}
        aria-controls={`${id}-options`}
        onClick={props.onToggle}
      >
        <div className="oe-product-image">
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
            {props.product.category ?? "Other products"}
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
  props: CatalogBrowserProps & {
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
    <div className="oe-variant-options" aria-busy={variants.isFetching}>
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
          <div key={variant.variantId} className="oe-variant-row">
            <div className="oe-variant-label">
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
              showSavings
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={
                included ? `${label} already in order` : `Add ${label}`
              }
              disabled={!props.enabled || included || !variant.available}
              onClick={() => {
                const notice = orderEditCatalogSelectionNotice(
                  variant.selectionFlow ?? "order_edit",
                );
                if (notice) {
                  props.onSelectionNotice(notice);
                  return;
                }
                props.onAdd(variant, plan);
              }}
            >
              {included ? (
                "In order"
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
