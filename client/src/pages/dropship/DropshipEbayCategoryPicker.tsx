import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EbayCategory, EbayCategoryOption } from "@shared/dropship/ebay-category-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  browseEbayCategories,
  categoryFromOption,
  categoryPathLabel,
  EBAY_CATEGORIES_PERMISSION_REQUIRED,
  isSearchableEbayCategoryQuery,
  searchEbayCategories,
} from "@/lib/dropship-ebay-category-rules";
import { queryErrorCode, queryErrorMessage } from "@/lib/dropship-ops-surface";

/** The server refreshes eBay's tree once a day, so answers can be reused for the whole visit. */
const EBAY_CATEGORY_ANSWER_STALE_MS = 60 * 60 * 1000;
/** Search waits for a pause in typing, so each keystroke does not spend the vendor's request budget. */
const EBAY_CATEGORY_SEARCH_DEBOUNCE_MS = 300;

/** Renders the reconnect control for an error that says the eBay connection needs a refresh. */
export type RenderEbayAuthorizationRecovery = (error: unknown) => ReactNode;

type PickerMode = "search" | "browse";

/**
 * Picks one eBay category from eBay's own US category list, by search or by
 * browsing the tree. Only final-level categories can be picked, because eBay
 * refuses listings anywhere else; the server checks the same again on save.
 */
