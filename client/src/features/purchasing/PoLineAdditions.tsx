import { useEffect, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { exactMoneyAsInput, parseExactMoneyInput } from "@/lib/exact-money-input";
import { poLineAdditionSchema, type PoLineAddition } from "@shared/procurement/po-quantity-amendment";
import { activeReceiveUnits, purchasableProducts, usePoProductSearch, type PoProductOption } from "./po-product-options";

export type NewPoLine = { input: PoLineAddition; name: string; unitName: string; product: PoProductOption };

export function PoLineAdditions({ lines, onChange, onDraftChange, disabled, blockedReason, currency }: {
  lines: NewPoLine[]; onChange: (lines: NewPoLine[]) => void; onDraftChange: (pending: boolean) => void;
  disabled: boolean; blockedReason?: string | null; currency: string;
}) {
  const [adding, setAdding] = useState(false), [search, setSearch] = useState("");
  useEffect(() => { onDraftChange(adding); return () => onDraftChange(false); }, [adding, onDraftChange]);
  const [productId, setProductId] = useState(""), [variantId, setVariantId] = useState("");
  const [selected, setSelected] = useState<PoProductOption | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(""), [price, setPrice] = useState(""), [packaging, setPackaging] = useState("0.00");
  const [discount, setDiscount] = useState("0.00"), [tax, setTax] = useState("0.00");
  const [error, setError] = useState<string | null>(null);
  const products = usePoProductSearch(search, adding);
  function add() {
    try {
      const variant = activeReceiveUnits(selected).find(value => value.id === Number(variantId));
      if (!selected || !variant) throw new Error("Choose a product and its receiving unit.");
      const input = poLineAdditionSchema.parse({ clientKey: editingKey ?? crypto.randomUUID(), productId: selected.id,
        expectedReceiveVariantId: variant.id, expectedReceiveUnitsPerVariant: variant.unitsPerVariant,
        pricing: { basis: "per_piece", quantityPieces: /^\d+$/.test(quantity) ? Number(quantity) : NaN, unitCostMills: parseExactMoneyInput(price, 4) },
        packagingCostCents: parseExactMoneyInput(packaging, 2), discountCents: parseExactMoneyInput(discount, 2), taxCents: parseExactMoneyInput(tax, 2) });
      const next = { input, name: selected.name, unitName: variant.name, product: selected };
      onChange(editingKey ? lines.map(line => line.input.clientKey === editingKey ? next : line) : [...lines, next]);
      setAdding(false); setEditingKey(null); setQuantity(""); setPrice(""); setPackaging("0.00"); setDiscount("0.00"); setTax("0.00"); setError(null);
    } catch (cause) { setError(cause instanceof z.ZodError ? "Enter a positive whole-piece quantity and valid amounts." : cause instanceof Error ? cause.message : "Review the new line."); }
  }
  return <section className="space-y-3" aria-label="New PO lines">
    {lines.map(line => <div key={line.input.clientKey} className="flex flex-wrap items-center gap-3 rounded border border-green-600 p-2 text-sm">
      <span className="font-medium">Added · {line.name}</span><span>{line.input.pricing.basis === "per_piece" ? `${line.input.pricing.quantityPieces.toLocaleString()} pieces · ${exactMoneyAsInput(line.input.pricing.unitCostMills, 4)} ${currency} per piece` : "Reviewed pricing"}</span>
      <span>Receive as {line.unitName}</span>
      <Button type="button" variant="outline" size="sm" disabled={disabled || adding} onClick={() => {
        if (line.input.pricing.basis !== "per_piece") return;
        setEditingKey(line.input.clientKey); setSelected(line.product); setProductId(String(line.input.productId)); setVariantId(String(line.input.expectedReceiveVariantId));
        setQuantity(String(line.input.pricing.quantityPieces)); setPrice(exactMoneyAsInput(line.input.pricing.unitCostMills, 4));
        setPackaging(exactMoneyAsInput(line.input.packagingCostCents, 2)); setDiscount(exactMoneyAsInput(line.input.discountCents, 2)); setTax(exactMoneyAsInput(line.input.taxCents, 2)); setAdding(true);
      }}>Edit new line</Button>
      <Button type="button" variant="outline" size="sm" disabled={disabled || adding} onClick={() => onChange(lines.filter(value => value.input.clientKey !== line.input.clientKey))}>Remove new line</Button>
    </div>)}
    {blockedReason && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
    {!adding && <Button type="button" variant="outline" disabled={disabled || !!blockedReason} onClick={() => setAdding(true)}>Add line item</Button>}
    {adding && <fieldset disabled={disabled} className="space-y-3 rounded border p-3">
      <div><Label htmlFor="new-po-search">Find product</Label><Input id="new-po-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Product name or SKU" /></div>
      {products.isPending && <p>Loading products…</p>}{products.error && <p role="alert">Products could not be loaded. <Button type="button" variant="outline" onClick={() => void products.refetch()}>Retry products</Button></p>}
      <div className="grid gap-3 sm:grid-cols-2"><div><Label htmlFor="new-po-product">Product</Label><select id="new-po-product" className="w-full rounded border bg-background p-2" value={productId} onChange={e => { setProductId(e.target.value); setSelected(products.data?.find(product => product.id === Number(e.target.value)) ?? null); setVariantId(""); }}><option value="">Choose product</option>
        {selected && !products.data?.some(product => product.id === selected.id) && <option value={selected.id}>{selected.sku} · {selected.name}</option>}
        {purchasableProducts(products.data).map(product => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}</select></div>
        <div><Label htmlFor="new-po-unit">Receive as</Label><select id="new-po-unit" className="w-full rounded border bg-background p-2" value={variantId} onChange={e => setVariantId(e.target.value)}><option value="">Choose receiving unit</option>{activeReceiveUnits(selected).map(variant => <option key={variant.id} value={variant.id}>{variant.name} · {variant.unitsPerVariant.toLocaleString()} pieces</option>)}</select></div></div>
      <div className="grid gap-3 sm:grid-cols-3"><div><Label htmlFor="new-po-pieces">Pieces ordered</Label><Input id="new-po-pieces" inputMode="numeric" value={quantity} onChange={e => setQuantity(e.target.value)} /></div>
        <div><Label htmlFor="new-po-price">Product price / piece ({currency})</Label><Input id="new-po-price" inputMode="decimal" value={price} onChange={e => setPrice(e.target.value)} /></div>
        <div><Label htmlFor="new-po-packaging">Packaging total ({currency})</Label><Input id="new-po-packaging" inputMode="decimal" value={packaging} onChange={e => setPackaging(e.target.value)} /></div></div>
      <details><summary className="cursor-pointer text-sm">Tax and discount</summary><div className="grid gap-3 pt-2 sm:grid-cols-2">
        <div><Label htmlFor="new-po-discount">Discount ({currency})</Label><Input id="new-po-discount" inputMode="decimal" value={discount} onChange={e => setDiscount(e.target.value)} /></div>
        <div><Label htmlFor="new-po-tax">Tax ({currency})</Label><Input id="new-po-tax" inputMode="decimal" value={tax} onChange={e => setTax(e.target.value)} /></div>
      </div></details>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <div className="flex gap-2"><Button type="button" onClick={add}>{editingKey ? "Update new line" : "Add to this edit"}</Button><Button type="button" variant="outline" onClick={() => { setAdding(false); setEditingKey(null); }}>Cancel new line</Button></div>
    </fieldset>}
  </section>;
}
