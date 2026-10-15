import { useId } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import type { ListingSettingsReadState, ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  categoriesCardQueryOptions,
  categorySettingsCardState,
  type CategoryCardRow,
  type CategoryCardState,
} from "@/lib/dropship-listing-settings-categories";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { useReportListTooLarge } from "./ProductsTab";

/** The card row a [Change] opens the editor on: the category, its name and how many products it holds (the editor's title while it loads). */
export type CategoryCardOpen = Pick<CategoryCardRow, "categoryId" | "name" | "productCount">;

export interface CategorySettingsCardProps {
  storeConnectionId: number;
  /** The step's summary read: the catalog state (its read is off while too large, D18) and the older-rules counts (D11). */
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "catalog" | "storeDefaults">>;
  /** W12's right (`rights.categorySettings`, D3). */
  right: ListingSettingsRight;
  /** A row's [Change]: the step opens that category's editor (`?category=<id>`, D21). */
  onChange: (row: CategoryCardOpen) => void;
  /** The card's read refused as too large: the banner says so, as for the lists (D18). */
  onTooLarge?: (error: unknown) => void;
  /** The step's line under the card: the editor closed because no chosen product is in its category any more (8.6). */
  notice?: string | null;
}

/** How many skeleton rows the loading card shows (PROPOSAL): about one card's worth. */
const SKELETON_ROWS = 2;

/**
 * The Category settings card (Listing settings PR 10e, plan 8.1, 8.3; REC:971,
 * REC:819): every Card Shellz category that holds a chosen product, with what
 * it sets ("Sleeves · 15 products · Sets: shipping policy, store shelf") and
 * [Change], the products with no category, and the one line while the store
 * still holds older group rules, when no row has [Change] (D11). Sits between
 * the Store defaults card and the tabs (A5). Hidden while the selection is
 * too large (D18). Every decision is the lib's (`categorySettingsCardState`).
 */
export function CategorySettingsCard(props: CategorySettingsCardProps) {
  const { storeConnectionId, summary, right, onChange, onTooLarge, notice } = props;
  const drafts = useListingSettingsDrafts();
  // A list read (60 s), off while the summary says too large (D18).
  const read = useQuery(categoriesCardQueryOptions(storeConnectionId, summary));
  useReportListTooLarge(read.error, onTooLarge);
  const card = categorySettingsCardState({ read: { data: read.data, error: read.error }, summary, draft: drafts.draft, right, notice });
  if (card.hidden) return null;
  return <CategorySettingsCardView card={card} onChange={onChange} onRetry={() => void read.refetch()} />;
}

/** The card as its model says, hook-free (but for its title id), so every state renders in a test. */
export function CategorySettingsCardView({ card, onChange, onRetry }: {
  card: CategoryCardState;
  onChange: (row: CategoryCardOpen) => void;
  onRetry: () => void;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      aria-busy={card.read === "loading" || undefined}
      data-testid="category-settings-card"
      className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5"
    >
      <h3 id={titleId} className="text-base font-semibold text-zinc-900">{card.title}</h3>
      <p className="mt-1 text-sm text-zinc-600">{card.intro}</p>
      {card.read === "loading" && (
        <ul aria-hidden="true" className="mt-3 space-y-2" data-testid="category-settings-loading">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <li key={index} className="h-9 animate-pulse rounded bg-zinc-100 motion-reduce:animate-none" />
          ))}
        </ul>
      )}
      {card.problem && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="category-settings-read-problem">
          <span>{card.problem.text}</span>
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={onRetry}>
            {card.problem.retryLabel}
          </Button>
        </div>
      )}
      {card.latestFailed && (
        <p role="status" className="mt-3 flex flex-wrap items-center gap-2 text-sm text-amber-900" data-testid="category-settings-latest-failed">
          <span>{card.latestFailed.text}</span>
          <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={onRetry}>
            {card.latestFailed.retryLabel}
          </Button>
        </p>
      )}
      {card.notice && <p role="status" className="mt-3 text-sm text-amber-900" data-testid="category-settings-notice">{card.notice}</p>}
      {card.rows.length > 0 && (
        <ul className="mt-2 divide-y divide-zinc-100" data-testid="category-settings-rows">
          {card.rows.map((row) => <CategoryCardRowItem key={row.key} row={row} onChange={onChange} />)}
        </ul>
      )}
      {card.empty && <p role="status" className="mt-3 text-sm text-zinc-700" data-testid="category-settings-empty">{card.empty}</p>}
      {card.olderRulesLine && (
        <p role="status" className="mt-3 text-sm text-amber-900" data-testid="category-settings-older-rules">{card.olderRulesLine}</p>
      )}
      {card.uncategorized && <p className="mt-3 text-sm text-zinc-600" data-testid="category-settings-uncategorized">{card.uncategorized}</p>}
    </section>
  );
}

/** One category's row: its words, [Change] (named with the category, plan 3.4) when the card offers it, and why not under it. Hook-free, so a test can press it. */
export function CategoryCardRowItem({ row, onChange }: { row: CategoryCardRow; onChange: (row: CategoryCardOpen) => void }) {
  const { change } = row;
  return (
    <li
      className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
      data-testid={`category-settings-row-${row.categoryId}`}
    >
      <div className="min-w-0 space-y-1 text-sm">
        <p className="break-words text-zinc-900">
          <span className="font-medium">{row.words.name}</span> · {row.words.products} · {row.words.sets}
        </p>
        {row.line && <p className="text-xs text-zinc-600">{row.line}</p>}
      </div>
      {change.shown && (
        <div className="shrink-0 self-start">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-label={change.ariaLabel}
            disabled={change.disabled}
            onClick={() => onChange({ categoryId: row.categoryId, name: row.name, productCount: row.productCount })}
          >
            {change.label}
          </Button>
        </div>
      )}
    </li>
  );
}
