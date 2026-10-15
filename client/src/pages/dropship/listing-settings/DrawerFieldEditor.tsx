import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EbayStoreCategoryCombobox } from "@/components/dropship/EbayStoreCategoryCombobox";
import { Button } from "@/components/ui/button";
import { bulkFieldChoiceReady, bulkStoreShelfEditorChoice } from "@/lib/dropship-listing-settings-bulk";
import { EBAY_CATEGORY_DEFAULT_WORDS } from "@/lib/dropship-listing-settings-content-requests";
import { LISTING_SETTINGS_SAVE_WORDS } from "@/lib/dropship-listing-settings-drafts";
import {
  ebayCategoryChoiceLabel,
  ebayCategoryChoiceReady,
  ebayCategoryPick,
  fieldChoiceReady,
  storeShelfEditorChoice,
  type EbayCategoryChoiceValue,
  type EbayCategoryFieldEditorModel,
  type FieldChoice,
  type PolicyChoiceValue,
  type PolicyFieldEditorModel,
  type StoreShelfChoiceValue,
  type StoreShelfEditorState,
  type StoreShelfFieldEditorModel,
} from "@/lib/dropship-listing-settings-product-edit";
import { STORE_DEFAULT_EDITOR_WORDS } from "@/lib/dropship-listing-settings-store-requests";
import { fieldEditorLabel, LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS } from "@/lib/dropship-listing-settings-words";
import { cn } from "@/lib/utils";
import { DropshipEbayCategoryPicker } from "../DropshipEbayCategoryPicker";
import { PolicyChoiceList } from "./PolicyChoiceList";

/** What every drawer field editor takes besides its model (plan 4.5, 5.2). */
interface FieldEditorBaseProps {
  /** The row's name ("Shipping policy"), read out for the group. */
  title: string;
  /** The product, so a screen reader names whose setting this is (plan 3.4). */
  productName: string;
  /** Why [Done] didn't take the choice ("Save or discard your other change first."); null for nothing. */
  message: string | null;
  /** Closes the editor and drops the pick; Esc does the same (the drawer routes it here). */
  onCancel: () => void;
  /**
   * "Set for selected"'s mode (PR 10 plan 6.3, UX-m5): the editor also offers
   * "Leave as is" (REC:854's Leave), which [Done] takes to put the row back to
   * no change, and opens on it while the row holds none. Left out, the drawer's.
   */
  bulk?: boolean;
  /**
   * The words of the default choice: the drawer's "Use default" (it follows the
   * category, else the store default), or the category editor's "Use store
   * default" (PR 10e, D17). Left out, "Use default".
   */
  defaultLabel?: string;
}

export interface DrawerFieldEditorProps extends FieldEditorBaseProps {
  /** What the editor lists and where it starts (`policyFieldEditor`). */
  model: PolicyFieldEditorModel;
  /** Puts the choice in the drawer's draft; nothing is sent until Save. */
  onDone: (choice: FieldChoice<PolicyChoiceValue>) => void;
}

const FOCUSABLE = "input:not([disabled]), textarea:not([disabled]), button:not([disabled])";

/**
 * The frame every drawer field editor shares (plan 3.4, 4.5): a group named
 * "<Setting> for <Product>", its title, the editor's choices, the words for a
 * [Done] that didn't take, and [Cancel] [Done]. It opens in place under its
 * row on every width, so the drawer stays the only surface (D20). Focus moves
 * into it when it opens, to the picked choice, else the first one that can
 * be used; the drawer gives focus back to the row's [Change] when it closes.
 */
export function FieldEditorFrame({ testId, title, productName, message, doneDisabled, doneLabel = LISTING_SETTINGS_EDIT_WORDS.done, onDone, onCancel, children }: FieldEditorBaseProps & {
  testId: string;
  doneDisabled: boolean;
  /** The main button's words when they aren't [Done]: the price editor's [Check new prices] (PR 10d). */
  doneLabel?: string;
  onDone: () => void;
  children: ReactNode;
}) {
  const label = fieldEditorLabel(title, productName);
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const checked = panel.querySelector<HTMLElement>("input:checked:not([disabled])");
    (checked ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel).focus();
  }, []);
  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="group"
      aria-label={label}
      data-testid={testId}
      className="mt-2 min-w-0 space-y-3 rounded-md border border-zinc-200 bg-zinc-50 p-3 outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0] sm:col-span-3"
    >
      <p aria-hidden="true" className="text-sm font-semibold text-zinc-900">{title}</p>
      {children}
      {message && <p role="alert" className="text-sm text-amber-900">{message}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={onCancel}>
          {LISTING_SETTINGS_SAVE_WORDS.cancel}
        </Button>
        <Button type="button" size="sm" className="min-h-11 sm:min-h-9" disabled={doneDisabled} onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </div>
  );
}

