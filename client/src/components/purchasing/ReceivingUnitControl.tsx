import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { recordedReceivingFactor, receivingBaseQuantity, receivingUnitDescription, type ReceivingUnitLine } from "@/lib/receiving-units";

export type ReceivingUnitVariant = { id: number; sku: string; name: string; productId: number; unitsPerVariant: number };

export function ReceivingUnitControl({ line, variants, mutable, pending, onChange }: {
  line: ReceivingUnitLine;
  variants: ReceivingUnitVariant[];
  mutable: boolean;
  pending: boolean;
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
    <div className="min-w-0 space-y-2 text-xs" aria-label={`Receive unit for line ${line.id}`}>
      <div className="font-medium">{receivingUnitDescription(line)}</div>
      {current && <div className="text-muted-foreground">{current.sku} — {current.name}</div>}
      {factor !== null && current && current.unitsPerVariant !== factor && (
        <div className="space-y-2 text-amber-700"><p>Catalog factor is now {current.unitsPerVariant}; this receipt records {factor}. Review the difference before posting.</p>{mutable && <Button variant="outline" size="sm" className="h-auto min-h-10 whitespace-normal" disabled={pending || !line.unitVersion} onClick={() => onChange(current.id, false)}>Review and apply current catalog factor ({current.unitsPerVariant} pieces)</Button>}</div>
      )}
      <div className="text-muted-foreground">
        Expected: {baseExpected === null ? "base pieces unknown" : `${baseExpected} pieces`}; received: {baseReceived === null ? "base pieces unknown" : `${baseReceived} pieces`}
        {line.damagedQty > 0 && <>; damaged: {baseDamaged === null ? "base pieces unknown" : `${baseDamaged} pieces`}</>}
      </div>
      {line.inboundShipmentLineId && <div className="text-muted-foreground">Shipment line #{line.inboundShipmentLineId}</div>}
      {mutable && available.length > 0 && (
        <select
          aria-label={`Receive variant for line ${line.id}`}
          className="h-10 w-full max-w-64 rounded border bg-background px-2 text-sm"
          value={legacy ? candidate ?? "" : line.productVariantId ?? ""}
          disabled={pending || legacy && line.productVariantId !== null}
          onChange={(event) => {
            const id = Number(event.target.value);
            if (!id) return;
            if (legacy) setCandidate(id); else onChange(id, false);
          }}
        >
          <option value="">Select a receive variant</option>
          {available.map((variant) => <option key={variant.id} value={variant.id}>{variant.name} ({variant.unitsPerVariant} pieces)</option>)}
        </select>
      )}
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