export function DropshipEbayCategoryPicker({
  storeConnectionId,
  label,
  initialQuery = "",
  onPick,
  onCancel,
  renderAuthorizationRecovery,
}: {
  storeConnectionId: number;
  label: string;
  initialQuery?: string;
  onPick: (category: EbayCategory) => void;
  onCancel: () => void;
  renderAuthorizationRecovery?: RenderEbayAuthorizationRecovery;
}) {
  const [mode, setMode] = useState<PickerMode>("search");
  const [search, setSearch] = useState(initialQuery);
  const [queryText, setQueryText] = useState(initialQuery.trim());
  const [trail, setTrail] = useState<EbayCategoryOption[]>([]);
  useEffect(() => {
    const timer = setTimeout(() => setQueryText(search.trim()), EBAY_CATEGORY_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const searchable = isSearchableEbayCategoryQuery(queryText);
  const searchQuery = useQuery({
    queryKey: ["dropship-ebay-categories", storeConnectionId, "search", queryText],
    enabled: mode === "search" && searchable,
    retry: false,
    staleTime: EBAY_CATEGORY_ANSWER_STALE_MS,
    queryFn: ({ signal }) => searchEbayCategories(storeConnectionId, queryText, signal),
  });
  const parentId = trail.length > 0 ? trail[trail.length - 1].categoryId : null;
  const browseQuery = useQuery({
    queryKey: ["dropship-ebay-categories", storeConnectionId, "browse", parentId],
    enabled: mode === "browse",
    retry: false,
    staleTime: EBAY_CATEGORY_ANSWER_STALE_MS,
    queryFn: ({ signal }) => browseEbayCategories(storeConnectionId, parentId, signal),
  });

  function pick(option: EbayCategoryOption) {
    if (option.leaf) onPick(categoryFromOption(option));
  }
  function open(option: EbayCategoryOption) {
    // A search result carries its path as names only, so browsing starts at that category itself.
    setTrail((current) => (mode === "browse" ? [...current, option] : [option]));
    setMode("browse");
  }

  return (
    <EbayCategoryPickerView
      label={label}
      mode={mode}
      onModeChange={setMode}
      onCancel={onCancel}
      search={search}
      onSearchChange={setSearch}
      searchStatus={mode !== "search" ? "idle" : !searchable ? "too_short"
        : searchQuery.isLoading ? "loading" : searchQuery.error ? "error" : "ready"}
      searchError={searchQuery.error}
      searchResults={searchQuery.data ?? []}
      searchedText={queryText}
      onRetrySearch={() => void searchQuery.refetch()}
      trail={trail}
      onTrailChange={setTrail}
      browseStatus={mode !== "browse" ? "idle" : browseQuery.isLoading ? "loading" : browseQuery.error ? "error" : "ready"}
      browseError={browseQuery.error}
      browseParent={browseQuery.data?.parent ?? null}
      browseChildren={browseQuery.data?.children ?? []}
      onRetryBrowse={() => void browseQuery.refetch()}
      onPick={pick}
      onOpen={open}
      renderAuthorizationRecovery={renderAuthorizationRecovery}
    />
  );
}

type RequestStatus = "idle" | "too_short" | "loading" | "error" | "ready";

/** Presentational half of the picker; it holds no state, so every state can be rendered in tests. */
export function EbayCategoryPickerView(props: {
  label: string;
  mode: PickerMode;
  onModeChange: (mode: PickerMode) => void;
  onCancel: () => void;
  search: string;
  onSearchChange: (value: string) => void;
  searchStatus: RequestStatus;
  searchError: unknown;
  searchResults: EbayCategoryOption[];
  searchedText: string;
  onRetrySearch: () => void;
  trail: EbayCategoryOption[];
  onTrailChange: (trail: EbayCategoryOption[]) => void;
  browseStatus: RequestStatus;
  browseError: unknown;
  browseParent: EbayCategoryOption | null;
  browseChildren: EbayCategoryOption[];
  onRetryBrowse: () => void;
  onPick: (option: EbayCategoryOption) => void;
  onOpen: (option: EbayCategoryOption) => void;
  renderAuthorizationRecovery?: RenderEbayAuthorizationRecovery;
}) {
  return (
    <div className="space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3" role="group" aria-label={props.label}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{props.label}</p>
        <Button type="button" size="sm" variant="ghost" onClick={props.onCancel}>Cancel</Button>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="How to find a category">
        <Button type="button" size="sm" role="tab" aria-selected={props.mode === "search"}
          variant={props.mode === "search" ? "default" : "outline"} onClick={() => props.onModeChange("search")}>
          Search eBay categories
        </Button>
        <Button type="button" size="sm" role="tab" aria-selected={props.mode === "browse"}
          variant={props.mode === "browse" ? "default" : "outline"} onClick={() => props.onModeChange("browse")}>
          Browse all categories
        </Button>
      </div>
      {props.mode === "search" ? (
        <div className="space-y-2">
          <Input aria-label="Search eBay categories" value={props.search} maxLength={100}
            placeholder="For example: card sleeves" onChange={(event) => props.onSearchChange(event.target.value)} />
          <p className="text-xs text-zinc-500">Suggestions come from eBay's own category list, the same list eBay uses when you list an item.</p>
          <SearchResults {...props} />
        </div>
      ) : (
        <div className="space-y-2">
          <nav aria-label="eBay category path" className="flex flex-wrap items-center gap-1 text-xs">
            <Button type="button" size="sm" variant="link" className="h-auto p-0" onClick={() => props.onTrailChange([])}>All categories</Button>
            {props.trail.map((option, index) => (
              <span key={option.categoryId} className="flex items-center gap-1">
                <span aria-hidden="true">›</span>
                <Button type="button" size="sm" variant="link" className="h-auto p-0"
                  onClick={() => props.onTrailChange(props.trail.slice(0, index + 1))}>{option.categoryName}</Button>
              </span>
            ))}
          </nav>
          <BrowseResults {...props} />
        </div>
      )}
    </div>
  );
}

function SearchResults(props: Parameters<typeof EbayCategoryPickerView>[0]) {
  if (props.searchStatus === "too_short") {
    return props.search.trim() ? <p className="text-xs text-zinc-500">Type at least 2 characters to search.</p> : null;
  }
  if (props.searchStatus === "loading") return <p className="text-xs" role="status">Searching eBay categories…</p>;
  if (props.searchStatus === "error") {
    return <PickerError error={props.searchError} onRetry={props.onRetrySearch} render={props.renderAuthorizationRecovery} />;
  }
  if (props.searchStatus !== "ready") return null;
  if (props.searchResults.length === 0) {
    return <p className="text-xs text-zinc-500">eBay has no suggestions for "{props.searchedText}". Try other words, or browse all categories.</p>;
  }
  return <OptionList options={props.searchResults} onPick={props.onPick} onOpen={props.onOpen} />;
}

function BrowseResults(props: Parameters<typeof EbayCategoryPickerView>[0]) {
  if (props.browseStatus === "loading") return <p className="text-xs" role="status">Loading eBay categories…</p>;
  if (props.browseStatus === "error") {
    return <PickerError error={props.browseError} onRetry={props.onRetryBrowse} render={props.renderAuthorizationRecovery} />;
  }
  if (props.browseStatus !== "ready") return null;
  return (
    <div className="space-y-2">
      {props.browseParent && <p className="text-xs text-zinc-600">{categoryPathLabel(props.browseParent)}</p>}
      {props.browseParent?.leaf && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-emerald-200 bg-white p-2 text-sm">
          <span>This is a final eBay category.</span>
          <Button type="button" size="sm" onClick={() => props.onPick(props.browseParent!)}>Use this category</Button>
        </div>
      )}
      {props.browseChildren.length > 0 && <OptionList options={props.browseChildren} onPick={props.onPick} onOpen={props.onOpen} />}
    </div>
  );
}

function OptionList({ options, onPick, onOpen }: {
  options: EbayCategoryOption[];
  onPick: (option: EbayCategoryOption) => void;
  onOpen: (option: EbayCategoryOption) => void;
}) {
  return (
    <ul className="max-h-72 divide-y overflow-y-auto overscroll-contain rounded border bg-white" aria-label="eBay categories">
      {options.map((option) => (
        <li key={option.categoryId} className="flex flex-wrap items-center justify-between gap-2 p-2">
          <div className="min-w-0">
            <p className="text-sm font-medium">{option.categoryName}</p>
            <p className="text-xs text-zinc-500">{categoryPathLabel(option)} · #{option.categoryId}</p>
          </div>
          {option.leaf ? (
            <Button type="button" size="sm" onClick={() => onPick(option)}>Use this category</Button>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => onOpen(option)}>Open</Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function PickerError({ error, onRetry, render }: { error: unknown; onRetry: () => void; render?: RenderEbayAuthorizationRecovery }) {
  if (queryErrorCode(error) === EBAY_CATEGORIES_PERMISSION_REQUIRED) {
    return (
      <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-medium">Your eBay connection needs a refresh.</p>
        <p className="mt-1">eBay categories load through your own eBay connection. Refresh it, then search again.</p>
        {render?.(error)}
      </div>
    );
  }
  return (
    <div role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p>{queryErrorMessage(error, "eBay categories could not be loaded.")}</p>
      <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onRetry}>Try again</Button>
    </div>
  );
}
