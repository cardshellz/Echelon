import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  FileSearch,
  MinusCircle,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Store,
  Truck,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildAdminStoreConnectionsUrl,
  buildAdminStoreWebhookRepairInput,
  buildStoreConnectionDisconnectInput,
  buildStoreListingModeChangeInput,
  buildStoreOrderProcessingConfigInput,
  createDropshipIdempotencyKey,
  describeDropshipListingMode,
  DROPSHIP_LISTING_MODE_OPTIONS,
  fetchJson,
  formatStatus,
  parseDropshipListingMode,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipAdminStoreConnectionListItem,
  type DropshipAdminStoreConnectionListResponse,
  type DropshipAdminStoreWebhookRepairResponse,
  type DropshipListingMode,
  type DropshipStoreConnectionDisconnectResponse,
  type DropshipStoreListingConfigResponse,
  type DropshipStoreOrderProcessingConfigResponse,
} from "@/lib/dropship-ops-surface";
import { EbayOAuthBrandingAdminPanel } from "@/components/dropship/EbayOAuthBrandingAdminPanel";
import {
  buildStoreConnectionAuthJourney,
  buildStoreConnectionListingJourney,
  buildStoreConnectionSetupJourney,
  buildStoreConnectionSummary,
  buildStoreConnectionWarehouseJourney,
  CatalogMetric,
  formatWarehouseOption,
  NO_DEFAULT_WAREHOUSE_VALUE,
  storeConnectionDisplayName,
  storeConnectionIsDisabled,
  storeConnectionJourneyTone,
  storeConnectionOwnerDetail,
  storeConnectionOwnerLabel,
  storeConnectionStatusFilters,
  storeConnectionStatusTone,
  subscriptionStatusLabel,
  subscriptionStatusTone,
  type DropshipWarehouseOption,
  type StoreConnectionJourneyItem,
  type StoreConnectionPlatformFilter,
  type StoreConnectionStatusFilter,
} from "./dropship-admin-shared";

