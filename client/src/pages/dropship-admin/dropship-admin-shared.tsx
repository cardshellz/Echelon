import type * as React from "react";
import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronsUpDown,
  FileSearch,
  MinusCircle,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  describeDropshipListingMode,
  formatStatus,
  type DropshipAdminOrderOpsStoreSummary,
  type DropshipAdminOrderOpsVendorSummary,
  type DropshipAdminStoreConnectionListItem,
  type DropshipAdminWorkerSweepName,
  type DropshipAdminWorkerSweepResponse,
  type DropshipDogfoodReadinessItem,
  type DropshipDogfoodReadinessResponse,
  type DropshipDogfoodReadinessStatus,
  type DropshipOmsChannelConfigOverview,
  type DropshipOmsChannelOption,
  type DropshipSeverity,
  type DropshipStoreConnectionLifecycleStatus,
  type DropshipStorePlatform,
  type DropshipSystemReadinessCheck,
  type DropshipTrackingPushStatus,
} from "@/lib/dropship-ops-surface";

export type AuditSeverityFilter = DropshipSeverity | "all";

export type DogfoodReadinessStatusFilter = DropshipDogfoodReadinessStatus | "all";

export type StoreConnectionStatusFilter =
  DropshipStoreConnectionLifecycleStatus | "all";

export type StoreConnectionPlatformFilter = DropshipStorePlatform | "all";

export type DropshipOpsSearchableTab =
  "listing-pushes" | "order-intake" | "tracking-pushes";

export type DropshipOpsTabValue =
  | "overview"
  | "dogfood"
  | "catalog"
  | "shipping"
  | "order-intake"
  | "wallet-ops"
  | "wallet-policy"
  | "finance"
  | "cost-changes"
  | "stores"
  | "listing-pushes"
  | "tracking-pushes"
  | "notifications"
  | "audit";

export interface DropshipWarehouseOption {
  id: number;
  code: string;
  name: string;
  warehouseType: string;
  isActive: number;
  isDefault: number;
}

export interface DropshipProductVariantOption {
  id: number;
  sku: string | null;
  name: string;
  productId: number;
  active?: number | null;
  isActive?: boolean;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
}

export interface DropshipSelectOption {
  value: string;
  label: string;
  detail?: string;
  search?: string;
}

export const NO_DEFAULT_WAREHOUSE_VALUE = "__none__";

export const dropshipOpsTabValues = new Set<DropshipOpsTabValue>([
  "overview",
  "dogfood",
  "catalog",
  "shipping",
  "order-intake",
  "wallet-ops",
  "wallet-policy",
  "finance",
  "cost-changes",
  "stores",
  "listing-pushes",
  "tracking-pushes",
  "notifications",
  "audit",
]);

export interface DropshipOpsSearchSignal {
  tab: DropshipOpsSearchableTab;
  search: string;
  platform?: StoreConnectionPlatformFilter;
  nonce: number;
}

export const storeConnectionStatusFilters: StoreConnectionStatusFilter[] = [
  "all",
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
  "disconnected",
];

export const dogfoodReadinessStatusFilters: DogfoodReadinessStatusFilter[] = [
  "all",
  "blocked",
  "warning",
  "ready",
];

export const adminWorkerSweepOptions: Array<{
  worker: DropshipAdminWorkerSweepName;
  label: string;
  description: string;
}> = [
  {
    worker: "listing_push",
    label: "Listing push",
    description:
      "Claims pending or stale listing push jobs and sends marketplace updates.",
  },
  {
    worker: "order_processing",
    label: "Order processing",
    description:
      "Processes received dropship orders, payment holds, cancellations, and stale intakes.",
  },
  {
    worker: "ebay_order_intake",
    label: "eBay intake",
    description: "Polls connected eBay stores for paid marketplace orders.",
  },
];

export function isDropshipOpsTabValue(
  value: string | null,
): value is DropshipOpsTabValue {
  return (
    value !== null && dropshipOpsTabValues.has(value as DropshipOpsTabValue)
  );
}

export function parseDropshipOpsTab(searchString: string): DropshipOpsTabValue {
  const normalizedSearch = searchString.startsWith("?")
    ? searchString.slice(1)
    : searchString;
  const tab = new URLSearchParams(normalizedSearch).get("tab");
  return isDropshipOpsTabValue(tab) ? tab : "overview";
}

