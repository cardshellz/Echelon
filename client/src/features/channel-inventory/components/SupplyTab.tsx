import { useQueryClient } from "@tanstack/react-query";

import { WarehouseInventorySourceSetup } from "@/components/inventory/WarehouseInventorySourceSetup";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { buildSupplyDraftRequest, saveSupplyDraft } from "../api";
import { invalidateChannelInventory } from "../hooks";
import { useDraftEditor } from "../use-draft-editor";
import { DraftSaveFeedback } from "./DraftSaveFeedback";
import {
  describeDestination,
  describeSupply,
  sameIdSet,
  summarizeNodes,
  type Target,
  type View,
} from "../model";
import { NodeChecklist } from "./NodeChecklist";
import { ActivePill, Callout, EvidenceNote, NoteField, PendingPill, SectionCard } from "./primitives";

/** Which warehouses may supply the selected destination. */
export function SupplyTab({ view, target, canEdit, onAddDestination, onReload, reloading }: {
  view: View;
  target: Target | null;
  canEdit: boolean;
  onAddDestination(): void;
  onReload(): void;
  reloading: boolean;
}) {
  if (!target) return <NoDestinationYet canEdit={canEdit} onAdd={onAddDestination} />;
  return (
    <SupplyEditor
      key={target.id}
      view={view}
      target={target}
      canEdit={canEdit}
      onReload={onReload}
      reloading={reloading}
    />
  );
}

export function NoDestinationYet({ canEdit, onAdd }: { canEdit: boolean; onAdd(): void }) {
  return (
    <Callout
      title="This channel has no destination yet"
      action={canEdit ? <Button type="button" size="sm" onClick={onAdd}>Set up destinations</Button> : undefined}
    >
      A destination is the exact store location or seller account that receives quantities.
      Add one to choose its supplying warehouses and calculate quantities.
    </Callout>
  );
}

function SupplyEditor({ view, target, canEdit, onReload, reloading }: {
  view: View;
  target: Target;
  canEdit: boolean;
  onReload(): void;
  reloading: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const identity = describeDestination(target, view);
  const head = view.sourceBindingHeads.find((item) => item.publicationTargetId === target.id) ?? null;
  const supply = describeSupply(head);
  const savedFingerprint = `${head?.revision ?? "0"}:${head?.draftBinding?.definitionHash ?? ""}:${head?.activeBinding?.definitionHash ?? ""}`;
  const editor = useDraftEditor({
    value: { selected: supply.savedNodeIds, note: "" }, baseline: head, fingerprint: savedFingerprint,
    equal: (left, right) => sameIdSet(left.selected, right.selected) && left.note === right.note,
    build: (value, baseline, idempotencyKey) => buildSupplyDraftRequest({ publicationTargetId: target.id,
      fulfillmentNodeIds: value.selected, head: baseline, note: value.note, idempotencyKey }),
    send: saveSupplyDraft,
    onSaved: async () => {
      await invalidateChannelInventory(queryClient);
      toast({
        title: `Supply saved for ${identity.title}`,
        description: "Takes effect when this configuration is activated. Nothing was sent to the provider.",
      });
    },
  });
  const { selected, note } = editor.value;
  const nodes = view.fulfillmentNodes;

  return (
    <div className="space-y-4">
      <SectionCard
        title={`Warehouses that can supply ${identity.title}`}
        description={(
          <>
            Availability is calculated per warehouse and only the warehouses chosen here are
            combined for this destination. Choosing a warehouse does not move stock, change who
            fulfills orders, or start publishing.
          </>
        )}
        actions={<SupplyStatus supply={supply} nodes={nodes} />}
      >
        {!supply.configured && (
          <Callout tone="danger" title="No supply configured">
            Without at least one supplying warehouse this destination cannot calculate or publish
            any quantity. There is no fallback to every warehouse.
          </Callout>
        )}
        <DraftSaveFeedback {...editor} onReload={() => { editor.reset(); onReload(); }} reloading={reloading} />
        {nodes.length === 0 ? (
          <Callout title="No warehouses are prepared as supply sources yet">
            Prepare an existing warehouse below to make it selectable.
          </Callout>
        ) : (
          <NodeChecklist
            idPrefix={`supply-${target.id}`}
            nodes={nodes}
            selectedIds={selected}
            activeIds={supply.activeNodeIds}
            disabled={!canEdit || editor.locked || reloading}
            onToggle={(nodeId, checked) => editor.setValue(current => ({ ...current, selected: checked
              ? [...new Set([...current.selected, nodeId])]
              : current.selected.filter((id) => id !== nodeId) }))}
          />
        )}
        {canEdit && (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
            <NoteField id={`supply-note-${target.id}`} value={note} onChange={note => editor.setValue(current => ({ ...current, note }))} disabled={editor.locked} />
            <div className="flex items-center gap-3">
              {editor.dirty && !editor.pending && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              <Button
                type="button"
                disabled={editor.pending || (!editor.uncertain && (!editor.dirty || editor.conflict || selected.length === 0 || reloading))}
                onClick={() => void editor.save()}
              >
                {editor.pending ? "Saving…" : editor.uncertain ? "Retry same save" : "Save supply"}
              </Button>
            </div>
          </div>
        )}
        <EvidenceNote>
          These are the default supply warehouses for this destination. Set different warehouses
          for a product or SKU in Selling rules → Exceptions. The narrower selection replaces the default.
        </EvidenceNote>
      </SectionCard>

      {canEdit && (
        <details className="rounded-md border bg-muted/20 px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">Need a warehouse that isn't listed?</summary>
          <div className="pt-3">
            <WarehouseInventorySourceSetup canEdit={canEdit} />
          </div>
        </details>
      )}
    </div>
  );
}

function SupplyStatus({ supply, nodes }: { supply: ReturnType<typeof describeSupply>; nodes: View["fulfillmentNodes"] }) {
  if (!supply.configured) return null;
  return (
    <dl className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {supply.activeNodeIds.length > 0 && (
        <div className="flex items-center gap-1.5">
          <ActivePill />
          <dd>{summarizeNodes(supply.activeNodeIds, nodes)}</dd>
        </div>
      )}
      {supply.draftNodeIds && (
        <div className="flex items-center gap-1.5">
          <PendingPill />
          <dd>{summarizeNodes(supply.draftNodeIds, nodes)}</dd>
        </div>
      )}
    </dl>
  );
}
