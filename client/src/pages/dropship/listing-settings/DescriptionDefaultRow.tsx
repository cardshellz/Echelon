import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MAX_TEMPLATE_TEXT_LENGTH } from "@shared/dropship/listing-content";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import type { ListingSettingsRight } from "@/lib/dropship-listing-settings-access";
import {
  checkDescriptionDefaultAnswer,
  DESCRIPTION_DEFAULT_WORDS,
  descriptionDefaultSaveInput,
  descriptionDefaultValue,
  descriptionLengthWords,
  prepareDescriptionDefaultSave,
  readDescriptionDefaultValue,
  rereadStoreDefault,
  runStoreDefaultSave,
  sendDescriptionDefaultSave,
  settleConflictBeforeSending,
  STORE_DEFAULT_EDITOR_WORDS,
  storeDefaultBaseMoved,
  storeDefaultContentProfileQueryOptions,
  storeDefaultEditorFooter,
  type DescriptionDefaultValue,
  type StoreDefaultEditorFooter,
  type StoreDefaultSaveCallbacks,
} from "@/lib/dropship-listing-settings-content-requests";
import {
  isDraftDirty,
  isDraftLocked,
  LISTING_SETTINGS_SAVE_WORDS,
  STORE_DEFAULT_LABELS,
} from "@/lib/dropship-listing-settings-drafts";
import { rightReasonLine, storeDefaultDescriptionValue } from "@/lib/dropship-listing-settings-words";
import { EditorMessage, MarkedField, StaleViewNotice, StoreDefaultEditorButtons } from "./EbayCategoryDefaultRow";
import { EditorSurface } from "./EditorSurface";
import { useListingSettingsDrafts } from "./ListingSettingsDraftsProvider";
import { StoreDefaultRow } from "./StoreDefaultRow";

const EDITOR = "description" as const;
const PLACE = STORE_DEFAULT_LABELS.description;

export interface DescriptionDefaultRowProps {
  storeConnectionId: number;
  /** The summary's store default (`summary.storeDefaults.description`); null until the summary answers. */
  saved: ListingSettingsSummary["storeDefaults"]["description"] | null;
  /** `rights.description` (plan 4.3): W4 takes a save while eBay needs a sign-in. */
  right: ListingSettingsRight;
  /** The page's pending-save counter (D10). */
  saveCallbacks: StoreDefaultSaveCallbacks;
  /** After a confirmed save: the step marks the step 3 preview stale and reads the summary again. */
  onSaved: () => void;
  /** A save refused because of a block a banner explains (plan 4.4). The draft is kept. */
  onBlocked?: (error: unknown) => void;
}

/**
 * The Store defaults row "Description" (R:582) and its editor (W4): the
 * store's text above and below Card Shellz's main text. The closed row reads
 * the summary. The saved profile is read only while the editor is open and W4
 * would take a save (D8), and read again after every save (D9). The save
 * sends every older description group back unchanged.
 */
