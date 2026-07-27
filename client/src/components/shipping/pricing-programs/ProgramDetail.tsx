import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Calculator,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Eye,
  FilePenLine,
  Globe2,
  Loader2,
  Plus,
  Settings2,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  assignmentLabel,
  countStaleRateTableCoverages,
  formatDate,
  invalidateShippingAdmin,
  postJson,
  rateTableCoveragesForGroup,
  resolveCoverageCellAction,
  type EffectiveRateTableCoverage,
  type ProgramDestinationGroup,
  type ProgramOverview,
  type ProgramOptionState,
  type WarehouseOption,
} from "./api";
import { ProgramFormDialog } from "./ProgramFormDialog";
import { RateTestDialog } from "./RateTestDialog";
import { programStatusBadge, revisionStatusBadge } from "./status";

interface ProgramDetailProps {
  program: ProgramOverview;
  warehouses: WarehouseOption[];
  onBack: () => void;
  onViewTable: (tableId: number) => void;
  onContinueDraft: (
    draftId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onCreateRevision: (
    sourceTableId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onStartRates: (
    serviceLevelCode: string,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
}

export function ProgramDetail({
  program,
  warehouses,
  onBack,
  onViewTable,
  onContinueDraft,
  onCreateRevision,
  onStartRates,
}: ProgramDetailProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);
  const [rateTestOpen, setRateTestOpen] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const { book, options, activeAssignments } = program;
  const retired = book.status === "retired";
  const servesShopifyCheckout = activeAssignments.some(
    (assignment) => assignment.pricingChannel === "shopify"
      && assignment.ratePurpose === "customer_checkout",
  );
  const history = options
    .flatMap((option) => option.history.map((table) => ({ option, table })))
    .sort((left, right) => right.table.id - left.table.id);
  const warehouseScopes = [...new Set(
    activeAssignments.map(
      (assignment) => assignment.originWarehouseName ?? "All warehouses",
    ),
  )];

  const retireMutation = useMutation({
    mutationFn: () =>
      postJson(`/api/shipping/admin/rate-books/${book.id}/retire`, {}),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      setConfirmRetire(false);
      toast({
        title: "Pricing program retired",
        description: "Its channels no longer resolve rates from this program.",
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Could not retire the program",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            aria-label="Back to pricing programs"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{book.name}</h2>
              {programStatusBadge(book.status)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Used by
              </span>
              {activeAssignments.length === 0 ? (
                <span className="flex items-center gap-1 text-xs text-amber-700">
                  <AlertTriangle className="h-3 w-3" />
                  Not assigned. Nothing quotes from this program yet.
                </span>
              ) : (
                activeAssignments.map((assignment) => (
                  <Badge
                    key={assignment.id}
                    variant="outline"
                    className="font-normal"
                  >
                    {assignmentLabel(assignment)}
                  </Badge>
                ))
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Warehouse scope:{" "}
              {warehouseScopes.length === 0
                ? "All warehouses"
                : warehouseScopes.join(", ")}
              {" | Last updated "}
              {formatDate(program.lastTouched)}
            </p>
          </div>
        </div>
        {!retired && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRateTestOpen(true)}
              disabled={activeAssignments.length === 0 || warehouses.length === 0}
            >
              <Calculator className="mr-1.5 h-3.5 w-3.5" />
              Test live rates
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Name and assignments
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmRetire(true)}
            >
              <Archive className="mr-1.5 h-3.5 w-3.5" />
              Retire
            </Button>
          </div>
        )}
      </div>

      {servesShopifyCheckout && (
        <section className="space-y-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Globe2 className="h-4 w-4" />
              Shopify destination ownership
            </h3>
            <p className="text-xs text-muted-foreground">
              Each destination has one rate owner. Echelon prices configured US
              coverage; Shopify and Global-e retain international ownership.
            </p>
          </div>
          <div className="grid overflow-hidden rounded-md border sm:grid-cols-2 sm:divide-x">
            <div className="p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">United States</span>
                <Badge
                  variant="outline"
                  className="border-emerald-300 bg-emerald-50 text-emerald-800"
                >
                  Echelon rates
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                The matrix below controls US availability and price coverage.
              </p>
            </div>
            <div className="border-t p-3 sm:border-t-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">International</span>
                <Badge variant="outline">Shopify / Global-e</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Echelon returns no competing international rate.
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold">Coverage and rates</h3>
            <p className="text-xs text-muted-foreground">
              Destination groups define where. Each shipping-option cell records
              priced, intentionally unavailable, or unconfigured coverage.
            </p>
          </div>
          {!retired && program.destinationGroups.length > 0 && (
            <AddDestinationGroupButton
              options={options}
              onContinueDraft={onContinueDraft}
              onCreateRevision={onCreateRevision}
              onStartRates={onStartRates}
            />
          )}
        </div>

        {program.destinationGroups.length === 0 ? (
          <div className="rounded-md border border-dashed p-8 text-center">
            <Globe2 className="mx-auto h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 text-sm font-medium">No destination groups yet</p>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
              Create the first group, choose its US regions, and decide whether
              the selected shipping option is offered there.
            </p>
            {!retired && (
              <AddDestinationGroupButton
                className="mt-4"
                options={options}
                onContinueDraft={onContinueDraft}
                onCreateRevision={onCreateRevision}
                onStartRates={onStartRates}
              />
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-52">Destination group</TableHead>
                  {options.map((option) => (
                    <TableHead
                      key={option.serviceLevel.id}
                      className="min-w-48"
                    >
                      <div>{option.serviceLevel.displayName}</div>
                      <div className="mt-0.5 text-[11px] font-normal text-muted-foreground">
                        {option.serviceLevel.fulfillmentMode === "freight"
                          ? "Pallet count"
                          : "Shipment weight"}
                        {!option.serviceLevel.isActive && " | Future"}
                      </div>
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {program.destinationGroups.map((group) => (
                  <TableRow key={group.key}>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="text-sm font-medium">{group.name}</div>
                        {!group.hasCurrentDefinition && (
                          <Badge variant="outline" className="font-normal">
                            {revisionOnlyLabel(group)}
                          </Badge>
                        )}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {destinationGroupSummary(group)}
                      </div>
                    </TableCell>
                    {options.map((option) => (
                      <TableCell
                        key={option.serviceLevel.id}
                        className="align-top"
                      >
                        <CoverageCell
                          group={group}
                          option={option}
                          warehouses={warehouses}
                          programRetired={retired}
                          onViewTable={onViewTable}
                          onContinueDraft={onContinueDraft}
                          onCreateRevision={onCreateRevision}
                          onStartRates={onStartRates}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 text-muted-foreground"
          >
            {historyOpen
              ? <ChevronDown className="mr-1 h-4 w-4" />
              : <ChevronRight className="mr-1 h-4 w-4" />}
            Revision history ({history.length})
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {history.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No revisions yet.
            </p>
          ) : (
            <div className="mt-1 overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shipping option</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="w-20">
                      <span className="sr-only">Open</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map(({ option, table }) => (
                    <TableRow
                      key={table.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onViewTable(table.id)}
                    >
                      <TableCell className="text-sm">
                        {option.serviceLevel.displayName}
                      </TableCell>
                      <TableCell>
                        {revisionStatusBadge(table.status)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(table.effectiveFrom)}
                        {" to "}
                        {table.effectiveTo
                          ? formatDate(table.effectiveTo)
                          : "open"}
                      </TableCell>
                      <TableCell className="text-right text-sm tabular-nums">
                        {table.rowCount.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Eye className="ml-auto h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>

      <ProgramFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        warehouses={warehouses}
        program={book}
        onSaved={() => undefined}
      />
      <RateTestDialog
        open={rateTestOpen}
        onOpenChange={setRateTestOpen}
        program={program}
        warehouses={warehouses}
      />

      <AlertDialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire {book.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {activeAssignments.length > 0
                ? `${activeAssignments.map(assignmentLabel).join("; ")} will stop resolving shipping rates immediately.`
                : "The program and its revisions become read-only history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retireMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => retireMutation.mutate()}
              disabled={retireMutation.isPending}
            >
              {retireMutation.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Retire program
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CoverageCell({
  group,
  option,
  warehouses,
  programRetired,
  onViewTable,
  onContinueDraft,
  onCreateRevision,
  onStartRates,
}: {
  group: ProgramDestinationGroup;
  option: ProgramOptionState;
  warehouses: WarehouseOption[];
  programRetired: boolean;
  onViewTable: (tableId: number) => void;
  onContinueDraft: (
    draftId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onCreateRevision: (
    sourceTableId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onStartRates: (
    serviceLevelCode: string,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
}) {
  const activeCoverages = rateTableCoveragesForGroup(option.active, group);
  const draftCoverages = rateTableCoveragesForGroup(option.draft, group);
  const staleActiveCoverageCount = countStaleRateTableCoverages(
    activeCoverages,
    group,
  );
  const staleDraftCoverageCount = countStaleRateTableCoverages(
    draftCoverages,
    group,
  );

  if (!option.serviceLevel.isActive) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
        Future option
      </div>
    );
  }

  const action = resolveCoverageCellAction({
    group,
    activeTableId: option.active?.id ?? null,
    draftTableId: option.draft?.id ?? null,
    hasActiveCoverage: activeCoverages.length > 0,
    hasDraftCoverage: draftCoverages.length > 0,
  });
  const openCoverage = () => {
    switch (action.kind) {
      case "continue_draft":
        onContinueDraft(action.tableId, group);
        return;
      case "create_revision":
        onCreateRevision(action.tableId, group);
        return;
      case "start_rates":
        onStartRates(option.serviceLevel.code, group);
        return;
      case "view_revision":
        onViewTable(action.tableId);
        return;
      case "none":
        return;
    }
  };

  let state: CoverageState;
  if (!group.hasCurrentDefinition) {
    state = {
      icon: Eye,
      label: draftCoverages.length > 0
        ? "Draft revision only"
        : "Live revision only",
      detail: "View read-only revision",
      tone: "neutral",
    };
  } else if (staleDraftCoverageCount > 0) {
    state = {
      icon: AlertTriangle,
      label: "Draft uses old group",
      detail: staleCoverageDetail(staleDraftCoverageCount),
      tone: "warning",
    };
  } else if (draftCoverages.length > 0) {
    state = draftCoverageState(
      draftCoverages,
      activeCoverages.length > 0,
      warehouses,
    );
  } else if (staleActiveCoverageCount > 0) {
    state = {
      icon: AlertTriangle,
      label: "Coverage changed",
      detail: staleCoverageDetail(staleActiveCoverageCount),
      tone: "warning",
    };
  } else if (activeCoverages.length > 0) {
    state = activeCoverageState(activeCoverages, warehouses);
  } else {
    state = {
      icon: Plus,
      label: "Not configured",
      detail: programRetired ? "Read only" : "Choose offered or not offered",
      tone: "unconfigured",
    };
  }

  return (
    <div className="space-y-1">
      <CoverageAction
        disabled={
          action.kind === "none" || (programRetired && group.hasCurrentDefinition)
        }
        onClick={openCoverage}
        {...state}
      />
      {group.hasCurrentDefinition
        && option.active
        && activeCoverages.length > 0 && (
        <button
          type="button"
          onClick={() => onViewTable(option.active!.id)}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <Eye className="h-3 w-3" />
          View live revision
        </button>
      )}
    </div>
  );
}

interface CoverageState {
  icon: LucideIcon;
  label: string;
  detail: string;
  tone: "active" | "draft" | "warning" | "neutral" | "unconfigured";
}

function CoverageAction({
  disabled,
  onClick,
  icon: Icon,
  label,
  detail,
  tone,
}: CoverageState & {
  disabled: boolean;
  onClick: () => void;
}) {
  const toneClasses = {
    active: "border-emerald-300 bg-emerald-50 text-emerald-900",
    draft: "border-amber-300 bg-amber-50 text-amber-900",
    warning: "border-red-300 bg-red-50 text-red-900",
    neutral: "border-slate-300 bg-slate-50 text-slate-800",
    unconfigured: "border-dashed text-muted-foreground",
  }[tone];
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${toneClasses} disabled:cursor-default disabled:opacity-70`}
    >
      <span className="flex items-center gap-1.5 text-xs font-medium">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className="mt-0.5 block text-[11px] opacity-75">{detail}</span>
    </button>
  );
}

function AddDestinationGroupButton({
  options,
  onContinueDraft,
  onCreateRevision,
  onStartRates,
  className,
}: {
  options: ProgramOptionState[];
  onContinueDraft: (
    draftId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onCreateRevision: (
    sourceTableId: number,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  onStartRates: (
    serviceLevelCode: string,
    destinationGroup?: ProgramDestinationGroup,
  ) => void;
  className?: string;
}) {
  const option = options.find((item) => item.serviceLevel.isActive) ?? null;
  if (option === null) return null;
  const open = () => {
    if (option.draft) onContinueDraft(option.draft.id);
    else if (option.active) onCreateRevision(option.active.id);
    else onStartRates(option.serviceLevel.code);
  };
  return (
    <Button variant="outline" size="sm" className={className} onClick={open}>
      <Plus className="mr-1.5 h-3.5 w-3.5" />
      Add destination group
    </Button>
  );
}

function revisionOnlyLabel(group: ProgramDestinationGroup): string {
  if (group.appearsInLiveRevision && group.appearsInDraftRevision) {
    return "Revision only";
  }
  if (group.appearsInLiveRevision) return "Live revision only";
  return "Draft revision only";
}

function draftCoverageState(
  coverages: readonly EffectiveRateTableCoverage[],
  hasActiveCoverage: boolean,
  warehouses: readonly WarehouseOption[],
): CoverageState {
  const offered = coverages.filter(
    (coverage) => coverage.availability === "offered",
  );
  const missingRates = offered.filter(
    (coverage) => coverage.rateRowCount === 0,
  );
  if (missingRates.length > 0) {
    return {
      icon: AlertTriangle,
      label: "Rates required",
      detail: `${scopeCountLabel(missingRates.length)} need rates`,
      tone: "warning",
    };
  }
  if (offered.length === 0) {
    return {
      icon: CircleOff,
      label: "Draft: not offered",
      detail: coverageScopeSummary(coverages, warehouses),
      tone: "neutral",
    };
  }
  return {
    icon: FilePenLine,
    label: offered.length === coverages.length
      ? "Draft rates"
      : "Draft coverage",
    detail: hasActiveCoverage
      ? `${coverageScopeSummary(coverages, warehouses)} | Active remains live`
      : coverageScopeSummary(coverages, warehouses),
    tone: "draft",
  };
}

function activeCoverageState(
  coverages: readonly EffectiveRateTableCoverage[],
  warehouses: readonly WarehouseOption[],
): CoverageState {
  const offered = coverages.filter(
    (coverage) => coverage.availability === "offered",
  );
  const missingRates = offered.filter(
    (coverage) => coverage.rateRowCount === 0,
  );
  if (missingRates.length > 0) {
    return {
      icon: AlertTriangle,
      label: "Active rates missing",
      detail: `${scopeCountLabel(missingRates.length)} have no rate rows`,
      tone: "warning",
    };
  }
  if (offered.length === 0) {
    return {
      icon: CircleOff,
      label: "Not offered",
      detail: coverageScopeSummary(coverages, warehouses),
      tone: "neutral",
    };
  }
  const rowCount = offered.reduce(
    (total, coverage) => total + coverage.rateRowCount,
    0,
  );
  return {
    icon: CheckCircle2,
    label: offered.length === coverages.length
      ? "Active rates"
      : "Active coverage",
    detail: [
      coverageScopeSummary(coverages, warehouses),
      `${rowCount.toLocaleString()} rate rows`,
    ].join(" | "),
    tone: "active",
  };
}

function coverageScopeSummary(
  coverages: readonly EffectiveRateTableCoverage[],
  warehouses: readonly WarehouseOption[],
): string {
  if (coverages.length !== 1) return scopeCountLabel(coverages.length);
  const [coverage] = coverages;
  if (coverage.originWarehouseId === null) return "All warehouses";
  return warehouses.find(
    (warehouse) => warehouse.id === coverage.originWarehouseId,
  )?.name ?? `Warehouse ${coverage.originWarehouseId}`;
}

function scopeCountLabel(count: number): string {
  return `${count} warehouse scope${count === 1 ? "" : "s"}`;
}

function staleCoverageDetail(count: number): string {
  return `${scopeCountLabel(count)} use previous destinations`;
}

function destinationGroupSummary(group: ProgramDestinationGroup): string {
  const regionWide = group.destinations
    .filter((destination) => destination.postalPrefix === null)
    .map((destination) => destination.destinationRegion)
    .filter((region): region is string => region !== null)
    .sort();
  const zipCount = group.destinations.filter(
    (destination) => destination.postalPrefix !== null,
  ).length;
  const regionLabel = regionWide.length === 0
    ? "No region-wide destinations"
    : regionWide.length <= 4
      ? regionWide.join(", ")
      : `${regionWide.slice(0, 4).join(", ")} + ${regionWide.length - 4} more`;
  return zipCount === 0 ? regionLabel : `${regionLabel} | ${zipCount} ZIP`;
}