/** One radio choice of a drawer editor, at least 44 px high (plan 3.4). */
export function ChoiceRadio({ name, label, checked, disabled = false, onPick, children }: {
  name: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onPick: () => void;
  /** Shown under the label inside the same choice (a picked category's path, say). */
  children?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex min-h-11 items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 text-sm",
        disabled ? "cursor-not-allowed bg-zinc-50" : "cursor-pointer",
        checked && "border-[#C060E0]",
      )}
    >
      <input type="radio" name={name} className="mt-0.5 h-4 w-4 shrink-0 accent-[#C060E0]" checked={checked} disabled={disabled} onChange={onPick} />
      <span className="min-w-0">
        <span className="block break-words font-medium text-zinc-900">{label}</span>
        {children}
      </span>
    </label>
  );
}

/**
 * A policy row's inline editor (Listing settings PR 10, plan 4.5): eBay's
 * policies of the row's kind as a radio list, with whether each shipping
 * policy works with Card Shellz shipping, and "Use default" (the category's
 * setting, else the store default; REC:854, REC:857). [Done] puts the
 * choice in the drawer's one draft; nothing is sent until the drawer's Save.
 */
export function DrawerFieldEditor({
  model, title, productName, message, onDone, onCancel, bulk = false, defaultLabel = LISTING_SETTINGS_EDIT_WORDS.useDefault,
}: DrawerFieldEditorProps) {
  const group = useId();
  const [choice, setChoice] = useState<FieldChoice<PolicyChoiceValue>>(model.initial);
  const picked = choice.mode === "set" ? choice.value.id : null;
  return (
    <FieldEditorFrame
      testId={`drawer-field-editor-${model.field}`}
      title={title}
      productName={productName}
      message={message}
      doneDisabled={!(bulk ? bulkFieldChoiceReady(model, choice) : fieldChoiceReady(model, choice))}
      onDone={() => onDone(choice)}
      onCancel={onCancel}
    >
      {model.emptyLine && <p className="text-sm text-zinc-700">{model.emptyLine}</p>}
      <PolicyChoiceList
        name={group}
        legend={fieldEditorLabel(title, productName)}
        choices={model.choices ?? []}
        picked={picked}
        disabled={false}
        marked={false}
        suggestedId={null}
        onPick={(policyId) => setChoice({ mode: "set", value: { id: policyId } })}
        leading={bulk
          ? { label: LISTING_SETTINGS_BULK_WORDS.leaveAsIs, checked: choice.mode === "leave", onPick: () => setChoice({ mode: "leave" }) }
          : undefined}
        extra={model.canDefault
          ? { label: defaultLabel, checked: choice.mode === "default", onPick: () => setChoice({ mode: "default" }) }
          : undefined}
      />
    </FieldEditorFrame>
  );
}

export interface DrawerEbayCategoryEditorProps extends FieldEditorBaseProps {
  /** Where it starts and what can be chosen (`ebayCategoryFieldEditor`). */
  model: EbayCategoryFieldEditorModel;
  /** The store whose eBay site the picker searches. */
  storeConnectionId: number;
  onDone: (choice: FieldChoice<EbayCategoryChoiceValue>) => void;
}

/**
 * The eBay category row's inline editor (plan 5.2): the product's own
 * category (picked from eBay's own list with the picker the Store defaults
 * row uses, last level only, no numbers shown) or "Use default". The picker
 * shows only while a new category can be picked (W3's right, D4); under a
 * sign-in only "Use default" is left, and the row says why. Focus moves into
 * the picker's search when it opens, and to the picked category after a pick.
 */
