import React, { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { ReceivingConfigurationForm } from "@/features/catalog/ReceivingConfigurationForm";
import { reviewReceivingConfiguration } from "@shared/procurement/receiving-configuration";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ReceiveUnitSelect } from "@/components/purchasing/ReceiveUnitSelect";
import { selectShipmentQuantityUnit, shipmentQuantityPreview, type ShipmentQuantityDraft } from "@/lib/shipment-unit-entry";
import type { ShipmentUnits } from "@shared/procurement/shipment-unit-selection";

export function ShipmentQuantityControl({ id, value, units, disabled, maximumPieces, quantityLabel, purpose = "shipment", onChange, onUnitsChange, onRefreshUnits, productName, draftAllowed = true }: {
  id: string;
  value: ShipmentQuantityDraft;
  units: ShipmentUnits | null;
  disabled?: boolean;
  maximumPieces?: number;
  quantityLabel?: string;
  purpose?: "shipment" | "supplier-return";
  onChange: (value: ShipmentQuantityDraft) => void;
  onUnitsChange?: (units: ShipmentUnits) => void;
  productName?: string;
  draftAllowed?: boolean;
  onRefreshUnits?: () => Promise<void>;
}) {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshSourceQueries = () => queryClient.invalidateQueries({ predicate: query => typeof query.queryKey[0] === "string"
    && /^\/api\/(?:purchase-orders|inbound-shipments|shipment-lines)(?:\/|\?|$)/.test(query.queryKey[0]) }, { throwOnError: true });
  async function refreshConfigurations() {
    setRefreshing(true); setRefreshError(null);
    try {
      if (onRefreshUnits) await onRefreshUnits();
      else await refreshSourceQueries();
    } catch (error) { setRefreshError(error instanceof Error ? error.message : "Configurations could not be refreshed. Try again."); }
    finally { setRefreshing(false); }
  }
  const preview = shipmentQuantityPreview(value, units, maximumPieces);
  const selected = units?.variants.find((variant) => variant.id === value.variantId);
  const pieceVariant = units?.variants.filter((variant) => variant.unitsPerVariant === 1).sort((a, b) => a.id - b.id)[0];
  const options = (units?.variants ?? []).filter((variant) => variant.unitsPerVariant !== 1 || variant.id === pieceVariant?.id)
    .map((variant) => variant.id === pieceVariant?.id ? { ...variant, name: "Pieces" } : variant);
  const setup = preview.pieces === null ? null : reviewReceivingConfiguration({ pieces: preview.pieces,
    variantId: value.variantId ?? units?.selectedVariantId ?? null,
    recordedUnits: value.variantId !== null ? value.unitsPerVariant : units?.unitsPerVariantSnapshot ?? null,
    activeVariants: units?.variants ?? [] });
  return <div className="min-w-0 space-y-3" aria-label={`Quantity entry ${id}`}>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="min-w-0 space-y-1">
        <Label htmlFor={`${id}-unit`}>Count in</Label>
        <ReceiveUnitSelect id={`${id}-unit`} label={`Count unit ${id}`} value={value.variantId}
          options={options} disabled={disabled || refreshing} piecesOption={!pieceVariant}
          emptyLabel={pieceVariant ? "Base pieces (unit not recorded)" : "Base pieces (no configured piece unit)"}
          onChange={(variantId) => onChange(selectShipmentQuantityUnit(value, variantId, units))} />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-quantity`}>{selected && selected.unitsPerVariant !== 1 ? "Number of receive units" : quantityLabel ?? "Pieces shipped"}</Label>
        <Input id={`${id}-quantity`} inputMode="numeric" autoComplete="off"
          value={value.quantity} disabled={disabled || refreshing} onChange={(event) => onChange({ ...value, quantity: event.target.value })} />
      </div>
    </div>
    <div aria-live="polite" className="rounded border bg-muted/20 p-3 text-sm">
      {preview.pieces !== null
        ? <p className="font-medium">{value.variantId === null ? "" : `${value.quantity} × ${value.unitsPerVariant.toLocaleString("en-US")} pieces = `}{preview.pieces.toLocaleString("en-US")} pieces {purpose === "supplier-return" ? "to return" : "shipped"}</p>
        : <p role="alert" className="text-destructive">{preview.error}</p>}
      {maximumPieces !== undefined && <p className="text-xs text-muted-foreground">{maximumPieces.toLocaleString("en-US")} pieces available</p>}
    </div>
    {units?.issue && !setup?.ready && <p className="text-xs text-amber-800 dark:text-amber-200">{units.issue.message}</p>}
    {!units && <p className="text-xs text-muted-foreground">Configured receive units could not be verified. This quantity is recorded in pieces.</p>}
    {purpose === "shipment" && setup?.issue && <p className="text-sm text-amber-800 dark:text-amber-200">Receiving setup: {setup.issue.message} {draftAllowed ? "You can save an incomplete draft." : "Complete this setup before saving a booked shipment."}</p>}
    {purpose === "shipment" && setup?.ready && <p className="text-xs text-green-700 dark:text-green-300">Receiving configuration ready · {setup.count?.toLocaleString("en-US")} units.</p>}
    {purpose === "shipment" && selected && selected.unitsPerVariant !== value.unitsPerVariant && <Button type="button" size="sm" variant="outline" disabled={disabled || refreshing}
      onClick={() => onChange(selectShipmentQuantityUnit(value, selected.id, units))}>Use current pack size</Button>}
    {purpose === "shipment" && <Button type="button" size="sm" variant="outline" disabled={disabled || refreshing || adding}
      onClick={() => void refreshConfigurations()}>{refreshing ? "Refreshing configurations…" : "Refresh configurations"}</Button>}
    {refreshError && <p role="alert" className="text-sm text-destructive">{refreshError}</p>}
    {purpose === "shipment" && units?.productId && hasPermission("inventory", "create") && !adding && <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setAdding(true)}>Add receiving configuration</Button>}
    {purpose === "shipment" && units?.productId && !units.variants.length && !hasPermission("inventory", "create") && <p className="text-sm">A catalog editor needs to add this product's receiving configuration.</p>}
    {purpose === "shipment" && adding && units?.productId && <ReceivingConfigurationForm key={units.productId} productId={units.productId}
      productName={productName ?? "this product"} onCancel={() => setAdding(false)} onCreated={async variant => {
        const nextUnits: ShipmentUnits = { ...units, issue: null, variants: [...units.variants.filter(option => option.id !== variant.id),
          { id: variant.id, sku: variant.sku, name: variant.name, unitsPerVariant: variant.unitsPerVariant }] };
        onUnitsChange?.(nextUnits);
        await refreshSourceQueries();
        onChange(selectShipmentQuantityUnit(value, variant.id, nextUnits));
        setAdding(false);
      }} />}
    <p className="text-xs text-muted-foreground">Selecting a unit preserves the piece total when conversion is exact. A blank count requires a new explicit quantity. {purpose === "supplier-return" ? "The original receipt unit is fixed; a return must contain whole recorded stock units." : "Shipping cartons and dimensions stay unchanged."}</p>
  </div>;
}