function StoreConnectionOpsTab() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StoreConnectionStatusFilter>("all");
  const [platform, setPlatform] =
    useState<StoreConnectionPlatformFilter>("all");
  const [appliedFilters, setAppliedFilters] = useState({
    search: "",
    status: "all" as StoreConnectionStatusFilter,
    platform: "all" as StoreConnectionPlatformFilter,
  });
  const [disableTarget, setDisableTarget] =
    useState<DropshipAdminStoreConnectionListItem | null>(null);
  const [disableReason, setDisableReason] = useState(
    "Disabled by Card Shellz admin.",
  );
  const [disablingConnectionId, setDisablingConnectionId] = useState<
    number | null
  >(null);
  const [warehouseTarget, setWarehouseTarget] =
    useState<DropshipAdminStoreConnectionListItem | null>(null);
  const [warehouseInput, setWarehouseInput] = useState("");
  const [savingWarehouseConnectionId, setSavingWarehouseConnectionId] =
    useState<number | null>(null);
  const [listingModeTarget, setListingModeTarget] =
    useState<DropshipAdminStoreConnectionListItem | null>(null);
  const [listingModeInput, setListingModeInput] =
    useState<DropshipListingMode>("live");
  const [savingListingModeConnectionId, setSavingListingModeConnectionId] =
    useState<number | null>(null);
  const [repairingWebhookConnectionId, setRepairingWebhookConnectionId] =
    useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const storeConnectionsUrl = useMemo(
    () =>
      buildAdminStoreConnectionsUrl({
        search: appliedFilters.search,
        status: appliedFilters.status,
        platform: appliedFilters.platform,
      }),
    [appliedFilters],
  );

  const storeConnectionsQuery =
    useQuery<DropshipAdminStoreConnectionListResponse>({
      queryKey: [storeConnectionsUrl],
      queryFn: () =>
        fetchJson<DropshipAdminStoreConnectionListResponse>(
          storeConnectionsUrl,
        ),
    });

  const warehousesQuery = useQuery<DropshipWarehouseOption[]>({
    queryKey: ["/api/warehouses"],
    queryFn: () => fetchJson<DropshipWarehouseOption[]>("/api/warehouses"),
  });

  const connections = useMemo(
    () => storeConnectionsQuery.data?.items ?? [],
    [storeConnectionsQuery.data?.items],
  );
  const warehouseOptions = useMemo(
    () =>
      (warehousesQuery.data ?? [])
        .filter(
          (warehouse) =>
            warehouse.isActive === 1 &&
            warehouse.warehouseType !== "bulk_storage",
        )
        .sort((a, b) => {
          if (a.isDefault !== b.isDefault) return b.isDefault - a.isDefault;
          return a.name.localeCompare(b.name);
        }),
    [warehousesQuery.data],
  );
  const summary = useMemo(
    () => buildStoreConnectionSummary(connections),
    [connections],
  );

  function applyStoreFilters() {
    setAppliedFilters({ search, status, platform });
  }

  function openWarehouseConfigDialog(
    connection: DropshipAdminStoreConnectionListItem,
  ) {
    setWarehouseTarget(connection);
    setWarehouseInput(
      connection.orderProcessingConfig.defaultWarehouseId === null
        ? ""
        : String(connection.orderProcessingConfig.defaultWarehouseId),
    );
    setError("");
    setMessage("");
  }

  async function saveWarehouseConfig() {
    if (!warehouseTarget) return;
    setSavingWarehouseConnectionId(warehouseTarget.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const response =
        await putJson<DropshipStoreOrderProcessingConfigResponse>(
          `/api/dropship/admin/store-connections/${warehouseTarget.storeConnectionId}/order-processing-config`,
          buildStoreOrderProcessingConfigInput({
            defaultWarehouseId: warehouseInput,
            idempotencyKey: createDropshipIdempotencyKey(
              `admin-store-${warehouseTarget.storeConnectionId}-warehouse`,
            ),
          }),
        );
      setMessage(
        `${storeConnectionDisplayName(warehouseTarget)} warehouse assignment saved.`,
      );
      setWarehouseTarget(null);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
      setWarehouseInput(
        response.connection.orderProcessingConfig.defaultWarehouseId === null
          ? ""
          : String(
              response.connection.orderProcessingConfig.defaultWarehouseId,
            ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Warehouse assignment update failed.",
      );
    } finally {
      setSavingWarehouseConnectionId(null);
    }
  }

  function openListingModeDialog(
    connection: DropshipAdminStoreConnectionListItem,
  ) {
    setListingModeTarget(connection);
    setListingModeInput(connection.listingConfig.listingMode ?? "live");
    setError("");
    setMessage("");
  }

  async function saveListingMode() {
    if (!listingModeTarget) return;
    setSavingListingModeConnectionId(listingModeTarget.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const url = `/api/dropship/admin/store-connections/${listingModeTarget.storeConnectionId}/listing-config`;
      // The route replaces the whole config, so read it first and change
      // only the mode: the rest goes back exactly as it was.
      const current = await fetchJson<DropshipStoreListingConfigResponse>(url);
      const response = await putJson<DropshipStoreListingConfigResponse>(
        url,
        buildStoreListingModeChangeInput(current.config, listingModeInput),
      );
      setMessage(
        `${storeConnectionDisplayName(listingModeTarget)} listing mode is now ` +
          `${describeDropshipListingMode(response.config.listingMode).label}. ` +
          "It applies to the next push. Anything queued before this change is refused as changed and must be queued again.",
      );
      setListingModeTarget(null);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Listing mode update failed.",
      );
    } finally {
      setSavingListingModeConnectionId(null);
    }
  }

  function openDisableStoreDialog(
    connection: DropshipAdminStoreConnectionListItem,
  ) {
    setDisableTarget(connection);
    setDisableReason(
      `Disabled by Card Shellz admin for ${storeConnectionDisplayName(connection)}.`,
    );
    setError("");
    setMessage("");
  }

  async function confirmDisableStoreConnection() {
    if (!disableTarget) return;
    setDisablingConnectionId(disableTarget.storeConnectionId);
    setError("");
    setMessage("");
    try {
      await postJson<DropshipStoreConnectionDisconnectResponse>(
        `/api/dropship/admin/store-connections/${disableTarget.storeConnectionId}/disconnect`,
        buildStoreConnectionDisconnectInput({
          reason: disableReason,
          idempotencyKey: createDropshipIdempotencyKey(
            `admin-store-${disableTarget.storeConnectionId}-disconnect`,
          ),
        }),
      );
      setMessage(
        `${storeConnectionDisplayName(disableTarget)} was disabled. Intake and listing pushes are paused during the disconnect grace period.`,
      );
      setDisableTarget(null);
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Store disable request failed.",
      );
    } finally {
      setDisablingConnectionId(null);
    }
  }

  async function repairShopifyWebhooks(
    connection: DropshipAdminStoreConnectionListItem,
  ) {
    setRepairingWebhookConnectionId(connection.storeConnectionId);
    setError("");
    setMessage("");
    try {
      const response = await postJson<DropshipAdminStoreWebhookRepairResponse>(
        `/api/dropship/admin/store-connections/${connection.storeConnectionId}/shopify-webhooks/repair`,
        buildAdminStoreWebhookRepairInput({
          idempotencyKey: createDropshipIdempotencyKey(
            `admin-store-${connection.storeConnectionId}-shopify-webhooks-repair`,
          ),
        }),
      );
      setMessage(
        `Shopify webhooks repaired for ${response.result.shopDomain}.`,
      );
      await Promise.all([
        storeConnectionsQuery.refetch(),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/dogfood-readiness"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/ops/overview"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/dropship/admin/audit-events"],
        }),
      ]);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Shopify webhook repair failed.",
      );
    } finally {
      setRepairingWebhookConnectionId(null);
    }
  }

  return (
    <div className="space-y-5">
      {(storeConnectionsQuery.error || warehousesQuery.error || error) && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error ||
              queryErrorMessage(
                storeConnectionsQuery.error ?? warehousesQuery.error,
                "Unable to load dropship store connections.",
              )}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}

      <section className="rounded-md border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">
              Customer store connections
            </h2>
            <p className="text-sm text-muted-foreground">
              Monitor connected dropship stores, owner identity, setup progress,
              and operator actions.
            </p>
          </div>
          <div className="flex flex-col gap-2 lg:flex-row">
            <div className="relative min-w-0 lg:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Store, owner, email, or domain"
              />
            </div>
            <Select
              value={platform}
              onValueChange={(value) =>
                setPlatform(value as StoreConnectionPlatformFilter)
              }
            >
              <SelectTrigger className="lg:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All platforms</SelectItem>
                <SelectItem value="ebay">eBay</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={status}
              onValueChange={(value) =>
                setStatus(value as StoreConnectionStatusFilter)
              }
            >
              <SelectTrigger className="lg:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {storeConnectionStatusFilters.map((option) => (
                  <SelectItem key={option} value={option}>
                    {option === "all" ? "All statuses" : formatStatus(option)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              onClick={applyStoreFilters}
            >
              <FileSearch className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <CatalogMetric
          icon={<Store className="h-4 w-4" />}
          label="Matching stores"
          value={String(storeConnectionsQuery.data?.total ?? 0)}
        />
        <CatalogMetric
          icon={<CheckCircle2 className="h-4 w-4" />}
          label="Ready stores"
          value={String(summary.ready)}
        />
        <CatalogMetric
          icon={<AlertCircle className="h-4 w-4" />}
          label="Needs setup"
          value={String(summary.setupIncomplete)}
        />
        <CatalogMetric
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Auth attention"
          value={String(summary.authAttention)}
        />
        <CatalogMetric
          icon={<MinusCircle className="h-4 w-4" />}
          label="Disabled"
          value={String(summary.disabled)}
        />
      </section>

      <StoreConnectionsTable
        connections={connections}
        isLoading={
          storeConnectionsQuery.isLoading || storeConnectionsQuery.isFetching
        }
        onDisableStoreConnection={openDisableStoreDialog}
        onOpenWarehouseConfig={openWarehouseConfigDialog}
        onOpenListingModeConfig={openListingModeDialog}
        onRepairShopifyWebhooks={repairShopifyWebhooks}
        disablingConnectionId={disablingConnectionId}
        repairingWebhookConnectionId={repairingWebhookConnectionId}
        savingWarehouseConnectionId={savingWarehouseConnectionId}
        savingListingModeConnectionId={savingListingModeConnectionId}
        total={storeConnectionsQuery.data?.total ?? 0}
      />

      <Dialog
        open={listingModeTarget !== null}
        onOpenChange={(open) => {
          if (!open && savingListingModeConnectionId === null) {
            setListingModeTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Listing mode</DialogTitle>
            <DialogDescription>
              What a vendor&apos;s push does on this store. The change applies
              to the next push. Anything queued before it is refused as changed
              and must be queued again.
            </DialogDescription>
          </DialogHeader>
          {listingModeTarget && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="font-medium">
                  {storeConnectionDisplayName(listingModeTarget)}
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatStatus(listingModeTarget.platform)} /{" "}
                  {storeConnectionOwnerLabel(listingModeTarget)}
                </div>
              </div>
              <div>
                <label
                  className="text-sm font-medium"
                  htmlFor="dropship-store-listing-mode"
                >
                  Mode
                </label>
                <Select
                  value={listingModeInput}
                  onValueChange={(value) => {
                    const mode = parseDropshipListingMode(value);
                    if (mode) setListingModeInput(mode);
                  }}
                >
                  <SelectTrigger
                    id="dropship-store-listing-mode"
                    className="mt-2"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DROPSHIP_LISTING_MODE_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p
                  className="mt-2 text-sm text-muted-foreground"
                  data-testid="dropship-store-listing-mode-description"
                >
                  {describeDropshipListingMode(listingModeInput).description}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={savingListingModeConnectionId !== null}
              onClick={() => setListingModeTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={
                savingListingModeConnectionId !== null ||
                listingModeTarget?.listingConfig.listingMode ===
                  listingModeInput
              }
              onClick={saveListingMode}
            >
              <Save
                className={
                  savingListingModeConnectionId !== null
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
              Save listing mode
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EbayOAuthBrandingAdminPanel />

      <Dialog
        open={warehouseTarget !== null}
        onOpenChange={(open) => {
          if (!open && savingWarehouseConnectionId === null) {
            setWarehouseTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign default warehouse</DialogTitle>
            <DialogDescription>
              This sets the internal Echelon warehouse used when accepted
              dropship orders are routed for fulfillment.
            </DialogDescription>
          </DialogHeader>
          {warehouseTarget && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="font-medium">
                  {storeConnectionDisplayName(warehouseTarget)}
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatStatus(warehouseTarget.platform)} /{" "}
                  {storeConnectionOwnerLabel(warehouseTarget)}
                </div>
              </div>
              <div>
                <label
                  className="text-sm font-medium"
                  htmlFor="dropship-store-warehouse"
                >
                  Default warehouse
                </label>
                <Select
                  value={warehouseInput || NO_DEFAULT_WAREHOUSE_VALUE}
                  onValueChange={(value) =>
                    setWarehouseInput(
                      value === NO_DEFAULT_WAREHOUSE_VALUE ? "" : value,
                    )
                  }
                  disabled={
                    warehousesQuery.isLoading || warehousesQuery.isFetching
                  }
                >
                  <SelectTrigger id="dropship-store-warehouse" className="mt-2">
                    <SelectValue
                      placeholder={
                        warehousesQuery.isLoading
                          ? "Loading warehouses..."
                          : "Select warehouse"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_DEFAULT_WAREHOUSE_VALUE}>
                      Not assigned
                    </SelectItem>
                    {warehouseInput !== "" &&
                      !warehouseOptions.some(
                        (warehouse) => String(warehouse.id) === warehouseInput,
                      ) && (
                        <SelectItem value={warehouseInput}>
                          Warehouse ID {warehouseInput} (not found)
                        </SelectItem>
                      )}
                    {warehouseOptions.map((warehouse) => (
                      <SelectItem
                        key={warehouse.id}
                        value={String(warehouse.id)}
                      >
                        {formatWarehouseOption(warehouse)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={savingWarehouseConnectionId !== null}
              onClick={() => setWarehouseTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={
                savingWarehouseConnectionId !== null ||
                warehousesQuery.isLoading ||
                warehousesQuery.isFetching
              }
              onClick={saveWarehouseConfig}
            >
              <Save
                className={
                  savingWarehouseConnectionId !== null
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
              {savingWarehouseConnectionId !== null
                ? "Saving"
                : "Save warehouse"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open && disablingConnectionId === null) {
            setDisableTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable store connection</DialogTitle>
            <DialogDescription>
              This moves the store into disconnect grace, clears marketplace
              tokens, and pauses dropship intake and listing pushes for this
              store.
            </DialogDescription>
          </DialogHeader>
          {disableTarget && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="font-medium">
                  {storeConnectionDisplayName(disableTarget)}
                </div>
                <div className="text-sm text-muted-foreground">
                  {formatStatus(disableTarget.platform)} /{" "}
                  {storeConnectionOwnerLabel(disableTarget)}
                </div>
              </div>
              <div>
                <label
                  className="text-sm font-medium"
                  htmlFor="dropship-store-disable-reason"
                >
                  Reason
                </label>
                <Textarea
                  id="dropship-store-disable-reason"
                  value={disableReason}
                  onChange={(event) => setDisableReason(event.target.value)}
                  className="mt-2 min-h-28"
                  maxLength={500}
                />
                <div className="mt-1 text-xs text-muted-foreground">
                  This reason is saved to audit history and included in the
                  vendor notification.
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={disablingConnectionId !== null}
              onClick={() => setDisableTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                disablingConnectionId !== null ||
                disableReason.trim().length === 0
              }
              onClick={confirmDisableStoreConnection}
            >
              {disablingConnectionId !== null ? "Disabling" : "Disable store"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StoreConnectionsTable({
  connections,
  disablingConnectionId,
  isLoading,
  onDisableStoreConnection,
  onOpenWarehouseConfig,
  onOpenListingModeConfig,
  onRepairShopifyWebhooks,
  repairingWebhookConnectionId,
  savingWarehouseConnectionId,
  savingListingModeConnectionId,
  total,
}: {
  connections: DropshipAdminStoreConnectionListItem[];
  disablingConnectionId: number | null;
  isLoading: boolean;
  onDisableStoreConnection: (
    connection: DropshipAdminStoreConnectionListItem,
  ) => void;
  onOpenWarehouseConfig: (
    connection: DropshipAdminStoreConnectionListItem,
  ) => void;
  onOpenListingModeConfig: (
    connection: DropshipAdminStoreConnectionListItem,
  ) => void;
  onRepairShopifyWebhooks: (
    connection: DropshipAdminStoreConnectionListItem,
  ) => void;
  repairingWebhookConnectionId: number | null;
  savingWarehouseConnectionId: number | null;
  savingListingModeConnectionId: number | null;
  total: number;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <Empty className="rounded-md border border-dashed p-8">
        <EmptyMedia variant="icon">
          <Store />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No store connections</EmptyTitle>
          <EmptyDescription>
            No dropship store connections match the current filters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3 text-sm text-muted-foreground">
        <span>
          {total} store connection{total === 1 ? "" : "s"}
        </span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Store</TableHead>
            <TableHead>Owner</TableHead>
            <TableHead>Subscription</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Marketplace auth</TableHead>
            <TableHead className="w-[190px]">Warehouse</TableHead>
            <TableHead>Listing</TableHead>
            <TableHead>Setup status</TableHead>
            <TableHead className="w-[210px]">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {connections.map((connection) => {
            const disabled = storeConnectionIsDisabled(connection);
            const canRepairShopifyWebhooks =
              connection.platform === "shopify" &&
              connection.status === "connected";
            const ownerDetail = storeConnectionOwnerDetail(connection);
            return (
              <TableRow key={connection.storeConnectionId}>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <div className="font-medium">
                      {storeConnectionDisplayName(connection)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge
                        variant="outline"
                        className="border-zinc-200 bg-zinc-50 text-zinc-700"
                      >
                        {formatStatus(connection.platform)}
                      </Badge>
                      {connection.shopDomain && (
                        <span className="max-w-[220px] truncate text-xs text-muted-foreground">
                          {connection.shopDomain}
                        </span>
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="font-medium">
                    {storeConnectionOwnerLabel(connection)}
                  </div>
                  {ownerDetail && (
                    <div className="text-xs text-muted-foreground">
                      {ownerDetail}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={subscriptionStatusTone(
                      connection.vendor.entitlementStatus,
                    )}
                  >
                    {subscriptionStatusLabel(
                      connection.vendor.entitlementStatus,
                    )}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={storeConnectionStatusTone(connection.status)}
                  >
                    {formatStatus(connection.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <StoreConnectionStatusPill
                    item={buildStoreConnectionAuthJourney(connection)}
                  />
                </TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <StoreConnectionStatusPill
                      item={buildStoreConnectionWarehouseJourney(connection)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-full gap-2"
                      disabled={
                        disabled || savingWarehouseConnectionId !== null
                      }
                      onClick={() => onOpenWarehouseConfig(connection)}
                    >
                      <Truck
                        className={
                          savingWarehouseConnectionId ===
                          connection.storeConnectionId
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      {connection.orderProcessingConfig.defaultWarehouseId ===
                      null
                        ? "Assign"
                        : "Change"}
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="space-y-2">
                    <StoreConnectionStatusPill
                      item={buildStoreConnectionListingJourney(connection)}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 w-full gap-2"
                      disabled={
                        disabled || savingListingModeConnectionId !== null
                      }
                      onClick={() => onOpenListingModeConfig(connection)}
                    >
                      <Store
                        className={
                          savingListingModeConnectionId ===
                          connection.storeConnectionId
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      Listing mode
                    </Button>
                  </div>
                </TableCell>
                <TableCell>
                  <StoreConnectionStatusPill
                    item={buildStoreConnectionSetupJourney(connection)}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-2">
                    {canRepairShopifyWebhooks && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9 gap-2"
                        disabled={repairingWebhookConnectionId !== null}
                        onClick={() => onRepairShopifyWebhooks(connection)}
                      >
                        <RefreshCw
                          className={
                            repairingWebhookConnectionId ===
                            connection.storeConnectionId
                              ? "h-4 w-4 animate-spin"
                              : "h-4 w-4"
                          }
                        />
                        {repairingWebhookConnectionId ===
                        connection.storeConnectionId
                          ? "Repairing"
                          : "Repair webhooks"}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-2 border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                      disabled={disabled || disablingConnectionId !== null}
                      onClick={() => onDisableStoreConnection(connection)}
                    >
                      <ShieldAlert
                        className={
                          disablingConnectionId === connection.storeConnectionId
                            ? "h-4 w-4 animate-spin"
                            : "h-4 w-4"
                        }
                      />
                      {disabled
                        ? "Disabled"
                        : disablingConnectionId === connection.storeConnectionId
                          ? "Disabling"
                          : "Disable store"}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </section>
  );
}

function StoreConnectionStatusPill({
  item,
}: {
  item: StoreConnectionJourneyItem;
}) {
  return (
    <div
      className={`rounded-md border px-3 py-2 ${storeConnectionJourneyTone(item.state)}`}
    >
      <div className="text-sm font-semibold">{item.value}</div>
      {item.detail && <div className="text-xs opacity-80">{item.detail}</div>}
    </div>
  );
}

export {
  StoreConnectionOpsTab,
  StoreConnectionsTable,
  StoreConnectionStatusPill,
};
export default StoreConnectionOpsTab;
