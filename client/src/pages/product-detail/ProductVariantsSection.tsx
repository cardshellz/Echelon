import type { Dispatch, SetStateAction } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Layers, Plus, Pencil, Archive } from "lucide-react";
import {
  VARIANT_UOM_DEFINITIONS,
  getVariantUomDefinition,
  isSingleUnitVariantUomType,
  type VariantUomType,
} from "@shared/catalog/variant-uom";
import type { VariantSalesEligibility } from "@shared/catalog/variant-sales-eligibility";
import { VariantShippingBehavior } from "./ProductInventoryAndShippingPanels";
import {
  buildVariantPackageDisplay,
  getVariantUomType,
  type ProductVariantRow,
  type VariantFormState,
} from "./product-detail-types-and-helpers";

export function ProductVariantsSection({
  sortedVariants,
  archivedVariants,
  onCreateVariant,
  onEditVariant,
  onArchiveVariant,
}: {
  sortedVariants: ProductVariantRow[];
  archivedVariants: ProductVariantRow[];
  onCreateVariant: () => void;
  onEditVariant: (variant: ProductVariantRow) => void;
  onArchiveVariant: (variant: ProductVariantRow) => void;
}) {
  return (
    <Card>
      <CardHeader className="p-3 md:p-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-base md:text-lg">Product Variants</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Pack sizes and configurations
          </CardDescription>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={onCreateVariant} className="min-h-[44px]">
            <Plus className="h-4 w-4 mr-1" />
            Add Variant
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
        {sortedVariants.length > 0 ? (
          <>
            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {sortedVariants.map((variant) => {
                const packageDisplay = buildVariantPackageDisplay(variant);
                return (
                  <div
                    key={variant.id}
                    className="border rounded-lg p-3"
                    data-testid={`variant-card-mobile-${variant.id}`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-sm text-primary">{variant.sku}</span>
                      <div className="flex items-center gap-1.5">
                        {variant.salesEligibility === "internal_only" && (
                          <Badge variant="outline" className="text-[10px] bg-slate-50 text-slate-700 border-slate-300">
                            Internal only
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-xs">
                          {getVariantUomDefinition(getVariantUomType(variant)).label}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-sm mb-2">{variant.name}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Units: {variant.unitsPerVariant}</span>
                      <span className="font-mono">{variant.barcode || "No barcode"}</span>
                    </div>
                    <div className="mt-2">
                      <Badge variant="outline" className={`text-[10px] ${packageDisplay.className}`}>
                        {packageDisplay.label}
                      </Badge>
                      <p className="mt-1 text-xs text-muted-foreground">{packageDisplay.detail}</p>
                    </div>
                    <div className="flex justify-end items-center mt-2">
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onEditVariant(variant)}
                          className="min-h-[44px]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onArchiveVariant(variant)}
                          className="min-h-[44px] text-muted-foreground hover:text-foreground"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Desktop table */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Units</TableHead>
                    <TableHead>Barcode</TableHead>
                    <TableHead>Package</TableHead>
                    <TableHead>Customer sale</TableHead>
                    <TableHead className="w-[80px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sortedVariants.map((variant) => {
                    const packageDisplay = buildVariantPackageDisplay(variant);
                    return (
                      <TableRow
                        key={variant.id}
                        data-testid={`variant-row-${variant.id}`}
                      >
                        <TableCell className="font-mono">{variant.sku}</TableCell>
                        <TableCell>{variant.name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {getVariantUomDefinition(getVariantUomType(variant)).label}
                          </Badge>
                        </TableCell>
                        <TableCell>{variant.unitsPerVariant}</TableCell>
                        <TableCell className="font-mono text-sm">
                          {variant.barcode || "-"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] ${packageDisplay.className}`}>
                            {packageDisplay.label}
                          </Badge>
                          <p className="mt-1 text-xs text-muted-foreground">{packageDisplay.detail}</p>
                        </TableCell>
                        <TableCell>
                          {variant.salesEligibility === "internal_only" ? (
                            <Badge variant="outline" className="bg-slate-50 text-slate-700 border-slate-300">
                              Internal only
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-300">
                              Sellable
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => onEditVariant(variant)}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-muted-foreground hover:text-foreground"
                              onClick={() => onArchiveVariant(variant)}
                            >
                              <Archive className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <Layers className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No variants defined for this product.</p>
            <Button
              variant="link"
              onClick={onCreateVariant}
              className="text-xs mt-1"
            >
              Add your first variant
            </Button>
          </div>
        )}
        {/* Archived variants section */}
        {archivedVariants.length > 0 && (
          <div className="mt-6 pt-4 border-t border-dashed">
            <p className="text-xs font-medium text-muted-foreground mb-2">Archived ({archivedVariants.length})</p>
            <div className="space-y-1">
              {archivedVariants.map((variant) => (
                <div key={variant.id} className="flex items-center gap-3 px-3 py-2 rounded-md bg-muted/30 opacity-50">
                  <span className="font-mono text-xs">{variant.sku}</span>
                  <span className="text-xs text-muted-foreground truncate flex-1">{variant.name}</span>
                  <Badge variant="outline" className="text-[10px] h-5">Archived</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function VariantEditorDialog({
  open,
  onOpenChange,
  editingVariant,
  variantForm,
  setVariantForm,
  unitsInputRaw,
  setUnitsInputRaw,
  skuManuallyEdited,
  setSkuManuallyEdited,
  nameManuallyEdited,
  setNameManuallyEdited,
  onTypeChange,
  onUnitsChange,
  productInventoryTrackingDefault,
  onSubmit,
  isCreating,
  isUpdating,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingVariant: ProductVariantRow | null;
  variantForm: VariantFormState;
  setVariantForm: Dispatch<SetStateAction<VariantFormState>>;
  unitsInputRaw: string | null;
  setUnitsInputRaw: Dispatch<SetStateAction<string | null>>;
  skuManuallyEdited: boolean;
  setSkuManuallyEdited: Dispatch<SetStateAction<boolean>>;
  nameManuallyEdited: boolean;
  setNameManuallyEdited: Dispatch<SetStateAction<boolean>>;
  onTypeChange: (uomType: VariantUomType) => void;
  onUnitsChange: (units: number) => void;
  productInventoryTrackingDefault: boolean;
  onSubmit: () => void;
  isCreating: boolean;
  isUpdating: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingVariant ? "Edit Variant" : "Add Variant"}</DialogTitle>
          <DialogDescription className="sr-only">Form to add or edit a product variant</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select
              value={variantForm.uomType}
              onValueChange={(value) => onTypeChange(value as VariantUomType)}
            >
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VARIANT_UOM_DEFINITIONS.map((definition) => (
                  <SelectItem key={definition.type} value={definition.type}>
                    {definition.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Units Per Variant</Label>
            <Input
              type="text"
              inputMode="numeric"
              value={unitsInputRaw ?? variantForm.unitsPerVariant}
              onChange={(e) => {
                const val = e.target.value.replace(/[^0-9]/g, "");
                setUnitsInputRaw(val);
                const num = parseInt(val);
                if (num > 0) onUnitsChange(num);
              }}
              onBlur={() => {
                const num = parseInt(unitsInputRaw ?? "") || 1;
                setUnitsInputRaw(null);
                onUnitsChange(num);
              }}
              className="h-11"
              disabled={isSingleUnitVariantUomType(variantForm.uomType)}
            />
            {isSingleUnitVariantUomType(variantForm.uomType) && (
              <p className="text-xs text-muted-foreground">{getVariantUomDefinition(variantForm.uomType).label} is always one inventory unit.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>SKU</Label>
            <Input
              value={variantForm.sku}
              onChange={(e) => {
                setSkuManuallyEdited(true);
                setVariantForm((prev) => ({ ...prev, sku: e.target.value }));
              }}
              className="h-11 font-mono"
            />
            {!skuManuallyEdited && (
              <p className="text-xs text-muted-foreground">Auto-generated from product SKU</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Display Name</Label>
            <Input
              value={variantForm.name}
              onChange={(e) => {
                setNameManuallyEdited(true);
                setVariantForm((prev) => ({ ...prev, name: e.target.value }));
              }}
              className="h-11"
            />
            {!nameManuallyEdited && (
              <p className="text-xs text-muted-foreground">Auto-generated from product name</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Barcode</Label>
            <Input
              value={variantForm.barcode}
              onChange={(e) => setVariantForm((prev) => ({ ...prev, barcode: e.target.value }))}
              placeholder="Optional"
              className="h-11"
            />
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <div>
              <Label className="text-sm font-medium">Fulfillment &amp; Inventory</Label>
              <p className="text-xs text-muted-foreground">
                Digital variants bypass warehouse ATP, reservations, picking, and channel quantity publication.
              </p>
            </div>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="variant-sales-eligibility">Customer sale eligibility</Label>
                <Select
                  value={variantForm.salesEligibility}
                  onValueChange={(value) => setVariantForm((prev) => ({
                    ...prev,
                    salesEligibility: value as VariantSalesEligibility,
                  }))}
                >
                  <SelectTrigger id="variant-sales-eligibility" className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sellable">Sellable to customers</SelectItem>
                    <SelectItem value="internal_only">Internal build / inventory only</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Internal-only variants remain in physical inventory and transformation planning, but cannot be listed, allocated, published, dropshipped, or reserved as an order line.
                </p>
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="variant-requires-shipping"
                  checked={variantForm.requiresShipping}
                  onCheckedChange={(checked) => setVariantForm((prev) => ({
                    ...prev,
                    requiresShipping: checked === true,
                  }))}
                />
                <div>
                  <label htmlFor="variant-requires-shipping" className="text-sm cursor-pointer">
                    Requires shipping (physical item)
                  </label>
                  <p className="text-xs text-muted-foreground">Turn this off for gift cards, donations, and other digital items.</p>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="variant-track-inventory">Inventory tracking</Label>
                <Select
                  value={variantForm.inventoryTrackingOverride === null ? "inherit" : variantForm.inventoryTrackingOverride ? "tracked" : "untracked"}
                  disabled={!variantForm.requiresShipping}
                  onValueChange={(value) => setVariantForm((prev) => ({
                    ...prev,
                    inventoryTrackingOverride: value === "inherit" ? null : value === "tracked",
                  }))}
                >
                  <SelectTrigger id="variant-track-inventory"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inherit">Inherit product ({productInventoryTrackingDefault ? "tracked" : "not tracked"})</SelectItem>
                    <SelectItem value="tracked">Track inventory</SelectItem>
                    <SelectItem value="untracked">Do not track inventory</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Effective: {!variantForm.requiresShipping ? "not tracked (digital item)" : (variantForm.inventoryTrackingOverride ?? productInventoryTrackingDefault) ? "tracked" : "not tracked"}.
                  Physical items still require pick confirmation when tracking is off.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-md border p-3 space-y-3">
            <div>
              <Label className="text-sm font-medium">Package Details</Label>
              <p className="text-xs text-muted-foreground">
                Stored on the variant and used by connected sales channels. Unspecified fields preserve existing channel package data; they do not erase it.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="variant-package-weight">Weight (lb)</Label>
                <Input
                  id="variant-package-weight"
                  type="number"
                  min="0"
                  step="0.001"
                  value={variantForm.package.weightLb}
                  onChange={(e) => setVariantForm((prev) => ({ ...prev, package: { ...prev.package, weightLb: e.target.value } }))}
                  placeholder="0.25"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="variant-package-length">Length (in)</Label>
                <Input
                  id="variant-package-length"
                  type="number"
                  min="0"
                  step="0.001"
                  value={variantForm.package.lengthIn}
                  onChange={(e) => setVariantForm((prev) => ({ ...prev, package: { ...prev.package, lengthIn: e.target.value } }))}
                  placeholder="8"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="variant-package-width">Width (in)</Label>
                <Input
                  id="variant-package-width"
                  type="number"
                  min="0"
                  step="0.001"
                  value={variantForm.package.widthIn}
                  onChange={(e) => setVariantForm((prev) => ({ ...prev, package: { ...prev.package, widthIn: e.target.value } }))}
                  placeholder="4"
                  className="h-11"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="variant-package-height">Height (in)</Label>
                <Input
                  id="variant-package-height"
                  type="number"
                  min="0"
                  step="0.001"
                  value={variantForm.package.heightIn}
                  onChange={(e) => setVariantForm((prev) => ({ ...prev, package: { ...prev.package, heightIn: e.target.value } }))}
                  placeholder="1"
                  className="h-11"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="variant-ships-in-own-container"
                  checked={variantForm.shipsInOwnContainer}
                  onCheckedChange={(checked) => setVariantForm((prev) => ({ ...prev, shipsInOwnContainer: checked === true }))}
                />
                <label htmlFor="variant-ships-in-own-container" className="text-sm cursor-pointer">
                  Ships in its own container (no outer box)
                </label>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="variant-max-units-per-package" className="text-sm">Max units per package</Label>
                <Input
                  id="variant-max-units-per-package"
                  type="number"
                  min="1"
                  step="1"
                  value={variantForm.maxUnitsPerPackage}
                  onChange={(e) => setVariantForm((prev) => ({ ...prev, maxUnitsPerPackage: e.target.value }))}
                  placeholder="No cap"
                  className="h-9 w-28"
                />
              </div>
            </div>
          </div>

          {editingVariant && (
            <VariantShippingBehavior
              variantId={editingVariant.id}
              sku={editingVariant.sku}
              name={editingVariant.name}
              shipsInOwnContainer={variantForm.shipsInOwnContainer}
            />
          )}

          <p className="text-xs text-muted-foreground">Physical SKU details do not authorize conversions. Manage allowed directions and recipes in Inventory behavior on the Variants tab.</p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={isCreating || isUpdating}
          >
            {editingVariant
              ? isUpdating
                ? "Saving..."
                : "Save Changes"
              : isCreating
                ? "Creating..."
                : "Create Variant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
