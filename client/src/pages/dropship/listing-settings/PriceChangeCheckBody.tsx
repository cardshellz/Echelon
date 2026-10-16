import { useEffect, useRef, type ReactNode } from "react";
import type { PriceChangeReviewResponse } from "@shared/dropship/listing-setting-writes";
import { Button } from "@/components/ui/button";
import type { SavePhase } from "@/lib/dropship-listing-settings-drafts";
import {
  hasNextPriceCheckPage,
  hasPreviousPriceCheckPage,
  priceCheckAfterWords,
  priceCheckChangeWords,
  priceCheckCountsWords,
  priceCheckFooter,
  priceCheckPageWords,
  priceCheckRow,
  type PriceCheckNote,
  type PriceCheckRowModel,
} from "@/lib/dropship-listing-settings-price-check";
import type { PriceCheckRef, ProductPriceChange } from "@/lib/dropship-listing-settings-product-edit";
import { CHECK_NEW_PRICES_WORDS, PRICE_DEFAULT_WORDS } from "@/lib/dropship-listing-settings-recipe";
import { LISTING_SETTINGS_PRICE_CHECK_WORDS } from "@/lib/dropship-listing-settings-words";

/** How the check's rows are being read again after the owner reopened on a held check (D21). */
export type PriceCheckRead =
  | { kind: "loading" }
  | { kind: "failed"; message: string };

export interface PriceChangeCheckBodyProps {
  /** The check the owner's draft holds: the review the vendor saw, its hash, and why it replaced an earlier one. */
  check: PriceCheckRef;
  /** The page shown: page 0 from the review, later pages from the page read; null while the rows are read again. */
  review: PriceChangeReviewResponse | null;
  /** What was checked: the recipe or "Use default", and "Clear exact prices too". */
  change: Pick<ProductPriceChange, "price" | "releaseExactPrices">;
  /** The head's words for `change` when they aren't the products kind's (a category check says "Use store default", D17; PR 10f). */
  changeWords?: readonly string[];
  /** Lines under the head for what else the check saves (a category check: "Also saves: …", "Clears …"; plan 9.2, UX-m9). */
  also?: readonly string[];
  /** The owner's draft phase: a save in flight, unconfirmed, refused…; null before any apply. */
  phase: SavePhase | null;
  /** The draft's words for its phase (a failed apply's), shown under the buttons. */
  message: string | null;
  /** The draft's last failure code: a refused apply keeps Save off (`priceCheckFooter`). */
  code: string | null;
  /** Words outside the draft: a page that didn't load, a save the page held back. */
  notice: string | null;
  /** Sizes a refused apply named as losing their price (422 WOULD_BE_LOST), shown as "● Loses its price". */
  refusedSizes: ReadonlySet<number>;
  /** Another listing action is running, or a new check is being made, so the page holds saves back. */
  busy: boolean;
  /** A page of the check is loading. */
  paging: boolean;
  /** The rows being read again for a reopened check (D21); null when `review` is the check's own answer. */
  read: PriceCheckRead | null;
  compact: boolean;
  /** [Back to editing]: the owner's body shows again, or the owner closes and keeps a locked draft (D21). */
  onBack: () => void;
  /** [Save new prices]. */
  onSave: () => void;
  /** [Check again] after an unconfirmed save: the same apply with the same key. */
  onResend: () => void;
  onPage: (page: number) => void;
  /** [Try again] when the rows couldn't be read again. */
  onRetryRead?: () => void;
  /**
   * The owner's own button before the footer's two (the category editor's [See what changes] beside the older-rules
   * line, PR 11b, plan 11.1); the drawer's and "Set for selected"'s checks pass none.
   */
  aside?: ReactNode;
}

/**
 * The price check for one or many products (W7; Listing settings PR 10d,
 * plan 7.2, 7.4, 7.6; M3's words): what the product's price, or the price of
 * the selected products, would do to every chosen size, before anything is
 * saved. It is rendered inside its owner, the drawer or "Set for selected",
 * in place of the owner's body (D20): no sheet of its own. Every price is the
 * server's integer cents (D1); every row and line is worked out by the lib
 * (`priceCheckRow`, `priceCheckCountsWords`, `priceCheckFooter`), so the
 * component only draws. Stateless, so every state renders in tests; its one
 * effect moves focus into the check when it replaces the owner's body (plan
 * 3.4, as into an opened editor), and again when a new check replaces it.
 */
