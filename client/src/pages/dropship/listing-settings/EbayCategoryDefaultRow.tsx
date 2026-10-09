import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EbayCategory } from "@shared/dropship/ebay-category-rules";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import { categoryPathLabel } from "@/lib/dropship-ebay-category-rules";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  checkEbayCategoryDefaultAnswer,
  EBAY_CATEGORY_DEFAULT_WORDS,
  ebayCategoryDefaultSaveInput,
  ebayCategoryDefaultValue,
  prepareEbayCategoryDefaultSave,
  readEbayCategoryDefaultValue,
  rereadStoreDefault,
  runStoreDefaultSave,
  sendEbayCategoryDefaultSave,
  settleConflictBeforeSending,
  STORE_DEFAULT_EDITOR_WORDS,
  storeDefaultBaseMoved,
  storeDefaultEbayCategoryCompactValue,
  storeDefaultEbayCategoryRulesQueryOptions,
  storeDefaultEditorFooter,
  type StoreDefaultEditorFooter,
  type StoreDefaultSaveCallbacks,
} from "@/lib/dropship-listing-settings-content-requests";
import {
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_SAVE_WORDS,
  STORE_DEFAULT_LABELS,
} from "@/lib/dropship-listing-settings-drafts";
import { rightReasonLine, storeDefaultEbayCategoryValue } from "@/lib/dropship-listing-settings-words";
import { DropshipEbayCategoryPicker } from "../DropshipEbayCategoryPicker";
import { EditorSurface } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { StoreDefaultRow } from "./StoreDefaultRow";

const EDITOR = "ebayCategory" as const;
const PLACE = STORE_DEFAULT_LABELS.ebayCategory;

export interface EbayCategoryDefaultRowProps {
  storeConnectionId: number;
  /** The summary's store default (`summary.storeDefaults.ebayCategory`); null until the summary answers. */
  saved: ListingSettingsSummary["storeDefaults"]["ebayCategory"] | null;
  /** `rights.ebayCategory` (plan 4.3): W3 refuses a store that needs an eBay sign-in. */
  right: ListingSettingsRight;
  /** The page's pending-save counter (D10). */
  saveCallbacks: StoreDefaultSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. */
  onBlocked?: (error: unknown) => void;
}

/**
 * The Store defaults row "eBay category" (R:580) and its editor (W3). The
 * closed row reads the summary. The saved rules are read only while the
 * editor is open and W3 would take a save (D8), and read again after every
 * save (D9). The save sends every older rule back unchanged.
 */
