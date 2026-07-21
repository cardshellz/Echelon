/**
 * Pricing-program detail (spec §7.2): where the program is used, which
 * shipping options have live rates or drafts in progress, what needs
 * attention, and the revision history — all without opening a modal.
 */

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Calculator,
  ChevronDown,
  ChevronRight,
  Eye,
  Globe2,
  Loader2,
  Pencil,
  Plus,
  Settings2,
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
import { describeMeasureRange } from "../rate-table-model";
import {
  assignmentLabel,
  formatDate,
  invalidateShippingAdmin,
  postJson,
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
  onContinueDraft: (draftId: number) => void;
  onCreateRevision: (sourceTableId: number) => void;
  onStartRates: (serviceLevelCode: string) => void;
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

  const retireMutation = useMutation({
    mutationFn: () => postJson(`/api/shipping/admin/rate-books/${book.id}/retire`, {}),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      setConfirmRetire(false);
      toast({
        title: "Pricing program retired",
        description: "Its channels no longer resolve rates from this program.",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Could not retire the program", description: error.message, variant: "destructive" });
    },
  });

  const history = options
    .flatMap((option) => option.history.map((table) => ({ option, table })))
    .sort((a, b) => b.table.id - a.table.id);

  const warehouseScopes = [...new Set(
    activeAssignments.map((assignment) => assignment.originWarehouseName ?? "All warehouses"),
  )];

  return (
    <div className="space-y-5">
      {/* Program summary */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to pricing programs">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">{book.name}</h2>
              {programStatusBadge(book.status)}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Used by</span>
              {activeAssignments.length === 0 ? (
                <span className="flex items-center gap-1 text-xs text-amber-700">
                  <AlertTriangle className="h-3 w-3" />
                  Not assigned — nothing quotes from this program yet
                </span>
              ) : (
                activeAssignments.map((assignment) => (
                  <Badge key={assignment.id} variant="outline" className="font-normal">
                    {assignmentLabel(assignment)}
                  </Badge>
                ))
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Warehouse scope: {warehouseScopes.length === 0 ? "All warehouses" : warehouseScopes.join(", ")}
              {" · Last updated "}
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
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              <Settings2 className="mr-1.5 h-3.5 w-3.5" />
              Manage assignments
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
              Each destination has one rate owner, so Shopify availability never depends on a duplicate Echelon country list.
            </p>
          </div>
          <div className="grid overflow-hidden rounded-md border sm:grid-cols-2 sm:divide-x">
            <div className="p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">United States</span>
                <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-800">
                  Echelon rates
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Active state, ZIP, warehouse, and weight rules in this program determine checkout prices.
              </p>
            </div>
            <div className="border-t p-3 sm:border-t-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">International</span>
                <Badge variant="outline">Shopify / Global-e</Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Echelon returns no competing rate and does not maintain an international allowlist.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Shipping options */}
      <section className="space-y-2">
        <div>
          <h3 className="text-sm font-semibold">Shipping options</h3>
          <p className="text-xs text-muted-foreground">
            Each option owns its destination groups and weight bands inside this program.
            Future options remain visible but cannot be priced until their fulfillment methods are mapped.
          </p>
        </div>
        <div className="overflow-hidden rounded-md border">
          <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Shipping option</TableHead>
              <TableHead>Pricing basis</TableHead>
              <TableHead>Live revision</TableHead>
              <TableHead>Coverage</TableHead>
              <TableHead>Draft</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {options.map((option) => (
              <OptionRow
                key={option.serviceLevel.id}
                option={option}
                programRetired={retired}
                onViewTable={onViewTable}
                onContinueDraft={onContinueDraft}
                onCreateRevision={onCreateRevision}
                onStartRates={onStartRates}
              />
            ))}
          </TableBody>
          </Table>
        </div>
      </section>

      {/* Revision history */}
      <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
            {historyOpen ? <ChevronDown className="mr-1 h-4 w-4" /> : <ChevronRight className="mr-1 h-4 w-4" />}
            Revision history ({history.length})
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          {history.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">No revisions yet.</p>
          ) : (
            <div className="mt-1 overflow-hidden rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shipping option</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Effective</TableHead>
                    <TableHead className="text-right">Rows</TableHead>
                    <TableHead className="w-20"><span className="sr-only">Open</span></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map(({ option, table }) => (
                    <TableRow
                      key={table.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => onViewTable(table.id)}
                    >
                      <TableCell className="text-sm">{option.serviceLevel.displayName}</TableCell>
                      <TableCell>{revisionStatusBadge(table.status)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(table.effectiveFrom)}
                        {" – "}
                        {table.effectiveTo ? formatDate(table.effectiveTo) : "open"}
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
                ? `${activeAssignments.map(assignmentLabel).join("; ")} will stop resolving shipping rates immediately — those flows return no quotes until another program takes the scope.`
                : "The program and its revisions become read-only history."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={retireMutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => retireMutation.mutate()}
              disabled={retireMutation.isPending}
            >
              {retireMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Retire program
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function OptionRow({
  option,
  programRetired,
  onViewTable,
  onContinueDraft,
  onCreateRevision,
  onStartRates,
}: {
  option: ProgramOptionState;
  programRetired: boolean;
  onViewTable: (tableId: number) => void;
  onContinueDraft: (draftId: number) => void;
  onCreateRevision: (sourceTableId: number) => void;
  onStartRates: (serviceLevelCode: string) => void;
}) {
  const { serviceLevel, active, draft } = option;
  const configurable = serviceLevel.isActive;
  return (
    <TableRow className={!configurable ? "bg-muted/20" : undefined}>
      <TableCell>
        <div className="text-sm font-medium">{serviceLevel.displayName}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Badge variant="outline" className="px-1 py-0 text-[10px] uppercase">
            {serviceLevel.fulfillmentMode === "freight" ? "Freight" : "Parcel"}
          </Badge>
          {serviceLevel.promiseMinBusinessDays !== null && serviceLevel.promiseMaxBusinessDays !== null && (
            <span>
              {serviceLevel.promiseMinBusinessDays === serviceLevel.promiseMaxBusinessDays
                ? `${serviceLevel.promiseMinBusinessDays} business day${serviceLevel.promiseMinBusinessDays === 1 ? "" : "s"}`
                : `${serviceLevel.promiseMinBusinessDays}–${serviceLevel.promiseMaxBusinessDays} business days`}
            </span>
          )}
          {!configurable && (
            <Badge variant="secondary" className="px-1 py-0 text-[10px]">Future</Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {serviceLevel.fulfillmentMode === "freight" ? "Pallet count" : "Shipment weight"}
      </TableCell>
      <TableCell>
        {active ? (
          <button
            type="button"
            onClick={() => onViewTable(active.id)}
            className="text-left text-xs hover:underline"
          >
            <span className="font-medium text-foreground">
              Active since {formatDate(active.effectiveFrom)}
            </span>
          </button>
        ) : (
          <span className="text-xs text-muted-foreground">
            {configurable ? "No live rates" : "Available after method mapping"}
          </span>
        )}
      </TableCell>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        {active
          ? `${active.stateCount} states · ${active.zipOverrideCount} ZIP · ${describeMeasureRange(active.pricingBasis, active.minMeasure, active.maxMeasure)}`
          : "—"}
      </TableCell>
      <TableCell>
        {draft ? (
          configurable ? (
            <button
              type="button"
              onClick={() => onContinueDraft(draft.id)}
              className="text-left text-xs text-amber-700 hover:underline"
            >
              In progress · {draft.rowCount.toLocaleString()} rows
            </button>
          ) : (
            <span className="text-xs text-muted-foreground">
              Preserved · available after method mapping
            </span>
          )
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex justify-end gap-1.5">
          {active && (
            <Button variant="ghost" size="sm" onClick={() => onViewTable(active.id)}>
              <Eye className="mr-1 h-3.5 w-3.5" />
              View
            </Button>
          )}
          {!programRetired && !configurable && !active && (
            <Badge variant="secondary" className="font-normal">Future feature</Badge>
          )}
          {!programRetired && configurable && (draft ? (
            <Button size="sm" variant="outline" onClick={() => onContinueDraft(draft.id)}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Continue draft
            </Button>
          ) : active ? (
            <Button size="sm" variant="outline" onClick={() => onCreateRevision(active.id)}>
              <Pencil className="mr-1 h-3.5 w-3.5" />
              Create revision
            </Button>
          ) : (
            <Button size="sm" onClick={() => onStartRates(serviceLevel.code)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Set up rates
            </Button>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}
