import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bulkDescriptionEditorResult, type BulkPicks } from "@/lib/dropship-listing-settings-bulk";
import { categoryDescriptionEditorResult, type CategoryDescriptionField, type CategoryPicks } from "@/lib/dropship-listing-settings-categories";
import {
  descriptionEditorAnswer,
  descriptionEditorCheck,
  descriptionEditorResult,
  textCounter,
  type DescriptionEditField,
  type DescriptionEditorModel,
  type DescriptionEditorState,
  type FieldChoice,
  type MainTextChoiceValue,
  type MainTextEditorState,
  type OwnTextCheck,
  type ProductSettingsPicks,
  type TemplateTextEditorState,
} from "@/lib/dropship-listing-settings-product-edit";
import { fieldEditorLabel, LISTING_SETTINGS_BULK_WORDS, LISTING_SETTINGS_EDIT_WORDS, textLengthWords } from "@/lib/dropship-listing-settings-words";
import { cn } from "@/lib/utils";
import { ChoiceRadio, FieldEditorFrame } from "./DrawerFieldEditor";

interface DescriptionEditorBaseProps {
  /** Where each part starts and what can be chosen (`descriptionFieldEditor`, or `bulkDescriptionFieldEditor`). */
  model: DescriptionEditorModel;
  /** The row's name ("Description"). */
  title: string;
  /** The product, so a screen reader names whose text this is (plan 3.4). */
  productName: string;
  /** Why [Done] didn't take the change ("Save or discard your other change first."); null for nothing. */
  message: string | null;
  /** Closes the editor and drops what was typed; Esc does the same (the drawer routes it here). */
  onCancel: () => void;
  /** The words of each part's default choice: "Use default", or the category editor's "Use store default" (PR 10e, D17). */
  defaultLabel?: string;
}

export type DrawerDescriptionEditorProps = DescriptionEditorBaseProps & (
  | {
    /** The drawer's (one product). */
    bulk?: false;
    category?: false;
    /** Puts the parts the vendor changed in the drawer's draft; nothing is sent until Save. */
    onDone: (picks: Pick<ProductSettingsPicks, DescriptionEditField>) => void;
  }
  | {
    /**
     * "Set for selected"'s mode (PR 10 plan 6.3): each part also offers "Leave
     * as is" (a part taken back to it is no change), and the main text only "Use
     * Card Shellz text" (the model's `mainTextOwn: false`).
     */
    bulk: true;
    category?: false;
    /** Puts the parts the vendor changed in the sheet's draft; nothing is sent until Save. */
    onDone: (picks: Pick<BulkPicks, DescriptionEditField>) => void;
  }
  | {
    /**
     * The category editor's mode (PR 10e, plan 8.2): text above and below only,
     * since a category has no main text (that part is not shown), with "Use
     * store default" for the default (D17).
     */
    category: true;
    bulk?: false;
    /** Puts the parts the vendor changed in the category's draft; nothing is sent until Save. */
    onDone: (picks: Pick<CategoryPicks, CategoryDescriptionField>) => void;
  });

type Problems = Partial<Record<DescriptionEditField, string>>;

/**
 * The Description row's inline editor (Listing settings PR 10, plan 5.2,
 * 5.4): text above and text below (Use default / None / Own text, up to 4,000
 * characters each) and the main text (Use Card Shellz text / Own text, up to
 * 20,000), each own text prefilled with what the product has. Counters count
 * the text as typed, as the server does; [Done] checks each own text with the
 * shared rules first, and text that can't be saved stays here with its words
 * under its box (a problem is only ever an own text's), so nothing is sent
 * (5.5). While Card Shellz changed the product under the vendor's own main
 * text, the check's two answers sit on top of the main text until it is
 * edited (5.4). Every decision is the lib's (`descriptionEditorResult`,
 * `descriptionEditorCheck`).
 */
