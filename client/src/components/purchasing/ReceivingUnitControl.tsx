import React, { useEffect, useState } from "react";
import { ReceiveUnitSelect } from "./ReceiveUnitSelect";
import { Button } from "@/components/ui/button";
import { recordedReceivingFactor, receivingBaseQuantity, receivingUnitDescription, type ReceivingUnitLine } from "@/lib/receiving-units";

export type ReceivingUnitVariant = { id: number; sku: string; name: string; productId: number; unitsPerVariant: number };

export function ReceivingUnitControl({ line, variants, mutable, pending, compact = false, onChange }: {
  line: ReceivingUnitLine;
  variants: ReceivingUnitVariant[];
  mutable: boolean;
  pending: boolean;
  compact?: boolean;
  onChange: (variantId: number, confirmLegacyUnit: boolean, expectedUnitsPerVariant?: number) => void;
}) {
  const factor = recordedReceivingFactor(line);
  const [candidate, setCandidate] = useState<number | null>(line.productVariantId);
  useEffect(() => { setCandidate(line.productVariantId); }, [line.id, line.productVariantId, line.unitVersion]);
  const current = variants.find((variant) => variant.id === line.productVariantId);
  const productId = line.productId ?? current?.productId;
  const available = variants.filter((variant) => variant.productId === productId);
  const selected = variants.find((variant) => variant.id === candidate);
  const legacy = factor === null;
  const baseExpected = receivingBaseQuantity(line.expectedQty, factor);
  const baseReceived = receivingBaseQuantity(line.receivedQty, factor);
  const baseDamaged = receivingBaseQuantity(line.damagedQty, factor);

  return (
    <div className={compact ? `${legacy || current && current.unitsPerVariant !== factor ? "col-span-2 " : ""}min-w-0 space-y-2 text-xs [&_select]:min-h-11` : "min-w-0 space-y-2 text-xs"} aria-label={`Receive unit for line ${line.id}`}>
      {!compact && <><div className="font-medium">{receivingUnitDescription(line)}</div>
      {current && <div className="text-muted-foreground">{current.sku} — {current.name}</div>}</>}
      {compact && (!mutable || available.length === 0 || legacy) && <p className="font-medium">{factor === null ? "Confirm pack size" : factor === 1 ? "Count individual pieces" : `Count packs of ${factor.toLocaleString("en-US")} pieces`}</p>}
      {factor !== null && current && current.unitsPerVariant !== factor && (
        <div className="space-y-2 text-amber-700"><p>Catalog factor is now {current.unitsPerVariant}; this receipt records {factor}. Review the difference before posting.</p>{mutable && <Button variant="outline" size="sm" className="h-auto min-h-10 whitespace-normal" disabled={pending || !line.unitVersion} onClick={() => onChange(current.id, false)}>Review and apply current catalog factor ({current.unitsPerVariant} pieces)</Button>}</div>
      )}
      {!compact && <div className="text-muted-foreground">
        Expected: {baseExpected === null ? "base pieces unknown" : `${baseExpected} pieces`}; received: {baseReceived === null ? "base pieces unknown" : `${baseReceived} pieces`}
        {line.damagedQty > 0 && <>; damaged: {baseDamaged === null ? "base pieces unknown" : `${baseDamaged} pieces`}</>}
      </div>}
      {!compact && line.inboundShipmentLineId && <div className="text-muted-foreground">Shipment line #{line.inboundShipmentLineId}</div>}
      {mutable && available.length > 0 && (compact && !legacy ? (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer items-center gap-1 text-primary underline-offset-4 hover:underline" aria-label={`Change receive pack for line ${line.id}`}>{factor === 1 ? "Pieces" : `Pack of ${factor?.toLocaleString("en-US")}`}<span className="text-muted-foreground"> / Change</span></summary>
          <div className="pb-2"><ReceiveUnitSelect label={`Receive variant for line ${line.id}`}
            value={line.productVariantId} options={available} disabled={pending}
            onChange={(id) => { if (id !== null) onChange(id, false); }} /></div>
        </details>
      ) : (
        <ReceiveUnitSelect label={`Receive variant for line ${line.id}`}
          value={legacy ? candidate : line.productVariantId} options={available}
          disabled={pending || legacy && line.productVariantId !== null}
          onChange={(id) => { if (id === null) return; if (legacy) setCandidate(id); else onChange(id, false); }} />
      ))}
      {compact && !mutable && current && <p className="text-muted-foreground">{current.name}</p>}
      {legacy && (
        <div className="rounded border border-amber-400/50 p-2 text-amber-800 dark:text-amber-200">
          <p>The count basis was not recorded. Existing counts remain unchanged until you confirm their unit.</p>
          {mutable && selected && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-auto min-h-10 whitespace-normal text-left"
              disabled={pending || !line.unitVersion}
              onClick={() => onChange(selected.id, true, selected.unitsPerVariant)}
            >
              Confirm these counts are in {selected.name} ({selected.unitsPerVariant} pieces)
            </Button>
          )}
          {!selected && <p className="mt-1">Select the variant that the existing counts describe, or review the source document if their meaning is unknown.</p>}
        </div>
      )}
    </div>
  );
}
