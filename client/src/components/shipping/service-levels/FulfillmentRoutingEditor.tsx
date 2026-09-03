import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ShippingFulfillmentCatalogMethod,
  ShippingFulfillmentMethodCapabilities,
  ShippingFulfillmentMethodIdentity,
  ShippingFulfillmentRouteMethod,
} from "@shared/types/shipping-fulfillment-routing";
import {
  shippingFulfillmentMethodIdentityKey as methodKey,
  shippingFulfillmentMethodScopeLabel,
} from "@shared/lib/shipping-fulfillment-method-identity";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import {
  fulfillmentRoutingKey,
  loadFulfillmentRouting,
  saveFulfillmentRouting,
} from "./api";
import {
  groupFulfillmentCatalogMethodsByScope,
  type FulfillmentCatalogDestinationScope,
} from "./fulfillment-catalog-display";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  Search,
  ServerCog,
  Settings2,
  Trash2,
} from "lucide-react";

interface PendingCommand {
  signature: string;
  idempotencyKey: string;
}

const PROVIDER_CATALOG_STALE_MS = 5 * 60 * 1000;

export interface FulfillmentRoutingEditorState {
  loaded: boolean;
  dirty: boolean;
  revision: number;
  methodCount: number;
}

export function FulfillmentRoutingEditor({
  serviceLevelId,
  onStateChange,
}: {
  serviceLevelId: number;
  onStateChange?: (state: FulfillmentRoutingEditorState) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ShippingFulfillmentMethodIdentity[]>([]);
  const pendingCommand = useRef<PendingCommand | null>(null);
  const loadedRevision = useRef<number | null>(null);
  const queryKey = fulfillmentRoutingKey(serviceLevelId);
  const query = useQuery({
    queryKey: [queryKey],
    queryFn: () => loadFulfillmentRouting(serviceLevelId),
    staleTime: PROVIDER_CATALOG_STALE_MS,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!query.data || loadedRevision.current === query.data.profile.revision) return;
    loadedRevision.current = query.data.profile.revision;
    setSelected(query.data.profile.methods.map(methodIdentity));
    pendingCommand.current = null;
  }, [query.data]);

  const catalogMethods = query.data?.catalog.status === "available"
    ? query.data.catalog.methods
    : [];
  const catalogByKey = useMemo(
    () => new Map(catalogMethods.map((method) => [methodKey(method), method])),
    [catalogMethods],
  );
  const storedByKey = useMemo(
    () => new Map((query.data?.profile.methods ?? []).map((method) => [methodKey(method), method])),
    [query.data?.profile.methods],
  );
  const selectedKeys = useMemo(
    () => new Set(selected.map(methodKey)),
    [selected],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredCatalog = catalogMethods.filter((method) => (
    !normalizedSearch
    || [
      method.providerAccountName,
      method.providerAccountId,
      method.carrierName,
      method.carrierCode,
      method.serviceName,
      method.serviceCode,
      shippingFulfillmentMethodScopeLabel(method),
    ].some((value) => value.toLowerCase().includes(normalizedSearch))
  ));
  const catalogScopeGroups = groupFulfillmentCatalogMethodsByScope(filteredCatalog);
  const selectedRows = selected.map((identity) => ({
    identity,
    method: catalogByKey.get(methodKey(identity)) ?? storedByKey.get(methodKey(identity)) ?? null,
    available: catalogByKey.has(methodKey(identity)),
  }));
  const staleSelectionCount = selectedRows.filter((row) => !row.available).length;
  const persisted = query.data?.profile.methods.map(methodIdentity) ?? [];
  const dirty = methodSequence(selected) !== methodSequence(persisted);

  useEffect(() => {
    onStateChange?.({
      loaded: query.isSuccess && query.data !== undefined,
      dirty,
      revision: query.data?.profile.revision ?? 0,
      methodCount: selected.length,
    });
  }, [dirty, onStateChange, query.data, query.isSuccess, selected.length]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!query.data) throw new Error("Fulfillment routing is not loaded.");
      if (query.data.catalog.status !== "available") {
        throw new Error("Refresh the connected provider catalogs before saving.");
      }
      if (staleSelectionCount > 0) {
        throw new Error("Remove methods that are no longer available before saving.");
      }
      const signature = methodSequence(selected);
      if (!pendingCommand.current || pendingCommand.current.signature !== signature) {
        pendingCommand.current = {
          signature,
          idempotencyKey: `fulfillment-routing:${serviceLevelId}:${crypto.randomUUID()}`,
        };
      }
      return saveFulfillmentRouting(serviceLevelId, {
        expectedRevision: query.data.profile.revision,
        idempotencyKey: pendingCommand.current.idempotencyKey,
        methods: selected,
      });
    },
    onSuccess: (result) => {
      pendingCommand.current = null;
      queryClient.setQueryData<typeof query.data>(queryKeyAsArray(queryKey), (current) => (
        current ? { ...current, profile: result.profile } : current
      ));
      toast({
        title: result.idempotentReplay
          ? "Fulfillment routing already saved"
          : "Fulfillment routing saved",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save fulfillment routing",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const refreshCatalogMutation = useMutation({
    mutationFn: () => loadFulfillmentRouting(serviceLevelId),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeyAsArray(queryKey), result);
      if (result.catalog.status !== "available") {
        toast({
          title: "Provider catalog is unavailable",
          description: result.catalog.message,
          variant: "destructive",
        });
        return;
      }
      const availableConnections = result.catalog.connections.filter(
        (connection) => connection.status === "available",
      ).length;
      toast({
        title: "Provider catalog refreshed",
        description: `${result.catalog.methods.length} methods loaded from ${availableConnections} available ${availableConnections === 1 ? "connection" : "connections"}.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not refresh provider catalog",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  if (query.isLoading) {
    return (
      <div className="flex min-h-48 items-center justify-center rounded-md border">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Fulfillment routing could not be loaded</AlertTitle>
        <AlertDescription className="mt-2 flex flex-wrap items-center gap-3">
          <span>{query.error instanceof Error ? query.error.message : "Retry the request."}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => query.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const catalog = query.data.catalog;
  const connectionCount = new Set(catalogMethods.map((method) => method.providerConnectionId)).size;

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label="Profile revision" value={String(query.data.profile.revision)} />
        <SummaryCard label="Allowed methods" value={String(selected.length)} />
        <SummaryCard
          label="Provider catalog"
          value={catalog.status === "available"
            ? `${connectionCount} ${connectionCount === 1 ? "connection" : "connections"}`
            : "Unavailable"}
        />
      </div>

      {query.data.profile.legacyUnscopedMethodCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Legacy routing records need replacement</AlertTitle>
          <AlertDescription>
            {query.data.profile.legacyUnscopedMethodCount} old method record(s) lack an exact
            provider-account identity. They are not executable routes. Save this profile to replace them.
          </AlertDescription>
        </Alert>
      )}

      {catalog.status !== "available" && (
        <Alert variant="destructive">
          <ServerCog className="h-4 w-4" />
          <AlertTitle>Fulfillment provider catalog unavailable</AlertTitle>
          <AlertDescription className="mt-2 space-y-3">
            <p>{catalog.message}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" asChild>
                <a href="/shipping-settings?tab=fulfillment-providers">
                  <Settings2 className="mr-2 h-4 w-4" /> Manage connections
                </a>
              </Button>
              <CatalogRefreshButton
                pending={refreshCatalogMutation.isPending}
                onRefresh={() => refreshCatalogMutation.mutate()}
                label="Refresh provider catalog"
              />
            </div>
          </AlertDescription>
        </Alert>
      )}

      <section className="space-y-3" aria-labelledby="allowed-methods-heading">
        <div>
          <h3 id="allowed-methods-heading" className="font-medium">Allowed routing methods</h3>
          <p className="text-sm text-muted-foreground">
            These exact account methods are the routing authority for this service level. Order them
            from first choice to last fallback. Checkout prices are configured separately.
          </p>
        </div>
        <div className="divide-y rounded-md border">
          {selectedRows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No provider method is currently allowed for this service level.
            </p>
          ) : selectedRows.map((row, index) => (
            <div key={methodKey(row.identity)} className="flex flex-wrap items-center gap-3 p-3">
              <Badge variant="outline" className="w-8 justify-center">{index + 1}</Badge>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {row.method?.serviceName ?? row.identity.serviceCode}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {row.method
                    ? `${row.method.carrierName} · ${row.method.providerConnectionName} · ${row.method.providerAccountName}`
                    : `Connection ${row.identity.providerConnectionId} · ${row.identity.providerAccountId} · ${row.identity.serviceCode}`}
                </p>
                {row.method && (
                  <div className="mt-1 space-y-1">
                    <MethodScopeBadges method={row.method} />
                    <MethodCapabilitySummary capabilities={row.method.capabilities} />
                  </div>
                )}
              </div>
              {!row.available && <Badge variant="destructive">No longer available</Badge>}
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={index === 0 || saveMutation.isPending}
                  onClick={() => setSelected(move(selected, index, index - 1))}
                  aria-label={`Move ${row.method?.serviceName ?? row.identity.serviceCode} up`}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={index === selectedRows.length - 1 || saveMutation.isPending}
                  onClick={() => setSelected(move(selected, index, index + 1))}
                  aria-label={`Move ${row.method?.serviceName ?? row.identity.serviceCode} down`}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={saveMutation.isPending}
                  onClick={() => setSelected(selected.filter((_, candidate) => candidate !== index))}
                  aria-label={`Remove ${row.method?.serviceName ?? row.identity.serviceCode}`}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="provider-catalog-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="provider-catalog-heading" className="font-medium">Connected provider catalog</h3>
            <p className="text-sm text-muted-foreground">
              A connected method is only available to route after you select and save it here.
            </p>
          </div>
          {catalog.status === "available" && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" asChild>
                <a href="/shipping-settings?tab=fulfillment-providers">
                  <Settings2 className="mr-2 h-4 w-4" /> Manage connections
                </a>
              </Button>
              <CatalogRefreshButton
                pending={refreshCatalogMutation.isPending}
                onRefresh={() => refreshCatalogMutation.mutate()}
                label="Refresh catalog"
              />
            </div>
          )}
        </div>

        {catalog.status === "available" && (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {refreshCatalogMutation.isPending
              ? "Refreshing directly from connected providers..."
              : `Last provider refresh: ${formatCatalogFetchedAt(catalog.fetchedAt)}`}
          </p>
        )}

        {catalog.connections.some((connection) => connection.status !== "available") && (
          <div className="space-y-2">
            {catalog.connections.filter((connection) => connection.status !== "available").map((connection) => (
              <Alert key={connection.connectionId} variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{connection.connectionName} is unavailable</AlertTitle>
                <AlertDescription>{connection.message}</AlertDescription>
              </Alert>
            ))}
          </div>
        )}

        {catalog.status === "available" && (
          <>
            <div className="space-y-2">
              <Label htmlFor="fulfillment-method-search">Search connected methods</Label>
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  id="fulfillment-method-search"
                  className="pl-9"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Carrier, account, service, or code"
                />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto rounded-md border">
              {filteredCatalog.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {catalogMethods.length === 0
                    ? "Connected providers returned no carrier methods."
                    : "No connected methods match this search."}
                </p>
              ) : catalogScopeGroups.map((group) => (
                <section key={group.scope} aria-labelledby={`catalog-${group.scope}-heading`}>
                  <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-muted px-3 py-2">
                    <p id={`catalog-${group.scope}-heading`} className="text-sm font-semibold">
                      {group.label}
                    </p>
                    <Badge variant="outline">
                      {group.methods.length} {group.methods.length === 1 ? "service" : "services"}
                    </Badge>
                  </div>
                  <div className="divide-y">
                    {group.methods.map((method) => {
                      const key = methodKey(method);
                      const checked = selectedKeys.has(key);
                      return (
                        <label
                          key={key}
                          className="flex cursor-pointer items-start gap-3 p-3 hover:bg-muted/40"
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={checked}
                            disabled={saveMutation.isPending}
                            onCheckedChange={(next) => {
                              setSelected((current) => next === true
                                ? current.some((candidate) => methodKey(candidate) === key)
                                  ? current
                                  : [...current, methodIdentity(method)]
                                : current.filter((candidate) => methodKey(candidate) !== key));
                            }}
                            aria-label={`Allow ${method.serviceName} for ${group.label.toLowerCase()} destinations from ${method.providerAccountName}`}
                          />
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-medium">{method.serviceName}</span>
                              <CrossScopeBadge method={method} displayedScope={group.scope} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                              {method.carrierName} · {method.providerConnectionName}
                              {" · "}{method.providerAccountName} · {method.serviceCode}
                            </p>
                            <MethodCapabilitySummary capabilities={method.capabilities} />
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </section>

      {staleSelectionCount > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Remove unavailable methods before saving</AlertTitle>
          <AlertDescription>
            A provider account or service changed after this profile was saved. Routing fails closed
            until the unavailable selection is removed or restored at its provider connection.
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <div className="text-sm text-muted-foreground">
          {dirty ? "Unsaved routing changes" : query.data.profile.revision === 0 ? (
            "Routing profile is not configured"
          ) : selected.length === 0 ? (
            "Routing profile is saved with no allowed methods"
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              Routing profile is saved
            </span>
          )}
        </div>
        <Button
          type="button"
          disabled={
            !dirty
            || saveMutation.isPending
            || catalog.status !== "available"
            || staleSelectionCount > 0
          }
          onClick={() => {
            if (
              selected.length === 0
              && persisted.length > 0
              && !window.confirm(
                "Remove every allowed method from this fulfillment routing profile?",
              )
            ) return;
            saveMutation.mutate();
          }}
        >
          {saveMutation.isPending
            ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            : <Save className="mr-2 h-4 w-4" />}
          Save fulfillment routing
        </Button>
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function methodIdentity(
  method: ShippingFulfillmentCatalogMethod | ShippingFulfillmentRouteMethod,
): ShippingFulfillmentMethodIdentity {
  return {
    providerConnectionId: method.providerConnectionId,
    provider: method.provider,
    providerAccountId: method.providerAccountId,
    serviceCode: method.serviceCode,
    domestic: method.domestic,
    international: method.international,
  };
}

function methodSequence(methods: readonly ShippingFulfillmentMethodIdentity[]): string {
  return methods.map(methodKey).join("\u0001");
}

function move<T>(values: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) {
    return [...values];
  }
  const next = [...values];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

function queryKeyAsArray(key: string): [string] {
  return [key];
}

function MethodScopeBadges({
  method,
}: {
  method: Pick<ShippingFulfillmentMethodIdentity, "domestic" | "international">;
}) {
  return (
    <div className="inline-flex flex-wrap gap-1">
      {method.domestic && <Badge variant="secondary">Domestic</Badge>}
      {method.international && <Badge variant="secondary">International</Badge>}
    </div>
  );
}

function CrossScopeBadge({
  method,
  displayedScope,
}: {
  method: Pick<ShippingFulfillmentMethodIdentity, "domestic" | "international">;
  displayedScope: FulfillmentCatalogDestinationScope;
}) {
  if (!method.domestic || !method.international) return null;
  return (
    <Badge variant="secondary">
      Also {displayedScope === "domestic" ? "international" : "domestic"}
    </Badge>
  );
}

function CatalogRefreshButton({
  pending,
  onRefresh,
  label,
}: {
  pending: boolean;
  onRefresh: () => void;
  label: string;
}) {
  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={onRefresh}>
      {pending
        ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        : <RefreshCw className="mr-2 h-4 w-4" />}
      {pending ? "Refreshing catalog..." : label}
    </Button>
  );
}

function formatCatalogFetchedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "unknown time" : timestamp.toLocaleString();
}

function MethodCapabilitySummary({
  capabilities,
}: {
  capabilities: ShippingFulfillmentMethodCapabilities | null;
}) {
  if (!capabilities) {
    return (
      <span className="block text-xs text-muted-foreground">
        Provider capabilities were not captured for this saved route.
      </span>
    );
  }
  const schemes = capabilities.displaySchemes.length > 0
    ? capabilities.displaySchemes.join(", ")
    : "none";
  return (
    <span className="block text-xs text-muted-foreground">
      Provider flags: multi-package {yesNo(capabilities.supportsMultiPackage)} · returns {yesNo(capabilities.supportsReturns)}
      {" · "}prepaid duties/taxes {yesNo(capabilities.supportsPrepaidDutiesTaxes)} · send rates {yesNo(capabilities.sendRates)}
      {" · "}display schemes {schemes}
    </span>
  );
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}