export function DrawerDescriptionEditor(props: DrawerDescriptionEditorProps) {
  const { model, title, productName, message, onCancel, defaultLabel = LISTING_SETTINGS_EDIT_WORDS.useDefault } = props;
  const bulk = props.bulk === true;
  const category = props.category === true;
  const [state, setState] = useState<DescriptionEditorState>(model.initial);
  const [problems, setProblems] = useState<Problems>({});
  const groupId = useId();

  const change = <F extends DescriptionEditField>(field: F, next: DescriptionEditorState[F]) => {
    setState((current) => ({ ...current, [field]: next }));
    // A part the vendor changes again is checked again at [Done].
    setProblems((current) => {
      if (current[field] === undefined) return current;
      const rest = { ...current };
      delete rest[field];
      return rest;
    });
  };
  const finish = (result: ReturnType<typeof descriptionEditorResult>) => {
    if (props.bulk === true || props.category === true) return;
    if (result.ok) props.onDone(result.picks);
    else setProblems(result.problems);
  };
  const done = () => {
    if (props.category === true) {
      // Never a main text: the part is not shown, and the result drops it.
      const result = categoryDescriptionEditorResult(model, state);
      if (result.ok) props.onDone(result.picks);
      else setProblems(result.problems);
      return;
    }
    if (props.bulk !== true) {
      finish(descriptionEditorResult(model, state));
      return;
    }
    const result = bulkDescriptionEditorResult(model, state);
    if (result.ok) props.onDone(result.picks);
    else setProblems(result.problems);
  };

  return (
    <FieldEditorFrame
      testId="drawer-field-editor-description"
      title={title}
      productName={productName}
      message={message}
      doneDisabled={false}
      onDone={done}
      onCancel={onCancel}
    >
      {model.conflictLine !== null && (
        <p className="text-sm font-medium text-amber-900" data-testid="drawer-description-conflict">{model.conflictLine}</p>
      )}
      <TemplatePart
        name={`${groupId}-above`}
        field="textAbove"
        label={LISTING_SETTINGS_EDIT_WORDS.textAbove}
        productName={productName}
        model={model}
        state={state.textAbove}
        bulk={bulk}
        defaultLabel={defaultLabel}
        problem={problems.textAbove ?? null}
        onChange={(next) => change("textAbove", next)}
      />
      {/* A category has no main text (PR 10e): its part stays at the model's initial, which the result drops. */}
      {!category && (
        <MainTextPart
          name={`${groupId}-main`}
          productName={productName}
          model={model}
          state={state.mainText}
          bulk={bulk}
          check={descriptionEditorCheck(model, state)}
          problem={problems.mainText ?? null}
          onChange={(next) => change("mainText", next)}
          onAnswer={(answer) => finish(descriptionEditorAnswer(model, state, answer))}
        />
      )}
      <TemplatePart
        name={`${groupId}-below`}
        field="textBelow"
        label={LISTING_SETTINGS_EDIT_WORDS.textBelow}
        productName={productName}
        model={model}
        state={state.textBelow}
        bulk={bulk}
        defaultLabel={defaultLabel}
        problem={problems.textBelow ?? null}
        onChange={(next) => change("textBelow", next)}
      />
    </FieldEditorFrame>
  );
}

/** Text above or below: Use default / None / Own text, and the box for own text. */
function TemplatePart({ name, field, label, productName, model, state, bulk, defaultLabel, problem, onChange }: {
  name: string;
  field: "textAbove" | "textBelow";
  label: string;
  productName: string;
  model: DescriptionEditorModel;
  state: TemplateTextEditorState;
  /** "Set for selected": "Leave as is" comes first. */
  bulk: boolean;
  /** "Use default", or the category editor's "Use store default" (D17). */
  defaultLabel: string;
  problem: string | null;
  onChange: (next: TemplateTextEditorState) => void;
}) {
  return (
    <fieldset className="space-y-2" data-testid={`drawer-description-${field}`}>
      <legend className="text-sm font-medium text-zinc-900">{label}</legend>
      {bulk && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_BULK_WORDS.leaveAsIs} checked={state.mode === "leave"} onPick={() => onChange({ ...state, mode: "leave" })} />
      )}
      {model.canDefault && (
        <ChoiceRadio name={name} label={defaultLabel} checked={state.mode === "default"} onPick={() => onChange({ ...state, mode: "default" })} />
      )}
      {model.canNone && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_EDIT_WORDS.none} checked={state.mode === "none"} onPick={() => onChange({ ...state, mode: "none" })} />
      )}
      {model.canSet && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_EDIT_WORDS.ownText} checked={state.mode === "own"} onPick={() => onChange({ ...state, mode: "own" })} />
      )}
      {model.canSet && state.mode === "own" && (
        <TextBox
          field={field}
          label={fieldEditorLabel(label, productName)}
          text={state.text}
          rows={3}
          problem={problem}
          onChange={(text) => onChange({ mode: "own", text })}
        />
      )}
    </fieldset>
  );
}

