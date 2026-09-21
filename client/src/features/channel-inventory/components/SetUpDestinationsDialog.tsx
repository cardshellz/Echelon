import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";

import { describeError, normalizeNote, setUpChannelDestinations } from "../api";
import { invalidateChannelInventory, useCommandKey } from "../hooks";
import {
  PUBLISHER_LABELS,
  destinationOptionsFor,
  type Channel,
  type PublisherKey,
  type View,
} from "../model";
import { NodeChecklist } from "./NodeChecklist";
import { Callout, NoteField } from "./primitives";

const PUBLISHER_ORDER: readonly PublisherKey[] = ["echelon", "external_provider", "manual"];

/** Operator-facing wording for each reason the server declined to register one. */
const SKIP_EXPLANATIONS: Record<string, string> = {
  already_registered: "Already set up",
  no_publishing_adapter: "Echelon cannot publish to this provider yet",
  no_verified_account: "The connection has no verified account id yet",
  no_provider_location: "The connection has no verified fulfillment center yet",
  no_shopify_location: "The connection has no Shopify location recorded yet",
};

/**
 * Sets up every destination a channel's connections already imply.
 *
 * Deliberately asks two questions and no more. Which account or location
 * receives quantities is never a choice: an eBay connection has exactly one
 * verified seller account, a Shopify connection already records the location
 * its inventory writes must name, and a dropship storefront is described by its
 * vendor record. The server derives all of that and reports anything it refused
 * to guess, so this dialog never asks an operator to retype a known value or to
 * pick between options where only one is possible.
 */
export function SetUpDestinationsDialog({ open, onOpenChange, view, channel, onCompleted }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  view: View;
  channel: Channel;
  onCompleted(): void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const command = useCommandKey();
  const [supplyNodeIds, setSupplyNodeIds] = useState<number[]>([]);
  const [publisher, setPublisher] = useState<PublisherKey>("echelon");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  // Preview only. The server re-derives from the connections and its response is
  // the record of what actually happened.
  const pending = useMemo(
    () => destinationOptionsFor(channel, view).filter((option) => option.supported),
    [channel, view],
  );

  const setUp = useMutation({
    mutationFn: async () => {
      const payload = {
        channelId: channel.id,
        supplyFulfillmentNodeIds: supplyNodeIds,
        publicationAuthority: publisher,
        changeReason: normalizeNote(note),
      };
      return setUpChannelDestinations({
        ...payload,
        idempotencyKey: command.keyFor(JSON.stringify(payload)),
      });
    },
    onSuccess: (result) => {
      command.clear();
      const blocked = result.skipped.filter((entry) => entry.reason !== "already_registered");
      toast({
        title: result.created.length === 1
          ? "1 destination set up"
          : `${result.created.length} destinations set up`,
        description: blocked.length > 0
          ? `${blocked.length} could not be derived and were left alone.`
          : undefined,
      });
      void invalidateChannelInventory(queryClient);
      onCompleted();
      onOpenChange(false);
    },
    onError: (error) => {
      const described = describeError(error);
      setMessage(described.message);
      toast({ title: described.title, description: described.message, variant: "destructive" });
    },
  });

  const canSubmit = supplyNodeIds.length > 0 && pending.length > 0 && !setUp.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!setUp.isPending) onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set up destinations for {channel.name}</DialogTitle>
          <DialogDescription>
            Echelon reads the accounts and locations your connections already define. Each one
            starts as not publishing; nothing is sent until it is reviewed and enabled.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-sm font-medium">
              {pending.length === 0
                ? "Nothing to set up"
                : pending.length === 1
                  ? "1 destination found"
                  : `${pending.length} destinations found`}
            </p>
            {pending.length === 0 ? (
              <Callout tone="warning">
                Every connected account or location on this channel is either already set up or
                missing the identity Echelon needs. Connect a store, or verify the account, first.
              </Callout>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {pending.slice(0, 8).map((option) => (
                  <li key={`${option.kind}:${option.id}`} className="px-3 py-2">
                    {option.label}
                  </li>
                ))}
                {pending.length > 8 && (
                  <li className="px-3 py-2 text-xs text-muted-foreground">
                    and {pending.length - 8} more
                  </li>
                )}
              </ul>
            )}
          </section>

          {pending.length > 0 && (
            <section className="space-y-2">
              <p className="text-sm font-medium">Warehouses that supply them</p>
              <p className="text-xs text-muted-foreground">
                This cannot be changed per destination afterwards, so it is asked once for the
                whole channel.
              </p>
              {view.fulfillmentNodes.length === 0 ? (
                <Callout tone="warning">
                  No warehouses are prepared as supply sources yet. Prepare one from the Supply tab
                  first.
                </Callout>
              ) : (
                <NodeChecklist
                  idPrefix="set-up-destinations"
                  nodes={view.fulfillmentNodes}
                  selectedIds={supplyNodeIds}
                  disabled={setUp.isPending}
                  onToggle={(nodeId, checked) => setSupplyNodeIds((current) => checked
                    ? [...new Set([...current, nodeId])]
                    : current.filter((id) => id !== nodeId))}
                />
              )}
            </section>
          )}

          {pending.length > 0 && (
            <section className="space-y-2">
              <p className="text-sm font-medium">Who publishes the quantity</p>
              <RadioGroup
                value={publisher}
                onValueChange={(value) => setPublisher(value as PublisherKey)}
                disabled={setUp.isPending}
                className="gap-2"
              >
                {PUBLISHER_ORDER.map((key) => (
                  <label
                    key={key}
                    htmlFor={`setup-publisher-${key}`}
                    className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-accent/40"
                  >
                    <RadioGroupItem id={`setup-publisher-${key}`} value={key} className="mt-0.5" />
                    <span className="text-sm">
                      <span className="font-medium">{PUBLISHER_LABELS[key].label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {PUBLISHER_LABELS[key].description}
                      </span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </section>
          )}

          {setUp.data && setUp.data.skipped.length > 0 && (
            <section className="space-y-2">
              <p className="text-sm font-medium">Left alone</p>
              <ul className="divide-y rounded-md border text-sm">
                {setUp.data.skipped.map((entry, index) => (
                  <li key={`${entry.label}:${index}`} className="px-3 py-2">
                    <span>{entry.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {SKIP_EXPLANATIONS[entry.reason] ?? entry.reason}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {pending.length > 0 && (
            <NoteField
              id="set-up-destinations-note"
              value={note}
              onChange={setNote}
              disabled={setUp.isPending}
            />
          )}
          {message && <Callout tone="warning">{message}</Callout>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={setUp.isPending}>
            Cancel
          </Button>
          <Button onClick={() => { setMessage(null); setUp.mutate(); }} disabled={!canSubmit}>
            {setUp.isPending ? "Setting up…" : "Set up destinations"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
