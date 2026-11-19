import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { financialCommandFetchJson } from "@/lib/financial-command";
import { poLineProductChangeSchema, type PoLineProductChange as ProductChangeInput, type PoQuantityAmendmentContext } from "@shared/procurement/po-quantity-amendment";
import { activeReceiveUnits, purchasableProducts, usePoProductSearch, type PoProductOption } from "./po-product-options";

type Line = PoQuantityAmendmentContext["lines"][number];
const supplierItemSchema = z.object({
  id: z.number().int().positive(), productId: z.number().int().positive(),
  vendorSku: z.string().nullable(), vendorProductName: z.string().nullable().optional(),
}).passthrough();
type SupplierItem = z.infer<typeof supplierItemSchema>;
export type PoProductChangeDraft = { input: ProductChangeInput; name: string; sku: string | null; unitName: string; supplierItem: string | null; product: PoProductOption };

function supplierItemLabel(item: SupplierItem): string {
  return [item.vendorSku, item.vendorProductName].filter(Boolean).join(" · ") || `Supplier item #${item.id}`;
}

/** Picks the product, receiving unit and supplier item an untouched line should
 * buy. Pieces and prices stay on the line; the server re-verifies every choice. */
export function PoLineProductChange({ line, vendorId, draft, disabled, onSave, onCancel }: {
  line: Line; vendorId: number | null; draft: PoProductChangeDraft | null; disabled: boolean;
  onSave: (draft: PoProductChangeDraft) => void; onCancel: () => void;
}) {
  const [search, setSearch] = useState(draft?.sku ?? "");
  const [selected, setSelected] = useState<PoProductOption | null>(draft?.product ?? null);
  const [variantId, setVariantId] = useState(draft ? String(draft.input.expectedReceiveVariantId) : "");
  const [supplierItemId, setSupplierItemId] = useState(draft?.input.vendorProductId ? String(draft.input.vendorProductId) : "");
  const [vendorSku, setVendorSku] = useState(draft ? draft.input.vendorSku ?? "" : line.vendorSku ?? "");
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLFieldSetElement>(null), searchInput = useRef<HTMLInputElement>(null);
  // The picker opens below the line table; bring it to the operator on long POs.
  useEffect(() => { panel.current?.scrollIntoView({ block: "nearest" }); searchInput.current?.focus({ preventScroll: true }); }, []);
  const products = usePoProductSearch(search, true);
  const supplierUrl = vendorId && selected ? `/api/vendor-products?${new URLSearchParams({ vendorId: String(vendorId), productId: String(selected.id), isActive: "1" })}` : null;
  const supplierItems = useQuery({ queryKey: [supplierUrl, "po-product-change"], enabled: supplierUrl !== null,
    queryFn: async () => z.object({ vendorProducts: z.array(supplierItemSchema) }).parse(await financialCommandFetchJson(supplierUrl!, { credentials: "include" })).vendorProducts
      .filter(item => item.productId === selected!.id) });
  const unit = activeReceiveUnits(selected).find(value => value.id === Number(variantId));
  const wholeUnits = unit ? line.orderQty % unit.unitsPerVariant === 0 : true;
  function chooseProduct(value: string) {
    setSelected(purchasableProducts(products.data).find(product => product.id === Number(value)) ?? null);
    setVariantId(""); setSupplierItemId(""); setError(null);
  }
  function chooseSupplierItem(value: string) {
    setSupplierItemId(value);
    const item = supplierItems.data?.find(candidate => candidate.id === Number(value));
    if (item?.vendorSku) setVendorSku(item.vendorSku);
  }
  function save() {
    try {
      if (!selected || !unit) throw new Error("Choose the new product and how it is received.");
      const item = supplierItems.data?.find(candidate => candidate.id === Number(supplierItemId)) ?? null;
      if (supplierItemId && !item) throw new Error("The supplier item list changed. Choose the supplier item again.");
      const input = poLineProductChangeSchema.parse({ lineId: line.id, productId: selected.id, expectedReceiveVariantId: unit.id,
        expectedReceiveUnitsPerVariant: unit.unitsPerVariant, vendorProductId: item?.id ?? null, vendorSku: vendorSku.trim() || null });
      if (input.productId === line.productId && input.expectedReceiveVariantId === line.receiveVariantId
        && input.vendorProductId === (line.vendorProductId ?? null) && input.vendorSku === (line.vendorSku ?? null)) {
        throw new Error("Choose a different product, receiving unit or supplier item.");
      }
      onSave({ input, name: selected.name, sku: selected.sku, unitName: unit.name, supplierItem: item ? supplierItemLabel(item) : null, product: selected });
    } catch (cause) {
      setError(cause instanceof z.ZodError ? "The supplier SKU can be up to 100 characters." : cause instanceof Error ? cause.message : "Review the product change.");
    }
  }
  return <fieldset ref={panel} disabled={disabled} className="space-y-3 rounded border border-blue-300 p-3" aria-label={`Change product for line ${line.lineNumber}`}>
    <p className="text-sm font-semibold">Change product · Line {line.lineNumber} · {line.sku ? `${line.sku} · ` : ""}{line.name}</p>
    <p className="text-xs text-muted-foreground">The line keeps its {line.orderQty.toLocaleString()} pieces and its prices. Linked invoices keep their recorded description and stay matched to this line.</p>
    <div><Label htmlFor="change-po-search">Find replacement product</Label><Input ref={searchInput} id="change-po-search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Product name or SKU" /></div>
    {products.isPending && <p>Loading products…</p>}{products.error && <p role="alert">Products could not be loaded. <Button type="button" variant="outline" onClick={() => void products.refetch()}>Retry products</Button></p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor="change-po-product">New product</Label><select id="change-po-product" className="w-full rounded border bg-background p-2" value={selected ? String(selected.id) : ""} onChange={e => chooseProduct(e.target.value)}><option value="">Choose product</option>
        {selected && !purchasableProducts(products.data).some(product => product.id === selected.id) && <option value={selected.id}>{selected.sku} · {selected.name}</option>}
        {purchasableProducts(products.data).map(product => <option key={product.id} value={product.id}>{product.sku} · {product.name}</option>)}</select></div>
      <div><Label htmlFor="change-po-unit">New receive as</Label><select id="change-po-unit" className="w-full rounded border bg-background p-2" value={variantId} onChange={e => setVariantId(e.target.value)}><option value="">Choose receiving unit</option>
        {activeReceiveUnits(selected).map(variant => <option key={variant.id} value={variant.id}>{variant.name} · {variant.unitsPerVariant.toLocaleString()} pieces</option>)}</select>
        {unit && <p className={`mt-1 text-xs ${wholeUnits ? "text-muted-foreground" : "text-amber-800 dark:text-amber-300"}`}>{wholeUnits
          ? `Expect ${(line.orderQty / unit.unitsPerVariant).toLocaleString()} × ${unit.name}.`
          : `${line.orderQty.toLocaleString()} pieces is not a whole number of ${unit.name}. Check the quantity with the supplier.`}</p>}</div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label htmlFor="change-po-supplier-item">Supplier catalog item</Label><select id="change-po-supplier-item" className="w-full rounded border bg-background p-2" value={supplierItemId} disabled={!selected || !vendorId} onChange={e => chooseSupplierItem(e.target.value)}>
        <option value="">No supplier catalog item</option>
        {supplierItems.data?.map(item => <option key={item.id} value={item.id}>{supplierItemLabel(item)}</option>)}</select>
        {supplierItems.error && <p role="alert" className="mt-1 text-xs">Supplier items could not be loaded. <Button type="button" variant="outline" size="sm" onClick={() => void supplierItems.refetch()}>Retry supplier items</Button></p>}</div>
      <div><Label htmlFor="change-po-vendor-sku">Supplier SKU on the PO</Label><Input id="change-po-vendor-sku" value={vendorSku} maxLength={100} onChange={e => setVendorSku(e.target.value)} placeholder="Optional" /></div>
    </div>
    {error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="flex gap-2"><Button type="button" onClick={save}>Use this product</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel product change</Button></div>
  </fieldset>;
}
