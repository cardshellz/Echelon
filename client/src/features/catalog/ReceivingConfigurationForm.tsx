import { useState } from "react";
import { z } from "zod";
import { getVariantUomDefinition, isSingleUnitVariantUomType, VARIANT_UOM_TYPES, VARIANT_UOM_DEFINITIONS } from "@shared/catalog/variant-uom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useQueryClient } from "@tanstack/react-query";
import { createProductVariant, type CreatedProductVariant } from "./create-product-variant";

const inputSchema = z.object({
  uomType: z.enum(VARIANT_UOM_TYPES),
  unitsPerVariant: z.coerce.number().int().positive().max(2_147_483_647),
  sku: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  sellable: z.boolean(),
});
const createdSchema = z.object({ id: z.number().int().positive(), productId: z.number().int().positive(),
  sku: z.string().nullable(), name: z.string(), unitsPerVariant: z.number().int().positive() });

/** Reuses catalog SKU, UOM, publication and permission rules. Creating a
 * configuration does not receive stock or post costs. */
export function ReceivingConfigurationForm({ productId, productName, onCreated, onCancel }: {
  productId: number; productName: string; onCreated: (variant: CreatedProductVariant) => Promise<void>; onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState({ uomType: "", unitsPerVariant: "", sku: "", name: "", sellable: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedProductVariant | null>(null);
  async function save() {
    setError(null);
    const parsed = inputSchema.safeParse(draft);
    if (!parsed.success) { setError("Choose the configuration type, enter a whole piece count, SKU and name."); return; }
    setBusy(true);
    try {
      if (created) { await onCreated(created); return; }
      const value = parsed.data;
      const single = isSingleUnitVariantUomType(value.uomType);
      const result = createdSchema.parse(await createProductVariant(productId, {
        sku: value.sku, name: value.name, uomType: value.uomType, unitsPerVariant: value.unitsPerVariant,
        hierarchyLevel: getVariantUomDefinition(value.uomType).defaultHierarchyLevel,
        parentVariantId: null, isBaseUnit: single, barcode: null, requiresShipping: true,
        salesEligibility: value.sellable ? "sellable" : "internal_only",
      }));
      if (result.productId !== productId || result.unitsPerVariant !== value.unitsPerVariant) {
        throw new Error("The saved configuration could not be verified. Refresh the product configurations before trying again.");
      }
      // A source refresh failure must not submit a second catalog creation.
      setCreated(result);
      void queryClient.invalidateQueries({ predicate: query => typeof query.queryKey[0] === "string" && (
        query.queryKey[0] === "/api/products" || query.queryKey[0] === `/api/products/${productId}` || query.queryKey[0].startsWith(`/api/products/${productId}/`)
        || query.queryKey[0].startsWith("/api/product-variants")) });
      await onCreated(result);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The configuration could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="rounded-md border bg-muted/20 p-3 space-y-3" aria-label={`New configuration for ${productName}`}>
    <h3 className="font-medium">Add receiving configuration · {productName}</h3>
    <p className="text-xs text-muted-foreground">Enter how this product is actually packed. This creates a reusable catalog variant.</p>
    <fieldset disabled={busy || !!created} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">Configuration type<select autoFocus className="w-full h-10 rounded-md border bg-background px-2" value={draft.uomType}
          onChange={event => { const type = event.target.value; setDraft(value => ({ ...value, uomType: type,
            unitsPerVariant: type === "piece" || type === "each" ? "1" : "" })); }}>
          <option value="">Choose type</option>{VARIANT_UOM_DEFINITIONS.map(type => <option key={type.type} value={type.type}>{type.label}</option>)}
        </select></label>
        <label className="space-y-1 text-sm">Pieces in each configuration<Input type="number" min={1} step={1} value={draft.unitsPerVariant}
          disabled={draft.uomType === "piece" || draft.uomType === "each"} onChange={event => setDraft(value => ({ ...value, unitsPerVariant: event.target.value }))} /></label>
        <label className="space-y-1 text-sm">SKU<Input maxLength={100} value={draft.sku} onChange={event => setDraft(value => ({ ...value, sku: event.target.value }))} /></label>
        <label className="space-y-1 text-sm">Configuration name<Input maxLength={200} placeholder="For example: Case of 10,000" value={draft.name} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} /></label>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.sellable} onChange={event => setDraft(value => ({ ...value, sellable: event.target.checked }))} />This configuration can also be sold to customers</label>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : created ? "Use saved configuration" : "Save configuration and use it"}</Button>
      <Button type="button" disabled={busy} variant="outline" onClick={onCancel}>Cancel configuration</Button></div>
  </section>;
}
