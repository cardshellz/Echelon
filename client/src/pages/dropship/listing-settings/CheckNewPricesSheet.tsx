import { PRICING_REVIEW_PAGE_SIZE, type PricingImpactRow, type PricingProfile, type PricingReviewResponse } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { SavePhase } from "@/lib/dropship-listing-settings-drafts";
import { recipeWords } from "@/lib/dropship-listing-settings-price-words";
import {
  CHECK_NEW_PRICES_WORDS,
  checkNewPricesFooter,
  hasNextReviewPage,
  hasPreviousReviewPage,
  reviewBlockedWords,
  reviewCountsWords,
  reviewPageWords,
  reviewPriceWords,
  reviewRowBuiltFrom,
  reviewRowNotes,
  reviewSizeLine,
  type ReviewNote,
} from "@/lib/dropship-listing-settings-recipe";
import type { FocusReturnTarget } from "./EditorSurface";

/**
 * Full width below 640 px (a full-screen sheet on a phone, plan 4.7, R:471);
 * a wide right-side sheet above it.
 */
export const CHECK_NEW_PRICES_SHEET_CLASS =
  "flex w-full flex-col gap-0 p-0 sm:max-w-3xl motion-reduce:animate-none motion-reduce:transition-none";

/** The check the vendor is looking at, and what it was made from. */
export interface CheckedPrices {
  review: PricingReviewResponse;
  /** The profile the check was made with: the new store default and the older group rules, unchanged. */
  profile: PricingProfile;
  /** The saved revision the check was made against; a stale save compares it with the revision read again. */
  expectedRevisionId: number | null;
  /** Shown once, after a check was run again because prices moved (R:683). */
  stale: boolean;
}

export interface CheckNewPricesSheetProps {
  /** The check to show; the sheet is closed while it is null. */
  checked: CheckedPrices | null;
  /** The Price draft's phase: a save in flight, unconfirmed, or refused for now. */
  phase: SavePhase | null;
  /** Words for a save that didn't go through, or a page that didn't load. */
  message: string | null;
  /** A page of the check is loading. */
  paging: boolean;
  /** Another listing action is running, so the page holds saves back. */
  busy: boolean;
  /** × or Esc or [Back to editing]: back to the Price editor (ignored while a save is in flight or unconfirmed). */
  onBack: () => void;
  /** [Save new prices]. */
  onSave: () => void;
  /** [Check again] after an unconfirmed save: the same apply with the same key. */
  onResend: () => void;
  onPage: (page: number) => void;
  /** Gets focus when the sheet closes. */
  returnFocusTo?: FocusReturnTarget;
}

/**
 * "Check new prices" (M3): what the store price would do to every chosen
 * size, before anything is saved. It never writes; [Save new prices] asks the
 * Price row to apply the check.
 */
