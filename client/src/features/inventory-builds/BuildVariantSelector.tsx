import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronUp, Loader2, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { buildVariantPackagePayload, emptyVariantPackageInput, type VariantPackageInput } from "@/lib/variant-package";
import { createProductVariant } from "@/features/catalog/create-product-variant";
import {
  VARIANT_UOM_DEFINITIONS,
  getVariantUomDefinition,
  isSingleUnitVariantUomType,
  type VariantUomType,
} from "@shared/catalog/variant-uom";
import type { BuildVariantResult } from "./build-recipe-model";

type ProductSummary = { id: number; sku: string | null; name: string; isActive?: boolean | number };
type ProductVariantSummary = {
  id: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  isActive?: boolean | number;
};

type VariantDraft = {
  productId: number | null;
  uomType: VariantUomType;
  unitsPerVariant: string;
  sku: string;
  name: string;
  barcode: string;
  parentVariantId: number | null;
  isBaseUnit: boolean;
  package: VariantPackageInput;
  shipsInOwnContainer: boolean;
  maxUnitsPerPackage: string;
};

function newVariantDraft(search: string): VariantDraft {
  return {
    productId: null,
    uomType: "each",
    unitsPerVariant: "1",
    sku: search.trim(),
    name: "Each",
    barcode: "",
    parentVariantId: null,
    isBaseUnit: true,
    package: emptyVariantPackageInput(),
    shipsInOwnContainer: false,
    maxUnitsPerPackage: "",
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? `Request failed (${response.status}).`);
  return body as T;
}