export function buildDropshipTabHref(tab: DropshipOpsTabValue): string {
  return `/dropship?tab=${encodeURIComponent(tab)}`;
}

export function ProductVariantSkuPicker({
  clearable = false,
  disabled = false,
  isLoading,
  label = "SKU",
  onChange,
  placeholder = "Select SKU",
  value,
  variants,
}: {
  clearable?: boolean;
  disabled?: boolean;
  isLoading: boolean;
  label?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
  variants: DropshipProductVariantOption[];
}) {
  const [open, setOpen] = useState(false);
  const selectedVariant =
    variants.find((variant) => String(variant.id) === value) ?? null;

  return (
    <div>
      {label && <label className="text-sm font-medium">{label}</label>}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={`${label ? "mt-2 " : ""}h-10 w-full justify-between`}
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span
              className={
                selectedVariant ? "truncate" : "truncate text-muted-foreground"
              }
            >
              {isLoading
                ? "Loading SKUs..."
                : selectedVariant
                  ? formatVariantOption(selectedVariant)
                  : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder="Search SKU or name..." />
            <CommandList>
              <CommandEmpty>No SKU found.</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_variant__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    Clear SKU
                  </CommandItem>
                )}
                {variants.map((variant) => (
                  <CommandItem
                    key={variant.id}
                    onSelect={() => {
                      onChange(String(variant.id));
                      setOpen(false);
                    }}
                    value={variantOptionSearchValue(variant)}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${String(variant.id) === value ? "opacity-100" : "opacity-0"}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {variant.sku || `Variant ${variant.id}`}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">
                        {variant.name} - ID {variant.id}
                      </div>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function SearchableOptionPicker({
  clearLabel = "Clear selection",
  clearable = false,
  disabled = false,
  emptyText,
  isLoading,
  label,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  value,
}: {
  clearLabel?: string;
  clearable?: boolean;
  disabled?: boolean;
  emptyText: string;
  isLoading: boolean;
  label: string;
  onChange: (value: string) => void;
  options: DropshipSelectOption[];
  placeholder: string;
  searchPlaceholder: string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selectedOption =
    options.find((option) => option.value === value) ?? null;

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className="mt-2 h-10 w-full justify-between"
            disabled={disabled}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span
              className={
                selectedOption || value
                  ? "truncate"
                  : "truncate text-muted-foreground"
              }
            >
              {isLoading
                ? "Loading..."
                : selectedOption
                  ? selectedOption.label
                  : value
                    ? `Selected ID ${value} (not found)`
                    : placeholder}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[360px] p-0">
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandList>
              <CommandEmpty>{emptyText}</CommandEmpty>
              <CommandGroup>
                {clearable && value && (
                  <CommandItem
                    onSelect={() => {
                      onChange("");
                      setOpen(false);
                    }}
                    value="__clear_selection__"
                  >
                    <MinusCircle className="mr-2 h-4 w-4" />
                    {clearLabel}
                  </CommandItem>
                )}
                {options.map((option) => (
                  <CommandItem
                    key={option.value}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    value={
                      option.search ??
                      `${option.label} ${option.detail ?? ""} ${option.value}`
                    }
                  >
                    <Check
                      className={`mr-2 h-4 w-4 ${option.value === value ? "opacity-100" : "opacity-0"}`}
                    />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{option.label}</div>
                      {option.detail && (
                        <div className="truncate text-xs text-muted-foreground">
                          {option.detail}
                        </div>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function FieldGroup({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-2 text-sm font-medium">{title}</div>
      <div className="flex flex-wrap gap-4">{children}</div>
    </div>
  );
}

export function ToggleField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Switch checked={checked} onCheckedChange={onChange} />
      <span>{label}</span>
    </label>
  );
}

export function LabeledSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="space-y-1">
      <label className="text-sm font-medium">{label}</label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ShippingTableSkeleton() {
  return (
    <section className="rounded-md border bg-card p-4">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="mt-4 h-44 w-full" />
    </section>
  );
}

export function ShippingSimpleTable({
  emptyTitle,
  headers,
  rows,
  title,
}: {
  emptyTitle: string;
  headers: string[];
  rows: ReactNode[][];
  title: string;
}) {
  return (
    <section className="rounded-md border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Badge variant="outline">{rows.length}</Badge>
      </div>
      {rows.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>{emptyTitle}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {headers.map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, rowIndex) => (
                <TableRow key={`${title}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell
                      key={`${title}-${rowIndex}-${cellIndex}`}
                      className={
                        cellIndex === 0
                          ? "font-medium"
                          : "text-sm text-muted-foreground"
                      }
                    >
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

export function PanelHeader({ detail, title }: { detail: string; title: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

export function WarehouseSelect({
  label,
  onChange,
  optional = false,
  value,
  warehouses,
  warehousesLoading,
}: {
  label: string;
  onChange: (value: string) => void;
  optional?: boolean;
  value: string;
  warehouses: DropshipWarehouseOption[];
  warehousesLoading: boolean;
}) {
  const selectedWarehouseKnown =
    value === "" ||
    warehouses.some((warehouse) => String(warehouse.id) === value);

  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Select
        value={value || NO_DEFAULT_WAREHOUSE_VALUE}
        onValueChange={(nextValue) =>
          onChange(nextValue === NO_DEFAULT_WAREHOUSE_VALUE ? "" : nextValue)
        }
        disabled={warehousesLoading}
      >
        <SelectTrigger className="mt-2">
          <SelectValue
            placeholder={
              warehousesLoading ? "Loading warehouses..." : "Select warehouse"
            }
          />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT_WAREHOUSE_VALUE}>
            {optional ? "Any warehouse" : "Select warehouse"}
          </SelectItem>
          {!selectedWarehouseKnown && (
            <SelectItem value={value}>
              Warehouse ID {value} (not found)
            </SelectItem>
          )}
          {warehouses.map((warehouse) => (
            <SelectItem key={warehouse.id} value={String(warehouse.id)}>
              {formatWarehouseOption(warehouse)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ShippingInput({
  label,
  onChange,
  placeholder,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  value: string;
}) {
  return (
    <div>
      <label className="text-sm font-medium">{label}</label>
      <Input
        className="mt-2"
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

export function ShippingActiveSelect({
  onChange,
  value,
}: {
  onChange: (value: boolean) => void;
  value: boolean;
}) {
  return (
    <div>
      <label className="text-sm font-medium">Status</label>
      <Select
        value={value ? "active" : "inactive"}
        onValueChange={(nextValue) => onChange(nextValue === "active")}
      >
        <SelectTrigger className="mt-2">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="active">Active</SelectItem>
          <SelectItem value="inactive">Inactive</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function dropshipOmsSourceLabel(channel: DropshipOmsChannelOption): string {
  if (channel.type === "internal" && channel.provider === "manual") {
    return channel.name;
  }
  const provider = formatStatus(channel.provider);
  return channel.name.trim().toLowerCase() === provider.trim().toLowerCase()
    ? channel.name
    : `${channel.name} (${provider})`;
}

export function OmsChannelConfigPanel({
  config,
  isLoading,
  isSaving,
  onEnsureDefaultSource,
}: {
  config: DropshipOmsChannelConfigOverview | null;
  isLoading: boolean;
  isSaving: boolean;
  onEnsureDefaultSource: () => void;
}) {
  if (isLoading && !config) {
    return (
      <section className="rounded-md border bg-card p-4">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="mt-4 h-10 w-full max-w-xl" />
      </section>
    );
  }

  const internalDropshipChannels =
    config?.channels.filter((channel) => channel.isInternalDropshipChannel) ??
    [];
  const legacyMarkedChannels =
    config?.channels.filter(
      (channel) =>
        channel.isDropshipOmsChannel && !channel.isInternalDropshipChannel,
    ) ?? [];
  const currentChannel =
    config?.channels.find(
      (channel) => channel.channelId === config.currentChannelId,
    ) ?? null;
  const hasAmbiguousConfig = (config?.currentChannelCount ?? 0) > 1;

  return (
    <section className="rounded-md border bg-card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">Internal dropship channel</h2>
            <Badge variant="outline" className={omsChannelConfigTone(config)}>
              {omsChannelConfigLabel(config)}
            </Badge>
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            {currentChannel
              ? `${dropshipOmsSourceLabel(currentChannel)} is the static internal Echelon channel used to tag dropship intake rows.`
              : hasAmbiguousConfig
                ? `${config?.currentChannelCount ?? 0} active internal dropship channels exist. This needs a data cleanup.`
                : "The static internal dropship channel is missing."}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            Vendor eBay and Shopify stores connect separately under Store
            Connections. This source only tags accepted dropship orders inside
            Echelon.
          </div>
          {internalDropshipChannels.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Internal channel:{" "}
              {internalDropshipChannels
                .map(
                  (channel) =>
                    `${dropshipOmsSourceLabel(channel)} (${formatStatus(channel.status)})`,
                )
                .join(", ")}
            </div>
          )}
          {legacyMarkedChannels.length > 0 && (
            <div className="mt-1 text-xs text-muted-foreground">
              Legacy markers:{" "}
              {legacyMarkedChannels
                .map(
                  (channel) =>
                    `${dropshipOmsSourceLabel(channel)} (${formatStatus(channel.status)})`,
                )
                .join(", ")}
            </div>
          )}
        </div>
        {(!currentChannel || hasAmbiguousConfig) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Button
              className="h-10 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
              disabled={isSaving}
              onClick={onEnsureDefaultSource}
            >
              <Save className="h-4 w-4" />
              {isSaving ? "Saving" : "Initialize channel"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

export function CatalogMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-3 text-2xl font-bold">{value}</div>
    </div>
  );
}

export function readinessSummaryCount(
  summary: DropshipDogfoodReadinessResponse["summary"],
  status: DropshipDogfoodReadinessStatus,
): number {
  return summary.find((entry) => entry.status === status)?.count ?? 0;
}

export function dogfoodReadinessStatusTone(
  status: DropshipDogfoodReadinessStatus,
): string {
  if (status === "ready")
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "warning")
    return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

export function systemReadinessCheckTone(
  status: DropshipSystemReadinessCheck["status"],
): string {
  if (status === "not_applicable")
    return "border-zinc-200 bg-zinc-50 text-zinc-700";
  return dogfoodReadinessStatusTone(status);
}

export function workerSweepMessageForResponse(
  response: DropshipAdminWorkerSweepResponse,
): string {
  const metrics = Object.entries(response.metrics)
    .filter(([, value]) => value !== 0)
    .map(([key, value]) => `${formatStatus(key)} ${value}`);
  const suffix = metrics.length > 0 ? `: ${metrics.join(" / ")}.` : ".";
  return `${workerSweepLabel(response.worker)} sweep completed${suffix}`;
}

export function workerSweepLabel(worker: DropshipAdminWorkerSweepName): string {
  return (
    adminWorkerSweepOptions.find((option) => option.worker === worker)?.label ??
    formatStatus(worker)
  );
}

export function omsChannelConfigLabel(
  config: DropshipOmsChannelConfigOverview | null,
): string {
  if (!config) return "Loading";
  if (config.currentChannelCount === 1) return "Ready";
  if (config.currentChannelCount > 1) return "Ambiguous";
  return "Missing";
}

export function omsChannelConfigTone(
  config: DropshipOmsChannelConfigOverview | null,
): string {
  if (!config) return "border-zinc-200 bg-zinc-50 text-zinc-700";
  if (config.currentChannelCount === 1)
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (config.currentChannelCount > 1)
    return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-rose-200 bg-rose-50 text-rose-800";
}

export function systemReadinessTone(
  blockedCount: number,
  warningCount: number,
): string {
  if (blockedCount > 0) return "border-rose-200 bg-rose-50 text-rose-800";
  if (warningCount > 0) return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

export function trackingPushStatusTone(status: DropshipTrackingPushStatus): string {
  if (status === "succeeded") {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (status === "queued" || status === "processing") {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (status === "failed") {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export type StoreConnectionJourneyState = "ready" | "warning" | "blocked" | "disabled";

export interface StoreConnectionJourneyItem {
  key: string;
  label: string;
  value: string;
  detail?: string;
  state: StoreConnectionJourneyState;
}

export function buildStoreConnectionSummary(
  connections: DropshipAdminStoreConnectionListItem[],
): {
  ready: number;
  setupIncomplete: number;
  authAttention: number;
  disabled: number;
} {
  return {
    ready: connections.filter((connection) => connection.launchReady).length,
    setupIncomplete: connections.filter(
      (connection) =>
        !connection.launchReady && !storeConnectionIsDisabled(connection),
    ).length,
    authAttention: connections.filter(
      (connection) =>
        !storeConnectionIsDisabled(connection) &&
        storeConnectionNeedsAuthAttention(connection),
    ).length,
    disabled: connections.filter((connection) =>
      storeConnectionIsDisabled(connection),
    ).length,
  };
}

export function storeConnectionIsDisabled(
  connection: DropshipAdminStoreConnectionListItem,
): boolean {
  return (
    connection.status === "grace_period" ||
    connection.status === "paused" ||
    connection.status === "disconnected"
  );
}

export function storeConnectionNeedsAuthAttention(
  connection: DropshipAdminStoreConnectionListItem,
): boolean {
  return (
    connection.status === "needs_reauth" ||
    connection.status === "refresh_failed" ||
    !connection.hasAccessToken ||
    (connection.platform === "ebay" && !connection.hasRefreshToken)
  );
}

export function buildStoreConnectionAuthJourney(
  connection: DropshipAdminStoreConnectionListItem,
): StoreConnectionJourneyItem {
  if (storeConnectionIsDisabled(connection)) {
    return {
      key: "auth",
      label: "Auth",
      value: "Disabled",
      detail: "Authorization removed",
      state: "disabled",
    };
  }
  if (
    connection.status === "needs_reauth" ||
    connection.status === "refresh_failed"
  ) {
    return {
      key: "auth",
      label: "Auth",
      value: "Reconnect",
      detail: formatStatus(connection.status),
      state: "blocked",
    };
  }
  if (!connection.hasAccessToken) {
    return {
      key: "auth",
      label: "Auth",
      value: "Missing",
      detail: "Reconnect required",
      state: "blocked",
    };
  }
  if (connection.platform === "ebay" && !connection.hasRefreshToken) {
    return {
      key: "auth",
      label: "Auth",
      value: "Missing",
      detail: "Reconnect required",
      state: "blocked",
    };
  }
  return { key: "auth", label: "Auth", value: "Authorized", state: "ready" };
}

export function buildStoreConnectionSetupJourney(
  connection: DropshipAdminStoreConnectionListItem,
): StoreConnectionJourneyItem {
  if (connection.setupCheckSummary.errorCount > 0) {
    return {
      key: "setup",
      label: "Setup",
      value: `${connection.setupCheckSummary.errorCount} blocker${connection.setupCheckSummary.errorCount === 1 ? "" : "s"}`,
      detail: `${connection.setupCheckSummary.openCount} open check${connection.setupCheckSummary.openCount === 1 ? "" : "s"}`,
      state: "blocked",
    };
  }
  if (connection.setupCheckSummary.warningCount > 0) {
    return {
      key: "setup",
      label: "Setup",
      value: `${connection.setupCheckSummary.warningCount} warning${connection.setupCheckSummary.warningCount === 1 ? "" : "s"}`,
      detail: `${connection.setupCheckSummary.openCount} open check${connection.setupCheckSummary.openCount === 1 ? "" : "s"}`,
      state: "warning",
    };
  }
  if (connection.setupStatus === "ready") {
    return { key: "setup", label: "Setup", value: "Ready", state: "ready" };
  }
  return {
    key: "setup",
    label: "Setup",
    value: formatStatus(connection.setupStatus),
    state: "warning",
  };
}

export function buildStoreConnectionWarehouseJourney(
  connection: DropshipAdminStoreConnectionListItem,
): StoreConnectionJourneyItem {
  if (connection.orderProcessingConfig.defaultWarehouseId !== null) {
    return {
      key: "warehouse",
      label: "Warehouse",
      value: "Set",
      state: "ready",
    };
  }
  return {
    key: "warehouse",
    label: "Warehouse",
    value: "Missing",
    detail: "Order routing not assigned",
    state: "blocked",
  };
}

export function buildStoreConnectionListingJourney(
  connection: DropshipAdminStoreConnectionListItem,
): StoreConnectionJourneyItem {
  if (!connection.listingConfig.isConfigured) {
    return {
      key: "listing",
      label: "Listing",
      value: "Missing",
      detail: "Push policy not configured",
      state: "blocked",
    };
  }
  if (!connection.listingConfig.isActive) {
    return {
      key: "listing",
      label: "Listing",
      value: "Inactive",
      detail: "Pushes disabled",
      state: "warning",
    };
  }
  const mode = describeDropshipListingMode(connection.listingConfig.listingMode);
  switch (connection.listingConfig.listingMode) {
    case "live":
      return { key: "listing", label: "Listing", value: "Ready", detail: mode.label, state: "ready" };
    // Drafts only and manual only both leave the store without a visible
    // listing after a push; the admin should see that before a vendor asks.
    case "draft_first":
      return { key: "listing", label: "Listing", value: mode.label, detail: "Pushed listings stay unpublished", state: "warning" };
    case "manual_only":
      return { key: "listing", label: "Listing", value: mode.label, detail: "Pushes are blocked", state: "warning" };
    default:
      return { key: "listing", label: "Listing", value: mode.label, detail: mode.description, state: "warning" };
  }
}

export function storeConnectionJourneyTone(
  state: StoreConnectionJourneyState,
): string {
  if (state === "ready")
    return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (state === "warning") return "border-amber-200 bg-amber-50 text-amber-950";
  if (state === "blocked") return "border-rose-200 bg-rose-50 text-rose-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export function subscriptionStatusLabel(status: string): string {
  if (status === "active") return "Active";
  if (status === "grace") return "Grace";
  if (status === "suspended") return "Suspended";
  if (status === "lapsed" || status === "not_entitled") return "Expired";
  return formatStatus(status);
}

export function subscriptionStatusTone(status: string): string {
  if (status === "active")
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "grace") return "border-amber-200 bg-amber-50 text-amber-900";
  if (
    status === "suspended" ||
    status === "lapsed" ||
    status === "not_entitled"
  ) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export function formatWarehouseOption(warehouse: DropshipWarehouseOption): string {
  const defaultSuffix = warehouse.isDefault === 1 ? " default" : "";
  return `${warehouse.name} (${warehouse.code}) - ID ${warehouse.id}${defaultSuffix}`;
}

export function buildVendorSelectOptions(
  items: DropshipDogfoodReadinessItem[],
): DropshipSelectOption[] {
  const vendors = new Map<number, DropshipDogfoodReadinessItem["vendor"]>();
  for (const item of items) {
    vendors.set(item.vendor.vendorId, item.vendor);
  }
  return Array.from(vendors.values())
    .sort((first, second) =>
      vendorDisplayName(first).localeCompare(vendorDisplayName(second)),
    )
    .map((vendor) => ({
      value: String(vendor.vendorId),
      label: vendorDisplayName(vendor),
      detail: [
        vendor.email,
        vendor.memberId,
        formatStatus(vendor.status),
        formatStatus(vendor.entitlementStatus),
      ]
        .filter(Boolean)
        .join(" / "),
      search: [
        vendor.vendorId,
        vendor.businessName,
        vendor.email,
        vendor.memberId,
        vendor.status,
        vendor.entitlementStatus,
      ]
        .filter(Boolean)
        .join(" "),
    }));
}

export function vendorDisplayName(
  vendor:
    DropshipDogfoodReadinessItem["vendor"] | DropshipAdminOrderOpsVendorSummary,
): string {
  return vendor.businessName || vendor.email || `Vendor ${vendor.vendorId}`;
}

export function storeConnectionDisplayName(
  connection:
    DropshipAdminStoreConnectionListItem | DropshipAdminOrderOpsStoreSummary,
): string {
  return (
    connection.externalDisplayName ||
    connection.shopDomain ||
    `${formatStatus(connection.platform)} store`
  );
}

export function storeConnectionOwnerLabel(
  connection: DropshipAdminStoreConnectionListItem,
): string {
  return (
    connection.vendor.businessName ||
    connection.vendor.email ||
    `Vendor ${connection.vendor.vendorId}`
  );
}

export function storeConnectionOwnerDetail(
  connection: DropshipAdminStoreConnectionListItem,
): string {
  if (connection.vendor.businessName && connection.vendor.email) {
    return connection.vendor.email;
  }
  return "";
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sideLength = Math.max(3, Math.floor((maxLength - 3) / 2));
  return `${value.slice(0, sideLength)}...${value.slice(-sideLength)}`;
}

export function formatVariantOption(variant: DropshipProductVariantOption): string {
  return `${variant.sku || `Variant ${variant.id}`} - ${variant.name}`;
}

export function variantOptionSearchValue(
  variant: DropshipProductVariantOption,
): string {
  return `${variant.sku ?? ""} ${variant.name} ${variant.id}`;
}

export function storeConnectionStatusTone(
  status: DropshipStoreConnectionLifecycleStatus,
): string {
  if (status === "connected")
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (
    status === "needs_reauth" ||
    status === "refresh_failed" ||
    status === "grace_period"
  ) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  if (status === "paused") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

export function EmptyState({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <Empty className="mt-4 rounded-md border border-dashed">
      <EmptyMedia variant="icon">
        <FileSearch />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_0.9fr]">
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Dropship ops request failed.";
}
