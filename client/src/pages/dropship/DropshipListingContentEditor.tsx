import { useEffect, useId, useRef, useState } from "react";
import {
  listingContentResponseSchema, previewListingContentInputSchema, saveListingContentResponseSchema,
  MAX_DESCRIPTION_TEXT_LENGTH, type ListingContentSetting,
} from "@shared/dropship/listing-content";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { useContentDraft, type ContentSaveCallbacks } from "./useContentDraft";

export function SanitizedDescriptionPreview({ html, title = "Description preview" }: { html: string; title?: string }) {
  // No scripts, forms, links, network access or same-origin privileges. HTML is
  // generated and sanitized by the server, not constructed from editor text.
  return <iframe title={title} sandbox="" referrerPolicy="no-referrer" className="h-64 w-full rounded border bg-white"
    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${html}</body></html>`} />;
}

type ContentEditorProps = {
  storeConnectionId: number;
  productVariantId: number;
  previewEvidenceHash?: string;
} & ContentSaveCallbacks;

export function DropshipListingContentEditor(props: ContentEditorProps) {
  return <ContentEditorSession key={`${props.storeConnectionId}:${props.productVariantId}`} {...props} />;
}

function ContentEditorSession(props: ContentEditorProps) {
  const endpoint = `/api/dropship/listings/stores/${props.storeConnectionId}/variants/${props.productVariantId}/content`;
  const editor = useContentDraft<ListingContentSetting, { customText: string | null }>({
    endpoint, callbacks: props, refreshToken: props.previewEvidenceHash,
    matchesRefreshToken: (state, token) => state.resolved.evidenceHash === token,
    read(value) {
      const result = listingContentResponseSchema.parse(value).content;
      if (result.storeConnectionId !== props.storeConnectionId || result.productVariantId !== props.productVariantId) {
        throw new Error("Description returned a different listing.");
      }
      return result;
    },
    draftFrom: (state) => ({ customText: state.customText }),
    request: (state, draft) => previewListingContentInputSchema.parse({
      ...draft, expectedRevisionId: state.revisionId, expectedCatalogHash: state.resolved.catalogHash,
      expectedProfileRevisionId: state.resolved.profileRevisionId,
    }),
    validateSave: (value) => { saveListingContentResponseSchema.parse(value); },
  });
  const [editing, setEditing] = useState(false);
  const [compareSaved, setCompareSaved] = useState(false);
  const descriptionId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const previouslyEditing = useRef(false);

  useEffect(() => {
    if (previouslyEditing.current && !editing) editButton.current?.focus();
    previouslyEditing.current = editing;
  }, [editing]);

  const dirty = Boolean(editor.draft && editor.state && editor.draft.customText !== editor.state.customText);
  const previewMismatch = editor.state && props.previewEvidenceHash && editor.state.resolved.evidenceHash !== props.previewEvidenceHash;
  // Opening Edit must not turn inherited, formatted catalog content into an
  // override. Only an actual text change materializes a custom plain-text draft.
  const text = editor.draft?.customText ?? editor.state?.resolved.catalogText ?? "";
  const saved = editor.state;

  function returnToDescription() {
    setEditing(false);
    setCompareSaved(false);
  }
  function startEditing() {
    if (editor.discard()) setEditing(true);
  }
  function cancelEditing() {
    if (editor.discard()) returnToDescription();
  }
  function resetDescription() {
    if (!editor.editable) return;
    editor.edit({ customText: null });
    setEditing(true);
  }
  async function saveDescription() {
    if (await editor.save()) returnToDescription();
  }
  async function reloadSavedDescription() {
    if (await editor.reload()) returnToDescription();
  }
  async function reviewLatest() {
    if (await editor.reload(true)) setCompareSaved(true);
  }
  async function refreshDescription() {
    if (await editor.refreshPreview()) returnToDescription();
  }

  return <><section aria-label="Listing description editor" className="space-y-3 rounded-lg border p-4">
    <h4 className="font-semibold">Your listing description</h4>

    {saved?.resolved.needsCatalogReview && <p role="alert" className="text-sm text-amber-800">
      Catalog facts changed. Edit and review your description, then save to acknowledge them. Your text has been preserved.
    </p>}

    {editing && editor.draft ? <div className="space-y-2">
      <label htmlFor={descriptionId} className="sr-only">Description text</label>
      <Textarea id={descriptionId} autoFocus className="h-64 resize-none" value={text} disabled={!editor.editable}
        maxLength={MAX_DESCRIPTION_TEXT_LENGTH} onChange={(event) => editor.edit({ customText: event.target.value })} />
      <div className="flex flex-wrap justify-between gap-1 text-xs text-zinc-500">
        <span>Plain text; paragraphs and line breaks are preserved.</span>
        <span>{text.length.toLocaleString()} / {MAX_DESCRIPTION_TEXT_LENGTH.toLocaleString()}</span>
      </div>
    </div> : saved ? <SanitizedDescriptionPreview html={saved.resolved.descriptionHtml} />
      : editor.busy ? <p role="status" className="text-sm text-zinc-500">Loading description…</p> : null}

    <div aria-label="Description actions" className="flex flex-wrap gap-2">
      {editor.phase === "editing" && (editing ? <>
        <Button size="sm" disabled={!editor.editable || (!dirty && !saved?.resolved.needsCatalogReview)}
          onClick={() => void saveDescription()}>Save</Button>
        <Button size="sm" variant="outline" disabled={!editor.editable} onClick={cancelEditing}>Cancel</Button>
      </> : <Button ref={editButton} size="sm" variant="outline" disabled={!editor.editable || !saved}
        onClick={startEditing}>Edit</Button>)}
      {editor.phase === "editing" && <Button size="sm" variant="outline" title="Reset to catalog description"
        disabled={!editor.editable || !editor.draft || editor.draft.customText === null} onClick={resetDescription}>Reset</Button>}
      {editor.busy && editing && <Button size="sm" disabled>{editor.phase === "saving" ? "Saving…" : "Loading…"}</Button>}
      {editor.phase === "uncertain" && <>
        <Button size="sm" disabled={props.disabled} onClick={() => void saveDescription()}>Retry save</Button>
        <Button size="sm" variant="outline" onClick={() => void reloadSavedDescription()}>Check saved description</Button>
      </>}
      {editor.phase === "conflict" && (editing && editor.draft ? <>
        <Button size="sm" onClick={() => void reviewLatest()}>Review latest</Button>
        <Button size="sm" variant="outline" onClick={() => void reloadSavedDescription()}>Discard changes</Button>
      </> : <Button size="sm" variant="outline" onClick={() => void reloadSavedDescription()}>Try again</Button>)}
      {editor.phase === "refresh_error" && <Button size="sm" variant="outline"
        onClick={() => void refreshDescription()}>Retry preview refresh</Button>}
    </div>

    {editing && <p className="text-xs text-zinc-500">Saving updates this draft, not a live listing.</p>}
    {editing && dirty && editor.draft?.customText === null && <p className="text-sm text-zinc-600">
      Catalog description restored in this draft. Save to apply, or Cancel to keep your saved description.
    </p>}
    {editor.error && <p role="alert" className="text-sm text-amber-800">{editor.error}</p>}
    {editor.message && <p role="status" className="text-sm text-emerald-800">{editor.message}</p>}

    {compareSaved && saved && <div className="space-y-2">
      <p className="text-xs font-medium">Latest saved description — compare with your text above</p>
      <SanitizedDescriptionPreview html={saved.resolved.descriptionHtml} title="Latest saved description" />
    </div>}

    {previewMismatch && !editor.busy && <div role="alert" className="space-y-2 text-sm text-amber-800">
      <p>Saved content differs from the listing preview. Refresh and review it before queueing.</p>
      <Button variant="outline" size="sm" disabled={dirty || !editor.editable}
        onClick={() => void refreshDescription()}>Refresh listing preview</Button>
    </div>}

    {saved && <details className="text-xs">
      <summary className="cursor-pointer text-zinc-500">Description details</summary>
      <div className="mt-3 space-y-3">
        <p>{saved.customText === null ? "Using the catalog description." : "Using your custom description."}
          {saved.resolved.templateName ? ` Template: ${saved.resolved.templateName}.` : ""}
          {" "}Store/group introductions and footers are added automatically.</p>
        {editing && <>
          <p>Saving edited catalog copy replaces its formatting with plain text. Reset restores the current catalog body and formatting; templates still apply.</p>
        </>}
        <p>You are responsible for accurate claims. Descriptions must match the product facts and your accepted shipping and return policies.</p>
      </div>
    </details>}
    {saved && saved.resolved.issues.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-800">
      {saved.resolved.issues.map((issue) => <li key={issue}>{formatListingPreviewIssue(issue)}</li>)}
    </ul>}
  </section>
    {saved && saved.resolved.facts.length > 0 && <details aria-label="Product facts" className="rounded-lg border p-4 text-sm">
      <summary className="cursor-pointer font-medium">Product facts (read-only)</summary>
      <p className="mt-2 text-xs text-zinc-500">Catalog reference only. These facts are not automatically added to your description.</p>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">{saved.resolved.facts.map((fact) =>
        <div key={fact.name} className="min-w-0"><dt className="text-xs text-zinc-500">{fact.name}</dt>
          <dd className="break-words">{fact.value}</dd></div>)}</dl>
    </details>}
  </>;
}
