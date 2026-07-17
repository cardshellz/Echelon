/**
 * Spreadsheet-like band editor. Lower bounds derive from the previous row
 * and stay read-only; operators type upper bounds and charges in pounds,
 * pallets, and dollars. Supports arrow/Enter navigation and pasting a
 * column or block of values across consecutive cells.
 */

import { useRef } from "react";
import { Copy, Info, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  describeBandLowerBound,
  newId,
  type BuilderBand,
  type PricingBasis,
} from "../rate-table-model";

interface CopyTarget {
  id: string;
  label: string;
}

interface RateBandMatrixProps {
  pricingBasis: PricingBasis;
  bands: BuilderBand[];
  onChange: (bands: BuilderBand[]) => void;
  copyTargets: CopyTarget[];
  onCopyTo: (targetGroupId: string) => void;
  readOnly?: boolean;
}

type EditableField = "maxMeasure" | "maxShipmentWeightLb" | "rateUsd";

export function RateBandMatrix({
  pricingBasis,
  bands,
  onChange,
  copyTargets,
  onCopyTo,
  readOnly = false,
}: RateBandMatrixProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isFreight = pricingBasis === "pallet_count";
  const columns: EditableField[] = isFreight
    ? ["maxMeasure", "maxShipmentWeightLb", "rateUsd"]
    : ["maxMeasure", "rateUsd"];

  const updateBand = (bandId: string, field: EditableField, value: string) => {
    onChange(bands.map((band) => band.id === bandId ? { ...band, [field]: value } : band));
  };

  const addBand = () => {
    onChange([...bands, { id: newId(), maxMeasure: "", rateUsd: "", maxShipmentWeightLb: "" }]);
  };

  const removeBand = (bandId: string) => {
    onChange(bands.filter((band) => band.id !== bandId));
  };

  const focusCell = (rowIndex: number, field: EditableField) => {
    const cell = containerRef.current?.querySelector<HTMLInputElement>(
      `input[data-row="${rowIndex}"][data-field="${field}"]`,
    );
    cell?.focus();
    cell?.select();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    field: EditableField,
  ) => {
    if (event.key === "ArrowDown" || event.key === "Enter") {
      event.preventDefault();
      if (rowIndex + 1 < bands.length) {
        focusCell(rowIndex + 1, field);
      } else if (event.key === "Enter" && !readOnly) {
        addBand();
        // Focus lands after React commits the new row.
        requestAnimationFrame(() => focusCell(rowIndex + 1, field));
      }
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (rowIndex > 0) focusCell(rowIndex - 1, field);
    }
  };

  /**
   * Paste a spreadsheet block starting at the focused cell: lines fill rows
   * downward (appending new bands as needed); tab/comma-separated cells fill
   * the editable columns rightward from the paste origin.
   */
  const handlePaste = (
    event: React.ClipboardEvent<HTMLInputElement>,
    rowIndex: number,
    field: EditableField,
  ) => {
    if (readOnly) return;
    const text = event.clipboardData.getData("text");
    if (!text.includes("\n") && !text.includes("\t") && !text.includes(",")) return;
    event.preventDefault();
    const lines = text
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) return;

    const startColumn = columns.indexOf(field);
    const next = [...bands];
    lines.forEach((line, lineOffset) => {
      const targetIndex = rowIndex + lineOffset;
      while (targetIndex >= next.length) {
        next.push({ id: newId(), maxMeasure: "", rateUsd: "", maxShipmentWeightLb: "" });
      }
      const cells = line.split(/\t|,/).map((cell) => cell.trim().replace(/^\$/, ""));
      cells.forEach((cell, cellOffset) => {
        const column = columns[startColumn + cellOffset];
        if (!column) return;
        next[targetIndex] = { ...next[targetIndex], [column]: cell };
      });
    });
    onChange(next);
  };

  const unitLabel = isFreight ? "pallets" : "lb";

  return (
    <div ref={containerRef}>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
              <th className="w-32 px-3 py-2 font-medium">From</th>
              <th className="px-3 py-2 font-medium">Through ({unitLabel})</th>
              {isFreight && (
                <th className="px-3 py-2 font-medium">
                  <span className="inline-flex items-center gap-1">
                    Max total weight (lb)
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 cursor-help" aria-label="About the weight ceiling" />
                        </TooltipTrigger>
                        <TooltipContent className="max-w-64">
                          Optional ceiling: this band applies only when both the pallet count
                          and the total shipment weight fit.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </span>
                </th>
              )}
              <th className="w-36 px-3 py-2 font-medium">Charge</th>
              {!readOnly && <th className="w-10 px-1 py-2"><span className="sr-only">Row actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {bands.map((band, index) => (
              <tr key={band.id} className="border-b last:border-b-0">
                <td className="whitespace-nowrap px-3 py-1.5 text-muted-foreground tabular-nums">
                  {describeBandLowerBound(pricingBasis, bands, index)}
                </td>
                <td className="px-2 py-1.5">
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={isFreight ? 1 : 0}
                    step={isFreight ? 1 : 0.1}
                    value={band.maxMeasure}
                    disabled={readOnly}
                    data-row={index}
                    data-field="maxMeasure"
                    aria-label={`Band ${index + 1} upper limit in ${unitLabel}`}
                    onChange={(event) => updateBand(band.id, "maxMeasure", event.target.value)}
                    onKeyDown={(event) => handleKeyDown(event, index, "maxMeasure")}
                    onPaste={(event) => handlePaste(event, index, "maxMeasure")}
                    className="h-8 min-w-20 tabular-nums"
                  />
                </td>
                {isFreight && (
                  <td className="px-2 py-1.5">
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={1}
                      placeholder="No ceiling"
                      value={band.maxShipmentWeightLb}
                      disabled={readOnly}
                      data-row={index}
                      data-field="maxShipmentWeightLb"
                      aria-label={`Band ${index + 1} maximum total shipment weight in pounds`}
                      onChange={(event) => updateBand(band.id, "maxShipmentWeightLb", event.target.value)}
                      onKeyDown={(event) => handleKeyDown(event, index, "maxShipmentWeightLb")}
                      onPaste={(event) => handlePaste(event, index, "maxShipmentWeightLb")}
                      className="h-8 min-w-24 tabular-nums"
                    />
                  </td>
                )}
                <td className="px-2 py-1.5">
                  <div className="relative">
                    <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-muted-foreground">
                      $
                    </span>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step={0.01}
                      value={band.rateUsd}
                      disabled={readOnly}
                      data-row={index}
                      data-field="rateUsd"
                      aria-label={`Band ${index + 1} charge in US dollars`}
                      onChange={(event) => updateBand(band.id, "rateUsd", event.target.value)}
                      onKeyDown={(event) => handleKeyDown(event, index, "rateUsd")}
                      onPaste={(event) => handlePaste(event, index, "rateUsd")}
                      className="h-8 min-w-24 pl-6 tabular-nums"
                    />
                  </div>
                </td>
                {!readOnly && (
                  <td className="px-1 py-1.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={cn("h-8 w-8", bands.length === 1 && "invisible")}
                      aria-label={`Delete band ${index + 1}`}
                      onClick={() => removeBand(band.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {isFreight
            ? "Shipments above the last pallet band do not match this option."
            : "Shipments heavier than the last band do not match this option."}
        </p>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {copyTargets.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="outline" size="sm">
                    <Copy className="mr-1.5 h-3.5 w-3.5" />
                    Copy bands to…
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Replace bands in</DropdownMenuLabel>
                  {copyTargets.map((target) => (
                    <DropdownMenuItem key={target.id} onSelect={() => onCopyTo(target.id)}>
                      {target.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button type="button" variant="outline" size="sm" onClick={addBand}>
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add band
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
