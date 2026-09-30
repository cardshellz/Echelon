import { Fragment, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Folder, Loader2, Search } from "lucide-react";
import type { ListingTaxonomy } from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import {
  buildProductTypeIndex,
  searchProductTypes,
  type ProductTypeBranch,
  type ProductTypeLeaf,
} from "./product-type-model";

const EMPTY_TAXONOMY: ListingTaxonomy = { productTypes: [], entries: [] };
const DISPLAY_INCREMENT = 50;

interface Props {
  label: string;
  value: string;
  taxonomy?: ListingTaxonomy;
  loading: boolean;
  error?: string;
  disabled: boolean;
  onRetry(): void;
  onSelect(productType: string): void;
}

export function ListingProductTypePicker({
  label,
  value,
  taxonomy,
  loading,
  error,
  disabled,
  onRetry,
  onSelect,
}: Props) {
  const prefix = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const browserHeading = useRef<HTMLHeadingElement>(null);
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(DISPLAY_INCREMENT);
  const index = useMemo(
    () => buildProductTypeIndex(taxonomy ?? EMPTY_TAXONOMY),
    [taxonomy],
  );
  const selectedPaths = index.byType.get(value) ?? [];
  const branch = index.branches.get(JSON.stringify(path)) ?? index.root;
  const searching = query.trim().length > 0;
  const results = useMemo(
    () => searchProductTypes(index, query),
    [index, query],
  );
  const choices: Array<ProductTypeBranch | ProductTypeLeaf> = searching
    ? [...results]
    : [...branch.children, ...branch.leaves];
  const visible = choices.slice(0, limit);
  const blocked = disabled || loading || Boolean(error);
  const toggleLabel = open
    ? "Close product type browser"
    : value
      ? "Change product type"
      : "Browse product types";

  function browse(next: readonly string[]) {
    setPath(next);
    setQuery("");
    setLimit(DISPLAY_INCREMENT);
    browserHeading.current?.focus();
  }
  function choose(leaf: ProductTypeLeaf) {
    if (blocked) return;
    onSelect(leaf.productType);
    setOpen(false);
    setQuery("");
    setLimit(DISPLAY_INCREMENT);
    toggle.current?.focus();
  }
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={`${prefix}-toggle`}>{label}</Label>
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="min-w-0 rounded-md border"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 p-3">
          <div className="min-w-0 flex-1 basis-48">
            <p className="break-words text-sm font-medium">
              {value || "No product type selected"}
            </p>
            {selectedPaths.length > 0 && (
              <div className="mt-1 space-y-1">
                {selectedPaths.slice(0, 3).map(
                  (leaf) =>
                    leaf.path.length > 0 && (
                      <p
                        key={leaf.key}
                        className="break-words text-xs text-muted-foreground"
                      >
                        {leaf.path.join(" › ")}
                      </p>
                    ),
                )}
                {selectedPaths.length > 3 && (
                  <p className="text-xs text-muted-foreground">
                    Also appears in {selectedPaths.length - 3} other categories.
                  </p>
                )}
              </div>
            )}
            {value &&
              taxonomy &&
              !loading &&
              !error &&
              selectedPaths.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  The saved type is not in the current taxonomy. It is preserved
                  until you choose another type.
                </p>
              )}
          </div>
          <Button
            ref={toggle}
            id={`${prefix}-toggle`}
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={toggleLabel}
            aria-expanded={open}
            aria-controls={`${prefix}-browser`}
            onClick={() => {
              if (!open) {
                setPath(selectedPaths[0]?.path ?? []);
                setQuery("");
                setLimit(DISPLAY_INCREMENT);
              }
              setOpen(!open);
            }}
          >
            {toggleLabel}
          </Button>
        </div>
        {loading && (
          <p
            role="status"
            className="flex items-center gap-2 px-3 pb-3 text-sm text-muted-foreground"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading product types…
          </p>
        )}
        {error && (
          <div className="space-y-2 px-3 pb-3">
            <p role="alert" className="break-words text-sm text-destructive">
              Unable to load product types: {error}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || loading}
              onClick={onRetry}
            >
              Retry product types
            </Button>
          </div>
        )}
        {!loading && !error && taxonomy && index.leaves.length === 0 && (
          <p className="px-3 pb-3 text-sm text-muted-foreground">
            No product types are available.
          </p>
        )}
        <CollapsibleContent
          id={`${prefix}-browser`}
          className="min-w-0 space-y-3 border-t p-3"
        >
          <h4
            ref={browserHeading}
            tabIndex={-1}
            className="text-sm font-medium outline-none"
          >
            Choose a category or product type
          </h4>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-3 top-3 h-4 w-4 text-muted-foreground"
            />
            <Input
              className="pl-9"
              aria-label="Search product types or categories"
              placeholder="Search product types or categories"
              maxLength={200}
              value={query}
              disabled={disabled}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(DISPLAY_INCREMENT);
              }}
            />
          </div>
          {searching ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={() => browse(path)}
            >
              Clear product type search
            </Button>
          ) : (
            <Breadcrumb aria-label="Product type categories">
              <BreadcrumbList>
                <BreadcrumbItem>
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    className="h-auto min-h-0 whitespace-normal p-0 text-left"
                    disabled={disabled}
                    aria-current={
                      branch.path.length === 0 ? "location" : undefined
                    }
                    onClick={() => browse([])}
                  >
                    All categories
                  </Button>
                </BreadcrumbItem>
                {branch.path.map((name, depth) => (
                  <Fragment
                    key={JSON.stringify(branch.path.slice(0, depth + 1))}
                  >
                    <BreadcrumbSeparator />
                    <BreadcrumbItem className="min-w-0">
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="h-auto min-h-0 whitespace-normal break-words p-0 text-left"
                        disabled={disabled}
                        aria-current={
                          depth === branch.path.length - 1
                            ? "location"
                            : undefined
                        }
                        onClick={() => browse(branch.path.slice(0, depth + 1))}
                      >
                        {name}
                      </Button>
                    </BreadcrumbItem>
                  </Fragment>
                ))}
              </BreadcrumbList>
            </Breadcrumb>
          )}
          {!loading && !error && taxonomy && choices.length > 0 && (
            <>
              <p role="status" className="text-xs text-muted-foreground">
                Showing {visible.length} of {choices.length}{" "}
                {searching ? "results" : "choices"}
              </p>
              <ul
                className="max-h-72 space-y-2 overflow-y-auto"
                aria-label={
                  searching
                    ? "Product type search results"
                    : "Product type choices"
                }
              >
                {visible.map((choice, choiceIndex) => (
                  <li key={choice.key}>
                    {"productType" in choice ? (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={blocked}
                        className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                        aria-label={`Select ${choice.productType}`}
                        aria-describedby={`${prefix}-choice-${choiceIndex}`}
                        aria-pressed={value === choice.productType}
                        onClick={() => choose(choice)}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-medium">
                            {choice.productType}
                          </p>
                          <p
                            id={`${prefix}-choice-${choiceIndex}`}
                            className="mt-1 break-words text-xs font-normal text-muted-foreground"
                          >
                            {choice.path.length
                              ? choice.path.join(" › ")
                              : "Product type"}
                          </p>
                          {choice.description && (
                            <p className="mt-1 line-clamp-2 break-words text-xs font-normal text-muted-foreground">
                              {choice.description}
                            </p>
                          )}
                        </div>
                        {value === choice.productType && (
                          <Check
                            aria-label="Selected"
                            className="h-4 w-4 shrink-0"
                          />
                        )}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={disabled}
                        className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                        aria-label={`Browse ${choice.label}`}
                        onClick={() => browse(choice.path)}
                      >
                        <Folder
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block break-words">
                            {choice.label}
                          </span>
                          <span className="mt-1 block text-xs font-normal text-muted-foreground">
                            {choice.productTypeCount} product{" "}
                            {choice.productTypeCount === 1 ? "type" : "types"}
                          </span>
                        </span>
                        <ChevronRight
                          aria-hidden="true"
                          className="h-4 w-4 shrink-0"
                        />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
              {visible.length < choices.length && (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  disabled={disabled}
                  onClick={() =>
                    setLimit((current) => current + DISPLAY_INCREMENT)
                  }
                >
                  Show more product types
                </Button>
              )}
            </>
          )}
          {!loading &&
            !error &&
            taxonomy &&
            choices.length === 0 &&
            index.leaves.length > 0 && (
              <p className="text-sm text-muted-foreground">
                {searching
                  ? "No product types match this search."
                  : "No product types are available in this category."}
              </p>
            )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
