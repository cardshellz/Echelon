import { useId, useState } from "react";
import {
  PRODUCT_PRICE_EDITOR_WORDS,
  productPriceEditorResult,
  type ProductPriceEditorModel,
  type ProductPriceEditorState,
} from "@/lib/dropship-listing-settings-price-check";
import type { ProductPriceChange } from "@/lib/dropship-listing-settings-product-edit";
import type { PriceRecipeField } from "@/lib/dropship-listing-settings-recipe";
import { rightReasonLine } from "@/lib/dropship-listing-settings-words";
import { ChoiceRadio, FieldEditorFrame } from "./DrawerFieldEditor";
import { PriceEditorView } from "./PriceDefaultRow";

type FieldErrors = Partial<Record<"percent" | "flat", string>>;

export interface ProductPriceEditorProps {
  /** What can be chosen and where the editor opens (`productPriceEditorModel`). */
  model: ProductPriceEditorModel;
  /** The row's name ("Price"), read out for the group. */
  title: string;
  /** The product, or "the selected products", so a screen reader names whose price this is (plan 3.4). */
  productName: string;
  /** Why [Check new prices] didn't take ("Save or discard your other change first.") or the check failed; null for nothing. */
  message: string | null;
  /** A check is running: the fields and the button wait. */
  checking: boolean;
  /** The owner's draft is locked (a save out or unconfirmed): nothing can change. */
  locked: boolean;
  /** [Check new prices]: the choice goes in the owner's draft and the check runs; nothing is saved until Save new prices. */
  onCheck: (change: Pick<ProductPriceChange, "price" | "releaseExactPrices">) => void;
  /** [Cancel] or Esc: the editor closes and drops what was typed. */
  onCancel: () => void;
  /** The default's words: the drawer's "Use default", or the category editor's "Use store default" (D17; PR 10f). */
  defaultLabel?: string;
  /** Whether "Clear exact prices too" is offered; a category check releases nothing (PR 10f), so its editor leaves it out. */
  release?: boolean;
}

/**
 * The product's price editor (Listing settings PR 10d, plan 7.2): "Use
 * default" (the category's price, else the store price; REC:854, REC:857) or
 * "Set price" with W1's recipe fields (`PriceEditorView`, without its
 * pricing-rules read), and "Clear exact prices too, so every size uses this
 * price". [Check new prices] parses the recipe with the integer parsers (D1,
 * `productPriceEditorResult`) and hands the change to its owner, the drawer's
 * PRICE head or "Set for selected"'s Price row, which checks it (W7). It
 * opens in place, so the owner stays the only surface (D20). Nothing here
 * computes a price.
 */
export function ProductPriceEditor({
  model, title, productName, message, checking, locked, onCheck, onCancel,
  defaultLabel = PRODUCT_PRICE_EDITOR_WORDS.useDefault, release = true,
}: ProductPriceEditorProps) {
  const group = useId();
  const [state, setState] = useState<ProductPriceEditorState>(model.initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [edited, setEdited] = useState(false);
  const waiting = checking || locked;
  const canChoose = model.canSet || model.canDefault;
  const reason = canChoose || model.reason === null ? null : rightReasonLine(model.reason);

  function edit(field: PriceRecipeField, next: string) {
    setEdited(true);
    setErrors((current) => (field in current ? withoutField(current, field) : current));
    setState((current) => ({ ...current, fields: { ...current.fields, [field]: next } }));
  }

  function check() {
    const result = productPriceEditorResult(model, state);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    onCheck(result.change);
  }

  return (
    <FieldEditorFrame
      testId="drawer-field-editor-price"
      title={title}
      productName={productName}
      message={message}
      doneDisabled={waiting || !canChoose || (state.mode === "set" ? !model.canSet : !model.canDefault)}
      doneLabel={checking ? PRODUCT_PRICE_EDITOR_WORDS.checking : PRODUCT_PRICE_EDITOR_WORDS.checkNewPrices}
      onDone={check}
      onCancel={onCancel}
    >
      {reason && <p className="text-sm text-zinc-600">{reason}</p>}
      {canChoose && (
        <fieldset disabled={waiting} className="space-y-2">
          <legend className="sr-only">{title}</legend>
          <ChoiceRadio name={group} label={defaultLabel} checked={state.mode === "default"} disabled={!model.canDefault}
            onPick={() => setState((current) => ({ ...current, mode: "default" }))} />
          <ChoiceRadio name={group} label={PRODUCT_PRICE_EDITOR_WORDS.setPrice} checked={state.mode === "set"} disabled={!model.canSet}
            onPick={() => setState((current) => ({ ...current, mode: "set" }))} />
          {state.mode === "set" && (
            // The fields sit under the choice, never inside its label: a label holds no fields of its own.
            <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-3" data-testid="drawer-price-fields">
              {model.suggestion && !edited && (
                // R:205: the fields start from the store price or the suggestion, not a price of the product's; not a change until edited.
                <p className="text-xs font-medium text-amber-800" data-testid="price-suggested">{PRODUCT_PRICE_EDITOR_WORDS.suggested}</p>
              )}
              <PriceEditorView
                read="ready"
                onRetryRead={noop}
                value={state.fields}
                onChange={edit}
                locked={waiting}
                suggested={false}
                errors={errors}
                marked={[]}
                reason={null}
                message={null}
              />
            </div>
          )}
          {release && (
            <label className="flex min-h-11 items-start gap-3 rounded-md border border-zinc-200 bg-white p-3 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#C060E0]" checked={state.releaseExactPrices}
                onChange={(event) => setState((current) => ({ ...current, releaseExactPrices: event.target.checked }))} />
              <span className="min-w-0 break-words text-zinc-900">{PRODUCT_PRICE_EDITOR_WORDS.clearExactPrices}</span>
            </label>
          )}
        </fieldset>
      )}
    </FieldEditorFrame>
  );
}

const noop = () => undefined;

function withoutField(errors: FieldErrors, field: PriceRecipeField): FieldErrors {
  const next = { ...errors };
  delete next[field as keyof FieldErrors];
  return next;
}
