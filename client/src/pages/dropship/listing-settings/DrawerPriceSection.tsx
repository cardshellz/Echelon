import { useId } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DRAWER_WORDS, type DrawerNotice, type DrawerSizeLine } from "@/lib/dropship-listing-settings-drawer";

export interface DrawerPriceSectionProps {
  /** "Store default: Retail price + 20%, round up to .99", or why there is none yet. */
  head: string;
  /** Why exact prices can't be changed now (plan 4.3); null when they can, or when the banner says why. */
  reason: string | null;
  /** "Save or discard the price you changed first." while one size holds a change (D4). */
  waitingHint: string | null;
  sizes: readonly DrawerSizeLine[];
  /** "2 more sizes aren't selected. Choose them in step 1." */
  notChosen: string | null;
  onGoToStep1: () => void;
  /** "Show all 40 sizes"; null when every size shows. */
  showAllLabel: string | null;
  onShowAll: () => void;
  /** The size search, once every size shows and there are more than 25 (R:556). */
  search: { value: string; onChange: (value: string) => void; noMatch: string | null } | null;
  onEdit: (productVariantId: number, text: string) => void;
  /** × ("Use the price above"): empties the box, so the size saves as `inherit`. */
  onClear: (productVariantId: number) => void;
  /** A size's box or × took focus: it becomes the size in edit, and its own price is read. */
  onFocusSize: (productVariantId: number) => void;
  /** Lets the drawer focus the box of the size it opened on. */
  inputRef?: (productVariantId: number, element: HTMLInputElement | null) => void;
}

const NOTICE_CLASS: Readonly<Record<DrawerNotice["tone"], string>> = {
  info: "text-zinc-600",
  warn: "text-amber-800",
  alert: "text-rose-800",
};

/**
 * The drawer's PRICE section (R:245-257): one line per size with its price,
 * what it is built from, its cost and stock, and an Exact price box. Only
 * the size in edit can change (D4). Stateless: every line comes worked out
 * from `drawerSizeLine`, so every state renders in tests.
 */
export function DrawerPriceSection(props: DrawerPriceSectionProps) {
  const ids = { waiting: useId(), head: useId() };
  return (
    <section aria-labelledby={ids.head} className="space-y-3" data-testid="drawer-price-section">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id={ids.head} className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{DRAWER_WORDS.priceHead}</h3>
        <p className="text-sm text-zinc-900">{props.head}</p>
      </div>
      {props.reason && <p className="text-sm text-zinc-600">{props.reason}</p>}
      {props.waitingHint && <p id={ids.waiting} className="text-sm text-amber-900">{props.waitingHint}</p>}
      {props.search && (
        <div className="max-w-xs">
          <Input
            type="search"
            aria-label={DRAWER_WORDS.sizeSearch}
            placeholder={DRAWER_WORDS.sizeSearch}
            value={props.search.value}
            onChange={(event) => props.search?.onChange(event.target.value)}
          />
        </div>
      )}
      {props.search?.noMatch && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          {props.search.noMatch}
          <Button type="button" size="sm" variant="outline" onClick={() => props.search?.onChange("")}>{DRAWER_WORDS.clearSearch}</Button>
        </p>
      )}
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200">
        {props.sizes.map((line) => (
          <SizeLine
            key={line.productVariantId}
            line={line}
            waitingId={props.waitingHint ? ids.waiting : undefined}
            onEdit={props.onEdit}
            onClear={props.onClear}
            onFocusSize={props.onFocusSize}
            inputRef={props.inputRef}
          />
        ))}
      </ul>
      <p className="text-xs text-zinc-600">{DRAWER_WORDS.leaveEmpty}</p>
      {props.showAllLabel && (
        <Button type="button" size="sm" variant="outline" onClick={props.onShowAll}>{props.showAllLabel}</Button>
      )}
      {props.notChosen && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          {props.notChosen}
          <Button type="button" size="sm" variant="link" className="h-auto p-0" onClick={props.onGoToStep1}>{DRAWER_WORDS.goToStep1}</Button>
        </p>
      )}
    </section>
  );
}

function SizeLine({ line, waitingId, onEdit, onClear, onFocusSize, inputRef }: Pick<DrawerPriceSectionProps, "onEdit" | "onClear" | "onFocusSize" | "inputRef"> & {
  line: DrawerSizeLine;
  /** The "Save or discard the price you changed first." line, which a waiting box points to. */
  waitingId: string | undefined;
}) {
  const ids = { input: useId(), error: useId() };
  const described = [line.fieldError ? ids.error : null, line.input.readOnly ? waitingId : null].filter(Boolean).join(" ") || undefined;
  return (
    <li
      className="space-y-1 p-3"
      data-testid={`drawer-size-${line.productVariantId}`}
      // Focus inside the line (its box or ×) makes it the size in edit; React's onFocus bubbles.
      onFocus={() => onFocusSize(line.productVariantId)}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 break-words text-sm font-medium text-zinc-900">{line.title}</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold tabular-nums text-zinc-900">{line.priceText}</span>
          <label htmlFor={ids.input} className="text-xs text-zinc-600">{DRAWER_WORDS.exact}</label>
          <Input
            id={ids.input}
            ref={(element) => inputRef?.(line.productVariantId, element)}
            className={`h-9 w-28 ${line.input.marked ? "border-amber-500 ring-1 ring-amber-400" : ""}`}
            type="text"
            inputMode="decimal"
            autoComplete="off"
            aria-label={`${DRAWER_WORDS.exact} price for ${line.title}`}
            value={line.input.text}
            readOnly={line.input.readOnly}
            aria-readonly={line.input.readOnly || undefined}
            aria-invalid={line.input.invalid || undefined}
            aria-describedby={described}
            onChange={(event) => onEdit(line.productVariantId, event.target.value)}
          />
          {line.clear.shown && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-9 w-9"
              aria-label={DRAWER_WORDS.clear}
              disabled={line.clear.disabled}
              onClick={() => onClear(line.productVariantId)}
            >
              <X aria-hidden="true" className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
      <p className="break-words text-xs text-zinc-600">{line.facts}</p>
      {line.pending && (
        <div className="space-y-0.5">
          <p className="text-sm font-medium text-zinc-900">{line.pending.line}</p>
          {line.pending.notices.map((notice) => <Notice key={notice.text} notice={notice} />)}
        </div>
      )}
      {line.clear.reason && <p className="text-xs text-zinc-700">{line.clear.reason}</p>}
      {line.notices.map((notice) => <Notice key={notice.text} notice={notice} />)}
      {line.fieldError && <p id={ids.error} role="alert" className="text-sm text-rose-800">{line.fieldError}</p>}
    </li>
  );
}

function Notice({ notice }: { notice: DrawerNotice }) {
  return <p className={`text-xs ${NOTICE_CLASS[notice.tone]}`}>{notice.text}</p>;
}
