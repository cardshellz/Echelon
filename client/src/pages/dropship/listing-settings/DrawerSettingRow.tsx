import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { DrawerEntryPick, DrawerSettingRowModel } from "@/lib/dropship-listing-settings-drawer";
import { LISTING_SETTINGS_SAVE_WORDS } from "@/lib/dropship-listing-settings-drafts";
import type { FieldChoice, MainTextChoiceValue } from "@/lib/dropship-listing-settings-product-edit";
import { STORE_DEFAULT_EDITOR_WORDS } from "@/lib/dropship-listing-settings-store-requests";
import { changeSettingLabel, sizesDifferPickLabel } from "@/lib/dropship-listing-settings-words";
import { cn } from "@/lib/utils";
import { OwnTextCheckNotice } from "./DrawerDescriptionEditor";

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
  /** The row's inline editor while it is open (`DrawerFieldEditor`, `DrawerDescriptionEditor`). */
  editor?: ReactNode;
  /** A "Sizes differ" quick pick pressed (plan 5.3): its choice goes in the draft; nothing is sent until Save. Left out, no quick pick shows. */
  onPick?: (pick: DrawerEntryPick) => void;
  /** [Keep my text] or [Use Card Shellz text] pressed under the closed Description row (5.4); off as the quick picks are. Left out, the check doesn't show. */
  onAnswerCheck?: (answer: FieldChoice<MainTextChoiceValue>) => void;
}

/**
 * One row of the product drawer (R:259-266): SHIPPING POLICY, RETURN POLICY,
 * PAYMENT POLICY, EBAY CATEGORY, STORE SHELF or DESCRIPTION, with each value
 * and where it comes from (C17). When the sizes differ, each value is listed
 * with the sizes that use it (C16).
 *
 * A row whose model can be changed (`row.edit`, every row from PR 10) has
 * [Change], the change it holds before Save ("→ … · Not saved"), the field
 * note (why it can't be changed, "Checking…", or the one-change line), a
 * refusal that names it, and an editor slot under it. Values whose sizes
 * differ get their quick pick beside them ("Use for all sizes", "Use default
 * for all sizes"; 5.3), and the closed Description row asks the main text's
 * check (5.4). A row without edit facts reads as it did in PR 7, with no
 * button.
 */
export function DrawerSettingRow({ row, productName = "", onChange, changeRef, rowRef, editor, onPick, onAnswerCheck }: DrawerSettingRowProps) {
  const edit = row.edit;
  const changeShown = edit !== null && edit.change.shown && onChange !== undefined;
  const check = edit !== null && edit.kind === "description" && !edit.open && onAnswerCheck !== undefined ? edit.check : null;
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
                  {entry.pick && onPick && (
                    <EntryPickButton
                      pick={entry.pick}
                      value={entry.value}
                      productName={productName}
                      describedBy={edit?.pending ? pendingId : undefined}
                      onPick={onPick}
                    />
                  )}
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
        {check !== null && onAnswerCheck && (
          <OwnTextCheckNotice check={check} productName={productName} disabled={edit?.picksDisabled ?? true} onAnswer={onAnswerCheck} />
        )}
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

/**
 * "Use for all sizes" / "Use default for all sizes" beside one value (plan
 * 5.3), read out with the value and the product ("Use USPS Priority Mail for
 * all sizes of Penny Sleeves"), and with the row's change not saved yet once
 * it holds one (focus stays on the button). Off as the row's [Change] is
 * (D2), and while an editor is open.
 */
function EntryPickButton({ pick, value, productName, describedBy, onPick }: {
  pick: DrawerEntryPick;
  value: string;
  productName: string;
  /** The row's pending line ("→ Use default · Not saved"), while it shows. */
  describedBy: string | undefined;
  onPick: (pick: DrawerEntryPick) => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-11 sm:h-7 sm:min-h-0 sm:px-2 sm:text-xs"
      aria-label={sizesDifferPickLabel(pick.action, value, productName)}
      aria-describedby={describedBy}
      disabled={pick.disabled}
      data-testid={`drawer-pick-${pick.field}`}
      onClick={() => onPick(pick)}
    >
      {pick.label}
    </Button>
  );
}