export function EbayCategoryDefaultRow({ storeConnectionId, saved, right, saveCallbacks, onSaved, onBlocked }: EbayCategoryDefaultRowProps) {
  const drafts = useListingSettingsDrafts();
  const queryClient = useQueryClient();
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const draft = drafts.draft?.editor === EDITOR ? drafts.draft : null;
  const editorOpen = draft?.open === true;
  const options = storeDefaultEbayCategoryRulesQueryOptions(storeConnectionId, { editorOpen, right });
  const rules = useQuery(options);
  const state = rules.data ?? null;
  const value = draft ? readEbayCategoryDefaultValue(draft.value) : null;
  // "One eBay category" chosen before a category is picked; only this row's view of the choice.
  const [wantsOne, setWantsOne] = useState(false);
  const [picking, setPicking] = useState(false);
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  // An unchanged draft follows what is saved, so the editor always starts from the latest rules.
  const { open: openDraft } = drafts;
  useEffect(() => {
    if (!state || !draft?.open || draft.phase !== "editing" || draft.message !== null || isDraftDirty(draft)) return;
    const latest = ebayCategoryDefaultValue(state);
    if (storeDefaultBaseMoved(draft.base, latest)) openDraft(EDITOR, PLACE, latest);
  }, [state, draft, openDraft]);

  function openEditor() {
    setWantsOne(false);
    setPicking(false);
    setLocalMessage(null);
    // The rules read starts as the editor opens; until it answers the editor shows "Checking…".
    drafts.open(EDITOR, PLACE, ebayCategoryDefaultValue(state));
  }

  function edit(defaultCategory: EbayCategory | null) {
    setLocalMessage(null);
    drafts.edit({ defaultCategory });
  }

  function choose(choice: "card_shellz" | "one") {
    if (!draft || !value) return;
    if (choice === "card_shellz") {
      setWantsOne(false);
      setPicking(false);
      edit(null);
      return;
    }
    setWantsOne(true);
    const base = readEbayCategoryDefaultValue(draft.base);
    if (value.defaultCategory === null && base?.defaultCategory) edit(base.defaultCategory);
    else if (value.defaultCategory === null) setPicking(true);
  }

  function pick(category: EbayCategory) {
    setPicking(false);
    setWantsOne(true);
    edit(category);
  }

  function cancelPicker() {
    setPicking(false);
    if (value?.defaultCategory === null) setWantsOne(false);
  }

  function reread() {
    return rereadStoreDefault(queryClient, options);
  }

  async function save(action: StoreDefaultEditorFooter["primary"]["action"]) {
    if (!draft || !value || !state) return;
    setLocalMessage(null);
    let signature: string;
    if (action === "resend" && draft.attempt) {
      signature = draft.attempt.signature;
    } else {
      if (storeDefaultBaseMoved(draft.base, ebayCategoryDefaultValue(state))) {
        settleConflictBeforeSending(drafts, "W3");
        return;
      }
      const prepared = prepareEbayCategoryDefaultSave(state, value);
      if (!prepared.ok) {
        setLocalMessage(prepared.message);
        return;
      }
      signature = prepared.signature;
    }
    const pickedId = value.defaultCategory?.categoryId ?? null;
    const outcome = await runStoreDefaultSave({
      writer: "W3",
      signature,
      drafts,
      callbacks: saveCallbacks,
      request: ebayCategoryDefaultSaveInput,
      send: (input) => sendEbayCategoryDefaultSave(storeConnectionId, input),
      checkAnswer: checkEbayCategoryDefaultAnswer,
      reread,
      onSaved,
      onBlocked,
      classify: { pickedEbayCategoryId: pickedId },
    });
    if (outcome.kind === "not_started" && outcome.message) setLocalMessage(outcome.message);
    if (outcome.kind === "saved") {
      setPicking(false);
      setWantsOne(false);
      // The row redraws from the summary; "Saved" shows beside it for 3 seconds.
      drafts.close();
    }
  }

  async function loadLatest() {
    setReading(true);
    setLocalMessage(null);
    try {
      drafts.rebase(ebayCategoryDefaultValue(await reread()));
    } catch {
      // The read's own error is not vendor words; the conflict stays, and the button can be pressed again.
      setLocalMessage(STORE_DEFAULT_EDITOR_WORDS.readFailed);
    } finally {
      setReading(false);
    }
  }

  async function reloadAfterSave() {
    setReading(true);
    try {
      await reread();
      drafts.discard();
    } catch {
      setLocalMessage(STORE_DEFAULT_EDITOR_WORDS.readFailed);
    } finally {
      setReading(false);
    }
  }

  const footer = storeDefaultEditorFooter({
    draft,
    ready: state !== null && value !== null,
    editable: right.editable,
    busy: saveCallbacks.disabled === true || reading,
    complete: !(wantsOne && value?.defaultCategory === null),
  });
  const dirty = isDraftDirty(draft);
  const savedFlash = drafts.savedFlashVisible && draft !== null;
  const staleView = draft?.phase === "saved_view_stale" && !draft.open;

  return (
    <StoreDefaultRow
      field={EDITOR}
      value={saved === null ? STORE_DEFAULT_EDITOR_WORDS.loading : storeDefaultEbayCategoryValue(saved.category)}
      compactValue={saved === null ? STORE_DEFAULT_EDITOR_WORDS.loading : storeDefaultEbayCategoryCompactValue(saved.category)}
      status={savedFlash ? LISTING_SETTINGS_SAVE_WORDS.saved : undefined}
      editable={right.editable}
      reason={right.editable ? null : rightReasonLine(right.reason)}
      notSaved={dirty}
      onChange={openEditor}
      compact={compact}
      changeRef={changeRef}
    >
      <EditorSurface
        open={editorOpen}
        title={PLACE}
        notSaved={dirty}
        onClose={drafts.requestClose}
        returnFocusTo={changeRef}
        footer={(
          <StoreDefaultEditorButtons
            footer={footer}
            onCancel={drafts.discard}
            onPrimary={() => {
              if (footer.primary.action === "load_latest") void loadLatest();
              else void save(footer.primary.action);
            }}
          />
        )}
      >
        <EbayCategoryEditorView
          read={state !== null && value !== null ? "ready" : rules.isError ? "failed" : "loading"}
          onRetryRead={() => void rules.refetch()}
          category={value?.defaultCategory ?? null}
          choice={wantsOne || (value?.defaultCategory ?? null) !== null ? "one" : "card_shellz"}
          locked={isDraftLocked(draft) || !right.editable}
          marked={draft?.marked.includes("defaultCategory") === true}
          picking={picking}
          onChoose={choose}
          onPickAnother={() => setPicking(true)}
          reason={right.editable ? null : rightReasonLine(right.reason)}
          message={localMessage !== null ? { text: localMessage, tone: "alert" } : footer.message}
          picker={(
            <DropshipEbayCategoryPicker
              storeConnectionId={storeConnectionId}
              label={EBAY_CATEGORY_DEFAULT_WORDS.pickerLabel}
              onPick={pick}
              onCancel={cancelPicker}
              hideIds
              showLeafHint
            />
          )}
        />
      </EditorSurface>
      {staleView && (
        <StaleViewNotice message={draft?.message ?? LISTING_SETTINGS_SAVE_WORDS.savedViewStale}
          detail={localMessage} reading={reading} onReload={() => void reloadAfterSave()} />
      )}
    </StoreDefaultRow>
  );
}

