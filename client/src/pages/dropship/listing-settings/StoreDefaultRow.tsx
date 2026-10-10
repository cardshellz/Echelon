import { useId, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import {
  LISTING_SETTINGS_SAVE_WORDS,
  STORE_DEFAULT_COMPACT_LABELS,
  STORE_DEFAULT_LABELS,
  STORE_DEFAULT_ONE_LINE_FIELDS,
  type StoreDefaultField,
} from "@/lib/dropship-listing-settings-drafts";
import { NotSavedBadge } from "../catalog/UnsavedChangesGuard";

export interface StoreDefaultRowProps {
  field: StoreDefaultField;
  /** The row's name; defaults to the record's (R:90). */
  label?: string;
  /** The saved value in words. Phrasing content only: on a phone it sits inside a button. */
  value: ReactNode;
  /** The shorter phone value ("Retail + 20%, up to .99"); defaults to `value`. */
  compactValue?: ReactNode;
  /** A line under the value, read out when it changes ("Saved", "✓ Works with Card Shellz shipping"). */
  status?: ReactNode;
  /** Whether [Change] is offered (plan 4.3). */
  editable: boolean;
  /** Why it can't be changed, shown when not editable ("Reconnect eBay to change this."). */
  reason?: string | null;
  /** Shows "● Not saved" by the name while the row's draft holds changes. */
  notSaved?: boolean;
  /** [Change] (or the whole phone row). */
  onChange: () => void;
  /** The phone layout (below 640 px). */
  compact: boolean;
  /** The [Change] button, so focus can go back to it when the editor closes. */
  changeRef?: Ref<HTMLButtonElement>;
  /** The row's editor and any note under the row. */
  children?: ReactNode;
}

/**
 * One row of the Store defaults card (R:90; phone R:433-442): the name, the
 * saved value, a status line, and [Change] when the vendor may change it, or
 * the reason they can't.
 */
export function StoreDefaultRow(props: StoreDefaultRowProps) {
  return (
    <div data-testid={`store-default-row-${props.field}`} data-field={props.field} className="py-3">
      {props.compact ? <CompactRow {...props} /> : <WideRow {...props} />}
      {props.children}
    </div>
  );
}

function WideRow({ field, label, value, status, editable, reason, notSaved, onChange, changeRef }: StoreDefaultRowProps) {
  const name = label ?? STORE_DEFAULT_LABELS[field];
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-900">
        <span>{name}</span>
        {notSaved && <NotSavedBadge />}
      </div>
      <div className="min-w-0 text-sm text-zinc-700">
        <div className="break-words">{value}</div>
        <RowStatus status={status} />
        {!editable && reason && <p className="mt-1 text-xs text-zinc-500">{reason}</p>}
      </div>
      <div>
        {editable && (
          <Button ref={changeRef} type="button" variant="outline" size="sm" aria-label={`${LISTING_SETTINGS_SAVE_WORDS.change} ${name}`} onClick={onChange}>
            {LISTING_SETTINGS_SAVE_WORDS.change}
          </Button>
        )}
      </div>
    </div>
  );
}

function CompactRow({ field, label, value, compactValue, status, editable, reason, notSaved, onChange, changeRef }: StoreDefaultRowProps) {
  const valueId = useId();
  const name = label ?? STORE_DEFAULT_LABELS[field];
  const shortName = label ?? STORE_DEFAULT_COMPACT_LABELS[field];
  const shown = compactValue ?? value;
  const oneLine = STORE_DEFAULT_ONE_LINE_FIELDS.has(field);
  const body = oneLine ? (
    <span className="min-w-0 break-words text-sm text-zinc-700">
      <span className="font-medium text-zinc-900">{shortName}</span>
      {" · "}
      <span id={valueId}>{shown}</span>
    </span>
  ) : (
    <span className="min-w-0">
      <span className="block text-sm font-medium text-zinc-900">{shortName}</span>
      <span id={valueId} className="block break-words text-sm text-zinc-700">{shown}</span>
    </span>
  );
  return (
    <>
      {editable ? (
        <button
          ref={changeRef}
          type="button"
          aria-label={`${LISTING_SETTINGS_SAVE_WORDS.change} ${name}`}
          aria-describedby={valueId}
          onClick={onChange}
          className="flex min-h-11 w-full items-start justify-between gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0]"
        >
          {body}
          <span aria-hidden="true" className="shrink-0 text-lg leading-5 text-zinc-400">›</span>
        </button>
      ) : (
        <div className="flex w-full items-start justify-between gap-3">{body}</div>
      )}
      {notSaved && <div className="mt-1"><NotSavedBadge /></div>}
      <RowStatus status={status} />
      {!editable && reason && <p className="mt-1 text-xs text-zinc-500">{reason}</p>}
    </>
  );
}

/** Always in the page, so a screen reader hears "Saved" when it appears (C28). */
function RowStatus({ status }: { status: ReactNode }) {
  return <div role="status" className="text-sm text-zinc-700 empty:hidden">{status}</div>;
}
