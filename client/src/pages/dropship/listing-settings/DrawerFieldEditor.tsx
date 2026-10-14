import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { LISTING_SETTINGS_SAVE_WORDS } from "@/lib/dropship-listing-settings-drafts";
import {
  fieldChoiceReady,
  type FieldChoice,
  type PolicyChoiceValue,
  type PolicyFieldEditorModel,
} from "@/lib/dropship-listing-settings-product-edit";
import { fieldEditorLabel, LISTING_SETTINGS_EDIT_WORDS } from "@/lib/dropship-listing-settings-words";
import { PolicyChoiceList } from "./PolicyChoiceList";

export interface DrawerFieldEditorProps {
  /** What the editor lists and where it starts (`policyFieldEditor`). */
  model: PolicyFieldEditorModel;
  /** The row's name ("Shipping policy"), read out for the list. */
  title: string;
  /** The product, so a screen reader names whose setting this is (plan 3.4). */
  productName: string;
  /** Why [Done] didn't take the choice ("Save or discard your other change first."); null for nothing. */
  message: string | null;
  /** Puts the choice in the drawer's draft; nothing is sent until Save. */
  onDone: (choice: FieldChoice<PolicyChoiceValue>) => void;
  /** Closes the editor and drops the pick; Esc does the same (the drawer routes it here). */
  onCancel: () => void;
}

const FOCUSABLE = "input:not([disabled]), button:not([disabled])";

/**
 * A drawer row's inline editor (Listing settings PR 10, plan 4.5): eBay's
 * policies of the row's kind as a radio list, with whether each shipping
 * policy works with Card Shellz shipping, and "Use default" (the category's
 * setting, else the store default; REC:854, REC:857). [Done] puts the
 * choice in the drawer's one draft; nothing is sent until the drawer's Save.
 *
 * It opens in place under its row on every width, so the drawer is the only
 * surface (D20). Focus moves into it when it opens; the drawer gives focus
 * back to the row's [Change] when it closes (plan 3.4).
 */
export function DrawerFieldEditor({ model, title, productName, message, onDone, onCancel }: DrawerFieldEditorProps) {
  const group = useId();
  const label = fieldEditorLabel(title, productName);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<FieldChoice<PolicyChoiceValue>>(model.initial);

  useEffect(() => {
    // Like a dialog: focus moves to the picked choice, else the first one that can be picked.
    const panel = panelRef.current;
    if (!panel) return;
    const checked = panel.querySelector<HTMLElement>("input:checked:not([disabled])");
    (checked ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
  }, []);

  const picked = choice.mode === "set" ? choice.value.id : null;
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={label}
      data-testid={`drawer-field-editor-${model.field}`}
      className="mt-2 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0] sm:col-span-3"
    >
      <p aria-hidden="true" className="text-sm font-semibold text-zinc-900">{title}</p>
      {model.emptyLine && <p className="text-sm text-zinc-700">{model.emptyLine}</p>}
      <PolicyChoiceList
        name={group}
        legend={label}
        choices={model.choices ?? []}
        picked={picked}
        disabled={false}
        marked={false}
        suggestedId={null}
        onPick={(policyId) => setChoice({ mode: "set", value: { id: policyId } })}
        extra={model.canDefault
          ? { label: LISTING_SETTINGS_EDIT_WORDS.useDefault, checked: choice.mode === "default", onPick: () => setChoice({ mode: "default" }) }
          : undefined}
      />
      {message && <p role="alert" className="text-sm text-amber-900">{message}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={onCancel}>
          {LISTING_SETTINGS_SAVE_WORDS.cancel}
        </Button>
        <Button
          type="button"
          size="sm"
          className="min-h-11 sm:min-h-9"
          disabled={!fieldChoiceReady(model, choice)}
          onClick={() => onDone(choice)}
        >
          {LISTING_SETTINGS_EDIT_WORDS.done}
        </Button>
      </div>
    </div>
  );
}