export interface EbayCategoryEditorViewProps {
  /** The saved rules: still loading, failed, or ready to edit. */
  read: "loading" | "failed" | "ready";
  onRetryRead: () => void;
  /** The picked store default; null when Card Shellz picks. */
  category: EbayCategory | null;
  choice: "card_shellz" | "one";
  /** Saving, an unconfirmed save, or a writer that won't take a save: nothing can be changed. */
  locked: boolean;
  /** The vendor and another window both changed it (R:542). */
  marked: boolean;
  /** Whether the eBay category picker shows. */
  picking: boolean;
  onChoose: (choice: "card_shellz" | "one") => void;
  onPickAnother: () => void;
  /** Why it can't be saved now (plan 4.3), when the writer won't take a save. */
  reason: string | null;
  message: StoreDefaultEditorFooter["message"];
  /** The picker itself (injected, so this view renders without network). */
  picker: ReactNode;
}

/** The eBay category editor's body (R:580). Stateless, so every state renders in tests. */
export function EbayCategoryEditorView(props: EbayCategoryEditorViewProps) {
  const groupName = useId();
  const helpId = useId();
  if (props.read === "loading") return <p role="status" className="text-sm text-zinc-600">{STORE_DEFAULT_EDITOR_WORDS.loading}</p>;
  if (props.read === "failed") {
    return (
      <div role="alert" className="space-y-2 text-sm text-amber-900">
        <p>{STORE_DEFAULT_EDITOR_WORDS.readFailed}</p>
        <Button type="button" size="sm" variant="outline" onClick={props.onRetryRead}>{STORE_DEFAULT_EDITOR_WORDS.tryAgain}</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <fieldset disabled={props.locked} className="space-y-2">
        <legend className="sr-only">{STORE_DEFAULT_LABELS.ebayCategory}</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name={groupName} className="mt-1" checked={props.choice === "card_shellz"}
            aria-describedby={helpId} onChange={() => props.onChoose("card_shellz")} />
          <span>
            <span className="block text-zinc-900">{EBAY_CATEGORY_DEFAULT_WORDS.cardShellzPicks}</span>
            <span id={helpId} className="block text-xs text-zinc-600">{EBAY_CATEGORY_DEFAULT_WORDS.cardShellzPicksHelp}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name={groupName} className="mt-1" checked={props.choice === "one"} onChange={() => props.onChoose("one")} />
          <span className="text-zinc-900">{EBAY_CATEGORY_DEFAULT_WORDS.oneCategory}</span>
        </label>
        {props.choice === "one" && (
          <div className="space-y-2 pl-6">
            {props.category && (
              <p className="break-words text-sm text-zinc-800" data-testid="ebay-category-default-path">
                {categoryPathLabel(props.category)}
                {props.marked && <MarkedField />}
              </p>
            )}
            {!props.picking && (
              <Button type="button" size="sm" variant="outline" onClick={props.onPickAnother}>
                {props.category ? EBAY_CATEGORY_DEFAULT_WORDS.pickAnother : EBAY_CATEGORY_DEFAULT_WORDS.pickCategory}
              </Button>
            )}
          </div>
        )}
        {props.choice === "card_shellz" && props.marked && <p className="text-xs"><MarkedField /></p>}
      </fieldset>
      {props.picking && !props.locked && props.picker}
      {props.reason && <p className="text-xs text-zinc-500">{props.reason}</p>}
      <EditorMessage message={props.message} />
    </div>
  );
}

/** "Also changed in another window", beside a field both changed (R:542). */
export function MarkedField() {
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-amber-900">
      <span aria-hidden="true">●</span> {STORE_DEFAULT_EDITOR_WORDS.bothChanged}
    </span>
  );
}

/** A save's words in the editor: failures as an alert, other lines as a status. */
export function EditorMessage({ message }: { message: StoreDefaultEditorFooter["message"] }) {
  if (!message) return null;
  return message.tone === "alert"
    ? <p role="alert" className="text-sm text-amber-900">{message.text}</p>
    : <p role="status" className="text-sm text-zinc-700">{message.text}</p>;
}

/** [Cancel] and the main button of a store default editor, from `storeDefaultEditorFooter`. */
export function StoreDefaultEditorButtons({ footer, onCancel, onPrimary }: {
  footer: StoreDefaultEditorFooter;
  onCancel: () => void;
  onPrimary: () => void;
}) {
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={footer.cancelDisabled} onClick={onCancel}>
        {LISTING_SETTINGS_SAVE_WORDS.cancel}
      </Button>
      <Button type="button" size="sm" disabled={footer.primary.disabled} onClick={onPrimary}>{footer.primary.label}</Button>
    </>
  );
}

/** Under a closed row whose save went through but whose saved view couldn't be read: "Saved. We couldn't load the latest view." [Reload]. */
export function StaleViewNotice({ message, detail, reading, onReload }: {
  message: string;
  detail: string | null;
  reading: boolean;
  onReload: () => void;
}) {
  return (
    <div role="status" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-zinc-700">
      <span>{message}</span>
      {detail && <span className="text-amber-900">{detail}</span>}
      <Button type="button" size="sm" variant="outline" disabled={reading} onClick={onReload}>{LISTING_SETTINGS_SAVE_WORDS.reload}</Button>
    </div>
  );
}
