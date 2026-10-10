import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import type { PricingProfileState, PricingRecipe } from "@shared/dropship/pricing-rules";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_SAVE_WORDS,
  STORE_DEFAULT_LABELS,
  type DraftValue,
} from "@/lib/dropship-listing-settings-drafts";
import { recipeWords } from "@/lib/dropship-listing-settings-price-words";
import {
  CHECK_NEW_PRICES_WORDS,
  checkPricingReviewPage,
  decideAfterStaleApply,
  fetchPricingReviewPage,
  isPriceSuggestion,
  PRICE_DEFAULT_WORDS,
  PriceDefaultRequestError,
  priceBaseMoved,
  priceDefaultBase,
  priceEditorFooter,
  pricingApplySignature,
  pricingRulesQueryOptions,
  readPriceRecipeDraft,
  recipeFromDraft,
  refreshAfterPricingApply,
  rereadPricingRules,
  runPriceCheck,
  runPricingApply,
  sendPricingApply,
  sendPricingReview,
  type PriceEditorFooter,
  type PriceRecipeDraft,
  type PriceRecipeField,
  type PriceSaveCallbacks,
} from "@/lib/dropship-listing-settings-recipe";
import { rightReasonLine } from "@/lib/dropship-listing-settings-words";
import { SUGGESTED_PRICING_RECIPE } from "@/lib/dropship-pricing-rules";
import { CheckNewPricesSheet, type CheckedPrices } from "./CheckNewPricesSheet";
import { EditorSurface, type FocusReturnTarget } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { StoreDefaultRow } from "./StoreDefaultRow";

const EDITOR = "price" as const;
const PLACE = STORE_DEFAULT_LABELS.price;

export interface PriceDefaultRowProps {
  storeConnectionId: number;
  /** The summary's store price (`summary.storeDefaults.price`); null until the summary answers. */
  saved: ListingSettingsSummary["storeDefaults"]["price"] | null;
  /** `rights.price` (plan 4.3). */
  right: ListingSettingsRight;
  /** The page's pending-save counter (D10). */
  saveCallbacks: PriceSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A check or save refused because of a block a banner explains (plan 4.4). The draft is kept. */
  onBlocked?: (error: unknown) => void;
}

type FieldErrors = Partial<Record<"percent" | "flat", string>>;

/**
 * The Store defaults row "Price" (R:174-183) and its editor, with "Check new
 * prices" (M3, W1). The closed row reads the summary. The saved pricing rules
 * are read only while the editor is open and W1 would take a save (D8), and
 * read again after every save (D9). A check sends every older group rule back
 * unchanged and keeps exact prices; nothing is saved until [Save new prices].
 */
