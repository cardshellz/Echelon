import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link2, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";

import { buildIdentityDraftRequest, describeError, isConflict, saveIdentityDraft } from "../api";
import { invalidateChannelInventory, useCommandKey } from "../hooks";
import {
  describeIdentity,
  findMappingHead,
  providerLabel,
  type Target,
  type Variant,
  type View,
} from "../model";
import { ConflictAlert, NoteField, StatePill } from "./primitives";

const IDENTITY_HINTS: Record<string, string> = {
  shopify: "The Shopify inventory item id for this SKU at the store.",
  ebay: "The inventory item identifier registered on the eBay seller account for this SKU.",
};

/**
 * Exact external identity of one SKU at one destination. Integration setup,
 * not a selling rule: without it the destination cannot send a quantity for
 * the SKU, and the server never guesses one.
 */
export function IdentityCell({ view, target, variant, provider, canEdit, onReload, reloading }: {
  view: View;
  target: Target;
  variant: Pick<Variant, "id" | "sku" | "name">;
  provider: string;
  canEdit: boolean;
  onReload(): void;
  reloading: boolean;
}) {
  const head = findMappingHead(view.variantMappingHeads, target.id, variant.id);
  const identity = describeIdentity(head);
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {identity.kind === "missing" ? (
        <StatePill tone="blocked">Not mapped</StatePill>
      ) : (
        <span className="flex flex-col">
          <span className="flex items-center gap-1.5">
            <StatePill tone={identity.kind === "draft" ? "draft" : "neutral"}>
              {identity.kind === "draft" ? "Mapped · pending" : "Mapped"}
            </StatePill>
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground" title={identity.externalInventoryItemId}>
            {identity.externalInventoryItemId}
          </span>
        </span>
      )}
      {canEdit && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs">
              {identity.kind === "missing"
                ? <><Link2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Set identity</>
                : <><Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />Edit</>}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[min(24rem,90vw)]">
            <IdentityForm
              view={view}
              target={target}
              variant={variant}
              provider={provider}
              onDone={() => setOpen(false)}
              onReload={onReload}
              reloading={reloading}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

function IdentityForm({ view, target, variant, provider, onDone, onReload, reloading }: {
  view: View;
  target: Target;
  variant: Pick<Variant, "id" | "sku" | "name">;
  provider: string;
  onDone(): void;
  onReload(): void;
  reloading: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const command = useCommandKey();
  const head = findMappingHead(view.variantMappingHeads, target.id, variant.id);
  const identity = describeIdentity(head);
  const suggestion = view.legacyMappingCandidates.find((candidate) =>
    candidate.channelId === target.channelId && candidate.productVariantId === variant.id) ?? null;
  const initialItemId = identity.kind === "missing" ? suggestion?.externalInventoryItemId ?? "" : identity.externalInventoryItemId;
  const initialSku = identity.kind === "missing" ? suggestion?.externalSku ?? variant.sku ?? "" : identity.externalSku ?? "";
  const [itemId, setItemId] = useState(initialItemId);
  const [externalSku, setExternalSku] = useState(initialSku);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const fingerprint = `${head?.revision ?? "0"}:${head?.draftMapping?.definitionHash ?? ""}`;

  useEffect(() => {
    setItemId(initialItemId);
    setExternalSku(initialSku);
    setConflict(null);
    command.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fingerprint]);

  const save = useMutation({
    mutationFn: () => saveIdentityDraft(buildIdentityDraftRequest({
      publicationTargetId: target.id,
      productVariantId: variant.id,
      externalInventoryItemId: itemId,
      externalSku,
      head,
      note,
      idempotencyKey: command.keyFor(JSON.stringify({ target: target.id, variant: variant.id, itemId: itemId.trim(), externalSku: externalSku.trim(), note, fingerprint })),
    })),
    onSuccess: async () => {
      command.clear();
      await invalidateChannelInventory(queryClient);
      toast({ title: `Identity saved for ${variant.sku ?? variant.name}`, description: "Pending activation. No quantity was sent." });
      onDone();
    },
    onError: (error) => {
      const described = describeError(error);
      if (isConflict(error)) { setConflict(described.message); return; }
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  const changed = itemId.trim() !== (identity.kind === "missing" ? "" : identity.externalInventoryItemId)
    || externalSku.trim() !== (identity.kind === "missing" ? "" : identity.externalSku ?? "");
  const idField = `identity-${target.id}-${variant.id}`;

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">{variant.sku ?? variant.name} at {providerLabel(provider)}</p>
        <p className="text-xs text-muted-foreground">{IDENTITY_HINTS[provider] ?? "The provider's inventory item identifier for this SKU."}</p>
      </div>
      {conflict && <ConflictAlert message={conflict} onReload={onReload} reloading={reloading} />}
      <div className="space-y-1.5">
        <Label htmlFor={`${idField}-item`}>Inventory item id</Label>
        <Input id={`${idField}-item`} value={itemId} maxLength={240} disabled={save.isPending} onChange={(event) => setItemId(event.target.value)} />
        {identity.kind === "missing" && suggestion?.externalInventoryItemId && (
          <p className="text-xs text-muted-foreground">Suggested from the legacy feed ({suggestion.mappingState}); verify before saving.</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${idField}-sku`}>Listing SKU at the provider (optional)</Label>
        <Input id={`${idField}-sku`} value={externalSku} maxLength={100} disabled={save.isPending} onChange={(event) => setExternalSku(event.target.value)} />
      </div>
      <NoteField id={`${idField}-note`} value={note} onChange={setNote} disabled={save.isPending} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" disabled={save.isPending} onClick={onDone}>Cancel</Button>
        <Button type="button" size="sm" disabled={!changed || itemId.trim().length === 0 || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save identity"}
        </Button>
      </div>
    </div>
  );
}