export function CheckNewPricesSheet(props: CheckNewPricesSheetProps) {
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const { checked } = props;
  const footer = checkNewPricesFooter({
    phase: props.phase,
    blocked: checked?.review.summary.blocked ?? 0,
    busy: props.busy,
    paging: props.paging,
  });
  return (
    <Sheet open={checked !== null} onOpenChange={(next) => { if (!next && !footer.backDisabled) props.onBack(); }}>
      <SheetContent
        side="right"
        data-testid="check-new-prices"
        data-layout={compact ? "phone" : "wide"}
        onCloseAutoFocus={(event) => {
          // The sheet has no trigger, so Radix would send focus to <body>.
          event.preventDefault();
          const target = props.returnFocusTo?.current ?? null;
          if (target && target.isConnected) target.focus();
        }}
        className={CHECK_NEW_PRICES_SHEET_CLASS}
      >
        {checked && (
          <>
            <SheetHeader className="border-b border-zinc-200 px-4 pb-3 pr-12 pt-4 text-left sm:px-6">
              <SheetTitle className="text-base">
                {CHECK_NEW_PRICES_WORDS.title}
                <span className="font-normal text-amber-800"> · {CHECK_NEW_PRICES_WORDS.notSavedYet}</span>
              </SheetTitle>
              <SheetDescription className="text-sm text-zinc-700">{recipeWords(checked.profile.defaultRecipe)}</SheetDescription>
            </SheetHeader>
            <CheckNewPricesBody {...props} checked={checked} compact={compact} footer={footer} />
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export interface CheckNewPricesBodyProps extends Omit<CheckNewPricesSheetProps, "checked" | "returnFocusTo"> {
  checked: CheckedPrices;
  compact: boolean;
  footer: ReturnType<typeof checkNewPricesFooter>;
}

/** The sheet under its title: counts, the sizes, paging, and the footer. Stateless, so every state renders in tests. */
export function CheckNewPricesBody({ checked, compact, footer, message, paging, onBack, onSave, onResend, onPage }: CheckNewPricesBodyProps) {
  const { review, profile } = checked;
  const pageWords = reviewPageWords(review, PRICING_REVIEW_PAGE_SIZE);
  const blocked = reviewBlockedWords(review.summary.blocked);
  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 sm:px-6">
        <p className="text-sm text-zinc-700" data-testid="check-new-prices-counts">{reviewCountsWords(review.summary)}</p>
        {checked.stale && <p role="status" className="text-sm text-zinc-700">{CHECK_NEW_PRICES_WORDS.stale}</p>}
        {message && <p role="alert" className="text-sm text-amber-900">{message}</p>}
        {review.summary.total === 0 ? (
          <p className="text-sm text-zinc-600">{CHECK_NEW_PRICES_WORDS.empty}</p>
        ) : compact ? (
          <ul className="space-y-2" aria-label={CHECK_NEW_PRICES_WORDS.title}>
            {review.rows.map((row) => <ReviewCard key={row.productVariantId} row={row} profile={profile} />)}
          </ul>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-zinc-50">
                <tr>
                  {CHECK_NEW_PRICES_WORDS.columns.map((label) => <th key={label} scope="col" className="whitespace-nowrap p-2 font-medium">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {review.rows.map((row) => <ReviewTableRow key={row.productVariantId} row={row} profile={profile} />)}
              </tbody>
            </table>
          </div>
        )}
        {pageWords && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-zinc-600">{pageWords}</span>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={paging || footer.backDisabled || !hasPreviousReviewPage(review)} onClick={() => onPage(review.page - 1)}>
                {CHECK_NEW_PRICES_WORDS.previous}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={paging || footer.backDisabled || !hasNextReviewPage(review, PRICING_REVIEW_PAGE_SIZE)} onClick={() => onPage(review.page + 1)}>
                {CHECK_NEW_PRICES_WORDS.next}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="sticky bottom-0 space-y-2 border-t border-zinc-200 bg-background px-4 py-3 sm:px-6" data-testid="check-new-prices-footer">
        {blocked && <p className="text-sm text-rose-800">{blocked}</p>}
        <p className="text-sm text-zinc-600">{compact ? CHECK_NEW_PRICES_WORDS.footerPhone : CHECK_NEW_PRICES_WORDS.footer}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="outline" size="sm" disabled={footer.backDisabled} onClick={onBack}>
            {compact ? CHECK_NEW_PRICES_WORDS.backPhone : CHECK_NEW_PRICES_WORDS.back}
          </Button>
          <Button type="button" size="sm" disabled={footer.primary.disabled}
            onClick={() => { if (footer.primary.action === "save") onSave(); else if (footer.primary.action === "resend") onResend(); }}>
            {footer.primary.label}
          </Button>
        </div>
      </div>
    </>
  );
}

function ReviewTableRow({ row, profile }: { row: PricingImpactRow; profile: PricingProfile }) {
  const size = reviewSizeLine(row);
  return (
    <tr className="border-t border-zinc-100 align-top" data-testid="check-new-prices-row">
      <td className="p-2">
        <div className="text-zinc-900">{row.title}</div>
        {size && <div className="text-xs text-zinc-600">{size}</div>}
      </td>
      <td className="p-2 text-zinc-700">{reviewRowBuiltFrom(row, profile)}</td>
      <td className="whitespace-nowrap p-2">{reviewPriceWords(row.previousPriceCents)}</td>
      <td className="whitespace-nowrap p-2 font-medium">{reviewPriceWords(row.priceCents)}</td>
      <td className="p-2 text-xs"><Notes notes={reviewRowNotes(row)} /></td>
    </tr>
  );
}

function ReviewCard({ row, profile }: { row: PricingImpactRow; profile: PricingProfile }) {
  const size = reviewSizeLine(row);
  return (
    <li className="rounded-md border border-zinc-200 p-3 text-sm" data-testid="check-new-prices-card">
      <p className="font-medium text-zinc-900">{row.title}</p>
      {size && <p className="text-xs text-zinc-600">{size}</p>}
      <p className="mt-1 text-zinc-700">{reviewRowBuiltFrom(row, profile)}</p>
      <p className="mt-1">{reviewPriceWords(row.previousPriceCents)} → <span className="font-medium">{reviewPriceWords(row.priceCents)}</span></p>
      <div className="mt-1 text-xs"><Notes notes={reviewRowNotes(row)} /></div>
    </li>
  );
}

const NOTE_TONE: Readonly<Record<ReviewNote["kind"], string>> = {
  below_cost: "text-amber-800",
  loses_price: "text-rose-800",
  outside_limit: "text-amber-800",
};

function Notes({ notes }: { notes: readonly ReviewNote[] }) {
  if (notes.length === 0) return null;
  return <>{notes.map((note) => <p key={note.kind} className={NOTE_TONE[note.kind]}>{note.text}</p>)}</>;
}
