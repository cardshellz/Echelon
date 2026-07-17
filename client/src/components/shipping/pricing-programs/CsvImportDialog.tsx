/**
 * CSV import (spec §9): an accelerator, not the primary editor. Uploaded or
 * pasted CSV is parsed server-side, previewed in business units with
 * line-level errors, then converted into destination groups in the visual
 * editor. Aggregate issues (band gaps, missing statewide fallbacks) do not
 * block loading — they surface in the editor where they can be fixed.
 */

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  FREIGHT_CSV_TEMPLATE,
  PARCEL_CSV_TEMPLATE,
  REGION_NAME,
  describeMeasureRange,
  downloadTextFile,
  usdFromCents,
  type PricingBasis,
} from "../rate-table-model";
import { postJson, type CsvParseResponse } from "./api";

const PREVIEW_ROW_LIMIT = 30;

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pricingBasis: PricingBasis;
  editorHasContent: boolean;
  onLoad: (parsed: CsvParseResponse) => void;
}

export function CsvImportDialog({
  open,
  onOpenChange,
  pricingBasis,
  editorHasContent,
  onLoad,
}: CsvImportDialogProps) {
  const { toast } = useToast();
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CsvParseResponse | null>(null);

  const parseMutation = useMutation({
    mutationFn: (text: string) => postJson<CsvParseResponse>(
      "/api/shipping/admin/rate-tables/parse-csv",
      { csv: text },
    ),
    onSuccess: setPreview,
    onError: (error: Error) => {
      toast({ title: "Could not read the CSV", description: error.message, variant: "destructive" });
    },
  });

  const reset = () => {
    setCsv("");
    setPreview(null);
  };

  const handleFile = (file: File) => {
    file.text()
      .then((text) => {
        setCsv(text);
        setPreview(null);
        parseMutation.mutate(text);
      })
      .catch(() => toast({ title: "Could not read the file", variant: "destructive" }));
  };

  const basisMismatch = preview !== null
    && preview.pricingBasis !== null
    && preview.pricingBasis !== pricingBasis;
  const hasLineErrors = (preview?.errors.length ?? 0) > 0;
  const canLoad = preview !== null
    && !hasLineErrors
    && !basisMismatch
    && preview.rows.length > 0;
  const warehouseColumnPresent = /(^|,)\s*origin_warehouse\s*(,|$)/im.test(
    csv.split(/\r\n|\r|\n/, 1)[0] ?? "",
  );
  const aggregateNotices = preview === null
    ? []
    : [...preview.bandErrors, ...preview.geographyErrors];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import rates from CSV</DialogTitle>
          <DialogDescription>
            Valid rows become destination groups in the visual editor — nothing is saved
            until you save the draft. {editorHasContent && "Loading replaces the groups currently in the editor."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => downloadTextFile(
                pricingBasis === "pallet_count"
                  ? "pallet-freight-rates-template.csv"
                  : "parcel-rates-template.csv",
                pricingBasis === "pallet_count" ? FREIGHT_CSV_TEMPLATE : PARCEL_CSV_TEMPLATE,
              )}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Download {pricingBasis === "pallet_count" ? "pallet freight" : "parcel"} template
            </Button>
            <label className="inline-flex">
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) handleFile(file);
                  event.target.value = "";
                }}
              />
              <span className="inline-flex h-8 cursor-pointer items-center rounded-md border bg-background px-3 text-xs font-medium shadow-xs hover:bg-accent">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Upload CSV file
              </span>
            </label>
          </div>

          <Textarea
            rows={7}
            value={csv}
            onChange={(event) => {
              setCsv(event.target.value);
              setPreview(null);
            }}
            className="font-mono text-xs"
            placeholder={pricingBasis === "pallet_count"
              ? "state,zip_prefix,min_pallets,max_pallets,max_total_lb,rate_usd\nPA,,1,1,2500,189.00"
              : "state,zip_prefix,min_lb,max_lb,rate_usd\nPA,,0,1,8.99"}
            aria-label="CSV contents"
          />

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => parseMutation.mutate(csv)}
              disabled={!csv.trim() || parseMutation.isPending}
            >
              {parseMutation.isPending
                ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                : <FileSpreadsheet className="mr-2 h-4 w-4" />}
              Preview
            </Button>
            {preview && !hasLineErrors && (
              <span className="text-sm text-muted-foreground">
                {preview.rows.length.toLocaleString()} row{preview.rows.length === 1 ? "" : "s"} parsed
              </span>
            )}
          </div>

          {warehouseColumnPresent && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
              This file has an <span className="font-mono">origin_warehouse</span> column (from an export).
              Imports load as all-warehouse rates — set warehouse scope per destination group in the
              editor afterward.
            </p>
          )}

          {basisMismatch && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {pricingBasis === "pallet_count"
                ? "This shipping option is priced by pallet count, but the CSV has parcel weight columns. Use the pallet freight template."
                : "This shipping option is priced by shipment weight, but the CSV has pallet columns. Use the parcel template."}
            </p>
          )}

          {hasLineErrors && preview && (
            <div className="max-h-40 overflow-y-auto rounded-md border border-destructive/50 bg-destructive/5 p-3">
              <p className="mb-1 text-xs font-semibold text-destructive">
                Fix these lines and preview again:
              </p>
              <ul className="space-y-0.5 text-xs text-destructive">
                {preview.errors.slice(0, 50).map((error) => (
                  <li key={`${error.line}-${error.message}`}>
                    Line {error.line}: {error.message}
                  </li>
                ))}
                {preview.errors.length > 50 && (
                  <li>…and {preview.errors.length - 50} more.</li>
                )}
              </ul>
            </div>
          )}

          {preview && !hasLineErrors && aggregateNotices.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-md border border-amber-300 bg-amber-50 p-3">
              <p className="mb-1 text-xs font-semibold text-amber-900">
                Loads with open issues you can fix in the editor:
              </p>
              <ul className="space-y-0.5 text-xs text-amber-900">
                {aggregateNotices.slice(0, 20).map((notice) => <li key={notice}>{notice}</li>)}
              </ul>
            </div>
          )}

          {preview && !hasLineErrors && preview.rows.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>State</TableHead>
                    <TableHead>ZIP</TableHead>
                    <TableHead>
                      {preview.pricingBasis === "pallet_count" ? "Pallets" : "Weight"}
                    </TableHead>
                    {preview.pricingBasis === "pallet_count" && <TableHead>Max total</TableHead>}
                    <TableHead className="text-right">Charge</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.slice(0, PREVIEW_ROW_LIMIT).map((row, index) => (
                    <TableRow key={index}>
                      <TableCell className="text-xs">
                        {REGION_NAME.get(row.destinationRegion) ?? row.destinationRegion}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {row.postalPrefix ? `${row.postalPrefix}*` : "Statewide"}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {describeMeasureRange(
                          preview.pricingBasis ?? "shipment_weight",
                          row.minMeasure,
                          row.maxMeasure,
                        )}
                      </TableCell>
                      {preview.pricingBasis === "pallet_count" && (
                        <TableCell className="text-xs text-muted-foreground">
                          {row.maxShipmentWeightGrams === null
                            ? "—"
                            : describeMeasureRange("shipment_weight", 0, row.maxShipmentWeightGrams).replace("0–", "≤ ")}
                        </TableCell>
                      )}
                      <TableCell className="text-right text-xs tabular-nums">
                        {usdFromCents(row.rateCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {preview.rows.length > PREVIEW_ROW_LIMIT && (
                <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
                  Showing first {PREVIEW_ROW_LIMIT} of {preview.rows.length.toLocaleString()} rows.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canLoad}
            onClick={() => {
              if (preview) {
                onLoad(preview);
                reset();
                onOpenChange(false);
              }
            }}
          >
            Load into editor
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