export function DescriptionDefaultRow({ storeConnectionId, saved, right, saveCallbacks, onSaved, onBlocked }: DescriptionDefaultRowProps) {
  const drafts = useListingSettingsDrafts();
  const queryClient = useQueryClient();
  const compact = !useMinWidth(SM_MIN_WIDTH_PX);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const draft = drafts.draft?.editor === EDITOR ? drafts.draft : null;
  const editorOpen = draft?.open === true;
  const options = storeDefaultContentProfileQueryOptions(storeConnectionId, { editorOpen, right });
  const profile = useQuery(options);
  const state = profile.data ?? null;
  const value = draft ? readDescriptionDefaultValue(draft.value) : null;
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  // An unchanged draft follows what is saved, so the editor always starts from the latest text.
  const { open: openDraft } = drafts;
  useEffect(() => {
    if (!state || !draft?.open || draft.phase !== "editing" || draft.message !== null || isDraftDirty(draft)) return;
    const latest = descriptionDefaultValue(state);
    if (storeDefaultBaseMoved(draft.base, latest)) openDraft(EDITOR, PLACE, latest);
  }, [state, draft, openDraft]);

  function openEditor() {
    setLocalMessage(null);
    // The profile read starts as the editor opens; until it answers the editor shows "Checking…".
    drafts.open(EDITOR, PLACE, descriptionDefaultValue(state));
  }

  function edit(field: keyof DescriptionDefaultValue, text: string) {
    if (!value) return;
    setLocalMessage(null);
    drafts.edit({ ...value, [field]: text });
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
      if (storeDefaultBaseMoved(draft.base, descriptionDefaultValue(state))) {
        settleConflictBeforeSending(drafts, "W4");
        return;
      }
      const prepared = prepareDescriptionDefaultSave(state, value);
      if (!prepared.ok) {
        setLocalMessage(prepared.message);
        return;
      }
      signature = prepared.signature;
    }
    const outcome = await runStoreDefaultSave({
      writer: "W4",
      signature,
      drafts,
      callbacks: saveCallbacks,
      request: descriptionDefaultSaveInput,
      send: (input) => sendDescriptionDefaultSave(storeConnectionId, input),
      checkAnswer: checkDescriptionDefaultAnswer,
      reread,
      onSaved,
      onBlocked,
    });
    if (outcome.kind === "not_started" && outcome.message) setLocalMessage(outcome.message);
    // The row redraws from the summary; "Saved" shows beside it for 3 seconds.
    if (outcome.kind === "saved") drafts.close();
  }

  async function loadLatest() {
    setReading(true);
    setLocalMessage(null);
    try {
      drafts.rebase(descriptionDefaultValue(await reread()));
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
    complete: true,
  });
  const dirty = isDraftDirty(draft);
  const savedFlash = drafts.savedFlashVisible && draft !== null;
  const staleView = draft?.phase === "saved_view_stale" && !draft.open;

  return (
    <StoreDefaultRow
      field={EDITOR}
      value={saved === null ? STORE_DEFAULT_EDITOR_WORDS.loading : storeDefaultDescriptionValue(saved)}
      compactValue={saved === null ? STORE_DEFAULT_EDITOR_WORDS.loading : storeDefaultDescriptionValue(saved, "phone")}
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
        <DescriptionEditorView
          read={state !== null && value !== null ? "ready" : profile.isError ? "failed" : "loading"}
          onRetryRead={() => void profile.refetch()}
          introduction={value?.introduction ?? ""}
          footer={value?.footer ?? ""}
          onChange={edit}
          locked={isDraftLocked(draft) || !right.editable}
          marked={draft?.marked ?? []}
          reason={right.editable ? null : rightReasonLine(right.reason)}
          message={localMessage !== null ? { text: localMessage, tone: "alert" } : footer.message}
        />
      </EditorSurface>
      {staleView && (
        <StaleViewNotice message={draft?.message ?? LISTING_SETTINGS_SAVE_WORDS.savedViewStale}
          detail={localMessage} reading={reading} onReload={() => void reloadAfterSave()} />
      )}
    </StoreDefaultRow>
  );
}

export interface DescriptionEditorViewProps {
  /** The saved profile: still loading, failed, or ready to edit. */
  read: "loading" | "failed" | "ready";
  onRetryRead: () => void;
  introduction: string;
  footer: string;
  onChange: (field: keyof DescriptionDefaultValue, text: string) => void;
  /** Saving, an unconfirmed save, or a writer that won't take a save: nothing can be changed. */
  locked: boolean;
  /** The fields the vendor and another window both changed (R:542). */
  marked: readonly string[];
  /** Why it can't be saved now (plan 4.3), when the writer won't take a save. */
  reason: string | null;
  message: StoreDefaultEditorFooter["message"];
}

/** The Description editor's body (R:582). Stateless, so every state renders in tests. */
export function DescriptionEditorView(props: DescriptionEditorViewProps) {
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
      <fieldset disabled={props.locked} className="space-y-3">
        <legend className="sr-only">{STORE_DEFAULT_LABELS.description}</legend>
        <TemplateText label={DESCRIPTION_DEFAULT_WORDS.textAbove} value={props.introduction}
          marked={props.marked.includes("introduction")} onChange={(text) => props.onChange("introduction", text)} />
        <p className="rounded border border-dashed border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-600">{DESCRIPTION_DEFAULT_WORDS.mainText}</p>
        <TemplateText label={DESCRIPTION_DEFAULT_WORDS.textBelow} value={props.footer}
          marked={props.marked.includes("footer")} onChange={(text) => props.onChange("footer", text)} />
      </fieldset>
      {props.reason && <p className="text-xs text-zinc-500">{props.reason}</p>}
      <EditorMessage message={props.message} />
    </div>
  );
}

function TemplateText({ label, value, marked, onChange }: {
  label: string;
  value: string;
  marked: boolean;
  onChange: (text: string) => void;
}) {
  const fieldId = useId();
  const countId = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={fieldId} className="block text-sm font-medium text-zinc-900">
        {label}
        {marked && <MarkedField />}
      </label>
      <Textarea id={fieldId} value={value} rows={3} maxLength={MAX_TEMPLATE_TEXT_LENGTH} aria-describedby={countId}
        onChange={(event) => onChange(event.target.value)} />
      <p id={countId} className="text-right text-xs text-zinc-500">{descriptionLengthWords(value)}</p>
    </div>
  );
}