export function DrawerEbayCategoryEditor({
  model, storeConnectionId, title, productName, message, onDone, onCancel, bulk = false, defaultLabel = LISTING_SETTINGS_EDIT_WORDS.useDefault,
}: DrawerEbayCategoryEditorProps) {
  const group = useId();
  const [choice, setChoice] = useState<FieldChoice<EbayCategoryChoiceValue>>(model.initial);
  // The category of its own the editor offers: the one it opened on, else the last one picked here.
  const [own, setOwn] = useState<EbayCategoryChoiceValue | null>(model.initial.mode === "set" ? model.initial.value : null);
  const [picking, setPicking] = useState(false);
  // Where focus goes once the picker opened or closed, so it never falls to the page (plan 3.4).
  const [focusNext, setFocusNext] = useState<"search" | "choice" | "pick_button" | null>(null);
  const areaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (focusNext === null || !area) return;
    const target = focusNext === "search" ? area.querySelector<HTMLElement>("input:not([type='radio'])")
      : focusNext === "choice" ? area.querySelector<HTMLElement>("input[type='radio']:checked")
        : area.querySelector<HTMLElement>("[data-pick-category]");
    target?.focus();
    setFocusNext(null);
  }, [focusNext]);
  return (
    <FieldEditorFrame
      testId="drawer-field-editor-ebayCategory"
      title={title}
      productName={productName}
      message={message}
      doneDisabled={!(bulk ? bulkFieldChoiceReady(model, choice) : ebayCategoryChoiceReady(model, choice))}
      onDone={() => onDone(choice)}
      onCancel={onCancel}
    >
      <div ref={areaRef} className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="sr-only">{fieldEditorLabel(title, productName)}</legend>
          {bulk && (
            <ChoiceRadio name={group} label={LISTING_SETTINGS_BULK_WORDS.leaveAsIs} checked={choice.mode === "leave"} onPick={() => setChoice({ mode: "leave" })} />
          )}
          {own !== null && model.canSet && (
            <ChoiceRadio
              name={group}
              label={ebayCategoryChoiceLabel(own)}
              checked={choice.mode === "set"}
              onPick={() => setChoice({ mode: "set", value: own })}
            />
          )}
          {model.canDefault && (
            <ChoiceRadio name={group} label={defaultLabel} checked={choice.mode === "default"} onPick={() => setChoice({ mode: "default" })} />
          )}
        </fieldset>
        {model.canSet && !picking && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            data-pick-category=""
            onClick={() => {
              setPicking(true);
              setFocusNext("search");
            }}
          >
            {own === null ? EBAY_CATEGORY_DEFAULT_WORDS.pickCategory : EBAY_CATEGORY_DEFAULT_WORDS.pickAnother}
          </Button>
        )}
        {model.canSet && picking && (
          <DropshipEbayCategoryPicker
            storeConnectionId={storeConnectionId}
            label={EBAY_CATEGORY_DEFAULT_WORDS.pickCategory}
            initialQuery={model.initialQuery}
            onPick={(category) => {
              const picked = ebayCategoryPick(category);
              if (picked.mode === "set") setOwn(picked.value);
              setChoice(picked);
              setPicking(false);
              setFocusNext("choice");
            }}
            onCancel={() => {
              setPicking(false);
              setFocusNext("pick_button");
            }}
            hideIds
            showLeafHint
          />
        )}
      </div>
    </FieldEditorFrame>
  );
}

export interface DrawerShelfEditorProps extends FieldEditorBaseProps {
  /** Where it starts, the shelves to pick from and what can be chosen (`storeShelfFieldEditor`). */
  model: StoreShelfFieldEditorModel;
  onDone: (choice: FieldChoice<StoreShelfChoiceValue>) => void;
}

/**
 * The store shelf row's inline editor (plan 5.2): one or two of the vendor's
 * eBay store shelves of its own (the Store defaults row's picker, the first
 * and an optional second, picked independently; no ids shown), "None" or
 * "Use default". Picking a shelf chooses "Own shelves". "None" and "Use
 * default" name no eBay value, so they stay while eBay needs a sign-in (D4).
 */
