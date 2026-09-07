import { useState } from "react";
import { contentProfileStateSchema, contentProfileSchema, saveContentProfileResponseSchema, MAX_TEMPLATE_TEXT_LENGTH,
  type ContentProfile, type ContentProfileState, type DescriptionTemplate } from "@shared/dropship/listing-content";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createDropshipIdempotencyKey } from "@/lib/dropship-ops-surface";
import { DropshipCatalogScopePicker } from "./DropshipCatalogScopePicker";
import { useContentDraft, type ContentSaveCallbacks } from "./useContentDraft";

const blankTemplate = (): DescriptionTemplate => ({ introduction: "", footer: "" });
const blankProfile = (): ContentProfile => ({ defaultTemplate: blankTemplate(), groups: [] });
export function DropshipContentTemplatesPanel(props: { storeConnectionId: number; storeName: string } & ContentSaveCallbacks) {
  return <TemplatesSession key={props.storeConnectionId} {...props} />;
}
function TemplatesSession(props: { storeConnectionId: number; storeName: string } & ContentSaveCallbacks) {
  const endpoint = `/api/dropship/listings/stores/${props.storeConnectionId}/content-profile`;
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  return <section className="rounded-lg border bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-semibold">Description templates</h3>
      <p className="text-xs text-zinc-500">Reusable introductions and footers for {props.storeName}. Product descriptions stay unique to each listing.</p></div>
      <Button variant="outline" size="sm" onClick={() => { setOpened(true); setOpen(!open); }}>{open ? "Hide templates" : "Edit templates"}</Button>
    </div>
    {opened && <div hidden={!open}><TemplateEditor endpoint={endpoint} {...props} /></div>}
  </section>;
}
function TemplateEditor({ endpoint, ...props }: { endpoint: string } & ContentSaveCallbacks) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const editor = useContentDraft<ContentProfileState, ContentProfile>({
    endpoint, callbacks: { ...props, onSaved: props.onSaved },
    read: (value) => contentProfileStateSchema.parse(value),
    draftFrom: (state) => state.profile ?? blankProfile(),
    request: (state, draft) => ({ expectedRevisionId: state.revisionId, profile: contentProfileSchema.parse(draft) }),
    validateSave: (value) => { saveContentProfileResponseSchema.parse(value); },
  });
  const draft = editor.draft;
  const dirty = draft && JSON.stringify(draft) !== JSON.stringify(editor.state?.profile ?? blankProfile());
  return <div className="mt-4 space-y-4">
    {draft && <fieldset disabled={!editor.editable} className="space-y-4">
      <TemplateFields value={draft.defaultTemplate} onChange={(defaultTemplate) => editor.edit({ ...draft, defaultTemplate })} />
      <p className="text-xs text-zinc-500">A matching group replaces the store introduction/footer; groups do not stack. Lowest priority number wins. Equal winning priorities block publication until resolved.</p>
      <div className="max-h-96 space-y-2 overflow-auto overscroll-contain">
        {draft.groups.map((group) => <details key={group.id} className="rounded border p-3"
          onToggle={(event) => { const open = event.currentTarget.open; setOpenGroups((current) => ({ ...current, [group.id]: open })); }}>
          <summary className="cursor-pointer text-sm font-medium">{group.name || "Unnamed group"} · priority {group.priority}</summary>
          {openGroups[group.id] && <div className="mt-3 space-y-3">
            <label className="block text-xs">Group name<Input value={group.name} maxLength={120} onChange={(event) => editor.edit({ ...draft, groups: draft.groups.map((row) => row.id === group.id ? { ...row, name: event.target.value } : row) })} /></label>
            <label className="block text-xs">Priority<Input type="number" min={1} max={100000} step={1} value={group.priority}
              onChange={(event) => editor.edit({ ...draft, groups: draft.groups.map((row) => row.id === group.id ? { ...row, priority: Number(event.target.value) } : row) })} /></label>
            <DropshipCatalogScopePicker endpoint={endpoint} value={group.scope} disabled={!editor.editable}
              onChange={(scope) => editor.edit({ ...draft, groups: draft.groups.map((row) => row.id === group.id ? { ...row, scope } : row) })} />
            <TemplateFields value={group.template} onChange={(template) => editor.edit({ ...draft, groups: draft.groups.map((row) => row.id === group.id ? { ...row, template } : row) })} />
            <Button variant="ghost" size="sm" onClick={() => editor.edit({ ...draft, groups: draft.groups.filter((row) => row.id !== group.id) })}>Remove template group</Button>
          </div>}
        </details>)}
      </div>
      <Button variant="outline" size="sm" disabled={draft.groups.length >= 100} onClick={() => editor.edit({ ...draft, groups: [...draft.groups,
        { id: createDropshipIdempotencyKey("content-group").replace(/:/g, "_"), name: "New group", priority: (draft.groups.length + 1) * 10,
          scope: { type: "listings", productVariantIds: [] }, template: blankTemplate() }] })}>Add template group</Button>
    </fieldset>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={editor.busy || props.disabled || (!dirty && editor.phase !== "uncertain") || ["conflict", "refresh_error"].includes(editor.phase)}
        onClick={() => void editor.save()}>{editor.phase === "uncertain" ? "Retry same template save" : "Save description templates"}</Button>
      <Button variant="outline" size="sm" disabled={editor.busy} onClick={() => void editor.reload()}>Reload saved templates</Button>
      {editor.phase === "refresh_error" && <Button variant="outline" size="sm" onClick={() => void editor.refreshPreview()}>Retry preview refresh</Button>}
    </div>
    <p className="text-xs text-zinc-500">Templates apply to current and future local listing drafts. Saving does not publish or rewrite live listings. Open a listing preview to inspect its assembled description. Reload discards local edits.</p>
    {editor.error && <p role="alert" className="text-sm text-amber-800">{editor.error}</p>}
    {editor.message && <p role="status" className="text-sm text-emerald-800">{editor.message}</p>}
  </div>;
}
function TemplateFields({ value, onChange }: { value: DescriptionTemplate; onChange: (value: DescriptionTemplate) => void }) {
  return <div className="grid gap-3 sm:grid-cols-2">{(["introduction", "footer"] as const).map((field) =>
    <label key={field} className="block text-xs capitalize">{field} (optional)
      <Textarea className="mt-1 min-h-24" maxLength={MAX_TEMPLATE_TEXT_LENGTH} value={value[field]} onChange={(event) => onChange({ ...value, [field]: event.target.value })} />
    </label>)}</div>;
}
