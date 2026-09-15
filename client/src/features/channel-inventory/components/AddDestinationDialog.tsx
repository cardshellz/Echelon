import { useEffect, useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

import { buildSupplyDraftRequest, describeError, normalizeNote, registerDestination, saveSupplyDraft } from "../api";
import { invalidateChannelInventory, useCommandKey, useShopifyLocations } from "../hooks";
import {
  PUBLISHER_LABELS,
  buildDestinationRequest,
  destinationOptionsFor,
  providerLabel,
  type Channel,
  type DestinationOption,
  type PublisherKey,
  type View,
} from "../model";
import { NodeChecklist } from "./NodeChecklist";
import { Callout, FormValidationStop, NoteField } from "./primitives";

const PUBLISHER_ORDER: readonly PublisherKey[] = ["echelon", "external_provider", "manual"];

/**
 * Registers a new destination for the channel. Provider-specific identity
 * (Shopify location, verified eBay account) is asked for only where the
 * provider needs it; there is no universal store/location field.
 */
export function AddDestinationDialog({ open, onOpenChange, view, channel, onCreated }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  view: View;
  channel: Channel;
  onCreated(targetId: number): void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const registerKey = useCommandKey();
  const supplyKey = useCommandKey();
  const options = useMemo(() => destinationOptionsFor(channel, view), [channel, view]);
  const [optionKey, setOptionKey] = useState<string>(options.length === 1 ? keyOf(options[0]!) : "");
  const option = options.find((item) => keyOf(item) === optionKey) ?? null;
  const [externalScopeId, setExternalScopeId] = useState("");
  const [supplyNodeIds, setSupplyNodeIds] = useState<number[]>([]);
  const [publisher, setPublisher] = useState<PublisherKey>("echelon");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const shopifyChannelId = option?.kind === "channel_connection" && option.provider === "shopify" ? channel.id : null;
  const locations = useShopifyLocations(shopifyChannelId);

  useEffect(() => {
    setExternalScopeId(option?.scopeType === "account"
      ? option.verifiedAccountId ?? ""
      : option?.suggestedLocationId ?? "");
    setMessage(null);
    registerKey.clear();
    supplyKey.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionKey]);

  const create = useMutation({
    mutationFn: async () => {
      const built = buildDestinationRequest(channel.id, { option, externalScopeId, supplyNodeIds, publisher });
      if (!built.ok) throw new FormValidationStop(built.message);
      const registration = { ...built.request, changeReason: normalizeNote(note) };
      const created = await registerDestination({
        ...registration,
        idempotencyKey: registerKey.keyFor(JSON.stringify(registration)),
      });
      // The registration is durable at this point. Saving the full supply set
      // is a second command; if it fails the destination simply shows "no
      // supply configured" and the operator can finish it on the Supply tab.
      try {
        await saveSupplyDraft(buildSupplyDraftRequest({
          publicationTargetId: created.publicationTargetId,
          fulfillmentNodeIds: supplyNodeIds,
          head: null,
          note,
          idempotencyKey: supplyKey.keyFor(JSON.stringify({ target: created.publicationTargetId, supplyNodeIds })),
        }));
      } catch (error) {
        return { created, supplyError: describeError(error) };
      }
      return { created, supplyError: null };
    },
    onSuccess: async ({ created, supplyError }) => {
      registerKey.clear();
      supplyKey.clear();
      await invalidateChannelInventory(queryClient);
      toast({
        title: "Destination added",
        description: supplyError
          ? `Registered, but supply was not saved: ${supplyError.message}. Finish it on the Supply tab.`
          : "It starts as not publishing. Set selling rules and SKU identities, then include it in readiness review.",
        variant: supplyError ? "destructive" : "default",
      });
      onCreated(created.publicationTargetId);
      onOpenChange(false);
    },
    onError: (error) => {
      if (error instanceof FormValidationStop) { setMessage(error.message); return; }
      const described = describeError(error);
      setMessage(described.message);
    },
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!create.isPending) onOpenChange(next); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a destination for {channel.name}</DialogTitle>
          <DialogDescription>
            A destination is the exact account or location that receives quantities. It starts as
            not publishing; nothing is sent until it is reviewed and enabled.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <section className="space-y-2">
            <Label htmlFor="destination-option">Where quantities go</Label>
            {options.length === 0 ? (
              <Callout tone="warning">
                No store connection or dropship store is available for this channel. Connect the
                store first on the Channels page.
              </Callout>
            ) : (
              <Select value={optionKey} onValueChange={setOptionKey} disabled={create.isPending}>
                <SelectTrigger id="destination-option"><SelectValue placeholder="Choose a store or account" /></SelectTrigger>
                <SelectContent>
                  <OptionGroup label={`${channel.name} connections`} options={options.filter((item) => item.kind === "channel_connection")} />
                  <OptionGroup label="Dropship stores" options={options.filter((item) => item.kind === "dropship_store_connection")} />
                </SelectContent>
              </Select>
            )}
            {option && !option.supported && (
              <Callout tone="warning">
                {providerLabel(option.provider)} has no inventory publishing adapter yet, so this
                destination cannot be registered. The channel's selling rules can still be prepared.
              </Callout>
            )}
          </section>

          {option?.supported && option.scopeType === "location" && (
            <section className="space-y-2">
              <Label htmlFor="destination-location">Shopify location</Label>
              {locations.isLoading && <p className="text-xs text-muted-foreground">Reading locations from Shopify…</p>}
              {locations.data && locations.data.length > 0 ? (
                <Select value={externalScopeId} onValueChange={setExternalScopeId} disabled={create.isPending}>
                  <SelectTrigger id="destination-location"><SelectValue placeholder="Choose the location that receives quantities" /></SelectTrigger>
                  <SelectContent>
                    {locations.data.map((location) => (
                      <SelectItem key={location.id} value={location.id}>
                        {location.name}{location.city ? ` · ${location.city}` : ""}{location.active === false ? " (inactive)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <>
                  <Input
                    id="destination-location"
                    value={externalScopeId}
                    placeholder="Shopify location id"
                    disabled={create.isPending}
                    onChange={(event) => setExternalScopeId(event.target.value)}
                  />
                  {locations.error && (
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      Locations could not be read from Shopify ({describeError(locations.error).message}). Enter the exact location id.
                    </p>
                  )}
                </>
              )}
              <p className="text-xs text-muted-foreground">Shopify quantities are written per location. Each location is its own destination.</p>
            </section>
          )}

          {option?.supported && option.scopeType === "account" && (
            <section className="space-y-2">
              <Label htmlFor="destination-account">{providerLabel(option.provider)} seller account</Label>
              {option.verifiedAccountId ? (
                <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
                  {option.verifiedAccountLabel ? `${option.verifiedAccountLabel} · ` : ""}
                  <span className="font-mono text-xs">{option.verifiedAccountId}</span>
                  <span className="block text-xs text-muted-foreground">Verified against the connected credential; quantities can only go to this account.</span>
                </p>
              ) : (
                <>
                  <Input
                    id="destination-account"
                    value={externalScopeId}
                    placeholder="Provider account id"
                    disabled={create.isPending}
                    onChange={(event) => setExternalScopeId(event.target.value)}
                  />
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    This connection has no provider-verified account identity yet. Publishing will be
                    refused until the account is verified through its OAuth connection.
                  </p>
                </>
              )}
            </section>
          )}

          {option?.supported && (
            <section className="space-y-2">
              <p className="text-sm font-medium">Warehouses that can supply it</p>
              {view.fulfillmentNodes.length === 0 ? (
                <Callout tone="warning">No warehouses are prepared as supply sources yet. Prepare one from the Supply tab first.</Callout>
              ) : (
                <NodeChecklist
                  idPrefix="new-destination"
                  nodes={view.fulfillmentNodes}
                  selectedIds={supplyNodeIds}
                  disabled={create.isPending}
                  onToggle={(nodeId, checked) => setSupplyNodeIds((current) => checked
                    ? [...new Set([...current, nodeId])]
                    : current.filter((id) => id !== nodeId))}
                />
              )}
            </section>
          )}

          {option?.supported && (
            <section className="space-y-2">
              <p className="text-sm font-medium">Who publishes the quantity</p>
              <RadioGroup value={publisher} onValueChange={(value) => setPublisher(value as PublisherKey)} disabled={create.isPending} className="gap-2">
                {PUBLISHER_ORDER.map((key) => (
                  <label key={key} htmlFor={`publisher-${key}`} className="flex cursor-pointer items-start gap-3 rounded-md border p-3 hover:bg-accent/40">
                    <RadioGroupItem id={`publisher-${key}`} value={key} className="mt-0.5" />
                    <span className="text-sm">
                      <span className="font-medium">{PUBLISHER_LABELS[key].label}</span>
                      <span className="block text-xs text-muted-foreground">{PUBLISHER_LABELS[key].description}</span>
                    </span>
                  </label>
                ))}
              </RadioGroup>
            </section>
          )}

          {option?.supported && <NoteField id="new-destination-note" value={note} onChange={setNote} disabled={create.isPending} />}
          {message && <Callout tone="warning">{message}</Callout>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={create.isPending} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" disabled={!option?.supported || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Adding…" : "Add destination"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OptionGroup({ label, options }: { label: string; options: readonly DestinationOption[] }) {
  if (options.length === 0) return null;
  return (
    <SelectGroup>
      <SelectLabel>{label}</SelectLabel>
      {options.map((option) => (
        <SelectItem key={keyOf(option)} value={keyOf(option)}>
          {option.label} · {providerLabel(option.provider)}
        </SelectItem>
      ))}
    </SelectGroup>
  );
}

function keyOf(option: DestinationOption): string {
  return `${option.kind}:${option.id}`;
}
