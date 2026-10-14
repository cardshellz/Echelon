import { STORE_DEFAULT_EDITOR_WORDS, type PolicyEditorChoice } from "@/lib/dropship-listing-settings-store-requests";
import { cn } from "@/lib/utils";

/** One more choice in the same radio group after eBay's policies, such as the drawer's "Use default". */
export interface PolicyChoiceExtra {
  label: string;
  checked: boolean;
  onPick: () => void;
}

export interface PolicyChoiceListProps {
  /** The radio group's name, unique on the page (the caller's `useId()`). */
  name: string;
  /** Read out for the group; not shown ("Shipping policy"). */
  legend: string;
  /** eBay's policies, in eBay's order (`policyEditorChoices`). */
  choices: readonly PolicyEditorChoice[];
  /** The picked policy's id; null when none of eBay's is picked. */
  picked: string | null;
  /** The whole list is off (a save is out or unconfirmed). */
  disabled: boolean;
  /** "Changed in another window too" above the list, after "Load latest". */
  marked: boolean;
  /** The policy shown as "Suggested · not saved" while it is picked (C18); null for none. */
  suggestedId: string | null;
  onPick: (policyId: string) => void;
  /** A choice after eBay's in the same group; left out, nothing more is drawn. */
  extra?: PolicyChoiceExtra;
}

/**
 * eBay's policies of one kind as a radio list (R:192-193): each with its
 * name, and each shipping policy with whether it works with Card Shellz
 * shipping. One that can't be used can't be picked. Shared by the Store
 * defaults policy editor (PolicyDefaultRow, W2) and the drawer's policy
 * editor (DrawerFieldEditor, W5; PR 10 plan 4.3). Stateless: the caller owns
 * the pick. No id is ever shown.
 */
export function PolicyChoiceList({ name, legend, choices, picked, disabled, marked, suggestedId, onPick, extra }: PolicyChoiceListProps) {
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="sr-only">{legend}</legend>
      {marked && (
        <p className="text-xs font-medium text-amber-900">{STORE_DEFAULT_EDITOR_WORDS.changedElsewhereToo}</p>
      )}
      {choices.map((choice) => {
        const checked = picked === choice.id;
        const suggested = checked && choice.id === suggestedId;
        return (
          <label
            key={choice.id}
            className={cn(
              "flex min-h-11 items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 text-sm",
              choice.choosable ? "cursor-pointer" : "cursor-not-allowed bg-zinc-50",
              checked && "border-[#C060E0]",
            )}
          >
            <input
              type="radio"
              name={name}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[#C060E0]"
              checked={checked}
              disabled={!choice.choosable}
              onChange={() => onPick(choice.id)}
            />
            <span className="min-w-0">
              <span className="block break-words font-medium text-zinc-900">{choice.name}</span>
              {choice.fit && (
                <span className={cn("block text-xs", choice.fit.fit === "works" ? "text-emerald-800" : choice.fit.fit === "cant_use" ? "text-rose-800" : "text-zinc-600")}>
                  {choice.fit.line}
                </span>
              )}
              {suggested && <span className="block text-xs font-medium text-amber-800">{STORE_DEFAULT_EDITOR_WORDS.suggested}</span>}
            </span>
          </label>
        );
      })}
      {extra && (
        <label
          className={cn(
            "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 text-sm",
            extra.checked && "border-[#C060E0]",
          )}
        >
          <input
            type="radio"
            name={name}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#C060E0]"
            checked={extra.checked}
            onChange={extra.onPick}
          />
          <span className="min-w-0 break-words font-medium text-zinc-900">{extra.label}</span>
        </label>
      )}
    </fieldset>
  );
}