/** The main text: Use Card Shellz text / Own text, the box for own text, and the check when Card Shellz changed the product. */
function MainTextPart({ name, productName, model, state, bulk, check, problem, onChange, onAnswer }: {
  name: string;
  productName: string;
  model: DescriptionEditorModel;
  state: MainTextEditorState;
  /** "Set for selected": "Leave as is" comes first. */
  bulk: boolean;
  /** The check's notice while the main text is as it opened (`descriptionEditorCheck`); null otherwise. */
  check: OwnTextCheck | null;
  problem: string | null;
  onChange: (next: MainTextEditorState) => void;
  onAnswer: (answer: FieldChoice<MainTextChoiceValue>) => void;
}) {
  const label = LISTING_SETTINGS_EDIT_WORDS.mainText;
  // For many products the main text is only a reset (`mainTextOwn: false`): one text can't carry each product's catalog hash.
  const ownOffered = model.canSet && model.mainTextOwn !== false;
  return (
    <fieldset className="space-y-2" data-testid="drawer-description-mainText">
      <legend className="text-sm font-medium text-zinc-900">{label}</legend>
      {check !== null && <OwnTextCheckNotice check={check} productName={productName} disabled={false} onAnswer={onAnswer} />}
      {bulk && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_BULK_WORDS.leaveAsIs} checked={state.mode === "leave"} onPick={() => onChange({ ...state, mode: "leave" })} />
      )}
      {model.canDefault && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_EDIT_WORDS.useCardShellzText} checked={state.mode === "default"} onPick={() => onChange({ ...state, mode: "default" })} />
      )}
      {ownOffered && (
        <ChoiceRadio name={name} label={LISTING_SETTINGS_EDIT_WORDS.ownText} checked={state.mode === "own"} onPick={() => onChange({ ...state, mode: "own" })} />
      )}
      {ownOffered && state.mode === "own" && (
        <TextBox
          field="mainText"
          label={fieldEditorLabel(label, productName)}
          text={state.text}
          rows={8}
          problem={problem}
          onChange={(text) => onChange({ mode: "own", text })}
        />
      )}
    </fieldset>
  );
}

/**
 * One own-text box with its counter, "12 / 4,000" (the raw text's length, as
 * the server counts it; 5.4). Nothing stops the typing at the limit, so a
 * paste is never cut silently: the counter turns red and [Done] says how much
 * to shorten.
 */
function TextBox({ field, label, text, rows, problem, onChange }: {
  field: DescriptionEditField;
  label: string;
  text: string;
  rows: number;
  problem: string | null;
  onChange: (text: string) => void;
}) {
  const counterId = useId();
  const problemId = useId();
  const counter = textCounter(text, field);
  return (
    <div className="space-y-1">
      <Textarea
        aria-label={label}
        value={text}
        rows={rows}
        aria-invalid={counter.over || problem !== null ? true : undefined}
        aria-describedby={problem === null ? counterId : `${counterId} ${problemId}`}
        className="min-h-11 text-sm"
        data-testid={`drawer-description-${field}-text`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={counterId} className={cn("text-right text-xs", counter.over ? "font-medium text-rose-800" : "text-zinc-500")}>
        {textLengthWords(counter.count, counter.max)}
      </p>
      {problem !== null && <p id={problemId} role="alert" className="text-sm text-rose-800">{problem}</p>}
    </div>
  );
}

/**
 * "Card Shellz changed this product. Check your text still fits." with
 * [Keep my text] (the same text saved again, checked against the product as
 * it is now) and [Use Card Shellz text] (5.4). Each answer goes in the
 * drawer's draft like any change; nothing is sent until Save. Shown in the
 * Description row while its editor is closed, and on top of the main text
 * while it is open.
 */
export function OwnTextCheckNotice({ check, productName, disabled, onAnswer }: {
  check: OwnTextCheck;
  productName: string;
  /** Off while [Change] is (the own read loads, a save is out, or a size's price waits). */
  disabled: boolean;
  onAnswer: (answer: FieldChoice<MainTextChoiceValue>) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" data-testid="drawer-own-text-check">
      <p>{LISTING_SETTINGS_EDIT_WORDS.ownTextCheck}</p>
      <div className="flex flex-wrap gap-2">
        {check.keep !== null && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-11 sm:min-h-9"
            aria-label={fieldEditorLabel(LISTING_SETTINGS_EDIT_WORDS.keepMyText, productName)}
            disabled={disabled}
            onClick={() => { if (check.keep !== null) onAnswer(check.keep); }}
          >
            {LISTING_SETTINGS_EDIT_WORDS.keepMyText}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-11 sm:min-h-9"
          aria-label={fieldEditorLabel(LISTING_SETTINGS_EDIT_WORDS.useCardShellzText, productName)}
          disabled={disabled}
          onClick={() => onAnswer(check.useCardShellz)}
        >
          {LISTING_SETTINGS_EDIT_WORDS.useCardShellzText}
        </Button>
      </div>
    </div>
  );
}