export function PriceChangeCheckBody(props: PriceChangeCheckBodyProps) {
  const { check, review, change, compact, refusedSizes } = props;
  // No rows yet (they are being read again, D21): Save waits for them; Check again needs only the draft's reference.
  const footer = priceCheckFooter({
    phase: props.phase, summary: review?.summary ?? null, change, busy: props.busy, paging: props.paging, message: props.message, code: props.code,
  });
  const region = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    region.current?.focus();
  }, [check.reviewId]);
  const after = priceCheckAfterWords(check.after);
  const pageWords = review === null ? null : priceCheckPageWords(review);
  const checked = props.changeWords ?? priceCheckChangeWords(change);
  const head = checked.length === 0 ? LISTING_SETTINGS_PRICE_CHECK_WORDS.checking : `${LISTING_SETTINGS_PRICE_CHECK_WORDS.checking}: ${checked.join(" · ")}`;
  const also = props.also ?? [];
  return (
    <>
      <div
        ref={region}
        tabIndex={-1}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3 outline-none sm:px-6"
        data-testid="price-check"
        data-review={check.reviewId}
      >
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-zinc-900" data-testid="price-check-head">
            {head}
            <span className="font-normal text-amber-800"> · {CHECK_NEW_PRICES_WORDS.notSavedYet}</span>
          </h3>
          {also.map((line) => <p key={line} className="text-sm text-zinc-700" data-testid="price-check-also">{line}</p>)}
        </div>
        {after && <p role="status" className="text-sm text-zinc-700" data-testid="price-check-after">{after}</p>}
        {props.notice && <p role="alert" className="text-sm text-amber-900">{props.notice}</p>}
        {review === null ? (
          <ReadState read={props.read} onRetryRead={props.onRetryRead} />
        ) : (
          <>
            <p role="status" className="text-sm text-zinc-700" data-testid="price-check-counts">{priceCheckCountsWords(review.summary)}</p>
            {review.summary.total === 0 ? (
              <p className="text-sm text-zinc-600">{CHECK_NEW_PRICES_WORDS.empty}</p>
            ) : compact ? (
              <ul className="space-y-2" aria-label={CHECK_NEW_PRICES_WORDS.title}>
                {review.rows.map((row) => <CheckCard key={row.productVariantId} row={priceCheckRow(row, refusedSizes)} />)}
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
                    {review.rows.map((row) => <CheckTableRow key={row.productVariantId} row={priceCheckRow(row, refusedSizes)} />)}
                  </tbody>
                </table>
              </div>
            )}
            {pageWords && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-zinc-600" data-testid="price-check-pages">{pageWords}</span>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9"
                    disabled={props.paging || footer.backDisabled || !hasPreviousPriceCheckPage(review)} onClick={() => props.onPage(review.page - 1)}>
                    {CHECK_NEW_PRICES_WORDS.previous}
                  </Button>
                  <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9"
                    disabled={props.paging || footer.backDisabled || !hasNextPriceCheckPage(review)} onClick={() => props.onPage(review.page + 1)}>
                    {CHECK_NEW_PRICES_WORDS.next}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="sticky bottom-0 space-y-2 border-t border-zinc-200 bg-background px-4 py-3 sm:px-6" data-testid="price-check-footer">
        {footer.lines.map((line) => (
          <p key={line.text} role={line.tone === "alert" ? "alert" : "status"} className={`text-sm ${line.tone === "alert" ? "text-rose-800" : "text-zinc-700"}`}>
            {line.text}
          </p>
        ))}
        <p className="text-sm text-zinc-600">{compact ? CHECK_NEW_PRICES_WORDS.footerPhone : CHECK_NEW_PRICES_WORDS.footer}</p>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {props.aside}
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" disabled={footer.backDisabled} onClick={props.onBack}>
            {compact ? CHECK_NEW_PRICES_WORDS.backPhone : CHECK_NEW_PRICES_WORDS.back}
          </Button>
          <Button type="button" size="sm" className="min-h-11 sm:min-h-9" disabled={footer.primary.disabled}
            onClick={() => { if (footer.primary.action === "save") props.onSave(); else if (footer.primary.action === "resend") props.onResend(); }}>
            {footer.primary.label}
          </Button>
        </div>
      </div>
    </>
  );
}

/** The rows being read again for a check the owner reopened on (D21): loading, or failed with Try again. */
function ReadState({ read, onRetryRead }: { read: PriceCheckRead | null; onRetryRead: (() => void) | undefined }) {
  if (read === null || read.kind === "loading") return <p role="status" className="text-sm text-zinc-600">{PRICE_DEFAULT_WORDS.loading}</p>;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
      <span>{read.message}</span>
      {onRetryRead && (
        <Button type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-9" onClick={onRetryRead}>{PRICE_DEFAULT_WORDS.tryAgain}</Button>
      )}
    </div>
  );
}

function CheckTableRow({ row }: { row: PriceCheckRowModel }) {
  return (
    <tr className="border-t border-zinc-100 align-top" data-testid={`price-check-size-${row.productVariantId}`} data-refused={row.refused || undefined}>
      <td className="p-2">
        <div className="text-zinc-900">{row.title}</div>
        {row.size && <div className="text-xs text-zinc-600">{row.size}</div>}
      </td>
      <td className="p-2 text-zinc-700">{row.builtFrom}</td>
      <td className="whitespace-nowrap p-2">{row.now}</td>
      <td className="whitespace-nowrap p-2 font-medium">{row.next}</td>
      <td className="p-2 text-xs"><Notes notes={row.notes} /></td>
    </tr>
  );
}

function CheckCard({ row }: { row: PriceCheckRowModel }) {
  return (
    <li className="rounded-md border border-zinc-200 p-3 text-sm" data-testid={`price-check-size-${row.productVariantId}`} data-refused={row.refused || undefined}>
      <p className="font-medium text-zinc-900">{row.title}</p>
      {row.size && <p className="text-xs text-zinc-600">{row.size}</p>}
      <p className="mt-1 text-zinc-700">{row.builtFrom}</p>
      <p className="mt-1">{row.now} → <span className="font-medium">{row.next}</span></p>
      <div className="mt-1 text-xs"><Notes notes={row.notes} /></div>
    </li>
  );
}

const NOTE_TONE: Readonly<Record<PriceCheckNote["kind"], string>> = {
  below_cost: "text-amber-800",
  loses_price: "text-rose-800",
  outside_limit: "text-amber-800",
  released: "text-zinc-700",
};

function Notes({ notes }: { notes: readonly PriceCheckNote[] }) {
  if (notes.length === 0) return null;
  return <>{notes.map((note) => <p key={note.kind} className={NOTE_TONE[note.kind]}>{note.text}</p>)}</>;
}