export function PriceDefaultRow({ storeConnectionId, saved, right, saveCallbacks, onSaved, onBlocked }: PriceDefaultRowProps) {
  const drafts = useListingSettingsDrafts();
  const queryClient = useQueryClient();
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const checkButtonRef = useRef<HTMLButtonElement | null>(null);
  const draft = drafts.draft?.editor === EDITOR ? drafts.draft : null;
  const editorOpen = draft?.open === true;
  const rules = useQuery(pricingRulesQueryOptions(storeConnectionId, { editorOpen, right }));
  const state = rules.data ?? null;
  const summaryRecipe = saved?.recipe ?? null;
  const value = draft ? readPriceRecipeDraft(draft.value) : null;
  const suggestion = isPriceSuggestion(state, summaryRecipe);

  const [checked, setChecked] = useState<CheckedPrices | null>(null);
  const [checking, setChecking] = useState(false);
  const [paging, setPaging] = useState(false);
  const [reading, setReading] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  /** Editor words outside the draft: a check that failed, a read that failed. */
  const [editorMessage, setEditorMessage] = useState<string | null>(null);
  /** Sheet words outside the draft: a page that didn't load, a save held back. */
  const [sheetMessage, setSheetMessage] = useState<string | null>(null);
  // A second click before React re-renders must not send a second check.
  const checkInFlight = useRef(false);
  // A check that comes back after Cancel or Back (or after the editor closed) is dropped, never shown.
  const checkGeneration = useRef(0);
  const latestDraft = useRef(draft);
  latestDraft.current = draft;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  // Focus goes back to [Check new prices] when the check closes, or to [Change] once the editor has closed too.
  const sheetFocus = useMemo<FocusReturnTarget>(() => ({
    get current() {
      const check = checkButtonRef.current;
      return check && check.isConnected ? check : changeRef.current;
    },
  }), []);

  // An unchanged draft follows what is saved, so the editor always starts from the latest store price.
  const { open: openDraft } = drafts;
  useEffect(() => {
    if (!state || !draft?.open || draft.phase !== "editing" || draft.message !== null || isDraftDirty(draft) || checked) return;
    const latest = priceDefaultBase(state, null);
    if (priceBaseMoved(draft.base, latest)) openDraft(EDITOR, PLACE, { ...latest });
  }, [state, draft, openDraft, checked]);

  function openEditor() {
    setEditorMessage(null);
    setFieldErrors({});
    // The rules read starts as the editor opens; until it answers the editor shows "Checking…".
    drafts.open(EDITOR, PLACE, { ...priceDefaultBase(state, summaryRecipe) });
  }

  function edit(field: PriceRecipeField, next: string) {
    if (!value) return;
    setEditorMessage(null);
    setFieldErrors((current) => (field in current ? withoutField(current, field) : current));
    drafts.edit({ ...value, [field]: next });
  }

  function cancel() {
    checkGeneration.current += 1;
    setChecked(null);
    setEditorMessage(null);
    setFieldErrors({});
    drafts.discard();
  }

  /** Checks `recipe` against the saved profile `start` (`runPriceCheck`) and shows the check, or why not. */
  async function checkPrices(base: DraftValue, recipe: PricingRecipe, start: PricingProfileState, staleNotice: boolean) {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    const generation = checkGeneration.current;
    setChecking(true);
    setEditorMessage(null);
    setSheetMessage(null);
    try {
      const outcome = await runPriceCheck({
        base,
        recipe,
        start,
        drafts,
        send: (input) => sendPricingReview(storeConnectionId, input),
        reread: () => rereadPricingRules(queryClient, storeConnectionId),
      });
      if (!mounted.current || generation !== checkGeneration.current || latestDraft.current?.open !== true) return;
      switch (outcome.kind) {
        case "checked":
          setChecked({ review: outcome.review, profile: outcome.request.profile, expectedRevisionId: outcome.request.expectedRevisionId, stale: staleNotice });
          return;
        case "conflict":
          // The draft shows "This changed in another window." with [Load latest and keep my changes].
          setChecked(null);
          return;
        case "blocked":
          setChecked(null);
          onBlocked?.(outcome.error);
          setEditorMessage(LISTING_SETTINGS_SAVE_WORDS.blocked);
          return;
        case "failed":
          setChecked(null);
          setEditorMessage(outcome.message);
          return;
      }
    } finally {
      checkInFlight.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  function checkNewPrices() {
    if (!draft || !value || !state) return;
    let recipe: PricingRecipe;
    try {
      const parsed = recipeFromDraft(value);
      if (!parsed.ok) {
        setFieldErrors(parsed.errors);
        return;
      }
      recipe = parsed.recipe;
    } catch (error) {
      setEditorMessage(error instanceof PriceDefaultRequestError ? error.message : PRICE_DEFAULT_WORDS.reviewFailed);
      return;
    }
    setFieldErrors({});
    void checkPrices(draft.base, recipe, state, false);
  }

  async function saveNewPrices(action: "save" | "resend") {
    const shown = checked;
    if (!draft || !value) return;
    // Check again sends the draft's last request with its key, even when the check on screen is gone
    // (the row was left and opened again); a save sends this check (one key per check).
    const signature = action === "resend" ? draft.attempt?.signature ?? null : shown ? pricingApplySignature(shown.review) : null;
    if (signature === null) return;
    const base = draft.base;
    setSheetMessage(null);
    const outcome = await runPricingApply({
      signature,
      drafts,
      callbacks: saveCallbacks,
      send: (input) => sendPricingApply(storeConnectionId, input),
      reread: () => refreshAfterPricingApply(queryClient, storeConnectionId),
      onSaved,
      onBlocked,
    });
    if (!mounted.current) return;
    switch (outcome.kind) {
      case "not_started":
        if (outcome.message) setSheetMessage(outcome.message);
        return;
      case "saved":
        // The row redraws from the summary; "Saved" shows beside it for 3 seconds.
        setChecked(null);
        drafts.close();
        return;
      case "failed":
        switch (outcome.failure.phase) {
          case "conflict":
            if (shown) await afterStaleApply(base, value, shown);
            else setChecked(null);
            return;
          case "uncertain":
          case "unreachable":
          case "rate_limited":
            // The check stays: Check again (or Save, after a rate limit) sends the same apply with the same key.
            return;
          default:
            // Refused, blocked or out of date: this check is spent. The editor says why.
            setChecked(null);
            return;
        }
    }
  }

  /**
   * A 409 stale save (R:683): someone else's save keeps the conflict and
   * closes the check. If only prices or costs moved, the check runs again and
   * says so, and the vendor must press Save again on the new check.
   */
  async function afterStaleApply(base: DraftValue, mine: PriceRecipeDraft, shown: CheckedPrices) {
    // The check on screen is out of date: Save stays off until this is decided.
    const generation = checkGeneration.current;
    setChecking(true);
    const next = await decideAfterStaleApply(shown.expectedRevisionId, () => rereadPricingRules(queryClient, storeConnectionId));
    if (!mounted.current) return;
    setChecking(false);
    // The vendor went back to editing meanwhile: the conflict state stays until their next check or save.
    if (generation !== checkGeneration.current) return;
    if (next.kind === "conflict") {
      setChecked(null);
      return;
    }
    // Nothing anyone saved moved: the conflict state is lifted (the same value is the vendor's draft again).
    drafts.edit({ ...mine });
    await checkPrices(base, shown.profile.defaultRecipe, next.latest, true);
  }

  async function loadLatest() {
    setReading(true);
    setEditorMessage(null);
    try {
      const fresh = await rereadPricingRules(queryClient, storeConnectionId);
      drafts.rebase({ ...priceDefaultBase(fresh, null) });
    } catch {
      // The read's own error is not vendor words; the conflict stays, and the button can be pressed again.
      setEditorMessage(PRICE_DEFAULT_WORDS.readFailed);
    } finally {
      setReading(false);
    }
  }

  async function reloadAfterSave() {
    setReading(true);
    try {
      await rereadPricingRules(queryClient, storeConnectionId);
      drafts.discard();
    } catch {
      setEditorMessage(PRICE_DEFAULT_WORDS.readFailed);
    } finally {
      setReading(false);
    }
  }

  async function showPage(page: number) {
    const shown = checked;
    if (!shown || paging) return;
    setPaging(true);
    setSheetMessage(null);
    try {
      const result = checkPricingReviewPage(shown.review, await fetchPricingReviewPage(storeConnectionId, shown.review.reviewId, page));
      if (!mounted.current) return;
      setChecked((current) => (current && current.review.reviewId === result.reviewId ? { ...current, review: result, stale: false } : current));
    } catch {
      if (mounted.current) setSheetMessage(CHECK_NEW_PRICES_WORDS.pageFailed);
    } finally {
      if (mounted.current) setPaging(false);
    }
  }

  function backToEditing() {
    checkGeneration.current += 1;
    setChecked(null);
    setSheetMessage(null);
  }

  const footer = priceEditorFooter({
    draft,
    ready: state !== null && value !== null,
    editable: right.editable,
    busy: saveCallbacks.disabled === true || reading,
    checking,
    suggestion,
  });
  const dirty = isDraftDirty(draft);
  const savedFlash = drafts.savedFlashVisible && draft !== null;
  const staleView = draft?.phase === "saved_view_stale" && !draft.open;
  const notSet = saved !== null && saved.recipe === null;
  const reason = right.editable ? null : rightReasonLine(right.reason);
  const sheetPhase = checked ? draft?.phase ?? null : null;
  const draftSheetMessage = sheetPhase === "uncertain" || sheetPhase === "rate_limited" || sheetPhase === "unreachable" ? draft?.message ?? null : null;

  return (
    <StoreDefaultRow
      field={EDITOR}
      value={priceRowValue(saved, "full")}
      compactValue={priceRowValue(saved, "phone")}
      status={savedFlash ? LISTING_SETTINGS_SAVE_WORDS.saved : undefined}
      // With no store price the row offers [Set price] instead of [Change] (R:516).
      editable={right.editable && !notSet}
      reason={reason}
      notSaved={dirty}
      onChange={openEditor}
      compact={compact}
      changeRef={changeRef}
    >
      {notSet && right.editable && (
        <div className="mt-2">
          <Button ref={changeRef} type="button" size="sm" variant="outline" onClick={openEditor}>{PRICE_DEFAULT_WORDS.setPrice}</Button>
        </div>
      )}
      <EditorSurface
        open={editorOpen}
        title={PLACE}
        notSaved={dirty}
        onClose={drafts.requestClose}
        returnFocusTo={changeRef}
        footer={(
          <PriceEditorButtons
            footer={footer}
            checkButtonRef={checkButtonRef}
            onCancel={cancel}
            onPrimary={() => {
              if (footer.primary.action === "load_latest") void loadLatest();
              else if (footer.primary.action === "resend") void saveNewPrices("resend");
              else if (footer.primary.action === "check") checkNewPrices();
            }}
          />
        )}
      >
        <PriceEditorView
          read={state !== null && value !== null ? "ready" : rules.isError ? "failed" : right.editable ? "loading" : "unavailable"}
          onRetryRead={() => void rules.refetch()}
          value={value ?? priceDefaultBase(state, summaryRecipe)}
          onChange={edit}
          locked={isDraftLocked(draft) || checking || !right.editable}
          suggested={suggestion && !dirty}
          errors={fieldErrors}
          marked={draft?.marked ?? []}
          reason={reason}
          message={editorMessage !== null ? { text: editorMessage, tone: "alert" } : footer.message}
        />
      </EditorSurface>
      {staleView && (
        <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-700">
          <span>{draft?.message ?? LISTING_SETTINGS_SAVE_WORDS.savedViewStale}</span>
          {editorMessage && <span className="text-amber-900">{editorMessage}</span>}
          <Button type="button" size="sm" variant="outline" disabled={reading} onClick={() => void reloadAfterSave()}>
            {LISTING_SETTINGS_SAVE_WORDS.reload}
          </Button>
        </div>
      )}
      <CheckNewPricesSheet
        checked={checked}
        phase={sheetPhase}
        message={sheetMessage ?? draftSheetMessage}
        paging={paging}
        // While a check runs again (prices moved), the check on screen is out of date and can't be saved.
        busy={saveCallbacks.disabled === true || checking}
        onBack={backToEditing}
        onSave={() => void saveNewPrices("save")}
        onResend={() => void saveNewPrices("resend")}
        onPage={(page) => void showPage(page)}
        returnFocusTo={sheetFocus}
      />
    </StoreDefaultRow>
  );
}

function withoutField(errors: FieldErrors, field: PriceRecipeField): FieldErrors {
  const next = { ...errors };
  delete next[field as keyof FieldErrors];
  return next;
}

/** The closed row's value: the store price in words, "Not set. …", or "Checking…" before the summary answers. */
export function priceRowValue(saved: ListingSettingsSummary["storeDefaults"]["price"] | null, form: "full" | "phone"): string {
  if (saved === null) return PRICE_DEFAULT_WORDS.loading;
  if (saved.recipe === null) return PRICE_DEFAULT_WORDS.notSet;
  return recipeWords(saved.recipe, form);
}

/** [Cancel] and the editor's main button, from `priceEditorFooter`. */
function PriceEditorButtons({ footer, checkButtonRef, onCancel, onPrimary }: {
  footer: PriceEditorFooter;
  checkButtonRef: Ref<HTMLButtonElement>;
  onCancel: () => void;
  onPrimary: () => void;
}) {
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={footer.cancelDisabled} onClick={onCancel}>
        {LISTING_SETTINGS_SAVE_WORDS.cancel}
      </Button>
      <Button ref={checkButtonRef} type="button" size="sm" disabled={footer.primary.disabled} onClick={onPrimary}>{footer.primary.label}</Button>
    </>
  );
}

export interface PriceEditorViewProps {
  /**
   * The saved pricing rules: still loading, failed, ready to edit, or not
   * read because W1 won't take a save now (the reason line says why).
   */
  read: "loading" | "failed" | "ready" | "unavailable";
  onRetryRead: () => void;
  value: PriceRecipeDraft;
  onChange: (field: PriceRecipeField, next: string) => void;
  /** Saving, an unconfirmed save, a check in flight, or a writer that won't take a save. */
  locked: boolean;
  /** Nothing is saved and nothing is edited: the value is the suggestion (R:205). */
  suggested: boolean;
  errors: FieldErrors;
  /** The fields the vendor and another window both changed (R:542). */
  marked: readonly string[];
  /** Why it can't be saved now (plan 4.3). */
  reason: string | null;
  message: PriceEditorFooter["message"];
}

const selectClass = "h-9 rounded-md border border-zinc-300 bg-white px-2 text-sm text-zinc-900";

/** The Price editor's body (R:174-183). Stateless, so every state renders in tests. */
export function PriceEditorView(props: PriceEditorViewProps) {
  const ids = {
    basis: useId(),
    percent: useId(),
    percentError: useId(),
    flat: useId(),
    flatError: useId(),
    rounding: useId(),
  };
  if (props.read === "loading") return <p role="status" className="text-sm text-zinc-600">{PRICE_DEFAULT_WORDS.loading}</p>;
  if (props.read === "unavailable") return props.reason ? <p className="text-sm text-zinc-600">{props.reason}</p> : null;
  if (props.read === "failed") {
    return (
      <div role="alert" className="space-y-2 text-sm text-amber-900">
        <p>{PRICE_DEFAULT_WORDS.readFailed}</p>
        <Button type="button" size="sm" variant="outline" onClick={props.onRetryRead}>{PRICE_DEFAULT_WORDS.tryAgain}</Button>
      </div>
    );
  }
  const { value, errors, marked } = props;
  return (
    <div className="space-y-3">
      {props.suggested && (
        // R:205: a first visit opens on the suggestion, never on "Your cost + 0%". It is not a change until edited.
        <p className="text-sm text-zinc-700" data-testid="price-suggested">
          {recipeWords(SUGGESTED_PRICING_RECIPE)}
          <span className="ml-2 text-xs font-medium text-amber-800">{PRICE_DEFAULT_WORDS.suggested}</span>
        </p>
      )}
      <fieldset disabled={props.locked} className="space-y-3">
        <legend className="sr-only">{PLACE}</legend>
        <fieldset>
          <legend className="text-sm font-medium text-zinc-900">
            {PRICE_DEFAULT_WORDS.startFrom}
            {marked.includes("basis") && <Marked />}
          </legend>
          <div className="mt-1 inline-flex overflow-hidden rounded-md border border-zinc-300" role="presentation">
            <BasisChoice name={ids.basis} value="catalog_retail" current={value.basis} label={PRICE_DEFAULT_WORDS.retailPrice} onChange={props.onChange} />
            <BasisChoice name={ids.basis} value="product_cost" current={value.basis} label={PRICE_DEFAULT_WORDS.yourCost} onChange={props.onChange} />
          </div>
        </fieldset>
        <div className="flex flex-wrap items-end gap-3">
          <Field id={ids.percent} label={PRICE_DEFAULT_WORDS.add} marked={marked.includes("percent")}>
            <span className="flex items-center gap-1">
              <Input id={ids.percent} className="w-24" inputMode="decimal" autoComplete="off" value={value.percent}
                aria-invalid={errors.percent ? true : undefined} aria-describedby={errors.percent ? ids.percentError : undefined}
                onChange={(event) => props.onChange("percent", event.target.value)} />
              <span aria-hidden="true" className="text-sm text-zinc-700">{PRICE_DEFAULT_WORDS.percentSign}</span>
              <span className="sr-only">percent</span>
            </span>
          </Field>
          <Field id={ids.flat} label={PRICE_DEFAULT_WORDS.plus} marked={marked.includes("flat")}>
            <Input id={ids.flat} className="w-28" inputMode="decimal" autoComplete="off" value={value.flat}
              aria-invalid={errors.flat ? true : undefined} aria-describedby={errors.flat ? ids.flatError : undefined}
              onChange={(event) => props.onChange("flat", event.target.value)} />
          </Field>
          <Field id={ids.rounding} label={PRICE_DEFAULT_WORDS.round} marked={marked.includes("rounding")}>
            <select id={ids.rounding} className={selectClass} value={value.rounding} onChange={(event) => props.onChange("rounding", event.target.value)}>
              <option value="up_99">{PRICE_DEFAULT_WORDS.roundUp99}</option>
              <option value="cent">{PRICE_DEFAULT_WORDS.roundCent}</option>
            </select>
          </Field>
        </div>
        {errors.percent && <p id={ids.percentError} role="alert" className="text-sm text-rose-800">{errors.percent}</p>}
        {errors.flat && <p id={ids.flatError} role="alert" className="text-sm text-rose-800">{errors.flat}</p>}
        {value.basis === "product_cost" && <p className="text-sm text-zinc-700">{PRICE_DEFAULT_WORDS.costFollows}</p>}
        <p className="text-xs text-zinc-600">{PRICE_DEFAULT_WORDS.basisHelp}</p>
        <p className="text-xs text-zinc-600">{PRICE_DEFAULT_WORDS.exactKept}</p>
      </fieldset>
      {props.reason && <p className="text-xs text-zinc-500">{props.reason}</p>}
      {props.message && (props.message.tone === "alert"
        ? <p role="alert" className="text-sm text-amber-900">{props.message.text}</p>
        : <p role="status" className="text-sm text-zinc-700">{props.message.text}</p>)}
    </div>
  );
}

function BasisChoice({ name, value, current, label, onChange }: {
  name: string;
  value: PricingRecipe["basis"];
  current: PricingRecipe["basis"];
  label: string;
  onChange: (field: PriceRecipeField, next: string) => void;
}) {
  const checked = current === value;
  return (
    <label className={`flex min-h-9 cursor-pointer items-center gap-2 px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#C060E0] ${checked ? "bg-zinc-900 text-white" : "bg-white text-zinc-900"}`}>
      <input type="radio" className="sr-only" name={name} value={value} checked={checked} onChange={() => onChange("basis", value)} />
      {label}
    </label>
  );
}

function Field({ id, label, marked, children }: { id: string; label: string; marked: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-zinc-900">
        {label}
        {marked && <Marked />}
      </label>
      {children}
    </div>
  );
}

function Marked() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-amber-900">
      <span aria-hidden="true">●</span> {PRICE_DEFAULT_WORDS.bothChanged}
    </span>
  );
}
