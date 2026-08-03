/**
 * Pricing destinations come from the reusable destination library. This
 * editor owns only availability, warehouse overrides, and rate configuration.
 */

import { useState } from "react";
import type { ShippingDestinationScopeSummary } from "@shared/types/shipping-channel-routing";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Warehouse as WarehouseIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ALL_REGION_CODES,
  groupDisplayName,
  newGroup,
  newId,
  replaceRateGroupAndPropagateIdentity,
  type PricingBasis,
  type RateGroup,
} from "../rate-table-model";
import type {
  ProgramDestinationGroup,
  WarehouseOption,
} from "./api";
import { RateBandMatrix } from "./RateBandMatrix";
import {
  DestinationProductPolicies,
  type DestinationPolicyView,
} from "./DestinationProductPolicies";

interface DestinationGroupsPanelProps {
  groups: RateGroup[];
  onChange: (groups: RateGroup[]) => void;
  pricingBasis: PricingBasis;
  warehouses: WarehouseOption[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  issueMessagesByGroup: Map<string, string[]>;
  draftId: number | null;
  onSaveDraft: () => void;
  savingDraft: boolean;
  availableDestinationGroups: ProgramDestinationGroup[];
  availableDestinationScopes: ShippingDestinationScopeSummary[];
}

export function DestinationGroupsPanel({
  groups,
  onChange,
  pricingBasis,
  warehouses,
  selectedGroupId,
  onSelectGroup,
  issueMessagesByGroup,
  draftId,
  onSaveDraft,
  savingDraft,
  availableDestinationGroups,
  availableDestinationScopes,
}: DestinationGroupsPanelProps) {
  const { toast } = useToast();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [detailView, setDetailView] = useState<"default" | DestinationPolicyView>("default");

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const currentDestinationScope = selectedGroup?.sourceDestinationScopeId === null
    || selectedGroup?.sourceDestinationScopeId === undefined
    ? null
    : availableDestinationScopes.find(
        (scope) => scope.id === selectedGroup.sourceDestinationScopeId,
      ) ?? null;
  const selectedGroupIsStale = currentDestinationScope !== null
    && selectedGroup?.sourceDestinationScopeLockVersion !== currentDestinationScope.lockVersion;

  const updateGroup = (groupId: string, update: (group: RateGroup) => RateGroup) => {
    const current = groups.find((group) => group.id === groupId);
    if (current === undefined) return;
    const next = update(current);
    onChange(replaceRateGroupAndPropagateIdentity(groups, groupId, next));
  };

  const addDestinationScope = (scope: ShippingDestinationScopeSummary) => {
    const existing = groups.find(
      (group) => group.sourceDestinationScopeId === scope.id,
    );
    if (existing) {
      onSelectGroup(existing.id);
      return;
    }
    const savedProgramGroup = availableDestinationGroups.find((group) =>
      group.hasCurrentDefinition
      && group.sourceDestinationScopeId === scope.id);
    const group = savedProgramGroup === undefined
      ? rateGroupFromDestinationScope(scope, pricingBasis)
      : rateGroupFromProgramDestinationGroup(savedProgramGroup, pricingBasis);
    onChange([...groups, group]);
    onSelectGroup(group.id);
  };

  const addWarehouseScope = (
    source: RateGroup,
    originWarehouseId: number | null,
  ) => {
    if (source.destinationGroupId === null) {
      toast({
        title: "Save the destination group first",
        description: "Warehouse pricing reuses the saved geography identity.",
        variant: "destructive",
      });
      return;
    }
    const duplicateScope = groups.some((group) =>
      group.destinationGroupId === source.destinationGroupId
      && group.originWarehouseId === originWarehouseId);
    if (duplicateScope) {
      toast({
        title: "That warehouse scope already exists",
        variant: "destructive",
      });
      return;
    }
    const scope: RateGroup = {
      ...source,
      id: newId(),
      originWarehouseId,
      regions: [...source.regions],
      zipEntries: cloneZipEntries(source.zipEntries),
      bands: source.bands.map((band) => ({ ...band, id: newId() })),
    };
    const sourceIndex = groups.findIndex((group) => group.id === source.id);
    const lastSharedIndex = groups.reduce(
      (last, group, index) =>
        group.destinationGroupId === source.destinationGroupId ? index : last,
      sourceIndex,
    );
    const next = [...groups];
    next.splice(lastSharedIndex + 1, 0, scope);
    onChange(next);
    onSelectGroup(scope.id);
  };

  const removeGroup = (groupId: string) => {
    const remaining = groups.filter((group) => group.id !== groupId);
    onChange(remaining);
    if (selectedGroupId === groupId && remaining.length > 0) {
      onSelectGroup(remaining[0].id);
    }
  };

  const groupHasContent = (group: RateGroup) =>
    group.regions.length > 0
    || group.zipEntries.length > 0
    || group.baseChargeUsd.trim() !== ""
    || group.perStartedPoundUsd.trim() !== ""
    || group.bands.some((band) => band.rateUsd.trim() !== "");

  if (groups.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center">
        <MapPin className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium">No destinations selected</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Add a reusable destination from the library, then configure this shipping option's
          availability and pricing for it.
        </p>
        <AddDestinationScopeMenu
          className="mt-4"
          onAdd={addDestinationScope}
          scopes={availableDestinationScopes}
          selectedScopeIds={new Set()}
        />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Left: group list */}
      <div className="min-w-0 space-y-2">
        <div className="px-1 pb-1">
          <h3 className="text-sm font-semibold">Destinations</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Reusable coverage from the destination library. Pricing and availability remain
            specific to this shipping option.
          </p>
        </div>
        {groups.map((group, index) => {
          const issues = issueMessagesByGroup.get(group.id) ?? [];
          const isSelected = selectedGroup?.id === group.id;
          return (
            <button
              key={group.id}
              type="button"
              onClick={() => onSelectGroup(group.id)}
              className={cn(
                "w-full rounded-md border px-3 py-2.5 text-left transition-colors",
                isSelected ? "border-primary bg-primary/5" : "hover:bg-muted/50",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">
                  {groupDisplayName(group, index)}
                </span>
                {issues.length > 0 && (
                  <AlertTriangle
                    className="h-3.5 w-3.5 shrink-0 text-destructive"
                    aria-label={`${issues.length} issue${issues.length === 1 ? "" : "s"}`}
                  />
                )}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {warehouseScopeLabel(group.originWarehouseId, warehouses)}
                {" | "}
                {destinationSummary(group)}
                {group.zipEntries.length > 0
                  && ` | ${group.zipEntries.reduce(
                    (sum, entry) => sum + entry.prefixes.length,
                    0,
                  )} ZIP`}
              </div>
              {group.availability === "not_offered" && (
                <Badge
                  variant="outline"
                  className="mt-1.5 border-slate-300 text-slate-700"
                >
                  Not offered
                </Badge>
              )}
            </button>
          );
        })}
        <AddDestinationScopeMenu
          variant="outline"
          className="w-full"
          onAdd={addDestinationScope}
          scopes={availableDestinationScopes}
          selectedScopeIds={new Set(
            groups.flatMap((group) =>
              group.sourceDestinationScopeId === null
                ? []
                : [group.sourceDestinationScopeId]),
          )}
        />
      </div>

      {/* Right: selected group detail */}
      {selectedGroup && (
        <div className="min-w-0 space-y-5 rounded-md border p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-52 flex-1">
              <Label className="text-xs text-muted-foreground">Destination</Label>
              <div className="mt-1 flex min-h-9 flex-wrap items-center gap-2">
                <span className="font-medium">
                  {groupDisplayName(selectedGroup, groups.indexOf(selectedGroup))}
                </span>
                {selectedGroup.sourceDestinationScopeLockVersion !== null && (
                  <Badge variant="outline">
                    v{selectedGroup.sourceDestinationScopeLockVersion}
                  </Badge>
                )}
              </div>
            </div>
            <div className="w-44">
              <Label className="text-xs text-muted-foreground">
                This shipping option
              </Label>
              <Select
                value={selectedGroup.availability}
                onValueChange={(availability: RateGroup["availability"]) =>
                  updateGroup(selectedGroup.id, (group) => ({
                    ...group,
                    availability,
                  }))}
              >
                <SelectTrigger className="mt-1 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="offered">Offered</SelectItem>
                  <SelectItem value="not_offered">Not offered</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5 self-end">
              <AddWarehouseScopeMenu
                group={selectedGroup}
                groups={groups}
                warehouses={warehouses}
                onAdd={addWarehouseScope}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={() => {
                  if (groupHasContent(selectedGroup)) setConfirmDeleteId(selectedGroup.id);
                  else removeGroup(selectedGroup.id);
                }}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {selectedGroup.originWarehouseId === null
                  ? "Remove default"
                  : "Remove override"}
              </Button>
            </div>
          </div>

          {(issueMessagesByGroup.get(selectedGroup.id) ?? []).length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2">
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive">
                {(issueMessagesByGroup.get(selectedGroup.id) ?? []).map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}

          {selectedGroup.availability === "not_offered" && (
            <div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2.5">
              <Ban className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">
                  This option is not offered to this destination group.
                </p>
                <p className="text-xs text-muted-foreground">
                  Its geography is recorded, but no price rows are saved.
                </p>
              </div>
            </div>
          )}

          {currentDestinationScope === null && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-destructive">
              <p className="text-sm font-medium">This destination is no longer available.</p>
              <p className="text-xs">
                Remove it from the draft or restore the destination in the library before saving.
              </p>
            </div>
          )}

          {currentDestinationScope?.status === "retired" && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5 text-destructive">
              <p className="text-sm font-medium">{currentDestinationScope.name} is retired.</p>
              <p className="text-xs">
                Retired destinations cannot be attached to new pricing revisions.
              </p>
            </div>
          )}

          {selectedGroupIsStale && currentDestinationScope !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-950">
              <div>
                <p className="text-sm font-medium">
                  This draft uses an older version of {currentDestinationScope.name}.
                </p>
                <p className="text-xs text-amber-800">
                  Refresh its locked coverage before saving this shipping option.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-amber-400 bg-white hover:bg-amber-100"
                onClick={() => updateGroup(selectedGroup.id, (group) =>
                  refreshRateGroupFromDestinationScope(group, currentDestinationScope))}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Use current coverage
              </Button>
            </div>
          )}
          {selectedGroup.availability === "offered" && (
            <div className="flex flex-wrap gap-1 rounded-md bg-muted p-1">
            {([
              ["default", "Default pricing"],
              ["exceptions", "Product exceptions"],
              ["restrictions", "Restrictions"],
              ["test", "Test rate"],
            ] as const).map(([value, label]) => (
              <Button
                key={value}
                type="button"
                variant={detailView === value ? "secondary" : "ghost"}
                size="sm"
                className="h-8"
                onClick={() => setDetailView(value)}
              >
                {label}
              </Button>
            ))}
            </div>
          )}

          {selectedGroup.availability === "offered" && detailView !== "default" && (
            <DestinationProductPolicies
              view={detailView}
              draftId={draftId}
              group={selectedGroup}
              groupIndex={groups.indexOf(selectedGroup)}
              warehouses={warehouses}
              onSaveDraft={onSaveDraft}
              savingDraft={savingDraft}
            />
          )}

          {(detailView === "default" || selectedGroup.availability === "not_offered") && <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <WarehouseIcon className="h-3.5 w-3.5 text-muted-foreground" />
                Warehouse override
              </Label>
              <Select
                value={selectedGroup.originWarehouseId === null
                  ? "all"
                  : String(selectedGroup.originWarehouseId)}
                onValueChange={(value) => updateGroup(selectedGroup.id, (group) => ({
                  ...group,
                  originWarehouseId: value === "all" ? null : Number(value),
                }))}
              >
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="all"
                    disabled={warehouseScopeInUse(groups, selectedGroup, null)}
                  >
                    All warehouses
                  </SelectItem>
                  {warehouses.map((warehouse) => (
                    <SelectItem
                      key={warehouse.id}
                      value={String(warehouse.id)}
                      disabled={warehouseScopeInUse(
                        groups,
                        selectedGroup,
                        warehouse.id,
                      )}
                    >
                      {warehouse.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Leave this at the program scope unless this destination needs
                warehouse-specific pricing.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                Coverage
              </Label>
              <div className="rounded-md border bg-muted/30 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{selectedGroup.name}</span>
                  {selectedGroup.sourceDestinationScopeLockVersion !== null && (
                    <Badge variant="outline">
                      Locked to v{selectedGroup.sourceDestinationScopeLockVersion}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {destinationCoverageSummary(selectedGroup)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Geography is managed in Destinations. This pricing draft keeps a versioned snapshot.
                </p>
              </div>
            </div>
          </div>

          {selectedGroup.availability === "offered" && (
          <div className="space-y-2 border-t pt-4">
            <div className="grid gap-3 sm:grid-cols-[260px_minmax(0,1fr)] sm:items-end">
              <div className="space-y-1.5">
                <Label>Charge method</Label>
                <Select
                  value={selectedGroup.pricingModel}
                  onValueChange={(pricingModel: RateGroup["pricingModel"]) => updateGroup(
                    selectedGroup.id,
                    (group) => ({ ...group, pricingModel }),
                  )}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weight_bands">Fixed weight bands</SelectItem>
                    {pricingBasis === "shipment_weight" && (
                      <SelectItem value="base_plus_per_started_pound">Base + per started lb</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <p className="pb-2 text-xs text-muted-foreground">
                {selectedGroup.pricingModel === "base_plus_per_started_pound"
                  ? "The shipment weight rounds up to the next whole pound; 2.1 lb bills as 3 lb."
                  : "Each shipment uses exactly one matching weight band."}
              </p>
            </div>

            {selectedGroup.pricingModel === "base_plus_per_started_pound" ? (
              <div className="grid gap-3 rounded-md border p-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`base-charge-${selectedGroup.id}`}>Base charge</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">$</span>
                    <Input
                      id={`base-charge-${selectedGroup.id}`}
                      type="number"
                      min={0}
                      step={0.01}
                      inputMode="decimal"
                      value={selectedGroup.baseChargeUsd}
                      onChange={(event) => updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        baseChargeUsd: event.target.value,
                      }))}
                      className="pl-7"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`per-pound-${selectedGroup.id}`}>Per started lb</Label>
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground">$</span>
                    <Input
                      id={`per-pound-${selectedGroup.id}`}
                      type="number"
                      min={0}
                      step={0.01}
                      inputMode="decimal"
                      value={selectedGroup.perStartedPoundUsd}
                      onChange={(event) => updateGroup(selectedGroup.id, (group) => ({
                        ...group,
                        perStartedPoundUsd: event.target.value,
                      }))}
                      className="pl-7"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <Label>{pricingBasis === "pallet_count" ? "Pallet bands" : "Weight bands"}</Label>
                  <p className="text-xs text-muted-foreground">
                    Lower boundaries are calculated from the previous row. Use arrow keys to move
                    between cells; paste a column from a spreadsheet to fill consecutive cells.
                  </p>
                </div>
                <RateBandMatrix
                  pricingBasis={pricingBasis}
                  bands={selectedGroup.bands}
                  onChange={(bands) => updateGroup(selectedGroup.id, (group) => ({ ...group, bands }))}
                  copyTargets={groups
                    .filter((group) => group.id !== selectedGroup.id)
                    .map((group) => ({
                      id: group.id,
                      label: groupDisplayName(group, groups.indexOf(group)),
                    }))}
                  onCopyTo={(targetGroupId) => {
                    updateGroup(targetGroupId, (group) => ({
                      ...group,
                      pricingModel: "weight_bands",
                      bands: selectedGroup.bands.map((band) => ({ ...band, id: newId() })),
                    }));
                    toast({ title: "Bands copied" });
                  }}
                />
              </>
            )}
          </div>
          )}
          </>}
        </div>
      )}

      <AlertDialog
        open={confirmDeleteId !== null}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this destination group?</AlertDialogTitle>
            <AlertDialogDescription>
              This warehouse rate scope comes out of the draft. The reusable
              destination group and live quoting do not change until activation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteId !== null) removeGroup(confirmDeleteId);
                setConfirmDeleteId(null);
              }}
            >
              Delete group
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

interface AddDestinationScopeMenuProps {
  onAdd: (scope: ShippingDestinationScopeSummary) => void;
  scopes: ShippingDestinationScopeSummary[];
  selectedScopeIds: Set<number>;
  variant?: "default" | "outline";
  className?: string;
}

function AddDestinationScopeMenu({
  onAdd,
  scopes,
  selectedScopeIds,
  variant = "default",
  className,
}: AddDestinationScopeMenuProps) {
  const activeScopes = scopes.filter((scope) => scope.status === "active");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={variant} className={className}>
          <Plus className="mr-2 h-4 w-4" />
          Add destination
          <ChevronDown className="ml-auto h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel>Destination library</DropdownMenuLabel>
        {activeScopes.length === 0 ? (
          <DropdownMenuItem disabled>No active destinations available</DropdownMenuItem>
        ) : activeScopes.map((scope) => {
          const selected = selectedScopeIds.has(scope.id);
          const unsupported = !isRateEditorCompatibleDestinationScope(scope);
          return (
            <DropdownMenuItem
              key={scope.id}
              disabled={selected || unsupported}
              onSelect={() => onAdd(scope)}
            >
              <span className="flex-1 truncate">{scope.name}</span>
              <span className="mr-2 text-xs text-muted-foreground">
                {unsupported ? "Not a US rate scope" : destinationScopeMemberSummary(scope)}
              </span>
              {selected && <Check className="h-3.5 w-3.5" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function isRateEditorCompatibleDestinationScope(
  scope: ShippingDestinationScopeSummary,
): boolean {
  return scope.members.length > 0 && scope.members.every((member) =>
    member.country === "US"
    && member.region !== null
    && (ALL_REGION_CODES as readonly string[]).includes(member.region));
}

function AddWarehouseScopeMenu({
  group,
  groups,
  warehouses,
  onAdd,
}: {
  group: RateGroup;
  groups: RateGroup[];
  warehouses: WarehouseOption[];
  onAdd: (source: RateGroup, originWarehouseId: number | null) => void;
}) {
  const usedScopes = new Set(
    groups
      .filter((candidate) =>
        group.destinationGroupId !== null
        && candidate.destinationGroupId === group.destinationGroupId)
      .map((candidate) => candidate.originWarehouseId ?? 0),
  );
  const allWarehouseAvailable = !usedScopes.has(0);
  const availableWarehouses = warehouses.filter(
    (warehouse) => !usedScopes.has(warehouse.id),
  );
  const disabled = group.destinationGroupId === null
    || (!allWarehouseAvailable && availableWarehouses.length === 0);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          title={group.destinationGroupId === null
            ? "Save this destination group before adding warehouse pricing"
            : disabled
              ? "Every configured warehouse scope already has pricing"
              : "Add a default or warehouse-specific rate schedule"}
        >
          <WarehouseIcon className="mr-1.5 h-3.5 w-3.5" />
          Add warehouse pricing
          <ChevronDown className="ml-1.5 h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Rate scope</DropdownMenuLabel>
        {allWarehouseAvailable && (
          <DropdownMenuItem onSelect={() => onAdd(group, null)}>
            <span className="flex-1">All warehouses</span>
            <span className="text-xs text-muted-foreground">Default</span>
          </DropdownMenuItem>
        )}
        {availableWarehouses.map((warehouse) => (
          <DropdownMenuItem
            key={warehouse.id}
            onSelect={() => onAdd(group, warehouse.id)}
          >
            {warehouse.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface DestinationSnapshotSource {
  destinationGroupId: number | null;
  destinationGroupLockVersion: number | null;
  sourceDestinationScopeId: number;
  sourceDestinationScopeLockVersion: number;
  name: string;
  destinations: Array<{
    destinationCountry: string;
    destinationRegion: string | null;
    postalPrefix: string | null;
  }>;
}
function rateGroupFromDestinationScope(
  scope: ShippingDestinationScopeSummary,
  pricingBasis: PricingBasis,
): RateGroup {
  return rateGroupFromDestinationSnapshot({
    destinationGroupId: null,
    destinationGroupLockVersion: null,
    sourceDestinationScopeId: scope.id,
    sourceDestinationScopeLockVersion: scope.lockVersion,
    name: scope.name,
    destinations: scope.members.map((member) => ({
      destinationCountry: member.country,
      destinationRegion: member.region,
      postalPrefix: member.postalPrefix,
    })),
  }, pricingBasis);
}

function rateGroupFromProgramDestinationGroup(
  source: ProgramDestinationGroup,
  pricingBasis: PricingBasis,
): RateGroup {
  if (
    source.sourceDestinationScopeId === null
    || source.sourceDestinationScopeLockVersion === null
  ) {
    throw new Error(`Destination group ${source.key} is not linked to the destination library.`);
  }
  return rateGroupFromDestinationSnapshot({
    destinationGroupId: source.id,
    destinationGroupLockVersion: source.lockVersion,
    sourceDestinationScopeId: source.sourceDestinationScopeId,
    sourceDestinationScopeLockVersion: source.sourceDestinationScopeLockVersion,
    name: source.name,
    destinations: source.destinations,
  }, pricingBasis);
}

function rateGroupFromDestinationSnapshot(
  source: DestinationSnapshotSource,
  pricingBasis: PricingBasis,
): RateGroup {
  const regionWide = source.destinations
    .filter((destination) =>
      destination.destinationCountry === "US"
      && destination.destinationRegion !== null
      && destination.postalPrefix === null)
    .map((destination) => destination.destinationRegion!);
  const zipByRegion = new Map<string, string[]>();
  for (const destination of source.destinations) {
    if (
      destination.destinationCountry !== "US"
      || destination.destinationRegion === null
      || destination.postalPrefix === null
    ) continue;
    zipByRegion.set(destination.destinationRegion, [
      ...(zipByRegion.get(destination.destinationRegion) ?? []),
      destination.postalPrefix,
    ]);
  }
  return {
    ...newGroup(pricingBasis, regionWide, source.name),
    destinationGroupId: source.destinationGroupId,
    destinationGroupLockVersion: source.destinationGroupLockVersion,
    sourceDestinationScopeId: source.sourceDestinationScopeId,
    sourceDestinationScopeLockVersion: source.sourceDestinationScopeLockVersion,
    zipEntries: [...zipByRegion].map(([state, prefixes]) => ({
      id: newId(),
      state,
      prefixes,
    })),
  };
}

function refreshRateGroupFromDestinationScope(
  current: RateGroup,
  scope: ShippingDestinationScopeSummary,
): RateGroup {
  const refreshed = rateGroupFromDestinationScope(scope, "shipment_weight");
  return {
    ...current,
    sourceDestinationScopeId: refreshed.sourceDestinationScopeId,
    sourceDestinationScopeLockVersion: refreshed.sourceDestinationScopeLockVersion,
    name: refreshed.name,
    regions: refreshed.regions,
    zipEntries: refreshed.zipEntries,
  };
}

function cloneZipEntries(
  entries: RateGroup["zipEntries"],
): RateGroup["zipEntries"] {
  return entries.map((entry) => ({
    ...entry,
    prefixes: [...entry.prefixes],
  }));
}

function warehouseScopeInUse(
  groups: readonly RateGroup[],
  selected: RateGroup,
  originWarehouseId: number | null,
): boolean {
  if (selected.destinationGroupId === null) return false;
  return groups.some((group) =>
    group.id !== selected.id
    && group.destinationGroupId === selected.destinationGroupId
    && group.originWarehouseId === originWarehouseId);
}

function warehouseScopeLabel(
  originWarehouseId: number | null,
  warehouses: readonly WarehouseOption[],
): string {
  if (originWarehouseId === null) return "All warehouses";
  return warehouses.find((warehouse) => warehouse.id === originWarehouseId)
    ?.name ?? `Warehouse ${originWarehouseId}`;
}

function destinationSummary(group: RateGroup): string {
  const ordered = [...new Set(group.regions)].sort();
  if (ordered.length === 0) return "No region-wide destinations";
  if (ordered.length <= 4) return ordered.join(", ");
  return `${ordered.slice(0, 4).join(", ")} + ${ordered.length - 4} more`;
}
function destinationCoverageSummary(group: RateGroup): string {
  const regionCount = new Set(group.regions).size;
  const postalPrefixCount = group.zipEntries.reduce(
    (sum, entry) => sum + entry.prefixes.length,
    0,
  );
  const pieces = [
    `${regionCount} US region${regionCount === 1 ? "" : "s"}`,
  ];
  if (postalPrefixCount > 0) {
    pieces.push(`${postalPrefixCount} postal prefix${postalPrefixCount === 1 ? "" : "es"}`);
  }
  return pieces.join(" | ");
}

function destinationScopeMemberSummary(scope: ShippingDestinationScopeSummary): string {
  const regionCount = new Set(
    scope.members
      .filter((member) => member.region !== null && member.postalPrefix === null)
      .map((member) => `${member.country}:${member.region}`),
  ).size;
  const postalPrefixCount = scope.members.filter((member) => member.postalPrefix !== null).length;
  if (postalPrefixCount === 0) return `${regionCount} region${regionCount === 1 ? "" : "s"}`;
  return `${regionCount} regions, ${postalPrefixCount} postal`;
}
