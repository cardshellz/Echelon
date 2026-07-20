/**
 * Master-detail destination-group workspace (spec §8.2): a compact group
 * list on the left, and the selected group's destinations, warehouse scope,
 * ZIP-prefix overrides, and band matrix on the right. Replaces the old
 * permanently-expanded 50-state checkbox grid.
 */

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Copy,
  MapPin,
  Plus,
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
  ALL_US_STATES,
  CONTIGUOUS_US,
  REGION_NAME,
  US_POSTAL_REGIONS,
  groupDisplayName,
  newGroup,
  newId,
  type PricingBasis,
  type RateGroup,
} from "../rate-table-model";
import type { WarehouseOption } from "./api";
import { RateBandMatrix } from "./RateBandMatrix";

interface DestinationGroupsPanelProps {
  groups: RateGroup[];
  onChange: (groups: RateGroup[]) => void;
  pricingBasis: PricingBasis;
  warehouses: WarehouseOption[];
  selectedGroupId: string | null;
  onSelectGroup: (groupId: string) => void;
  issueMessagesByGroup: Map<string, string[]>;
}

export function DestinationGroupsPanel({
  groups,
  onChange,
  pricingBasis,
  warehouses,
  selectedGroupId,
  onSelectGroup,
  issueMessagesByGroup,
}: DestinationGroupsPanelProps) {
  const { toast } = useToast();
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [zipDraft, setZipDraft] = useState<{ state: string; prefixes: string }>({
    state: "PA",
    prefixes: "",
  });

  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null;

  const updateGroup = (groupId: string, update: (group: RateGroup) => RateGroup) => {
    onChange(groups.map((group) => group.id === groupId ? update(group) : group));
  };

  const addGroup = () => {
    const group = newGroup(pricingBasis, []);
    onChange([...groups, group]);
    onSelectGroup(group.id);
  };

  const duplicateGroup = (source: RateGroup) => {
    // Copies the schedule and warehouse scope; destinations start empty so
    // the copy never instantly conflicts with its source.
    const copy: RateGroup = {
      ...source,
      id: newId(),
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
    || group.bands.some((band) => band.rateUsd.trim() !== "");

  /** Region codes claimed by another group in the same warehouse scope. */
  const conflictedRegions = useMemo(() => {
    if (!selectedGroup) return new Set<string>();
    const conflicts = new Set<string>();
    for (const group of groups) {
      if (group.id === selectedGroup.id) continue;
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
          A destination group applies one set of {pricingBasis === "pallet_count" ? "pallet" : "weight"} bands
          to the states you choose, with optional ZIP-prefix exceptions. Create separate groups
          when states need different prices.
        </p>
        <Button className="mt-4" onClick={addGroup}>
          <Plus className="mr-2 h-4 w-4" />
          Add destination group
        </Button>
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
            States in one group share this option's weight schedule. Put Pennsylvania and
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
                {group.regions.length} state{group.regions.length === 1 ? "" : "s"}
                {group.zipEntries.length > 0 && (
                  <> · {group.zipEntries.reduce((sum, entry) => sum + entry.prefixes.length, 0)} ZIP</>
                )}
                {" · "}
                {group.originWarehouseId === null
                  ? "All warehouses"
                  : warehouses.find((warehouse) => warehouse.id === group.originWarehouseId)?.name
                    ?? `Warehouse ${group.originWarehouseId}`}
              </div>
            </button>
          );
        })}
        <Button variant="outline" className="w-full" onClick={addGroup}>
          <Plus className="mr-2 h-4 w-4" />
          Add destination group
        </Button>
      </div>

      {/* Right: selected group detail */}
      {selectedGroup && (
        <div className="min-w-0 space-y-5 rounded-md border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
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
            <div className="flex items-center gap-1.5 self-end">
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
                disabled={groups.length === 1}
                onClick={() => {
                  if (groupHasContent(selectedGroup)) setConfirmDeleteId(selectedGroup.id);
                  else removeGroup(selectedGroup.id);
                }}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <WarehouseIcon className="h-3.5 w-3.5 text-muted-foreground" />
                Origin warehouse
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
                  <SelectItem value="all">All warehouses</SelectItem>
                  {warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={String(warehouse.id)}>
                      {warehouse.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Warehouse-specific pricing takes precedence over the all-warehouse default.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label>Destination states</Label>
              <StateMultiSelect
                selected={selectedGroup.regions}
                conflicted={conflictedRegions}
                onChange={(regions) => updateGroup(selectedGroup.id, (group) => ({
                  ...group,
                  regions,
                }))}
              />
              {conflictedRegions.size > 0 && (
                <p className="flex items-start gap-1 text-xs text-amber-700">
                  <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                  {[...conflictedRegions].join(", ")} {conflictedRegions.size === 1 ? "is" : "are"} already
                  priced by another group at this warehouse scope.
                </p>
              )}
            </div>
          </div>

          <SelectedStateChips
            group={selectedGroup}
            conflicted={conflictedRegions}
            onRemove={(region) => updateGroup(selectedGroup.id, (group) => ({
              ...group,
              regions: group.regions.filter((item) => item !== region),
            }))}
          />

          <div className="space-y-2 border-t pt-4">
            <div>
              <Label>ZIP-prefix overrides</Label>
              <p className="text-xs text-muted-foreground">
                Charge this group's rates for specific ZIP prefixes. The longest matching prefix
                wins; the state still needs a statewide rate as fallback.
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
                <SelectTrigger className="h-9" aria-label="State for ZIP prefixes"><SelectValue /></SelectTrigger>
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

          <div className="space-y-2 border-t pt-4">
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
                  bands: selectedGroup.bands.map((band) => ({ ...band, id: newId() })),
                }));
                toast({ title: "Bands copied" });
              }}
            />
          </div>
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
              Its states, ZIP overrides, and rates come out of the draft. Nothing changes for
              live quoting until you activate.
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

// ---------------------------------------------------------------------------
// State multi-select (searchable, keyboard-operable, with presets)
// ---------------------------------------------------------------------------

interface StateMultiSelectProps {
  selected: string[];
  conflicted: Set<string>;
  onChange: (regions: string[]) => void;
}

function StateMultiSelect({ selected, conflicted, onChange }: StateMultiSelectProps) {
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
            ? <span className="text-muted-foreground">Select states…</span>
            : `${selected.length} state${selected.length === 1 ? "" : "s"} selected`}
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
            States + territories
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-7 text-xs" onClick={() => applyPreset([])}>
            Clear
          </Button>
        </div>
        <Command>
          <CommandInput placeholder="Search states…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No state matches.</CommandEmpty>
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
// Selected-state chips (individual chips small sets, summary for presets)
// ---------------------------------------------------------------------------

const CHIP_LIMIT = 14;

function SelectedStateChips({
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
        {groupDisplayName({ ...group, name: "" }, 0)} — {group.regions.length} states selected.
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
