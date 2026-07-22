/**
 * Read-only revision detail: any table (active, superseded, retired, or a
 * draft opened for inspection) with coverage, validation state, the full
 * row set, CSV export, and lifecycle actions appropriate to its status.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArrowLeft,
  Download,
  Loader2,
  Pencil,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
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
import { Skeleton } from "@/components/ui/skeleton";
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
  describeMeasureRange,
  downloadTextFile,
  serializeRowsToCsv,
  usdFromCents,
} from "../rate-table-model";
import {
  formatDate,
  getJson,
  invalidateShippingAdmin,
  postJson,
  rateTableDetailKey,
  type RateTableDetail,
} from "./api";
import { revisionStatusBadge } from "./status";

const ROW_DISPLAY_LIMIT = 300;

interface RevisionViewerProps {
  tableId: number;
  onBack: () => void;
  /** Open the editor on a fresh clone of this revision. */
  onCreateRevision: (sourceTableId: number) => void;
  /** Resume the draft in the editor (drafts only). */
  onContinueDraft: (draftId: number) => void;
}

export function RevisionViewer({
  tableId,
  onBack,
  onCreateRevision,
  onContinueDraft,
}: RevisionViewerProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmRetire, setConfirmRetire] = useState(false);

  const { data: detail, isLoading, isError, refetch } = useQuery<RateTableDetail>({
    queryKey: [rateTableDetailKey(tableId)],
    queryFn: () => getJson<RateTableDetail>(rateTableDetailKey(tableId)),
  });

  const retireMutation = useMutation({
    mutationFn: () => postJson(`/api/shipping/admin/rate-tables/${tableId}/retire`, {}),
    onSuccess: () => {
      invalidateShippingAdmin(queryClient);
      setConfirmRetire(false);
      toast({ title: "Revision retired", description: "It no longer serves new quotes." });
    },
    onError: (error: Error) => {
      toast({ title: "Could not retire", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (isError || !detail) {
    return (
      <div className="rounded-md border border-destructive/40 p-8 text-center">
        <p className="text-sm text-destructive">This revision could not be loaded.</p>
        <Button variant="outline" className="mt-3" onClick={() => refetch()}>
          <RefreshCw className="mr-2 h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  const { rateTable, serviceLevel, rateBook, rows, analysis } = detail;
  const isDraft = rateTable.status === "draft";
  const canRetire = rateTable.status === "active" || rateTable.status === "superseded";
  const basis = rateTable.pricingBasis;

  const handleExport = () => {
    downloadTextFile(
      `${rateBook?.code ?? "rates"}-${serviceLevel?.code ?? "option"}-${rateTable.status}.csv`,
      serializeRowsToCsv(rows, basis, new Map(
        rows.flatMap((row) => row.originWarehouseId !== null && row.originWarehouseName !== null
          ? [[row.originWarehouseId, row.originWarehouseName] as [number, string]]
          : []),
      )),
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold">
                {serviceLevel?.displayName ?? "Shipping option"} rates
              </h2>
              {revisionStatusBadge(rateTable.status)}
            </div>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {rateBook?.name ?? "Unassigned program"}
              {" · effective "}
              {formatDate(rateTable.effectiveFrom)}
              {rateTable.effectiveTo ? ` – ${formatDate(rateTable.effectiveTo)}` : " – open"}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={rows.length === 0}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export CSV
          </Button>
          {isDraft ? (
            <Button size="sm" onClick={() => onContinueDraft(rateTable.id)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Continue draft
            </Button>
          ) : (
            <Button size="sm" onClick={() => onCreateRevision(rateTable.id)}>
              <Pencil className="mr-1.5 h-3.5 w-3.5" />
              Create revision
            </Button>
          )}
          {canRetire && (
            <Button variant="outline" size="sm" onClick={() => setConfirmRetire(true)}>
              <Archive className="mr-1.5 h-3.5 w-3.5" />
              Retire
            </Button>
          )}
        </div>
      </div>

      <section className="grid grid-cols-2 gap-4 rounded-md border p-4 sm:grid-cols-4">
        <div>
          <div className="text-xs text-muted-foreground">Rate rows</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">
            {analysis.coverage.rowCount.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">States covered</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">{analysis.coverage.stateCount}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">ZIP overrides</div>
          <div className="mt-0.5 text-base font-semibold tabular-nums">{analysis.coverage.zipOverrideCount}</div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground">
            {basis === "pallet_count" ? "Pallet coverage" : "Weight coverage"}
          </div>
          <div className="mt-0.5 text-base font-semibold">
            {describeMeasureRange(basis, analysis.coverage.minMeasure, analysis.coverage.maxMeasure)}
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-md border">
        <div className="max-h-[480px] overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>State</TableHead>
                <TableHead>ZIP</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>{basis === "pallet_count" ? "Pallets" : "Weight"}</TableHead>
                {basis === "pallet_count" && <TableHead>Max total weight</TableHead>}
                <TableHead className="text-right">Charge</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.slice(0, ROW_DISPLAY_LIMIT).map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs font-medium">{row.destinationRegion}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.postalPrefix ? `${row.postalPrefix}*` : "Statewide"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.originWarehouseName ?? "All warehouses"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {describeMeasureRange(basis, row.minMeasure, row.maxMeasure)}
                  </TableCell>
                  {basis === "pallet_count" && (
                    <TableCell className="text-xs text-muted-foreground">
                      {row.maxShipmentWeightGrams === null
                        ? "—"
                        : `≤ ${describeMeasureRange("shipment_weight", row.maxShipmentWeightGrams, row.maxShipmentWeightGrams).split("–")[0]} lb`}
                    </TableCell>
                  )}
                  <TableCell className="text-right text-xs tabular-nums">
                    {row.chargeModel === "base_plus_per_started_pound"
                      ? `${usdFromCents(row.rateCents)} + ${usdFromCents(row.perStartedPoundCents ?? 0)}/started lb`
                      : usdFromCents(row.rateCents)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        {rows.length > ROW_DISPLAY_LIMIT && (
          <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
            Showing first {ROW_DISPLAY_LIMIT} of {rows.length.toLocaleString()} rows — export the
            CSV for the complete set.
          </p>
        )}
      </section>

      <AlertDialog open={confirmRetire} onOpenChange={setConfirmRetire}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retire this revision?</AlertDialogTitle>
            <AlertDialogDescription>
              {rateTable.status === "active"
                ? `${serviceLevel?.displayName ?? "This option"} stops quoting from this program until another revision is activated.`
                : "The revision stays in history but can no longer be reactivated."}
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
              Retire revision
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
