import { Check, ChevronsUpDown, Package, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  PoLinePricingEditor,
  createEmptyPoLinePricingDraft,
  createVendorCatalogPricingDraft,
  formatVendorCatalogQuote,
  isVendorCatalogQuoteReusable,
  vendorCatalogQuoteStatus,
} from "@/features/po-edit/PoLinePricingEditor";
import {
  PoLineQuoteMetadataEditor,
  createEmptyPoLineQuoteMetadataDraft,
  createPoLineQuoteMetadataDraftFromStored,
} from "@/features/po-edit/PoLineQuoteMetadataEditor";
import {
  createEmptyNewLine,
  formatStoredLineQuote,
} from "./po-detail-types-and-helpers";
import type { PoLineEditingController } from "./PoLinesSection";

export function PoLineDialogs(props: {
  po: any;
  lineEditing: PoLineEditingController;
}) {
  const { po, lineEditing } = props;

  return (
    <>
      {/* Quote-aware line pricing editor */}
      <Dialog
        open={lineEditing.editingPricingLine != null}
        onOpenChange={(open) => {
          if (!open && !lineEditing.updateLineMutation.isPending) lineEditing.closePricingEdit();
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Vendor Quote</DialogTitle>
            <DialogDescription>
              Update the quantity in the same basis the supplier quoted. Echelon will derive the normalized per-piece cost and exact line total.
            </DialogDescription>
          </DialogHeader>

          {lineEditing.editingPricingLine && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/20 p-3 text-sm">
                <div className="font-medium">
                  {lineEditing.editingPricingLine.sku || `Line ${lineEditing.editingPricingLine.lineNumber}`}
                  {lineEditing.editingPricingLine.productName ? ` — ${lineEditing.editingPricingLine.productName}` : ""}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Stored vendor quote: {formatStoredLineQuote(lineEditing.editingPricingLine) ?? "Not recorded"}
                </div>
              </div>

              <PoLinePricingEditor
                value={lineEditing.editLinePricing}
                onChange={(next) => {
                  lineEditing.setEditLinePricing(next);
                  if (lineEditing.editRequiresLegacyConfirmation) {
                    lineEditing.setLegacyPricingConfirmed(false);
                  }
                }}
                receiveConfiguration={{
                  label: lineEditing.editingPricingLine.sku || "Selected receiving configuration",
                  unitsPerVariant:
                    lineEditing.editingPricingLine.expectedReceiveUnitsPerVariant ||
                    lineEditing.editingPricingLine.unitsPerUom ||
                    1,
                }}
              />
              <PoLineQuoteMetadataEditor
                value={lineEditing.editLineQuoteMetadata}
                onChange={lineEditing.setEditLineQuoteMetadata}
              />

              <div className="space-y-2 rounded-md border p-3">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="editSaveToVendorCatalog"
                    checked={
                      lineEditing.editSaveToVendorCatalog &&
                      lineEditing.editLinePricing.basis !== "extended_total"
                    }
                    onCheckedChange={(value) => lineEditing.setEditSaveToVendorCatalog(!!value)}
                    disabled={lineEditing.editLinePricing.basis === "extended_total"}
                  />
                  <label
                    htmlFor="editSaveToVendorCatalog"
                    className="text-sm cursor-pointer select-none"
                  >
                    Update supplier price with this quote
                  </label>
                </div>
                {lineEditing.editSaveToVendorCatalog && lineEditing.editLinePricing.basis !== "extended_total" && (
                  <>
                    {lineEditing.editCatalogQuoteDateMissing && (
                      <p className="text-xs text-amber-700 ml-6" role="alert">
                        Enter a quote date to save this reusable supplier price.
                      </p>
                    )}
                    <div className="flex items-center gap-2 ml-6">
                      <Checkbox
                        id="editSetAsPreferred"
                        checked={lineEditing.editSetAsPreferred}
                        onCheckedChange={(value) => lineEditing.setEditSetAsPreferred(!!value)}
                      />
                      <label
                        htmlFor="editSetAsPreferred"
                        className="text-sm cursor-pointer select-none text-muted-foreground"
                      >
                        Set as preferred supplier for this product
                      </label>
                    </div>
                  </>
                )}
                {lineEditing.editLinePricing.basis === "extended_total" && (
                  <p className="text-xs text-muted-foreground ml-6">
                    A quantity-specific total remains on this PO and cannot become a reusable supplier price.
                  </p>
                )}
              </div>

              {lineEditing.editRequiresLegacyConfirmation && (
                <div className="rounded-md border border-amber-300 bg-amber-50 p-3 space-y-3 text-sm text-amber-950">
                  <p>
                    This legacy line stores only a normalized unit cost; it does not record how the vendor quoted it. Verify the original quote, choose the correct basis above, and confirm before saving.
                  </p>
                  <div className="flex items-start gap-2">
                    <Checkbox
                      id="confirmLegacyLinePricing"
                      checked={lineEditing.legacyPricingConfirmed}
                      onCheckedChange={(checked) => lineEditing.setLegacyPricingConfirmed(checked === true)}
                    />
                    <label htmlFor="confirmLegacyLinePricing" className="cursor-pointer leading-5">
                      I verified the vendor quote and confirm the basis, quantity, and amount entered above.
                    </label>
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Saving records this as an operator-confirmed manual quote. Existing quote reference and validity metadata remain attached to the line.
              </p>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={lineEditing.closePricingEdit}
                  disabled={lineEditing.updateLineMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={lineEditing.savePricingEdit}
                  disabled={
                    !lineEditing.editLinePricingEvaluation.pricing ||
                    !lineEditing.editLineQuoteMetadataEvaluation.metadata ||
                    (lineEditing.editRequiresLegacyConfirmation && !lineEditing.legacyPricingConfirmed) ||
                    lineEditing.editCatalogQuoteDateMissing ||
                    lineEditing.updateLineMutation.isPending
                  }
                >
                  {lineEditing.updateLineMutation.isPending ? "Saving..." : "Save Quote & Quantity"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Add Line Dialog ── */}
      <Dialog
        open={lineEditing.showAddLineDialog}
        onOpenChange={(open) => {
          lineEditing.setShowAddLineDialog(open);
          if (!open) {
            lineEditing.setProductSearch("");
            lineEditing.setSelectedProductForLine(null);
            lineEditing.setLinePricing(createEmptyPoLinePricingDraft());
            lineEditing.setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
            lineEditing.setSaveToVendorCatalog(true);
            lineEditing.setSetAsPreferred(false);
            lineEditing.setNewLine(createEmptyNewLine());
            lineEditing.setCatalogSearch("");
            lineEditing.setSelectedCatalogEntry(null);
            lineEditing.setCatalogPricingUntouched(false);
            lineEditing.setAddLineMode("catalog");
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
          <style>{`.add-line-scroll [data-radix-popper-content-wrapper] { z-index: 9999 !important; }`}</style>
          <DialogHeader>
            <DialogTitle>Add Line Item</DialogTitle>
            <DialogDescription>
              {lineEditing.addLineMode === "catalog"
                ? "Select from this supplier's catalog, or search all products."
                : "Search all products. You can save new items to the supplier's catalog."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 overflow-y-auto flex-1 pr-1 add-line-scroll">
            {/* Mode toggle — only when PO has a vendor */}
            {po.vendorId && (
              <div className="flex rounded-lg border p-0.5 gap-0.5 bg-muted/30">
                <Button
                  variant={lineEditing.addLineMode === "catalog" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    lineEditing.setAddLineMode("catalog");
                    lineEditing.setSelectedProductForLine(null);
                    lineEditing.setSelectedCatalogEntry(null);
                    lineEditing.setCatalogPricingUntouched(false);
                    lineEditing.setNewLine(createEmptyNewLine());
                    lineEditing.setLinePricing(createEmptyPoLinePricingDraft());
                    lineEditing.setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                  }}
                >
                  Supplier Catalog{lineEditing.vendorCatalog.length > 0 ? ` (${lineEditing.vendorCatalog.length})` : ""}
                </Button>
                <Button
                  variant={lineEditing.addLineMode === "search" ? "default" : "ghost"}
                  size="sm"
                  className="flex-1 h-8 text-xs"
                  onClick={() => {
                    lineEditing.setAddLineMode("search");
                    lineEditing.setSelectedCatalogEntry(null);
                    lineEditing.setCatalogPricingUntouched(false);
                    lineEditing.setNewLine(createEmptyNewLine());
                    lineEditing.setLinePricing(createEmptyPoLinePricingDraft());
                    lineEditing.setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                    lineEditing.setSelectedProductForLine(null);
                  }}
                >
                  All Products
                </Button>
              </div>
            )}

            {/* ── CATALOG MODE ── */}
            {lineEditing.addLineMode === "catalog" && po.vendorId && (
              <>
                {lineEditing.selectedCatalogEntry ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-md bg-muted border">
                    <div className="flex-1 min-w-0">
                      {(() => {
                        const product = lineEditing.products.find((p: any) => p.id === lineEditing.selectedCatalogEntry.productId);
                        const variant = product?.variants?.find((v: any) => v.id === lineEditing.selectedCatalogEntry.productVariantId);
                        return (
                          <>
                            <div className="font-medium text-sm truncate">
                              {product?.name || lineEditing.selectedCatalogEntry.vendorProductName || `Product #${lineEditing.selectedCatalogEntry.productId}`}
                            </div>
                            {variant && (
                              <div className="text-xs text-muted-foreground font-mono">{variant.sku} — {variant.name}</div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={() => {
                        lineEditing.setSelectedCatalogEntry(null);
                        lineEditing.setCatalogPricingUntouched(false);
                        lineEditing.setSelectedProductForLine(null);
                        lineEditing.setNewLine(createEmptyNewLine());
                        lineEditing.setLinePricing(createEmptyPoLinePricingDraft());
                        lineEditing.setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                      }}
                    >
                      <XCircle className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <Input
                        placeholder="Filter supplier catalog..."
                        value={lineEditing.catalogSearch}
                        onChange={e => lineEditing.setCatalogSearch(e.target.value)}
                        className="h-9"
                      />
                    </div>
                    {lineEditing.catalogLoading ? (
                      <div className="h-32 flex items-center justify-center text-sm text-muted-foreground">
                        Loading catalog...
                      </div>
                    ) : lineEditing.vendorCatalog.length === 0 ? (
                      <div className="rounded-md border p-4 text-center text-sm text-muted-foreground space-y-2">
                        <Package className="h-6 w-6 mx-auto opacity-30" />
                        <p>No catalog entries for this supplier yet.</p>
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto p-0 text-xs"
                          onClick={() => lineEditing.setAddLineMode("search")}
                        >
                          Search all products →
                        </Button>
                      </div>
                    ) : (
                      <div className="rounded-md border divide-y max-h-52 overflow-y-auto">
                        {lineEditing.vendorCatalog
                          .filter((entry: any) => {
                            if (!lineEditing.catalogSearch) return true;
                            const s = lineEditing.catalogSearch.toLowerCase();
                            const product = lineEditing.products.find((p: any) => p.id === entry.productId);
                            const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
                            return (
                              product?.name?.toLowerCase().includes(s) ||
                              entry.vendorSku?.toLowerCase().includes(s) ||
                              entry.vendorProductName?.toLowerCase().includes(s) ||
                              variant?.sku?.toLowerCase().includes(s) ||
                              product?.sku?.toLowerCase().includes(s)
                            );
                          })
                          .map((entry: any) => {
                            const product = lineEditing.products.find((p: any) => p.id === entry.productId);
                            const variant = product?.variants?.find((v: any) => v.id === entry.productVariantId);
                            const quoteStatus = vendorCatalogQuoteStatus(entry);
                            return (
                              <button
                                key={entry.id}
                                type="button"
                                className="w-full text-left p-2.5 hover:bg-muted/50 transition-colors"
                                onClick={() => {
                                  lineEditing.setSelectedCatalogEntry(entry);
                                  lineEditing.setCatalogPricingUntouched(
                                    isVendorCatalogQuoteReusable(entry),
                                  );
                                  lineEditing.setSelectedProductForLine(product || null);
                                  lineEditing.setNewLine(prev => ({
                                    ...prev,
                                    productId: entry.productId,
                                    productVariantId: entry.productVariantId || 0,
                                    expectedReceiveVariantId: entry.productVariantId || 0,
                                    expectedReceiveUnitsPerVariant: variant?.unitsPerVariant || 1,
                                    vendorSku: entry.vendorSku || "",
                                    unitsPerUom: variant?.unitsPerVariant || 1,
                                  }));
                                  lineEditing.setLinePricing(createVendorCatalogPricingDraft(entry));
                                  lineEditing.setLineQuoteMetadata(createPoLineQuoteMetadataDraftFromStored(entry));
                                  lineEditing.setSaveToVendorCatalog(false);
                                }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <div className="font-medium text-sm truncate">
                                      {product?.name || entry.vendorProductName || `Product #${entry.productId}`}
                                    </div>
                                    <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5 flex-wrap">
                                      {variant && <span className="font-mono">{variant.sku}</span>}
                                      {entry.vendorSku && <span>· {entry.vendorSku}</span>}
                                      {entry.pricingBasis === "per_purchase_uom" && (
                                        <span>
                                          · {entry.piecesPerPurchaseUom || entry.packSize || 1} pcs/{entry.purchaseUom || "purchase UOM"}
                                        </span>
                                      )}
                                      {(variant?.unitsPerVariant || 1) > 1 && (
                                        <span>· Receive as {variant.unitsPerVariant} pcs/config</span>
                                      )}
                                      {entry.moq > 1 && <span>· MOQ {entry.moq}</span>}
                                      {(!entry.pricingBasis || entry.pricingBasis === "legacy_unknown") && (
                                        <span className="text-amber-700">· Verify legacy price</span>
                                      )}
                                      {quoteStatus !== "usable" && quoteStatus !== "legacy" && (
                                        <span className="text-amber-700">· Quote review required</span>
                                      )}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-sm font-mono font-medium">
                                      {formatVendorCatalogQuote(entry)}
                                    </div>
                                    {entry.isPreferred ? (
                                      <div className="text-xs text-green-600">Preferred</div>
                                    ) : null}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </>
                )}

                {lineEditing.selectedCatalogEntry && !lineEditing.selectedCatalogEntry.productVariantId && lineEditing.selectedProductForLine && (
                  <div className="space-y-2">
                    <Label>Receive As *</Label>
                    <Popover open={lineEditing.variantOpen} onOpenChange={lineEditing.setVariantOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                          <span className="truncate">
                            {lineEditing.selectedVariant
                              ? `${lineEditing.selectedVariant.sku} — ${lineEditing.selectedVariant.name}`
                              : "Select variant..."}
                          </span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandList>
                            <CommandEmpty>No variants available.</CommandEmpty>
                            <CommandGroup>
                              {(lineEditing.selectedProductForLine.variants || []).map((v: any) => (
                                <CommandItem
                                  key={v.id}
                                  value={String(v.id)}
                                  onSelect={() => {
                                    lineEditing.setNewLine(prev => ({
                                      ...prev,
                                      productVariantId: v.id,
                                      expectedReceiveVariantId: v.id,
                                      expectedReceiveUnitsPerVariant: v.unitsPerVariant || 1,
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    lineEditing.setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${lineEditing.selectedReceiveVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/config</span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </>
            )}

            {/* ── SEARCH MODE ── */}
            {(lineEditing.addLineMode === "search" || !po.vendorId) && (
              <>
                <div className="space-y-2">
                  <Label>Product *</Label>
                  <Popover open={lineEditing.productOpen} onOpenChange={lineEditing.setProductOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                        <span className="truncate">{lineEditing.selectedProductForLine ? lineEditing.selectedProductForLine.name : "Search product..."}</span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                      <Command shouldFilter={false}>
                        <CommandInput placeholder="Search name or SKU..." value={lineEditing.productSearch} onValueChange={lineEditing.setProductSearch} />
                        <CommandList>
                          <CommandEmpty>No products found.</CommandEmpty>
                          <CommandGroup>
                            {lineEditing.filteredProducts.map((p: any) => (
                              <CommandItem
                                key={p.id}
                                value={String(p.id)}
                                onSelect={() => {
                                  lineEditing.setSelectedProductForLine(p);
                                  lineEditing.setLinePricing(createEmptyPoLinePricingDraft());
                                  lineEditing.setLineQuoteMetadata(createEmptyPoLineQuoteMetadataDraft());
                                  lineEditing.setNewLine(prev => ({
                                    ...prev,
                                    productId: p.id,
                                    productVariantId: 0,
                                    expectedReceiveVariantId: 0,
                                    expectedReceiveUnitsPerVariant: 1,
                                    unitsPerUom: 1,
                                    vendorSku: "",
                                  }));
                                  lineEditing.setProductOpen(false);
                                  lineEditing.setProductSearch("");
                                }}
                              >
                                <Check className={`mr-2 h-4 w-4 ${lineEditing.selectedProductForLine?.id === p.id ? "opacity-100" : "opacity-0"}`} />
                                <span className="font-mono text-xs mr-2 text-muted-foreground">{p.sku}</span>
                                <span className="truncate">{p.name}</span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                {lineEditing.selectedProductForLine && (
                  <div className="space-y-2">
                    <Label>Receive As *</Label>
                    <Popover open={lineEditing.variantOpen} onOpenChange={lineEditing.setVariantOpen}>
                      <PopoverTrigger asChild>
                        <Button variant="outline" className="w-full justify-between h-10 font-normal overflow-hidden">
                          <span className="truncate">
                            {lineEditing.selectedVariant
                              ? `${lineEditing.selectedVariant.sku} — ${lineEditing.selectedVariant.name}`
                              : "Select variant..."}
                          </span>
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandList>
                            <CommandEmpty>No variants available.</CommandEmpty>
                            <CommandGroup>
                              {(lineEditing.selectedProductForLine.variants || []).map((v: any) => (
                                <CommandItem
                                  key={v.id}
                                  value={String(v.id)}
                                  onSelect={() => {
                                    lineEditing.setNewLine(prev => ({
                                      ...prev,
                                      productVariantId: v.id,
                                      expectedReceiveVariantId: v.id,
                                      expectedReceiveUnitsPerVariant: v.unitsPerVariant || 1,
                                      unitsPerUom: v.unitsPerVariant || 1,
                                    }));
                                    lineEditing.setVariantOpen(false);
                                  }}
                                >
                                  <Check className={`mr-2 h-4 w-4 ${lineEditing.selectedReceiveVariantId === v.id ? "opacity-100" : "opacity-0"}`} />
                                  <span className="font-mono text-xs mr-2">{v.sku}</span>
                                  <span className="truncate">{v.name}</span>
                                  {(v.unitsPerVariant || 1) > 1 && (
                                    <span className="ml-auto text-xs text-muted-foreground">{v.unitsPerVariant} pcs/config</span>
                                  )}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  </div>
                )}
              </>
            )}

            {/* ── COMMON FIELDS — shown once a variant is selected ── */}
            {lineEditing.selectedReceiveVariantId > 0 && (
              <>
                <Separator />
                <PoLinePricingEditor
                  value={lineEditing.linePricing}
                  onChange={(next) => {
                    lineEditing.setLinePricing(next);
                    lineEditing.setCatalogPricingUntouched(false);
                  }}
                  receiveConfiguration={{
                    label: lineEditing.selectedVariant
                      ? `${lineEditing.selectedVariant.sku} — ${lineEditing.selectedVariant.name}`
                      : "Selected product configuration",
                    unitsPerVariant: lineEditing.receiveUnitsPerVariant,
                  }}
                />
                <PoLineQuoteMetadataEditor
                  value={lineEditing.lineQuoteMetadata}
                  onChange={(next) => {
                    lineEditing.setLineQuoteMetadata(next);
                    lineEditing.setCatalogPricingUntouched(false);
                  }}
                />
                {lineEditing.selectedCatalogEntry && (!lineEditing.selectedCatalogEntry.pricingBasis || lineEditing.selectedCatalogEntry.pricingBasis === "legacy_unknown") && (
                  <p className="text-xs text-amber-700">
                    This legacy catalog price has no verified quote basis. Confirm it before adding; the line will be recorded as manual pricing.
                  </p>
                )}

                <div className="space-y-2">
                  <Label>Vendor SKU</Label>
                  <Input
                    value={lineEditing.newLine.vendorSku}
                    onChange={e => lineEditing.setNewLine(prev => ({ ...prev, vendorSku: e.target.value }))}
                    placeholder="Vendor's catalog number"
                    className="h-10"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="saveToVendorCatalog"
                      checked={lineEditing.saveToVendorCatalog && lineEditing.linePricing.basis !== "extended_total"}
                      onCheckedChange={(v) => lineEditing.setSaveToVendorCatalog(!!v)}
                      disabled={lineEditing.linePricing.basis === "extended_total"}
                    />
                    <label htmlFor="saveToVendorCatalog" className="text-sm cursor-pointer select-none">
                      Update supplier price with this quote
                    </label>
                  </div>
                  {lineEditing.saveToVendorCatalog && lineEditing.linePricing.basis !== "extended_total" && (
                    <>
                      {lineEditing.catalogQuoteDateMissing && (
                        <p className="text-xs text-amber-700 ml-6" role="alert">
                          Enter a quote date to save this reusable catalog price, or uncheck
                          {" "}“Update supplier price with this quote”
                          {" "}to add the line to this PO only.
                        </p>
                      )}
                      <div className="flex items-center gap-2 ml-6">
                        <Checkbox
                          id="setAsPreferred"
                          checked={lineEditing.setAsPreferred}
                          onCheckedChange={(v) => lineEditing.setSetAsPreferred(!!v)}
                        />
                        <label htmlFor="setAsPreferred" className="text-sm cursor-pointer select-none text-muted-foreground">
                          Set as preferred vendor for this product
                        </label>
                      </div>
                    </>
                  )}
                  {lineEditing.linePricing.basis === "extended_total" && (
                    <p className="text-xs text-muted-foreground ml-6">
                      A quoted total is specific to this quantity and will remain on this PO rather than becoming a reusable catalog price.
                    </p>
                  )}
                </div>
              </>
            )}

            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => lineEditing.setShowAddLineDialog(false)}>Cancel</Button>
              <Button
                onClick={lineEditing.submitAddLine}
                disabled={
                  !lineEditing.selectedReceiveVariantId ||
                  !lineEditing.linePricingEvaluation.pricing ||
                  !lineEditing.lineQuoteMetadataEvaluation.metadata ||
                  lineEditing.catalogQuoteDateMissing ||
                  !po.updatedAt ||
                  lineEditing.addLineMutation.isPending
                }
              >
                {lineEditing.addLineMutation.isPending ? "Adding..." : "Add Line"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
