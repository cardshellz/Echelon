import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";

import { InventoryRuntimeAuthorityBadge } from "@/components/inventory/InventoryRuntimeAuthorityBadge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@/lib/auth";

import { describeError } from "./api";
import { AddDestinationDialog } from "./components/AddDestinationDialog";
import { ChannelRail, ChannelSelect, ProviderGlyph } from "./components/ChannelRail";
import { DestinationStrip } from "./components/DestinationStrip";
import { GlobalPublishingControl } from "./components/GlobalPublishingControl";
import { PublishingTab } from "./components/PublishingTab";
import { QuantitiesTab } from "./components/QuantitiesTab";
import { SellingRulesTab } from "./components/SellingRulesTab";
import { SupplyTab } from "./components/SupplyTab";
import { Callout } from "./components/primitives";
import { useChannelInventoryView } from "./hooks";
import { buildChannelRail, providerLabel, reconcileSelection, summarizePendingChanges } from "./model";

export const CHANNEL_INVENTORY_PATH = "/channels/inventory";

const TABS = ["supply", "rules", "quantities", "publishing"] as const;
type Tab = typeof TABS[number];

interface PageSelection {
  channelId: number | null;
  targetId: number | null;
  productId: number | null;
  tab: Tab;
}

function readSelection(search: string): PageSelection {
  const params = new URLSearchParams(search);
  const number = (key: string) => {
    const raw = params.get(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  };
  const tab = params.get("tab");
  return {
    channelId: number("channel"),
    targetId: number("destination"),
    productId: number("product"),
    tab: TABS.includes(tab as Tab) ? (tab as Tab) : "supply",
  };
}

function writeSelection(selection: PageSelection): string {
  const params = new URLSearchParams();
  if (selection.channelId !== null) params.set("channel", String(selection.channelId));
  if (selection.targetId !== null) params.set("destination", String(selection.targetId));
  if (selection.productId !== null) params.set("product", String(selection.productId));
  if (selection.tab !== "supply") params.set("tab", selection.tab);
  return params.toString();
}

/**
 * Channel Inventory: which warehouses supply each sales channel, how much of
 * the available stock it may offer, which items need different rules, what
 * quantity results, and who currently controls publication.
 *
 * The page renders server evidence and collects intended changes. It never
 * calculates availability itself and never publishes on save.
 */
export default function ChannelInventoryPage() {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("inventory_planning", "edit");
  const canActivate = hasPermission("inventory_planning", "activate");
  const isMobile = useIsMobile();
  const search = useSearch();
  const [, navigate] = useLocation();
  const [selection, setSelection] = useState<PageSelection>(() => readSelection(search));
  const [addingDestination, setAddingDestination] = useState(false);
  const now = useCallback(() => new Date(), []);

  const viewQuery = useChannelInventoryView(selection.productId);
  const view = viewQuery.data ?? null;

  // Keep the URL shareable: every selection lives in the query string so a
  // link from a product page or a colleague opens the same channel and tab.
  useEffect(() => {
    const next = writeSelection(selection);
    if (next !== search) navigate(`${CHANNEL_INVENTORY_PATH}${next ? `?${next}` : ""}`, { replace: true });
  }, [selection, search, navigate]);

  const rail = useMemo(() => (view ? buildChannelRail(view) : []), [view]);
  const channelId = reconcileSelection(selection.channelId, view?.channels ?? []);
  const channel = view?.channels.find((item) => item.id === channelId) ?? null;
  const targets = useMemo(
    () => (view && channelId !== null ? view.publicationTargets.filter((target) => target.channelId === channelId) : []),
    [view, channelId],
  );
  const targetId = reconcileSelection(selection.targetId, targets);
  const target = targets.find((item) => item.id === targetId) ?? null;

  // Persist reconciled ids so the URL never points at a channel/destination
  // that no longer exists.
  useEffect(() => {
    if (!view) return;
    if (channelId !== selection.channelId || targetId !== selection.targetId) {
      setSelection((current) => ({ ...current, channelId, targetId }));
    }
  }, [view, channelId, targetId, selection.channelId, selection.targetId]);

  const focusProduct = useCallback((productId: number) => {
    setSelection((current) => (current.productId === productId ? current : { ...current, productId }));
  }, []);
  const reload = useCallback(() => { void viewQuery.refetch(); }, [viewQuery]);

  if (viewQuery.isLoading && !view) return <PageSkeleton />;
  if (!view) {
    const described = describeError(viewQuery.error);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Callout tone="danger" title={described.title} action={<Button type="button" size="sm" variant="outline" onClick={reload}>Try again</Button>}>
          {described.message}
        </Callout>
      </div>
    );
  }

  const pending = channel ? summarizePendingChanges(view, channel.id, targetId) : null;

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 p-4 md:p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Channel Inventory</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Choose which warehouses supply each sales channel, how much of the available stock it
            may offer, and which products need different rules. Saves are recorded immediately;
            nothing publishes until it is activated.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GlobalPublishingControl canActivate={canActivate} now={now} />
          <InventoryRuntimeAuthorityBadge />
        </div>
      </header>

      {!canEdit && (
        <Callout>You can review every setting here. Saving changes needs the inventory planning edit permission.</Callout>
      )}

      {view.channels.length === 0 ? (
        <Callout title="No sales channels yet">Connect a store on the Channels page; it will appear here with its own supply, rules, and destinations.</Callout>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <aside className="space-y-3">
            {isMobile ? (
              <ChannelSelect entries={rail} selectedId={channelId} onSelect={(id) => setSelection((current) => ({ ...current, channelId: id, targetId: null }))} />
            ) : (
              <>
                <p className="px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales channels</p>
                <ChannelRail entries={rail} selectedId={channelId} onSelect={(id) => setSelection((current) => ({ ...current, channelId: id, targetId: null }))} />
              </>
            )}
          </aside>

          {channel && (
            <section className="min-w-0 space-y-5" aria-label={`${channel.name} channel inventory`}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <ProviderGlyph provider={channel.provider} className="h-10 w-10 text-sm" />
                  <div>
                    <h2 className="text-lg font-semibold leading-tight">{channel.name}</h2>
                    <p className="text-xs text-muted-foreground">
                      {providerLabel(channel.provider)} · {channel.status}
                      {pending && pending.total > 0 ? ` · ${pending.total} saved change${pending.total === 1 ? "" : "s"} pending activation` : ""}
                    </p>
                  </div>
                </div>
              </div>

              <DestinationStrip
                view={view}
                targets={targets}
                selectedId={targetId}
                onSelect={(id) => setSelection((current) => ({ ...current, targetId: id }))}
                canEdit={canEdit}
                onAdd={() => setAddingDestination(true)}
              />

              <Tabs value={selection.tab} onValueChange={(value) => setSelection((current) => ({ ...current, tab: value as Tab }))}>
                <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
                  <TabsTrigger value="supply">Supply</TabsTrigger>
                  <TabsTrigger value="rules">Selling rules</TabsTrigger>
                  <TabsTrigger value="quantities">Quantities</TabsTrigger>
                  <TabsTrigger value="publishing">Publishing</TabsTrigger>
                </TabsList>
                <TabsContent value="supply" className="mt-4">
                  <SupplyTab
                    view={view}
                    target={target}
                    canEdit={canEdit}
                    onAddDestination={() => setAddingDestination(true)}
                    onReload={reload}
                    reloading={viewQuery.isFetching}
                  />
                </TabsContent>
                <TabsContent value="rules" className="mt-4">
                  <SellingRulesTab
                    view={view}
                    channel={channel}
                    canEdit={canEdit}
                    focusProductId={selection.productId}
                    onFocusProduct={focusProduct}
                    onReload={reload}
                    reloading={viewQuery.isFetching}
                  />
                </TabsContent>
                <TabsContent value="quantities" className="mt-4">
                  <QuantitiesTab
                    view={view}
                    channel={channel}
                    target={target}
                    canEdit={canEdit}
                    productId={selection.productId}
                    onProductChange={focusProduct}
                    onAddDestination={() => setAddingDestination(true)}
                    onReload={reload}
                    reloading={viewQuery.isFetching}
                    now={now}
                  />
                </TabsContent>
                <TabsContent value="publishing" className="mt-4">
                  <PublishingTab
                    view={view}
                    channel={channel}
                    target={target}
                    canEdit={canEdit}
                    canActivate={canActivate}
                    onAddDestination={() => setAddingDestination(true)}
                  />
                </TabsContent>
              </Tabs>
            </section>
          )}
        </div>
      )}

      {channel && addingDestination && (
        <AddDestinationDialog
          open={addingDestination}
          onOpenChange={setAddingDestination}
          view={view}
          channel={channel}
          onCreated={(id) => setSelection((current) => ({ ...current, targetId: id, tab: "supply" }))}
        />
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-6 p-4 md:p-6" aria-busy="true" aria-label="Loading channel inventory">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
