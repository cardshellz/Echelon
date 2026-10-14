import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { DrawerSettingRowModel } from "@/lib/dropship-listing-settings-drawer";
import { LISTING_SETTINGS_SAVE_WORDS } from "@/lib/dropship-listing-settings-drafts";
import { STORE_DEFAULT_EDITOR_WORDS } from "@/lib/dropship-listing-settings-store-requests";
import { changeSettingLabel } from "@/lib/dropship-listing-settings-words";
import { cn } from "@/lib/utils";

export interface DrawerSettingRowProps {
  row: DrawerSettingRowModel;
  /** Names the product in [Change]'s label (plan 3.4); only read when the row can be changed. */
  productName?: string;
  /** [Change]: opens the row's editor. Left out, the row has no button (PR 7, or no edit facts). */
  onChange?: () => void;
  /** The [Change] button, so the drawer can give it focus back when the editor closes. */
  changeRef?: (element: HTMLButtonElement | null) => void;
  /** The row itself, which takes focus back when its [Change] can't (plan 3.4); it can then be focused, not tabbed to. */
  rowRef?: (element: HTMLDivElement | null) => void;
  /** The row's inline editor while it is open (`DrawerFieldEditor`). */
  editor?: ReactNode;
}

/**
 * One row of the product drawer (R:259-266): SHIPPING POLICY, RETURN POLICY,
 * PAYMENT POLICY, EBAY CATEGORY, STORE SHELF or DESCRIPTION, with each value
 * and where it comes from (C17). When the sizes differ, each value is listed
 * with the sizes that use it (C16).
 *
 * A row whose model can be changed (`row.edit`, the policy rows from PR 10)
 * has [Change], the change it holds before Save ("→ … · Not saved"), the
 * field note (why it can't be changed, "Checking…", or the one-change line),
 * a refusal that names it, and an editor slot under it. Every other row reads
 * as it did in PR 7, with no button.
 */
export function DrawerSettingRow({ row, productName = "", onChange, changeRef, rowRef, editor }: DrawerSettingRowProps) {
  const edit = row.edit;
  const changeShown = edit !== null && edit.change.shown && onChange !== undefined;
  const pendingId = useId();
  return (
    <div
      ref={rowRef}
      tabIndex={rowRef ? -1 : undefined}
      className={cn(
        "grid gap-1 border-t border-zinc-100 py-3 outline-none first:border-t-0 focus-visible:ring-2 focus-visible:ring-[#C060E0] sm:gap-4",
        changeShown ? "sm:grid-cols-[10rem_minmax(0,1fr)_auto]" : "sm:grid-cols-[10rem_minmax(0,1fr)]",
      )}
      data-testid={`drawer-setting-${row.key}`}
    >
      <h4 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{row.label}</h4>
      <div className="min-w-0 space-y-2">
        {row.groups.map((group, groupIndex) => (
          <div key={groupIndex} className="space-y-1">
            {group.differ && (
              <p className="text-sm font-medium text-amber-900">
                <span aria-hidden="true">! </span>{group.differ}
              </p>
            )}
            <ul className="space-y-1">
              {group.entries.map((entry, entryIndex) => (
                <li key={entryIndex} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                  <span className="break-words text-zinc-900">{entry.value}</span>
                  {entry.tags.map((tag) => (
                    <span key={tag} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700">{tag}</span>
                  ))}
                  {entry.usedBy && <span className="text-xs text-zinc-600">{entry.usedBy}</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
        {edit?.pending && (
          <p id={pendingId} className="break-words text-sm font-medium text-zinc-900" data-testid={`drawer-setting-${row.key}-pending`}>
            {edit.pending}
          </p>
        )}
        {edit?.marked && <p className="text-xs font-medium text-amber-900">{STORE_DEFAULT_EDITOR_WORDS.changedElsewhereToo}</p>}
        {edit?.fieldError && <p role="alert" className="text-sm text-rose-800">{edit.fieldError}</p>}
        {row.notes.map((note) => <p key={note} className="text-xs text-zinc-600">{note}</p>)}
        {edit?.line && <p className="text-xs text-zinc-600" data-testid={`drawer-setting-${row.key}-line`}>{edit.line}</p>}
      </div>
      {changeShown && (
        <div>
          <Button
            ref={changeRef}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-label={changeSettingLabel(row.label, productName)}
            // Back on [Change] after [Done], the change not saved yet is read with it.
            aria-describedby={edit.pending ? pendingId : undefined}
            aria-expanded={edit.open}
            disabled={edit.change.disabled}
            onClick={onChange}
          >
            {LISTING_SETTINGS_SAVE_WORDS.change}
          </Button>
        </div>
      )}
      {editor}
    </div>
  );
}
