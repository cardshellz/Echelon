import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  FlaskConical,
  Loader2,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import type {
  ShippingChannelAdapterCapabilities,
  ShippingChannelEligibilityMode,
  ShippingChannelPolicyPurpose,
  ShippingChannelPolicyResolutionView,
  ShippingChannelPolicyRouteInput,
  ShippingChannelPolicyShadowComparison,
  ShippingChannelPolicyView,
  ShippingChannelRouteMode,
  ShippingChannelRoutingChannelSummary,
  ShippingChannelRoutingRateBookOption,
  ShippingChannelRoutingWarehouseOption,
  ShippingDestinationScopeSummary,
  ShippingLegacyProfileKey,
} from "@shared/types/shipping-channel-routing";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  activateChannelPolicy,
  channelPolicyKey,
  compareChannelPolicyToLegacy,
  createChannelPolicyDraft,
  discardChannelPolicyDraft,
  loadChannelPolicy,
  previewChannelPolicy,
  retireChannelPolicy,
  saveChannelPolicyDraft,
  updateRoutingCaches,
} from "./api";

interface Props {
  open: boolean;
  channel: ShippingChannelRoutingChannelSummary;
  purpose: ShippingChannelPolicyPurpose;
  destinationScopes: ShippingDestinationScopeSummary[];
  rateBooks: ShippingChannelRoutingRateBookOption[];
  warehouses: ShippingChannelRoutingWarehouseOption[];
  onOpenChange: (open: boolean) => void;
}

interface TestInput {
  originWarehouseId: string;
  country: string;
  region: string;
  postalCode: string;
  legacyProfile: ShippingLegacyProfileKey;
}

