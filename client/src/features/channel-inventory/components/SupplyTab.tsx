import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { WarehouseInventorySourceSetup } from "@/components/inventory/WarehouseInventorySourceSetup";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

import { buildSupplyDraftRequest, describeError, isConflict, saveSupplyDraft } from "../api";
import { invalidateChannelInventory, useCommandKey } from "../hooks";
import {
  describeDestination,
  describeSupply,
  sameIdSet,
  summarizeNodes,
  type Target,
  type View,
} from "../model";
import { NodeChecklist } from "./NodeChecklist";
import { ActivePill, Callout, ConflictAlert, EvidenceNote, NoteField, PendingPill, SectionCard } from "./primitives";

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
      action={canEdit ? <Button type="button" size="sm" onClick={onAdd}>Add destination</Button> : undefined}
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
  const command = useCommandKey();
  const identity = describeDestination(target, view);
  const head = view.sourceBindingHeads.find((item) => item.publicationTargetId === target.id) ?? null;
  const supply = describeSupply(head);
  const [selected, setSelected] = useState<number[]>(supply.savedNodeIds);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const savedFingerprint = `${head?.revision ?? "0"}:${head?.draftBinding?.definitionHash ?? ""}:${head?.activeBinding?.definitionHash ?? ""}`;

  // A fresh server revision (own save, reload, or another operator) resets the
  // working set to what is actually saved.
  useEffect(() => {
    setSelected(supply.savedNodeIds);
    setConflict(null);
    command.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedFingerprint]);

  const save = useMutation({
    mutationFn: () => {
      const request = buildSupplyDraftRequest({
        publicationTargetId: target.id,
        fulfillmentNodeIds: selected,
        head,
        note,
        idempotencyKey: command.keyFor(JSON.stringify({ target: target.id, selected: [...selected].sort(), note, savedFingerprint })),
      });
      return saveSupplyDraft(request);
    },
    onSuccess: async () => {
      command.clear();
      setNote("");
      setConflict(null);
      await invalidateChannelInventory(queryClient);
      toast({
        title: `Supply saved for ${identity.title}`,
        description: "Takes effect when this configuration is activated. Nothing was sent to the provider.",
      });
    },
    onError: (error) => {
      const described = describeError(error);
      if (isConflict(error)) {
        setConflict(described.message);
        return;
      }
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  const changed = !sameIdSet(selected, supply.savedNodeIds);
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
        {conflict && <ConflictAlert message={conflict} onReload={onReload} reloading={reloading} />}
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
            disabled={!canEdit || save.isPending}
            onToggle={(nodeId, checked) => setSelected((current) => checked
              ? [...new Set([...current, nodeId])]
              : current.filter((id) => id !== nodeId))}
          />
        )}
        {canEdit && (
          <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
            <NoteField id={`supply-note-${target.id}`} value={note} onChange={setNote} disabled={save.isPending} />
            <div className="flex items-center gap-3">
              {changed && !save.isPending && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              <Button
                type="button"
                disabled={!changed || selected.length === 0 || save.isPending}
                onClick={() => save.mutate()}
              >
                {save.isPending ? "Saving…" : "Save supply"}
              </Button>
            </div>
          </div>
        )}
        <EvidenceNote>
          Supply is set per destination. Narrower warehouse rules for one product or SKU are not
          available yet; every product on this destination draws from the same warehouses.
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
