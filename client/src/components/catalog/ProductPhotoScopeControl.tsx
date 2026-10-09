import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { ProductAssetScopeSaveError, type ProductAssetScopeAttempt } from "@/lib/product-asset-scope";
import type { CatalogPhotoVariant } from "@shared/catalog/product-asset-scope";

interface Props {
  assetId: number;
  productVariantId: number | null;
  variants: readonly CatalogPhotoVariant[];
  disabled: boolean;
  onSave: (attempt: ProductAssetScopeAttempt) => Promise<void>;
}

export function ProductPhotoScopeControl({ assetId, productVariantId, variants, disabled, onSave }: Props) {
  const [attempt, setAttempt] = useState<ProductAssetScopeAttempt | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const { toast } = useToast();
  const variant = variants.find(item => item.id === productVariantId);
  const labelId = `photo-scope-${assetId}`;
  const detailId = `photo-scope-detail-${assetId}`;

  async function save(change: ProductAssetScopeAttempt) {
    if (disabled || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setAttempt(change);
    setError(null);
    try {
      await onSave(change);
      setAttempt(null);
      toast({ title: "Photo assignment saved" });
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "Could not confirm the photo assignment. Retry this change.";
      setError(message);
      // An uncertain response retains the original key and snapshot. Retrying
      // a committed command returns its receipt without undoing a later edit.
      if (failure instanceof ProductAssetScopeSaveError && failure.outcome === "rejected") setAttempt(null);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={labelId} className="text-xs font-medium">Applies to</label>
      <select id={labelId} aria-label={`Applies to image ${assetId}`} aria-describedby={detailId}
        className="h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-60"
        value={productVariantId === null ? "all" : String(productVariantId)}
        disabled={disabled || saving || attempt !== null}
        onChange={event => {
          const next = event.target.value === "all" ? null : Number(event.target.value);
          if (next === productVariantId) return;
          void save({ assetId, command: { productVariantId: next, expectedProductVariantId: productVariantId },
            idempotencyKey: crypto.randomUUID() });
        }}>
        <option value="all">All variants (default)</option>
        {productVariantId !== null && !variant && <option value={productVariantId} disabled>Unknown variant #{productVariantId}</option>}
        {variants.map(item => <option key={item.id} value={item.id}>{item.name} — {item.sku}</option>)}
      </select>
      <p id={detailId} className="break-words text-xs text-muted-foreground">
        {productVariantId === null ? "Applies to all variants of this product" : variant ? `${variant.name} · ${variant.sku}` : `Unknown assignment: variant #${productVariantId}`}
      </p>
      {saving && <p role="status" className="text-xs">Saving assignment…</p>}
      {error && <p role="alert" className="break-words text-xs text-destructive">{error}</p>}
      {attempt && !saving && <Button type="button" variant="outline" size="sm" className="w-full whitespace-normal"
        disabled={disabled} onClick={() => void save(attempt)}>Retry assignment</Button>}
    </div>
  );
}