export function PolicyEditorDialog({
  open,
  channel,
  purpose,
  destinationScopes,
  rateBooks,
  warehouses,
  onOpenChange,
}: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const slot = purpose === "customer_checkout"
    ? channel.customerCheckout
    : channel.vendorFulfillmentCharge;
  const initialPolicyId = slot.draft?.id ?? slot.active?.id ?? null;
  const [policyIdOverride, setPolicyIdOverride] = useState<number | null>(null);
  const policyId = policyIdOverride ?? initialPolicyId;
  const [routes, setRoutes] = useState<ShippingChannelPolicyRouteInput[]>([]);
  const [notes, setNotes] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const [retireOpen, setRetireOpen] = useState(false);
  const [preview, setPreview] = useState<ShippingChannelPolicyResolutionView | null>(null);
  const [shadow, setShadow] = useState<ShippingChannelPolicyShadowComparison | null>(null);
  const [testInput, setTestInput] = useState<TestInput>(() =>
    defaultTestInput(purpose, channel.provider, warehouses));

  const policyQuery = useQuery({
    queryKey: [policyId === null ? "channel-policy-none" : channelPolicyKey(policyId)],
    queryFn: () => loadChannelPolicy(policyId as number),
    enabled: open && policyId !== null,
  });
  const policy = policyQuery.data ?? null;

  useEffect(() => {
    setPolicyIdOverride(null);
    setPreview(null);
    setShadow(null);
    setTestInput(defaultTestInput(purpose, channel.provider, warehouses));
  }, [channel.id, purpose]);

  useEffect(() => {
    if (!policy) {
      setRoutes([]);
      setNotes("");
      return;
    }
    setRoutes(policy.routes.map((route) => ({
      originWarehouseId: route.originWarehouseId,
      destinationScopeId: route.destinationScopeId,
      mode: route.mode,
      eligibilityMode: route.eligibilityMode,
      rateBookId: route.rateBookId,
    })));
    setNotes(policy.notes ?? "");
  }, [policy?.id, policy?.lockVersion]);

  const dirty = useMemo(
    () => policy !== null && (
      notes !== (policy.notes ?? "")
      || JSON.stringify(routes) !== JSON.stringify(policy.routes.map((route) => ({
        originWarehouseId: route.originWarehouseId,
        destinationScopeId: route.destinationScopeId,
        mode: route.mode,
        eligibilityMode: route.eligibilityMode,
        rateBookId: route.rateBookId,
      })))
    ),
    [notes, policy, routes],
  );

  const createMutation = useMutation({
    mutationFn: () => createChannelPolicyDraft({
      channelId: channel.id,
      purpose,
      cloneActive: policy?.status === "active" || slot.active !== null,
      notes: null,
    }),
    onSuccess: (created) => {
      setPolicyIdOverride(created.id);
      updateRoutingCaches(queryClient, created);
      toast({ title: `Draft v${created.version} created` });
    },
    onError: mutationError(toast, "Draft was not created"),
  });
  const saveMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return saveChannelPolicyDraft({
        policyId: policy.id,
        expectedLockVersion: policy.lockVersion,
        notes: notes.trim() === "" ? null : notes.trim(),
        routes,
      });
    },
    onSuccess: (saved) => {
      updateRoutingCaches(queryClient, saved);
      toast({ title: `Draft v${saved.version} saved` });
    },
    onError: mutationError(toast, "Draft was not saved"),
  });
  const activateMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return activateChannelPolicy({
        policyId: policy.id,
        expectedLockVersion: policy.lockVersion,
      });
    },
    onSuccess: (active) => {
      updateRoutingCaches(queryClient, active);
      toast({ title: `Policy v${active.version} activated` });
    },
    onError: mutationError(toast, "Policy was not activated"),
  });
  const discardMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return discardChannelPolicyDraft({
        policyId: policy.id,
        expectedLockVersion: policy.lockVersion,
      });
    },
    onSuccess: (discarded) => {
      setDiscardOpen(false);
      updateRoutingCaches(queryClient, discarded);
      toast({ title: `Draft v${discarded.version} discarded` });
      onOpenChange(false);
    },
    onError: mutationError(toast, "Draft was not discarded"),
  });
  const retireMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return retireChannelPolicy({
        policyId: policy.id,
        expectedLockVersion: policy.lockVersion,
      });
    },
    onSuccess: (retired) => {
      setRetireOpen(false);
      updateRoutingCaches(queryClient, retired);
      toast({ title: `Policy v${retired.version} retired` });
      onOpenChange(false);
    },
    onError: mutationError(toast, "Policy was not retired"),
  });
  const previewMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return previewChannelPolicy(toPreviewPayload(policy.id, testInput));
    },
    onSuccess: (result) => {
      setPreview(result);
      setShadow(null);
    },
    onError: mutationError(toast, "Routing test failed"),
  });
  const shadowMutation = useMutation({
    mutationFn: () => {
      if (!policy) throw new Error("Policy is not loaded.");
      return compareChannelPolicyToLegacy({
        ...toPreviewPayload(policy.id, testInput),
        legacyProfile: testInput.legacyProfile,
      });
    },
    onSuccess: (result) => {
      setShadow(result);
      setPreview(result.canonical);
      toast({
        title: result.matchesLegacy
          ? "Shadow comparison matched"
          : "Shadow difference recorded",
      });
    },
    onError: mutationError(toast, "Shadow comparison failed"),
  });

  const referencedScopeIds = new Set(
    policy?.routes.flatMap((route) =>
      route.destinationScopeId === null ? [] : [route.destinationScopeId]) ?? [],
  );
  const referencedRateBookIds = new Set(
    policy?.routes.flatMap((route) =>
      route.rateBookId === null ? [] : [route.rateBookId]) ?? [],
  );
  const referencedWarehouseIds = new Set(
    policy?.routes.flatMap((route) =>
      route.originWarehouseId === null ? [] : [route.originWarehouseId]) ?? [],
  );
  const activeScopes = destinationScopes.filter((scope) =>
    scope.status === "active");
  const selectableScopes = destinationScopes.filter((scope) =>
    scope.status === "active" || referencedScopeIds.has(scope.id));
  const selectableRateBooks = rateBooks.filter((book) =>
    book.status === "active" || referencedRateBookIds.has(book.id));
  const activeWarehouses = warehouses.filter((warehouse) => warehouse.isActive);
  const selectableWarehouses = warehouses.filter((warehouse) =>
    warehouse.isActive || referencedWarehouseIds.has(warehouse.id));
  const busy = createMutation.isPending
    || saveMutation.isPending
    || activateMutation.isPending
    || discardMutation.isPending
    || retireMutation.isPending;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!busy) onOpenChange(nextOpen);
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-7xl overflow-y-auto">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <DialogTitle>{channel.name}</DialogTitle>
              <Badge variant="outline">{purposeLabel(purpose)}</Badge>
              {policy && (
                <Badge variant={policy.status === "active" ? "default" : "secondary"}>
                  {policy.status} v{policy.version}
                </Badge>
              )}
            </div>
            <DialogDescription>
              Channel {channel.id} / {channel.provider}
            </DialogDescription>
            <AdapterCapabilitySummary
              capabilities={channel.shippingCapabilities}
            />
          </DialogHeader>

          {policyQuery.isLoading ? (
            <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading policy
            </div>
          ) : policyQuery.isError ? (
            <Alert variant="destructive">
              <CircleAlert className="h-4 w-4" />
              <AlertTitle>Policy could not be loaded</AlertTitle>
              <AlertDescription>
                {policyQuery.error instanceof Error
                  ? policyQuery.error.message
                  : "Unknown error"}
              </AlertDescription>
            </Alert>
          ) : !policy ? (
            <EmptyPolicy
              creating={createMutation.isPending}
              onCreate={() => createMutation.mutate()}
            />
          ) : (
            <Tabs defaultValue="routes" className="space-y-4">
              <TabsList>
                <TabsTrigger value="routes">Routes</TabsTrigger>
                <TabsTrigger value="test">Test routing</TabsTrigger>
              </TabsList>

              <TabsContent value="routes" className="space-y-4">
                {policy.activationErrors.length > 0 && (
                  <Alert>
                    <CircleAlert className="h-4 w-4" />
                    <AlertTitle>
                      {policy.status === "draft"
                        ? "Draft is not ready to activate"
                        : "Policy is not currently routable"}
                    </AlertTitle>
                    <AlertDescription>
                      <ul className="mt-1 list-disc space-y-1 pl-5">
                        {policy.activationErrors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-semibold">Routing decisions</h3>
                      <p className="text-sm text-muted-foreground">
                        More specific warehouse and destination matches win.
                      </p>
                    </div>
                    {policy.status === "draft" && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          const route = nextRoute(routes, activeScopes, activeWarehouses);
                          if (!route) {
                            toast({
                              title: "No unused route scope is available",
                              description: "Create a delivery region or choose another warehouse scope.",
                              variant: "destructive",
                            });
                            return;
                          }
                          setRoutes([...routes, route]);
                        }}
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Add route
                      </Button>
                    )}
                  </div>

                  <div className="space-y-2">
                    {routes.map((route, index) => (
                      <RouteEditor
                        key={index}
                        index={index}
                        route={route}
                        readOnly={policy.status !== "draft"}
                        destinationScopes={selectableScopes}
                        rateBooks={selectableRateBooks}
                        warehouses={selectableWarehouses}
                        capabilities={channel.shippingCapabilities}
                        canRemove={routes.length > 1}
                        onChange={(next) => setRoutes(routes.map((candidate, routeIndex) =>
                          routeIndex === index ? next : candidate))}
                        onRemove={() => setRoutes(routes.filter((_, routeIndex) =>
                          routeIndex !== index))}
                      />
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="policy-notes">Internal notes</Label>
                  <Textarea
                    id="policy-notes"
                    value={notes}
                    readOnly={policy.status !== "draft"}
                    maxLength={1_000}
                    rows={2}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <div>
                    {dirty && (
                      <span className="text-sm font-medium text-amber-700">
                        Unsaved changes
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {policy.status === "active" && (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => createMutation.mutate()}
                          disabled={busy}
                        >
                          Create revision
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setRetireOpen(true)}
                          disabled={busy}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          Retire
                        </Button>
                      </>
                    )}
                    {policy.status === "draft" && (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => setDiscardOpen(true)}
                          disabled={busy}
                        >
                          <Archive className="mr-2 h-4 w-4" />
                          Discard draft
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => saveMutation.mutate()}
                          disabled={!dirty || busy}
                        >
                          {saveMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="mr-2 h-4 w-4" />
                          )}
                          Save draft
                        </Button>
                        <Button
                          onClick={() => activateMutation.mutate()}
                          disabled={
                            dirty
                            || policy.activationErrors.length > 0
                            || busy
                          }
                        >
                          {activateMutation.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          Activate
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="test">
                <PolicyTestPanel
                  input={testInput}
                  purpose={purpose}
                  warehouses={activeWarehouses}
                  preview={preview}
                  shadow={shadow}
                  disabledReason={dirty
                    ? "Save the draft before testing. Tests always use the last saved revision."
                    : null}
                  previewing={previewMutation.isPending}
                  shadowing={shadowMutation.isPending}
                  onChange={setTestInput}
                  onPreview={() => previewMutation.mutate()}
                  onShadow={() => shadowMutation.mutate()}
                />
              </TabsContent>
            </Tabs>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={discardOpen}
        onOpenChange={(nextOpen) => {
          if (!discardMutation.isPending) setDiscardOpen(nextOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard this draft revision?</AlertDialogTitle>
            <AlertDialogDescription>
              The draft is preserved as a retired revision for audit history and
              will no longer block a new draft.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={discardMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={discardMutation.isPending}
              onClick={() => discardMutation.mutate()}
            >
              {discardMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Discard draft
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={retireOpen}
        onOpenChange={(nextOpen) => {
          if (!retireMutation.isPending) setRetireOpen(nextOpen);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this active policy?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes canonical routing for the slot. A configured legacy
              profile can resume; a channel without one will fail closed until
              another policy is active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retireMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={retireMutation.isPending}
              onClick={() => retireMutation.mutate()}
            >
              {retireMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Retire policy
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function EmptyPolicy({
  creating,
  onCreate,
}: {
  creating: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center gap-3 border">
      <div className="text-center">
        <h3 className="font-semibold">No canonical policy</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          This slot continues to use its existing channel behavior.
        </p>
      </div>
      <Button onClick={onCreate} disabled={creating}>
        {creating ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        Create draft
      </Button>
    </div>
  );
}

function RouteEditor({
  index,
  route,
  readOnly,
  destinationScopes,
  rateBooks,
  warehouses,
  capabilities,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  route: ShippingChannelPolicyRouteInput;
  readOnly: boolean;
  destinationScopes: ShippingDestinationScopeSummary[];
  rateBooks: ShippingChannelRoutingRateBookOption[];
  warehouses: ShippingChannelRoutingWarehouseOption[];
  capabilities: ShippingChannelAdapterCapabilities | null;
  canRemove: boolean;
  onChange: (route: ShippingChannelPolicyRouteInput) => void;
  onRemove: () => void;
}) {
  const setMode = (mode: ShippingChannelRouteMode) => {
    onChange({
      ...route,
      mode,
      eligibilityMode: mode === "disabled"
        ? "none"
        : mode === "channel_managed"
          ? "channel"
          : "engine",
      rateBookId: mode === "engine_quoted" ? route.rateBookId : null,
    });
  };
  const acceptsEngineQuotes =
    capabilities?.acceptsEngineQuotes === true;
  const managesOwnRates =
    capabilities?.managesOwnRates === true;
  const enforcesDestinationEligibility =
    capabilities?.enforcesDestinationEligibility === true;
  const canUseEngineEligibility = route.mode === "engine_quoted"
    || (
      route.mode === "channel_managed"
      && enforcesDestinationEligibility
    );

  return (
    <div className="grid gap-3 border p-3 lg:grid-cols-[2fr_1.5fr_1.5fr_1.5fr_2fr_2.5rem]">
      <div className="space-y-1">
        <Label className="text-xs">Delivery region</Label>
        <Select
          value={route.destinationScopeId === null
            ? "all"
            : String(route.destinationScopeId)}
          disabled={readOnly}
          onValueChange={(value) => onChange({
            ...route,
            destinationScopeId: value === "all" ? null : Number(value),
          })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All destinations</SelectItem>
            {destinationScopes.map((scope) => (
              <SelectItem key={scope.id} value={String(scope.id)}>
                {scope.name}{scope.status === "active" ? "" : ` (${scope.status})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Warehouse</Label>
        <Select
          value={route.originWarehouseId === null
            ? "all"
            : String(route.originWarehouseId)}
          disabled={readOnly}
          onValueChange={(value) => onChange({
            ...route,
            originWarehouseId: value === "all" ? null : Number(value),
          })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All warehouses</SelectItem>
            {warehouses.map((warehouse) => (
              <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                {warehouse.name}{warehouse.isActive ? "" : " (inactive)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Rate owner</Label>
        <Select
          value={route.mode}
          disabled={readOnly}
          onValueChange={(value) => setMode(value as ShippingChannelRouteMode)}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem
              value="engine_quoted"
              disabled={!acceptsEngineQuotes}
            >
              Echelon rates{acceptsEngineQuotes ? "" : " (unsupported)"}
            </SelectItem>
            <SelectItem
              value="channel_managed"
              disabled={!managesOwnRates}
            >
              Channel rates{managesOwnRates ? "" : " (unsupported)"}
            </SelectItem>
            <SelectItem value="disabled">Do not ship</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Eligibility</Label>
        <Select
          value={route.eligibilityMode}
          disabled={readOnly || route.mode === "disabled"}
          onValueChange={(value) => onChange({
            ...route,
            eligibilityMode: value as ShippingChannelEligibilityMode,
          })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {route.mode === "disabled" ? (
              <SelectItem value="none">Not allowed</SelectItem>
            ) : (
              <>
                <SelectItem
                  value="engine"
                  disabled={!canUseEngineEligibility}
                >
                  Echelon rules
                  {canUseEngineEligibility ? "" : " (unsupported)"}
                </SelectItem>
                <SelectItem
                  value="channel"
                  disabled={!enforcesDestinationEligibility}
                >
                  Channel rules
                  {enforcesDestinationEligibility ? "" : " (unsupported)"}
                </SelectItem>
                <SelectItem
                  value="intersection"
                  disabled={!enforcesDestinationEligibility}
                >
                  Both must allow
                  {enforcesDestinationEligibility ? "" : " (unsupported)"}
                </SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Pricing program</Label>
        <Select
          value={route.rateBookId === null ? "none" : String(route.rateBookId)}
          disabled={readOnly || route.mode !== "engine_quoted"}
          onValueChange={(value) => onChange({
            ...route,
            rateBookId: value === "none" ? null : Number(value),
          })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Select program</SelectItem>
            {rateBooks.map((book) => (
              <SelectItem key={book.id} value={String(book.id)}>
                {book.name} / {book.activeRateTableCount} live
                {book.status === "active" ? "" : ` (${book.status})`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-end">
        <Button
          variant="ghost"
          size="icon"
          title={`Remove route ${index + 1}`}
          disabled={readOnly || !canRemove}
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function AdapterCapabilitySummary({
  capabilities,
}: {
  capabilities: ShippingChannelAdapterCapabilities | null;
}) {
  if (!capabilities) {
    return (
      <p className="text-sm font-medium text-destructive">
        No shipping adapter is registered. Only Do not ship can be activated.
      </p>
    );
  }
  const supported = [
    capabilities.acceptsEngineQuotes ? "Echelon rates" : null,
    capabilities.managesOwnRates ? "channel rates" : null,
    capabilities.enforcesDestinationEligibility
      ? "channel destination rules"
      : null,
  ].filter((value): value is string => value !== null);
  return (
    <p className="text-sm text-muted-foreground">
      Supported: {supported.length > 0 ? supported.join(", ") : "disable only"}.
    </p>
  );
}

function PolicyTestPanel({
  input,
  purpose,
  warehouses,
  preview,
  shadow,
  disabledReason,
  previewing,
  shadowing,
  onChange,
  onPreview,
  onShadow,
}: {
  input: TestInput;
  purpose: ShippingChannelPolicyPurpose;
  warehouses: ShippingChannelRoutingWarehouseOption[];
  preview: ShippingChannelPolicyResolutionView | null;
  shadow: ShippingChannelPolicyShadowComparison | null;
  disabledReason: string | null;
  previewing: boolean;
  shadowing: boolean;
  onChange: (input: TestInput) => void;
  onPreview: () => void;
  onShadow: () => void;
}) {
  const legacyProfiles = purpose === "vendor_fulfillment_charge"
    ? (["dropship"] as ShippingLegacyProfileKey[])
    : (["shopify", "internal", "ebay"] as ShippingLegacyProfileKey[]);
  const valid = disabledReason === null
    && Number(input.originWarehouseId) > 0
    && /^[A-Za-z]{2}$/.test(input.country.trim());

  return (
    <div className="space-y-5">
      {disabledReason && (
        <Alert>
          <CircleAlert className="h-4 w-4" />
          <AlertTitle>Saved revision required</AlertTitle>
          <AlertDescription>{disabledReason}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="space-y-1">
          <Label className="text-xs">Warehouse</Label>
          <Select
            value={input.originWarehouseId}
            onValueChange={(value) => onChange({
              ...input,
              originWarehouseId: value,
            })}
          >
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>
              {warehouses.map((warehouse) => (
                <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                  {warehouse.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Country</Label>
          <Input
            value={input.country}
            maxLength={2}
            onChange={(event) => onChange({
              ...input,
              country: event.target.value.toUpperCase(),
            })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">State / region</Label>
          <Input
            value={input.region}
            maxLength={10}
            onChange={(event) => onChange({
              ...input,
              region: event.target.value.toUpperCase(),
            })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Postal code</Label>
          <Input
            value={input.postalCode}
            maxLength={20}
            onChange={(event) => onChange({
              ...input,
              postalCode: event.target.value.toUpperCase(),
            })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Legacy comparison</Label>
          <Select
            value={input.legacyProfile}
            onValueChange={(value) => onChange({
              ...input,
              legacyProfile: value as ShippingLegacyProfileKey,
            })}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {legacyProfiles.map((profile) => (
                <SelectItem key={profile} value={profile}>
                  {profile}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!valid || previewing || shadowing}
          onClick={onPreview}
        >
          {previewing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <FlaskConical className="mr-2 h-4 w-4" />
          )}
          Preview
        </Button>
        <Button
          disabled={!valid || previewing || shadowing}
          onClick={onShadow}
        >
          {shadowing ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <CircleCheck className="mr-2 h-4 w-4" />
          )}
          Record shadow comparison
        </Button>
      </div>

      {!disabledReason && preview && (
        <ResolutionResult title="Canonical policy" result={preview} />
      )}
      {!disabledReason && shadow && (
        <Alert variant={shadow.matchesLegacy ? "default" : "destructive"}>
          {shadow.matchesLegacy ? (
            <CircleCheck className="h-4 w-4" />
          ) : (
            <CircleAlert className="h-4 w-4" />
          )}
          <AlertTitle>
            {shadow.matchesLegacy ? "Legacy behavior matched" : "Legacy behavior differs"}
          </AlertTitle>
          <AlertDescription>
            <div>Snapshot {shadow.snapshotId}</div>
            {shadow.differences.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {shadow.differences.map((difference) => (
                  <li key={difference}>{difference}</li>
                ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function ResolutionResult({
  title,
  result,
}: {
  title: string;
  result: ShippingChannelPolicyResolutionView;
}) {
  return (
    <div className="border p-4">
      <div className="flex items-center gap-2">
        <h4 className="font-semibold">{title}</h4>
        <Badge variant={result.ok ? "outline" : "destructive"}>
          {result.ok ? "Resolved" : "Failed"}
        </Badge>
      </div>
      {result.ok ? (
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Rate owner</dt>
            <dd>{modeLabel(result.mode)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Eligibility</dt>
            <dd>{eligibilityLabel(result.eligibilityMode)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Pricing program</dt>
            <dd>{result.rateBookId ?? "None"}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-sm text-destructive">
          {result.code}: {result.message}
        </p>
      )}
    </div>
  );
}

function nextRoute(
  routes: ShippingChannelPolicyRouteInput[],
  scopes: ShippingDestinationScopeSummary[],
  warehouses: ShippingChannelRoutingWarehouseOption[],
): ShippingChannelPolicyRouteInput | null {
  const candidates: Array<{
    originWarehouseId: number | null;
    destinationScopeId: number | null;
  }> = [
    {
      originWarehouseId: null,
      destinationScopeId: null,
    },
    ...scopes.map((scope) => ({
      originWarehouseId: null,
      destinationScopeId: scope.id,
    })),
    ...warehouses.map((warehouse) => ({
      originWarehouseId: warehouse.id,
      destinationScopeId: null,
    })),
    ...warehouses.flatMap((warehouse) => scopes.map((scope) => ({
      originWarehouseId: warehouse.id,
      destinationScopeId: scope.id,
    }))),
  ];
  const candidate = candidates.find((item) => !routes.some((route) =>
    route.originWarehouseId === item.originWarehouseId
    && route.destinationScopeId === item.destinationScopeId));
  return candidate ? {
    ...candidate,
    mode: "disabled",
    eligibilityMode: "none",
    rateBookId: null,
  } : null;
}

function defaultTestInput(
  purpose: ShippingChannelPolicyPurpose,
  provider: string,
  warehouses: ShippingChannelRoutingWarehouseOption[],
): TestInput {
  const activeWarehouses = warehouses.filter((warehouse) => warehouse.isActive);
  const customerProfile = provider === "ebay"
    ? "ebay"
    : provider === "shopify"
      ? "shopify"
      : "internal";
  return {
    originWarehouseId: activeWarehouses[0] ? String(activeWarehouses[0].id) : "",
    country: "US",
    region: "PA",
    postalCode: "",
    legacyProfile: purpose === "vendor_fulfillment_charge"
      ? "dropship"
      : customerProfile,
  };
}

function toPreviewPayload(policyId: number, input: TestInput) {
  return {
    policyId,
    originWarehouseId: Number(input.originWarehouseId),
    destination: {
      country: input.country,
      region: emptyToNull(input.region),
      postalCode: emptyToNull(input.postalCode),
    },
  };
}

function purposeLabel(purpose: ShippingChannelPolicyPurpose): string {
  return purpose === "customer_checkout"
    ? "Customer checkout"
    : "Vendor fulfillment charge";
}

function modeLabel(mode: ShippingChannelRouteMode | null): string {
  if (mode === "engine_quoted") return "Echelon rates";
  if (mode === "channel_managed") return "Channel rates";
  if (mode === "disabled") return "Do not ship";
  return "None";
}

function eligibilityLabel(
  mode: ShippingChannelEligibilityMode | null,
): string {
  if (mode === "engine") return "Echelon rules";
  if (mode === "channel") return "Channel rules";
  if (mode === "intersection") return "Both must allow";
  return "Not allowed";
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function mutationError(
  toast: ReturnType<typeof useToast>["toast"],
  title: string,
) {
  return (error: unknown) => {
    toast({
      title,
      description: error instanceof Error ? error.message : undefined,
      variant: "destructive",
    });
  };
}