export function DrawerShelfEditor({
  model, title, productName, message, onDone, onCancel, bulk = false, defaultLabel = LISTING_SETTINGS_EDIT_WORDS.useDefault,
}: DrawerShelfEditorProps) {
  const group = useId();
  const [state, setState] = useState<StoreShelfEditorState>(model.initial);
  const result = bulk ? bulkStoreShelfEditorChoice(model, state) : storeShelfEditorChoice(model, state);
  const options = model.options;
  const canPick = model.canSet && options !== null && options.length > 0;
  const pickShelves = (next: Pick<StoreShelfEditorState, "first" | "second">) => setState({ mode: "own", ...next });
  return (
    <FieldEditorFrame
      testId="drawer-field-editor-storeShelf"
      title={title}
      productName={productName}
      message={message}
      doneDisabled={!result.ok}
      onDone={() => { if (result.ok) onDone(result.choice); }}
      onCancel={onCancel}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">{fieldEditorLabel(title, productName)}</legend>
        {bulk && (
          <ChoiceRadio name={group} label={LISTING_SETTINGS_BULK_WORDS.leaveAsIs} checked={state.mode === "leave"} onPick={() => setState({ ...state, mode: "leave" })} />
        )}
        {canPick && (
          <>
            <ChoiceRadio name={group} label={LISTING_SETTINGS_EDIT_WORDS.ownShelves} checked={state.mode === "own"} onPick={() => setState({ ...state, mode: "own" })} />
            <div className="grid gap-3 pl-7 sm:grid-cols-2">
              <div className="min-w-0 space-y-1">
                <p aria-hidden="true" className="text-xs text-zinc-700">{STORE_DEFAULT_EDITOR_WORDS.shelf}</p>
                <EbayStoreCategoryCombobox
                  ariaLabel={fieldEditorLabel(STORE_DEFAULT_EDITOR_WORDS.shelf, productName)}
                  categories={options}
                  value={state.first}
                  placeholder={LISTING_SETTINGS_EDIT_WORDS.pickShelf}
                  clearLabel={LISTING_SETTINGS_EDIT_WORDS.clearShelf}
                  searchPlaceholder={STORE_DEFAULT_EDITOR_WORDS.shelfSearch}
                  emptyMessage={STORE_DEFAULT_EDITOR_WORDS.shelfSearchEmpty}
                  hideIds
                  // The two boxes are independent: changing the first never changes the second (R:581).
                  onValueChange={(first) => pickShelves({ first, second: state.second })}
                />
              </div>
              <div className="min-w-0 space-y-1">
                <p aria-hidden="true" className="text-xs text-zinc-700">{STORE_DEFAULT_EDITOR_WORDS.secondShelf}</p>
                <EbayStoreCategoryCombobox
                  ariaLabel={fieldEditorLabel(STORE_DEFAULT_EDITOR_WORDS.secondShelf, productName)}
                  categories={options}
                  value={state.second}
                  placeholder={LISTING_SETTINGS_EDIT_WORDS.pickShelf}
                  clearLabel={LISTING_SETTINGS_EDIT_WORDS.clearShelf}
                  searchPlaceholder={STORE_DEFAULT_EDITOR_WORDS.shelfSearch}
                  emptyMessage={STORE_DEFAULT_EDITOR_WORDS.shelfSearchEmpty}
                  hideIds
                  // Off until a first shelf is picked, unless a second one is left to clear.
                  disabled={state.first === null && state.second === null}
                  onValueChange={(second) => pickShelves({ first: state.first, second })}
                />
              </div>
            </div>
          </>
        )}
        {model.canNone && (
          <ChoiceRadio name={group} label={LISTING_SETTINGS_EDIT_WORDS.none} checked={state.mode === "none"} onPick={() => setState({ ...state, mode: "none" })} />
        )}
        {model.canDefault && (
          <ChoiceRadio name={group} label={defaultLabel} checked={state.mode === "default"} onPick={() => setState({ ...state, mode: "default" })} />
        )}
      </fieldset>
      {model.canSet && options !== null && options.length === 0 && <p className="text-sm text-zinc-700">{STORE_DEFAULT_EDITOR_WORDS.noShelves}</p>}
      {!result.ok && result.problem !== null && <p role="alert" className="text-sm text-rose-800">{result.problem}</p>}
    </FieldEditorFrame>
  );
}
