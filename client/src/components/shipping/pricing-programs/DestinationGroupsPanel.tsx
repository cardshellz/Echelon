/**
 * Master-detail destination-group workspace (spec §8.2): a compact group
 * list on the left, and the selected group's destinations, warehouse scope,
 * ZIP-prefix overrides, and band matrix on the right. Replaces the old
 * permanently-expanded US-region checkbox grid.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Copy,
  MapPin,
  Plus,
  RefreshCw,
  Trash2,
  Warehouse as WarehouseIcon,
  X,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
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
  ALL_US_STATES,
  CONTIGUOUS_US,
  DESTINATION_COVERAGE_TEMPLATES,
  DESTINATION_REGION_TEMPLATES,
  REGION_NAME,
  US_POSTAL_REGIONS,
  destinationGroupTemplateById,
  findDestinationGroupTemplate,
  groupDisplayName,
  newGroup,
  newId,
  replaceRateGroupAndPropagateIdentity,
  type DestinationGroupTemplate,
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
}: DestinationGroupsPanelProps) {
  const { toast } = useToast();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [zipDraft, setZipDraft] = useState<{ state: string; prefixes: string }>({
    state: "PA",
    prefixes: "",
  });
  const [detailView, setDetailView] = useState<"default" | DestinationPolicyView>("default");

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;
  const selectedTemplate = selectedGroup === null
    ? null
    : findDestinationGroupTemplate(selectedGroup.regions);
  const currentProgramGroup = selectedGroup?.destinationGroupId === null
    || selectedGroup?.destinationGroupId === undefined
    ? null
    : availableDestinationGroups.find(
        (group) => group.id === selectedGroup.destinationGroupId,
      ) ?? null;
  const selectedGroupIsStale = currentProgramGroup !== null
    && selectedGroup?.destinationGroupLockVersion !== currentProgramGroup.lockVersion;

  const updateGroup = (groupId: string, update: (group: RateGroup) => RateGroup) => {
    const current = groups.find((group) => group.id === groupId);
    if (current === undefined) return;
    const next = update(current);
    onChange(replaceRateGroupAndPropagateIdentity(groups, groupId, next));
  };

  const addGroup = (template: DestinationGroupTemplate | null) => {
    const group = newGroup(
      pricingBasis,
      template === null ? [] : [...template.regions],
      template?.name ?? "",
    );
    onChange([...groups, group]);
    onSelectGroup(group.id);
  };

  const addExistingGroup = (source: ProgramDestinationGroup) => {
    const existing = groups.find(
      (group) => group.destinationGroupId === source.id && source.id !== null,
    );
    if (existing) {
      onSelectGroup(existing.id);
      return;
    }
    const group = rateGroupFromProgramDestinationGroup(source, pricingBasis);
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

  const applyTemplate = (templateId: string) => {
    if (!selectedGroup || templateId === "custom") return;
    const template = destinationGroupTemplateById(templateId);
    if (template === null) return;
    updateGroup(selectedGroup.id, (group) => ({
      ...group,
      name: template.name,
      regions: [...template.regions],
    }));
  };

  const duplicateGroup = (source: RateGroup) => {
    // Copies the schedule and warehouse scope; destinations start empty so
    // the copy never instantly conflicts with its source.
    const copy: RateGroup = {
      ...source,
      id: newId(),
      destinationGroupId: null,
      destinationGroupLockVersion: null,
      name: source.name.trim() === "" ? "" : `${source.name.trim()} copy`,
      regions: [],
      zipEntries: [],
      bands: source.bands.map((band) => ({ ...band, id: newId() })),
    };
    onChange([...groups, copy]);
    onSelectGroup(copy.id);
    toast({
      title: "Group duplicated",
      description: "The band schedule was copied. Choose destinations for the new group.",
    });
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

  /** Region codes claimed by another group in the same warehouse scope. */
  const conflictedRegions = useMemo(() => {
    if (!selectedGroup) return new Set<string>();
    const conflicts = new Set<string>();
    for (const group of groups) {
      if (group.id === selectedGroup.id) continue;
      if (
        selectedGroup.destinationGroupId !== null
        && group.destinationGroupId === selectedGroup.destinationGroupId
      ) continue;
      if ((group.originWarehouseId ?? null) !== (selectedGroup.originWarehouseId ?? null)) continue;
      for (const region of group.regions) {
        if (selectedGroup.regions.includes(region)) conflicts.add(region);
      }
    }
    return conflicts;
  }, [groups, selectedGroup]);

  const addZipPrefixes = () => {
    if (!selectedGroup) return;
    const entered = zipDraft.prefixes
      .split(/[\s,]+/)
      .map((prefix) => prefix.trim())
      .filter(Boolean);
    if (entered.length === 0) {
      toast({ title: "Enter at least one ZIP prefix", variant: "destructive" });
      return;
    }
    const invalid = entered.filter((prefix) => !/^\d{1,5}$/.test(prefix));
    if (invalid.length > 0) {
      toast({
        title: "ZIP prefixes must contain 1 to 5 digits",
        description: invalid.join(", "),
        variant: "destructive",
      });
      return;
    }
    const existingForState = new Set(
      selectedGroup.zipEntries
        .filter((entry) => entry.state === zipDraft.state)
        .flatMap((entry) => entry.prefixes),
    );
    const fresh = [...new Set(entered)].filter((prefix) => !existingForState.has(prefix));
    if (fresh.length === 0) {
      toast({ title: "Those prefixes are already in this group" });
      return;
    }
    updateGroup(selectedGroup.id, (group) => {
      const existing = group.zipEntries.find((entry) => entry.state === zipDraft.state);
      return {
        ...group,
        zipEntries: existing
          ? group.zipEntries.map((entry) => entry.id === existing.id
              ? { ...entry, prefixes: [...entry.prefixes, ...fresh] }
              : entry)
          : [...group.zipEntries, { id: newId(), state: zipDraft.state, prefixes: fresh }],
      };
    });
    setZipDraft((current) => ({ ...current, prefixes: "" }));
  };

  if (groups.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-10 text-center">
        <MapPin className="mx-auto mb-2 h-8 w-8 text-muted-foreground/60" />
        <p className="text-sm font-medium">No destination groups yet</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          A destination group applies one rate schedule to the US regions you choose, with optional
          ZIP-prefix exceptions. Create separate groups when regions need different prices.
        </p>
        <AddDestinationGroupMenu
          className="mt-4"
          onAdd={addGroup}
          onAddExisting={addExistingGroup}
          existingGroups={availableDestinationGroups}
          selectedDestinationGroupIds={new Set()}
        />
      </div>
    );
  }

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Left: group list */}
      <div className="min-w-0 space-y-2">
        <div className="px-1 pb-1">
          <h3 className="text-sm font-semibold">Destination groups</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            US regions in one group share this option's rate schedule. Put Pennsylvania and
            California in separate groups when their prices differ.
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
        <AddDestinationGroupMenu
          variant="outline"
          className="w-full"
          onAdd={addGroup}
          onAddExisting={addExistingGroup}
          existingGroups={availableDestinationGroups}
          selectedDestinationGroupIds={new Set(
            groups.flatMap((group) =>
              group.destinationGroupId === null
                ? []
                : [group.destinationGroupId]),
          )}
        />
      </div>

      {/* Right: selected group detail */}
      {selectedGroup && (
        <div className="min-w-0 space-y-5 rounded-md border p-4">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-52 flex-1">
              <Label htmlFor={`group-name-${selectedGroup.id}`} className="text-xs text-muted-foreground">
                Group name
              </Label>
              <Input
                id={`group-name-${selectedGroup.id}`}
                value={selectedGroup.name}
                placeholder={groupDisplayName(selectedGroup, groups.indexOf(selectedGroup))}
                onChange={(event) => updateGroup(selectedGroup.id, (group) => ({
                  ...group,
                  name: event.target.value,
                }))}
                className="mt-1 h-9 max-w-sm font-medium"
              />
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
                title="Copy this group's band schedule and warehouse scope into a new group"
                onClick={() => duplicateGroup(selectedGroup)}
              >
                <Copy className="mr-1.5 h-3.5 w-3.5" />
                Duplicate
              </Button>
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

          {selectedGroupIsStale && currentProgramGroup !== null && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-950">
              <div>
                <p className="text-sm font-medium">
                  This draft uses an older version of {currentProgramGroup.name}.
                </p>
                <p className="text-xs text-amber-800">
                  Refresh the destinations before saving this shipping option.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-amber-400 bg-white hover:bg-amber-100"
                onClick={() => updateGroup(selectedGroup.id, (group) =>
                  refreshRateGroupFromProgramGroup(
                    group,
                    currentProgramGroup,
                    pricingBasis,
                  ))}
              >
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Use current destinations
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
                    disabled={warehouseScopeInUse(
                      groups,
                      selectedGroup,
                      null,
                    )}
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

            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Region template</Label>
                <Select
                  value={selectedTemplate?.id ?? "custom"}
                  onValueChange={applyTemplate}
                >
                  <SelectTrigger className="h-9" aria-label="Region template">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="custom" disabled>Custom selection</SelectItem>
                    <SelectGroup>
                      <SelectLabel>Coverage</SelectLabel>
                      {DESTINATION_COVERAGE_TEMPLATES.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name} ({template.regions.length})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Regions</SelectLabel>
                      {DESTINATION_REGION_TEMPLATES.map((template) => (
                        <SelectItem key={template.id} value={template.id}>
                          {template.name} ({template.regions.length})
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Applying a template replaces the selected regions and group name. ZIP overrides are preserved.
                </p>
              </div>

              <div className="space-y-1.5">
                <Label>Destination US regions</Label>
                <RegionMultiSelect
                  selected={selectedGroup.regions}
                  conflicted={conflictedRegions}
                  onChange={(regions) => updateGroup(selectedGroup.id, (group) => ({
                    ...group,
                    regions,
                  }))}
                />
              </div>
              {conflictedRegions.size > 0 && (
                <p className="flex items-start gap-1 text-xs text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {[...conflictedRegions].join(", ")} {conflictedRegions.size === 1 ? "is" : "are"} already
                  priced by another group at this warehouse scope.
                </p>
              )}
            </div>
          </div>

          <SelectedRegionChips
            group={selectedGroup}
            conflicted={conflictedRegions}
            onRemove={(region) => updateGroup(selectedGroup.id, (group) => ({
              ...group,
              regions: group.regions.filter((item) => item !== region),
            }))}
          />

          {selectedGroup.availability === "offered" && (
          <div className="space-y-2 border-t pt-4">
            <div>
              <Label>ZIP-prefix overrides</Label>
              <p className="text-xs text-muted-foreground">
                Charge this group's rates for specific ZIP prefixes. The longest matching prefix
                wins; the region still needs a region-wide rate as fallback.
              </p>
            </div>
            {selectedGroup.zipEntries.length > 0 && (
              <div className="space-y-1.5">
                {selectedGroup.zipEntries.map((entry) => (
                  <div key={entry.id} className="flex flex-wrap items-center gap-1.5 rounded-md border px-2.5 py-1.5">
                    <Badge variant="outline" className="shrink-0">{entry.state}</Badge>
                    {entry.prefixes.map((prefix) => (
                      <Badge key={prefix} variant="secondary" className="gap-1 font-mono text-xs">
                        {prefix}*
                        <button
                          type="button"
                          aria-label={`Remove ${entry.state} prefix ${prefix}`}
                          onClick={() => updateGroup(selectedGroup.id, (group) => ({
                            ...group,
                            zipEntries: group.zipEntries
                              .map((item) => item.id === entry.id
                                ? { ...item, prefixes: item.prefixes.filter((p) => p !== prefix) }
                                : item)
                              .filter((item) => item.prefixes.length > 0),
                          }))}
                          className="rounded-full hover:text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
              <Select
                value={zipDraft.state}
                onValueChange={(state) => setZipDraft((current) => ({ ...current, state }))}
              >
                <SelectTrigger className="h-9" aria-label="US region for ZIP prefixes"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {US_POSTAL_REGIONS.map(([code, name]) => (
                    <SelectItem key={code} value={code}>{code} — {name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={zipDraft.prefixes}
                placeholder="ZIP prefixes, comma-separated (e.g. 160, 161, 162)"
                aria-label="ZIP prefixes to add"
                onChange={(event) => setZipDraft((current) => ({
                  ...current,
                  prefixes: event.target.value,
                }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addZipPrefixes();
                  }
                }}
                className="h-9"
              />
              <Button type="button" variant="outline" className="h-9" onClick={addZipPrefixes}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add
              </Button>
            </div>
          </div>
          )}

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

interface AddDestinationGroupMenuProps {
  onAdd: (template: DestinationGroupTemplate | null) => void;
  onAddExisting: (group: ProgramDestinationGroup) => void;
  existingGroups: ProgramDestinationGroup[];
  selectedDestinationGroupIds: Set<number>;
  variant?: "default" | "outline";
  className?: string;
}

function AddDestinationGroupMenu({
  onAdd,
  onAddExisting,
  existingGroups,
  selectedDestinationGroupIds,
  variant = "default",
  className,
}: AddDestinationGroupMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant={variant} className={className}>
          <Plus className="mr-2 h-4 w-4" />
          Add destination group
          <ChevronDown className="ml-auto h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {existingGroups.length > 0 && (
          <>
            <DropdownMenuLabel>From this pricing program</DropdownMenuLabel>
            {existingGroups.map((group) => (
              <DropdownMenuItem
                key={group.key}
                disabled={
                  group.id !== null
                  && selectedDestinationGroupIds.has(group.id)
                }
                onSelect={() => onAddExisting(group)}
              >
                <span className="flex-1 truncate">{group.name}</span>
                {group.id !== null
                  && selectedDestinationGroupIds.has(group.id)
                  && <Check className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => onAdd(null)}>
          <span className="flex-1">Custom group</span>
          <span className="text-xs text-muted-foreground">No regions</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Coverage</DropdownMenuLabel>
        {DESTINATION_COVERAGE_TEMPLATES.map((template) => (
          <DropdownMenuItem key={template.id} onSelect={() => onAdd(template)}>
            <span className="flex-1">{template.name}</span>
            <span className="text-xs text-muted-foreground">{template.regions.length}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Regional templates</DropdownMenuLabel>
        {DESTINATION_REGION_TEMPLATES.map((template) => (
          <DropdownMenuItem key={template.id} onSelect={() => onAdd(template)}>
            <span className="flex-1">{template.name}</span>
            <span className="text-xs text-muted-foreground">{template.regions.length}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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

// ---------------------------------------------------------------------------
// US-region multi-select (searchable, keyboard-operable, with presets)
// ---------------------------------------------------------------------------

interface RegionMultiSelectProps {
  selected: string[];
  conflicted: Set<string>;
  onChange: (regions: string[]) => void;
}

function RegionMultiSelect({ selected, conflicted, onChange }: RegionMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selected);

  const toggle = (code: string) => {
    onChange(selectedSet.has(code)
      ? selected.filter((item) => item !== code)
      : [...selected, code]);
  };

  const applyPreset = (codes: readonly string[]) => onChange([...codes]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between font-normal"
        >
          {selected.length === 0
            ? <span className="text-muted-foreground">Select US regions…</span>
            : `${selected.length} US region${selected.length === 1 ? "" : "s"} selected`}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="flex flex-wrap gap-1 border-b p-2">
          <Button type="button" size="sm" variant="secondary" className="h-7 text-xs" onClick={() => applyPreset(CONTIGUOUS_US)}>
            Contiguous US
          </Button>
          <Button type="button" size="sm" variant="secondary" className="h-7 text-xs" onClick={() => applyPreset(ALL_US_STATES)}>
            All US states
          </Button>
          <Button type="button" size="sm" variant="secondary" className="h-7 text-xs" onClick={() => applyPreset(ALL_REGION_CODES)}>
            All US regions
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => applyPreset([])}>
            Clear
          </Button>
        </div>
        <Command>
          <CommandInput placeholder="Search US regions…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No US region matches.</CommandEmpty>
            <CommandGroup>
              {US_POSTAL_REGIONS.map(([code, name]) => (
                <CommandItem
                  key={code}
                  value={`${code} ${name}`}
                  onSelect={() => toggle(code)}
                >
                  <span
                    className={cn(
                      "mr-2 flex h-4 w-4 items-center justify-center rounded-sm border border-primary",
                      selectedSet.has(code)
                        ? "bg-primary text-primary-foreground"
                        : "opacity-40 [&_svg]:invisible",
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="flex-1">{name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{code}</span>
                  {conflicted.has(code) && (
                    <AlertTriangle className="ml-1.5 h-3.5 w-3.5 text-amber-600" aria-label="Already in another group" />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Selected-region chips (individual chips for small sets, summary for presets)
// ---------------------------------------------------------------------------

const CHIP_LIMIT = 14;

function rateGroupFromProgramDestinationGroup(
  source: ProgramDestinationGroup,
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
    destinationGroupId: source.id,
    destinationGroupLockVersion: source.lockVersion,
    zipEntries: [...zipByRegion].map(([state, prefixes]) => ({
      id: newId(),
      state,
      prefixes,
    })),
  };
}

function refreshRateGroupFromProgramGroup(
  current: RateGroup,
  source: ProgramDestinationGroup,
  pricingBasis: PricingBasis,
): RateGroup {
  const refreshed = rateGroupFromProgramDestinationGroup(source, pricingBasis);
  return {
    ...current,
    destinationGroupId: refreshed.destinationGroupId,
    destinationGroupLockVersion: refreshed.destinationGroupLockVersion,
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

function SelectedRegionChips({
  group,
  conflicted,
  onRemove,
}: {
  group: RateGroup;
  conflicted: Set<string>;
  onRemove: (region: string) => void;
}) {
  if (group.regions.length === 0) return null;
  if (group.regions.length > CHIP_LIMIT) {
    const conflictedSelected = group.regions.filter((region) => conflicted.has(region));
    return (
      <p className="text-xs text-muted-foreground">
        {groupDisplayName({ ...group, name: "" }, 0)} — {group.regions.length} US regions selected.
        {conflictedSelected.length > 0 && (
          <span className="text-amber-700"> Conflicts: {conflictedSelected.join(", ")}.</span>
        )}
      </p>
    );
  }
  const ordered = [...group.regions].sort();
  return (
    <div className="flex flex-wrap gap-1.5">
      {ordered.map((region) => (
        <Badge
          key={region}
          variant="outline"
          className={cn("gap-1", conflicted.has(region) && "border-amber-500 text-amber-700")}
        >
          {conflicted.has(region) && <AlertTriangle className="h-3 w-3" />}
          {REGION_NAME.get(region) ?? region}
          <button
            type="button"
            aria-label={`Remove ${REGION_NAME.get(region) ?? region}`}
            onClick={() => onRemove(region)}
            className="rounded-full hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
    </div>
  );
}