export function BuildVariantSelector({
  value,
  onChange,
  label,
  allowCreate = true,
}: {
  value: BuildVariantResult | null;
  onChange: (variant: BuildVariantResult | null) => void;
  label: string;
  allowCreate?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [productSearch, setProductSearch] = useState("");
  const [showPackage, setShowPackage] = useState(false);
  const [draft, setDraft] = useState<VariantDraft>(() => newVariantDraft(""));

  const { data = [], isFetching } = useQuery<BuildVariantResult[]>({
    queryKey: ["/api/inventory/skus/search", "build", search],
    queryFn: async () => responseJson<BuildVariantResult[]>(await fetch(
      `/api/inventory/skus/search?q=${encodeURIComponent(search)}&limit=12`,
      { credentials: "include" },
    )),
    enabled: !value && !createOpen && search.trim().length >= 2,
  });
  const { data: products = [] } = useQuery<ProductSummary[]>({ queryKey: ["/api/products"] });
  const { data: productVariants = [] } = useQuery<ProductVariantSummary[]>({
    queryKey: ["/api/products", draft.productId, "variants"],
    queryFn: async () => responseJson<ProductVariantSummary[]>(await fetch(
      `/api/products/${draft.productId}/variants`,
      { credentials: "include" },
    )),
    enabled: draft.productId != null,
  });

  useEffect(() => {
    if (!createOpen) return;
    setDraft(newVariantDraft(search));
    setShowPackage(false);
  }, [createOpen]);

  const selectedProduct = products.find((product) => product.id === draft.productId) ?? null;
  const filteredProducts = useMemo(() => {
    const normalized = productSearch.trim().toLowerCase();
    return products
      .filter((product) => product.isActive !== false && product.isActive !== 0)
      .filter((product) => !normalized
        || product.name.toLowerCase().includes(normalized)
        || (product.sku ?? "").toLowerCase().includes(normalized))
      .slice(0, 50);
  }, [productSearch, products]);

  const unitsPerVariant = Number(draft.unitsPerVariant);
  const maxUnitsPerPackage = draft.maxUnitsPerPackage.trim() === ""
    ? null
    : Number(draft.maxUnitsPerPackage);
  const draftValid = draft.productId != null
    && draft.sku.trim().length > 0
    && draft.name.trim().length > 0
    && Number.isSafeInteger(unitsPerVariant)
    && unitsPerVariant > 0
    && (maxUnitsPerPackage == null || (Number.isSafeInteger(maxUnitsPerPackage) && maxUnitsPerPackage > 0))
    && (draft.isBaseUnit || draft.parentVariantId != null);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!draft.productId) throw new Error("Select a parent product.");
      const packageAttributes = buildVariantPackagePayload(draft.package, "null");
      return createProductVariant(draft.productId, {
        sku: draft.sku.trim(),
        name: draft.name.trim(),
        unitsPerVariant,
        hierarchyLevel: getVariantUomDefinition(draft.uomType).defaultHierarchyLevel,
        uomType: draft.uomType,
        barcode: draft.barcode.trim() || null,
        parentVariantId: draft.isBaseUnit ? null : draft.parentVariantId,
        isBaseUnit: draft.isBaseUnit,
        ...packageAttributes,
        shipsInOwnContainer: draft.shipsInOwnContainer,
        maxUnitsPerPackage,
      });
    },
    onSuccess: async (variant) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["/api/products"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/inventory/skus/search"] }),
      ]);
      onChange({
        productVariantId: variant.id,
        productId: variant.productId,
        unitsPerVariant: variant.unitsPerVariant,
        sku: variant.sku ?? variant.name,
        name: variant.name,
      });
      setCreateOpen(false);
      setSearch("");
      toast({ title: "Variant created", description: `${variant.sku ?? variant.name} is selected for this recipe.` });
    },
    onError: (error: Error) => toast({
      title: "Variant creation failed",
      description: error.message,
      variant: "destructive",
    }),
  });

  if (value) {
    return (
      <div className="flex min-w-0 items-center justify-between gap-2 border px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{value.sku}</div>
          <div className="truncate text-xs text-muted-foreground">{value.name}</div>
        </div>
        <Button type="button" variant="ghost" size="icon" onClick={() => onChange(null)} title={`Clear ${label}`}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {!createOpen && (
        <>
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder={label} />
          </div>
          {search.trim().length >= 2 && (
            <div className="max-h-52 overflow-y-auto border bg-background">
              {isFetching && <div className="p-3 text-sm text-muted-foreground">Searching...</div>}
              {!isFetching && data.length === 0 && (
                <div className="space-y-2 p-3">
                  <div className="text-sm text-muted-foreground">No variants found.</div>
                  {allowCreate && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
                      <Plus className="mr-1 h-4 w-4" />Create {search.trim()}
                    </Button>
                  )}
                </div>
              )}
              {data.map((variant) => (
                <button
                  key={variant.productVariantId}
                  type="button"
                  className="block w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted"
                  onClick={() => { onChange(variant); setSearch(""); }}
                >
                  <div className="text-sm font-medium">{variant.sku}</div>
                  <div className="text-xs text-muted-foreground">{variant.name}</div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {createOpen && (
        <div className="space-y-4 border-l-4 border-blue-500 bg-blue-50/40 p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-medium">Create catalog variant</div>
              <div className="text-xs text-muted-foreground">This uses the catalog variant API and selects the result automatically.</div>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={() => setCreateOpen(false)} title="Cancel variant creation">
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <Label>Parent product *</Label>
              <Popover open={productPickerOpen} onOpenChange={setProductPickerOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" className="w-full justify-between bg-background font-normal">
                    {selectedProduct ? `${selectedProduct.sku ?? "-"} - ${selectedProduct.name}` : "Select catalog product"}
                    <Search className="h-4 w-4 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                  <Command shouldFilter={false}>
                    <CommandInput value={productSearch} onValueChange={setProductSearch} placeholder="Search products" />
                    <CommandList>
                      <CommandEmpty>No products found.</CommandEmpty>
                      <CommandGroup>
                        {filteredProducts.map((product) => (
                          <CommandItem
                            key={product.id}
                            value={String(product.id)}
                            onSelect={() => {
                              setDraft((current) => ({ ...current, productId: product.id, parentVariantId: null }));
                              setProductPickerOpen(false);
                              setProductSearch("");
                            }}
                          >
                            <Check className={`mr-2 h-4 w-4 ${draft.productId === product.id ? "opacity-100" : "opacity-0"}`} />
                            <span className="mr-2 font-mono text-xs">{product.sku ?? "-"}</span>
                            <span className="truncate">{product.name}</span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div>
              <Label>Type *</Label>
              <Select
                value={draft.uomType}
                onValueChange={(value) => {
                  const uomType = value as VariantUomType;
                  setDraft((current) => ({
                    ...current,
                    uomType,
                    unitsPerVariant: isSingleUnitVariantUomType(uomType) ? "1" : current.unitsPerVariant,
                    parentVariantId: isSingleUnitVariantUomType(uomType) ? null : current.parentVariantId,
                    isBaseUnit: isSingleUnitVariantUomType(uomType),
                    name: isSingleUnitVariantUomType(uomType) ? getVariantUomDefinition(uomType).label : current.name,
                  }));
                }}
              >
                <SelectTrigger className="bg-background"><SelectValue /></SelectTrigger>
                <SelectContent>{VARIANT_UOM_DEFINITIONS.map((definition) => (
                  <SelectItem key={definition.type} value={definition.type}>{definition.label}</SelectItem>
                ))}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>Units per variant *</Label>
              <Input
                className="bg-background"
                type="number"
                min="1"
                step="1"
                disabled={isSingleUnitVariantUomType(draft.uomType)}
                value={draft.unitsPerVariant}
                onChange={(event) => setDraft((current) => ({ ...current, unitsPerVariant: event.target.value }))}
              />
            </div>
            <div>
              <Label>SKU *</Label>
              <Input className="bg-background font-mono" value={draft.sku} onChange={(event) => setDraft((current) => ({ ...current, sku: event.target.value }))} />
            </div>
            <div>
              <Label>Display name *</Label>
              <Input className="bg-background" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
            </div>
            <div>
              <Label>Barcode</Label>
              <Input className="bg-background" value={draft.barcode} onChange={(event) => setDraft((current) => ({ ...current, barcode: event.target.value }))} />
            </div>
            {!isSingleUnitVariantUomType(draft.uomType) && (
              <div className="space-y-2 md:col-span-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id={`${label.replace(/\s+/g, "-").toLowerCase()}-base-unit`}
                    checked={draft.isBaseUnit}
                    onCheckedChange={(checked) => setDraft((current) => ({
                      ...current,
                      isBaseUnit: checked === true,
                      parentVariantId: checked === true ? null : current.parentVariantId,
                    }))}
                  />
                  <Label htmlFor={`${label.replace(/\s+/g, "-").toLowerCase()}-base-unit`} className="font-normal">
                    This is the smallest inventory unit and does not break down further
                  </Label>
                </div>
                {!draft.isBaseUnit && (
                  <div>
                    <Label>Breaks into *</Label>
                    <Select value={draft.parentVariantId == null ? "" : String(draft.parentVariantId)} onValueChange={(value) => setDraft((current) => ({ ...current, parentVariantId: Number(value) }))} disabled={!draft.productId}>
                      <SelectTrigger className="bg-background"><SelectValue placeholder="Select smaller variant" /></SelectTrigger>
                      <SelectContent>{productVariants
                        .filter((variant) => variant.isActive !== false && variant.isActive !== 0 && variant.unitsPerVariant < unitsPerVariant)
                        .map((variant) => <SelectItem key={variant.id} value={String(variant.id)}>{variant.sku ?? variant.name} ({variant.unitsPerVariant})</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            )}
          </div>

          <Button type="button" variant="ghost" className="px-0" onClick={() => setShowPackage((current) => !current)}>
            {showPackage ? <ChevronUp className="mr-2 h-4 w-4" /> : <ChevronDown className="mr-2 h-4 w-4" />}
            Package and shipping attributes
          </Button>
          {showPackage && (
            <div className="grid gap-4 border-t pt-4 md:grid-cols-4">
              {([
                ["weightLb", "Weight (lb)"],
                ["lengthIn", "Length (in)"],
                ["widthIn", "Width (in)"],
                ["heightIn", "Height (in)"],
              ] as const).map(([key, fieldLabel]) => (
                <div key={key}>
                  <Label>{fieldLabel}</Label>
                  <Input className="bg-background" type="number" min="0" step="0.001" value={draft.package[key]} onChange={(event) => setDraft((current) => ({ ...current, package: { ...current.package, [key]: event.target.value } }))} />
                </div>
              ))}
              <div className="flex items-center gap-2 md:col-span-2">
                <Checkbox checked={draft.shipsInOwnContainer} onCheckedChange={(checked) => setDraft((current) => ({ ...current, shipsInOwnContainer: checked === true }))} />
                <span className="text-sm">Ships in its own container</span>
              </div>
              <div className="md:col-span-2">
                <Label>Max units per package</Label>
                <Input className="bg-background" type="number" min="1" step="1" value={draft.maxUnitsPerPackage} onChange={(event) => setDraft((current) => ({ ...current, maxUnitsPerPackage: event.target.value }))} />
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button type="button" disabled={!draftValid || createMutation.isPending} onClick={() => createMutation.mutate()}>
              {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Create and select
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
