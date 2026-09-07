import { useState } from "react";
import { listingContentResponseSchema, previewListingContentInputSchema, saveListingContentResponseSchema,
  MAX_DESCRIPTION_TEXT_LENGTH, type ListingContentSetting } from "@shared/dropship/listing-content";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { postJson, queryErrorMessage } from "@/lib/dropship-ops-surface";
import { formatListingPreviewIssue } from "@/lib/dropship-listing-preview";
import { useContentDraft, type ContentSaveCallbacks } from "./useContentDraft";

export function SanitizedDescriptionPreview({ html, title = "Description preview" }: { html: string; title?: string }) {
  // No scripts, forms, links, network access or same-origin privileges. HTML is
  // generated and sanitized by the server, not constructed from editor text.
  return <iframe title={title} sandbox="" referrerPolicy="no-referrer" className="h-64 w-full rounded border bg-white"
    srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'"></head><body>${html}</body></html>`} />;
}
export function DropshipListingContentEditor(props: { storeConnectionId: number; productVariantId: number; previewEvidenceHash?: string } & ContentSaveCallbacks) {
  return <ContentEditorSession key={`${props.storeConnectionId}:${props.productVariantId}`} {...props} />;
}
function ContentEditorSession(props: { storeConnectionId: number; productVariantId: number; previewEvidenceHash?: string } & ContentSaveCallbacks) {
  const endpoint = `/api/dropship/listings/stores/${props.storeConnectionId}/variants/${props.productVariantId}/content`;
  const editor = useContentDraft<ListingContentSetting, { customText: string | null }>({
    endpoint, callbacks: props, refreshToken: props.previewEvidenceHash,
    matchesRefreshToken: (state, token) => state.resolved.evidenceHash === token,
    read(value) {
      const result = listingContentResponseSchema.parse(value).content;
      if (result.storeConnectionId !== props.storeConnectionId || result.productVariantId !== props.productVariantId) throw new Error("Description returned a different listing.");
      return result;
    },
    draftFrom: (state) => ({ customText: state.customText }),
    request: (state, draft) => previewListingContentInputSchema.parse({ ...draft, expectedRevisionId: state.revisionId,
      expectedCatalogHash: state.resolved.catalogHash, expectedProfileRevisionId: state.resolved.profileRevisionId }),
    validateSave: (value) => { saveListingContentResponseSchema.parse(value); },
  });
  const [preview, setPreview] = useState<ListingContentSetting | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  function edit(text: string | null) { editor.edit({ customText: text }); setPreview(null); setPreviewError(""); }
  async function previewDraft() {
    if (!editor.state || !editor.draft || previewBusy) return;
    setPreviewBusy(true); setPreviewError("");
    try {
      const input = previewListingContentInputSchema.parse({ ...editor.draft, expectedRevisionId: editor.state.revisionId,
        expectedCatalogHash: editor.state.resolved.catalogHash, expectedProfileRevisionId: editor.state.resolved.profileRevisionId });
      setPreview(listingContentResponseSchema.parse(await postJson(`${endpoint}/preview`, input)).content);
    } catch (caught) { setPreviewError(queryErrorMessage(caught, "Draft preview failed.")); }
    finally { setPreviewBusy(false); }
  }
  const dirty = editor.draft && editor.state && editor.draft.customText !== editor.state.customText;
  const previewMismatch = editor.state && props.previewEvidenceHash && editor.state.resolved.evidenceHash !== props.previewEvidenceHash;
  const shown = preview ?? editor.state;
  return <section aria-label="Listing description editor" className="space-y-3 rounded-lg border p-4">
    <h4 className="font-semibold">Your listing description</h4>
    <p className="text-xs text-zinc-500">Catalog copy is inherited unless you save a custom description for this listing in this store. Templates add your introduction and footer. Product facts remain catalog-controlled.</p>
    {previewMismatch && !editor.busy && <div role="alert" className="space-y-2 text-sm text-amber-800">
      <p>Saved content differs from the listing preview. Refresh and review it before queueing.</p>
      <Button variant="outline" size="sm" disabled={Boolean(dirty) || !editor.editable} onClick={() => void editor.refreshPreview()}>Refresh listing content preview</Button>
    </div>}
    {editor.state?.resolved.needsCatalogReview && <p role="alert" className="text-sm text-amber-800">Catalog facts changed. Review the current product details below, then save to acknowledge them or reset to catalog. Your copy has been preserved.</p>}
    {editor.draft && <fieldset disabled={!editor.editable || previewBusy} className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs">{editor.draft.customText === null ? "Inheriting catalog description" : "Custom listing description"}</span>
        <Button variant="outline" size="sm" onClick={() => edit(editor.state!.resolved.catalogText)}>Copy catalog as editable text</Button>
        <Button variant="ghost" size="sm" disabled={editor.draft.customText === null} onClick={() => edit(null)}>Reset to catalog</Button>
      </div>
      {editor.draft.customText !== null && <label className="block text-sm">Description text
        <Textarea className="mt-1 min-h-40" value={editor.draft.customText} maxLength={MAX_DESCRIPTION_TEXT_LENGTH} onChange={(event) => edit(event.target.value)} />
        <span className="text-xs text-zinc-500">{editor.draft.customText.length.toLocaleString()} / {MAX_DESCRIPTION_TEXT_LENGTH.toLocaleString()} characters. Paragraphs and line breaks are preserved; HTML is treated as text.</span>
      </label>}
      <p className="text-xs text-zinc-500">Copying catalog content into the editor converts its formatting to text. Reset restores current catalog formatting; store/group templates still apply.</p>
      <p className="text-xs text-zinc-600">You are responsible for accurate claims. Do not promise pack sizes, handling times, services or returns that conflict with product facts or your accepted policies.</p>
      <Button variant="outline" size="sm" onClick={() => void previewDraft()}>Preview description draft</Button>
    </fieldset>}
    {shown && <div className="space-y-2">
      <p className="text-xs font-medium">{preview ? "Unsaved description preview" : "Current saved description"}{shown.resolved.templateName ? ` · ${shown.resolved.templateName}` : ""}</p>
      <SanitizedDescriptionPreview html={shown.resolved.descriptionHtml} />
      <details><summary className="cursor-pointer text-xs">Current catalog facts (not editable)</summary>
        <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">{shown.resolved.facts.map((fact) => <div key={fact.name}><dt className="text-zinc-500">{fact.name}</dt><dd>{fact.value}</dd></div>)}</dl>
      </details>
      {shown.resolved.issues.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-amber-800">{shown.resolved.issues.map((issue) => <li key={issue}>{formatListingPreviewIssue(issue)}</li>)}</ul>}
    </div>}
    {previewError && <p role="alert" className="text-sm text-amber-800">{previewError}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={editor.busy || props.disabled || previewBusy || (!dirty && !editor.state?.resolved.needsCatalogReview && editor.phase !== "uncertain") || ["conflict", "refresh_error"].includes(editor.phase)}
        onClick={() => { setPreview(null); void editor.save(); }}>{editor.phase === "uncertain" ? "Retry same description save" : "Save description draft"}</Button>
      <Button size="sm" variant="outline" disabled={editor.busy || previewBusy} onClick={() => { setPreview(null); void editor.reload(); }}>Reload saved description</Button>
      {editor.phase === "conflict" && editor.draft && <Button size="sm" variant="outline"
        onClick={() => { setPreview(null); void editor.reload(true); }}>Review latest, keep my text</Button>}
      {editor.phase === "refresh_error" && <Button size="sm" variant="outline" onClick={() => void editor.refreshPreview()}>Retry preview refresh</Button>}
    </div>
    <p className="text-xs text-zinc-500">Saving updates the local draft and refreshes the listing preview. Queueing is a separate action; no live listing changes here.</p>
    {editor.error && <p role="alert" className="text-sm text-amber-800">{editor.error} Reload discards local edits.</p>}
    {editor.message && <p role="status" className="text-sm text-emerald-800">{editor.message}</p>}
  </section>;
}
