import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Package, Save, Loader2, MapPin } from "lucide-react";
import {
  getVariantUomDefinition,
  inferLegacyVariantUomType,
} from "@shared/catalog/variant-uom";
import {
  CUBIC_CM_PER_CUBIC_INCH,
  GRAMS_PER_OUNCE,
  formatMeasurementInput,
  toStoredIntegerMeasurement,
  type InventoryRow,
} from "./product-detail-types-and-helpers";

export function ProductInventoryTab({ productId }: { productId: number }) {
  const { data: rows = [], isLoading } = useQuery<InventoryRow[]>({
    queryKey: [`/api/products/${productId}/inventory`],
    enabled: !!productId,
  });

  // Group by variant
  const variantGroups = rows.reduce<Record<number, { variant: InventoryRow; levels: InventoryRow[] }>>((acc, row) => {
    if (!acc[row.variant_id]) {
      acc[row.variant_id] = { variant: row, levels: [] };
    }
    if (row.level_id && row.variant_qty !== null) {
      acc[row.variant_id].levels.push(row);
    }
    return acc;
  }, {});

  const variantList = Object.values(variantGroups);

  const locationTypeBadge = (type: string | null) => {
    const colors: Record<string, string> = {
      pick: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      reserve: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      receiving: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      floor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
      pallet: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-400",
    };
    return (
      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${colors[type || ""] || "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
        {type || "—"}
      </span>
    );
  };

  return (
    <Card>
      <CardHeader className="p-3 md:p-6">
        <CardTitle className="text-base md:text-lg">Inventory Levels</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          Stock levels across warehouse locations for all variants
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">
            <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin opacity-50" />
            <p className="text-sm">Loading inventory...</p>
          </div>
        ) : variantList.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Package className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No variants found for this product.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {variantList.map(({ variant, levels }) => {
              const totalQty = levels.reduce((sum, l) => sum + (l.variant_qty || 0), 0);
              const totalReserved = levels.reduce((sum, l) => sum + (l.reserved_qty || 0), 0);
              const available = totalQty - totalReserved;
              const hierLabel = getVariantUomDefinition(inferLegacyVariantUomType({
                hierarchyLevel: variant.hierarchy_level,
                unitsPerVariant: variant.units_per_variant,
                isBaseUnit: variant.is_base_unit,
              })).label;

              return (
                <div key={variant.variant_id} className="border rounded-lg">
                  {/* Variant header */}
                  <div className="flex items-center justify-between p-3 bg-muted/50 rounded-t-lg">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs">{hierLabel}</Badge>
                      <span className="font-mono text-sm font-medium">{variant.sku}</span>
                      {variant.variant_name && variant.variant_name !== variant.sku && (
                        <span className="text-xs text-muted-foreground hidden sm:inline">{variant.variant_name}</span>
                      )}
                      {variant.units_per_variant > 1 && (
                        <span className="text-[10px] text-muted-foreground">({variant.units_per_variant} units)</span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-sm">
                      <div className="text-right">
                        <div className="font-semibold">{totalQty.toLocaleString()}</div>
                        <div className="text-[10px] text-muted-foreground">on hand</div>
                      </div>
                      {totalReserved > 0 && (
                        <div className="text-right">
                          <div className="text-amber-600 font-medium">{totalReserved.toLocaleString()}</div>
                          <div className="text-[10px] text-muted-foreground">reserved</div>
                        </div>
                      )}
                      <div className="text-right">
                        <div className={`font-semibold ${available < 0 ? "text-red-600" : available === 0 ? "text-muted-foreground" : "text-green-600"}`}>
                          {available.toLocaleString()}
                        </div>
                        <div className="text-[10px] text-muted-foreground">available</div>
                      </div>
                    </div>
                  </div>

                  {/* Location breakdown */}
                  {levels.length === 0 ? (
                    <div className="p-3 text-xs text-muted-foreground italic">No inventory at any location</div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="text-xs py-1.5 px-3">Location</TableHead>
                          <TableHead className="text-xs py-1.5 px-3">Type</TableHead>
                          <TableHead className="text-xs py-1.5 px-3 hidden sm:table-cell">Warehouse</TableHead>
                          <TableHead className="text-xs py-1.5 px-3 text-right">On Hand</TableHead>
                          <TableHead className="text-xs py-1.5 px-3 text-right hidden sm:table-cell">Reserved</TableHead>
                          <TableHead className="text-xs py-1.5 px-3 text-right hidden sm:table-cell">Picked</TableHead>
                          <TableHead className="text-xs py-1.5 px-3 text-right">Available</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {levels.map((l) => {
                          const avail = (l.variant_qty || 0) - (l.reserved_qty || 0);
                          return (
                            <TableRow key={l.level_id} className="text-xs">
                              <TableCell className="py-1.5 px-3 font-mono font-medium">
                                <div className="flex items-center gap-1.5">
                                  <MapPin className="h-3 w-3 text-muted-foreground" />
                                  {l.location_code}
                                  {l.zone && <span className="text-muted-foreground">({l.zone})</span>}
                                </div>
                              </TableCell>
                              <TableCell className="py-1.5 px-3">{locationTypeBadge(l.location_type)}</TableCell>
                              <TableCell className="py-1.5 px-3 hidden sm:table-cell text-muted-foreground">{l.warehouse_name || "—"}</TableCell>
                              <TableCell className="py-1.5 px-3 text-right font-medium">{(l.variant_qty || 0).toLocaleString()}</TableCell>
                              <TableCell className="py-1.5 px-3 text-right hidden sm:table-cell text-amber-600">
                                {(l.reserved_qty || 0) > 0 ? (l.reserved_qty || 0).toLocaleString() : "—"}
                              </TableCell>
                              <TableCell className="py-1.5 px-3 text-right hidden sm:table-cell text-muted-foreground">
                                {(l.picked_qty || 0) > 0 ? (l.picked_qty || 0).toLocaleString() : "—"}
                              </TableCell>
                              <TableCell className={`py-1.5 px-3 text-right font-medium ${avail < 0 ? "text-red-600" : avail === 0 ? "text-muted-foreground" : ""}`}>
                                {avail.toLocaleString()}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Shipping behavior (shipping-engine rider/void attributes) for a single variant ---
// SIOC itself is canonical on the variant and edited in Package Details above;
// this panel edits only rider/void behavior (shipping.variant_shipping_attrs).
interface VariantShippingAttrsRow {
  productVariantId: number;
  shipsInOwnContainer: boolean;
  riderEligible: boolean;
  riderVoidCm3: number | null;
  riderVoidMaxWeightGrams: number | null;
  riderVoidMaxItems: number | null;
  notes: string | null;
}

export function VariantShippingBehavior({
  variantId,
  sku,
  name,
  shipsInOwnContainer,
}: {
  variantId: number;
  sku: string | null;
  name: string;
  shipsInOwnContainer: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const searchTerm = (sku || name || "").trim();
  const attrsUrl = `/api/shipping/admin/variant-attrs?search=${encodeURIComponent(searchTerm)}`;
  const { data } = useQuery<{ rows: VariantShippingAttrsRow[] }>({
    queryKey: [attrsUrl],
    queryFn: async () => {
      const res = await fetch(attrsUrl, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch shipping attributes");
      return res.json();
    },
    enabled: searchTerm.length > 0,
  });
  const row = data?.rows?.find((r) => r.productVariantId === variantId) || null;

  const [shippingForm, setShippingForm] = useState({
    riderEligible: false,
    riderVoidIn3: "",
    riderVoidMaxWeightOz: "",
    riderVoidMaxItems: "",
  });
  const [shippingDirty, setShippingDirty] = useState(false);

  useEffect(() => {
    setShippingForm({
      riderEligible: row?.riderEligible ?? false,
      riderVoidIn3: formatMeasurementInput(row?.riderVoidCm3, CUBIC_CM_PER_CUBIC_INCH),
      riderVoidMaxWeightOz: formatMeasurementInput(row?.riderVoidMaxWeightGrams, GRAMS_PER_OUNCE),
      riderVoidMaxItems: row?.riderVoidMaxItems != null ? String(row.riderVoidMaxItems) : "",
    });
    setShippingDirty(false);
  }, [row, variantId]);

  const saveShippingMutation = useMutation({
    mutationFn: async () => {
      const riderVoidCm3 = shipsInOwnContainer
        ? toStoredIntegerMeasurement(shippingForm.riderVoidIn3, "Rider void volume", CUBIC_CM_PER_CUBIC_INCH)
        : null;
      const riderVoidMaxWeightGrams = shipsInOwnContainer
        ? toStoredIntegerMeasurement(shippingForm.riderVoidMaxWeightOz, "Rider void max weight", GRAMS_PER_OUNCE)
        : null;
      let riderVoidMaxItems: number | null = null;
      if (shipsInOwnContainer && shippingForm.riderVoidMaxItems.trim()) {
        const parsed = parseInt(shippingForm.riderVoidMaxItems.trim());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new Error("Rider void max items must be a positive whole number.");
        }
        riderVoidMaxItems = parsed;
      }
      const res = await fetch("/api/shipping/admin/variant-attrs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          productVariantId: variantId,
          riderEligible: shippingForm.riderEligible,
          riderVoidCm3,
          riderVoidMaxWeightGrams,
          riderVoidMaxItems,
          notes: row?.notes ?? null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to save shipping behavior");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/shipping/admin"),
      });
      toast({ title: "Shipping behavior saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save shipping behavior", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="rounded-md border p-3 space-y-3">
      <div>
        <Label className="text-sm font-medium">Shipping behavior</Label>
        <p className="text-xs text-muted-foreground">
          Rider/void packing attributes used by the shipping engine's cartonizer. Ships-in-own-container is set in Package Details above.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="variant-shipping-rider"
            checked={shippingForm.riderEligible}
            onCheckedChange={(checked) => {
              setShippingForm((prev) => ({ ...prev, riderEligible: checked === true }));
              setShippingDirty(true);
            }}
          />
          <label htmlFor="variant-shipping-rider" className="text-sm cursor-pointer">
            Rider eligible
          </label>
        </div>
      </div>
      {shipsInOwnContainer && (
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Rider void (in³)</Label>
            <Input
              type="number"
              min="0"
              step="0.001"
              value={shippingForm.riderVoidIn3}
              onChange={(e) => {
                setShippingForm((prev) => ({ ...prev, riderVoidIn3: e.target.value }));
                setShippingDirty(true);
              }}
              placeholder="Optional"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Void max wt (oz)</Label>
            <Input
              type="number"
              min="0"
              step="0.001"
              value={shippingForm.riderVoidMaxWeightOz}
              onChange={(e) => {
                setShippingForm((prev) => ({ ...prev, riderVoidMaxWeightOz: e.target.value }));
                setShippingDirty(true);
              }}
              placeholder="Optional"
              className="h-11"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Void max items</Label>
            <Input
              type="number"
              min="0"
              step="1"
              value={shippingForm.riderVoidMaxItems}
              onChange={(e) => {
                setShippingForm((prev) => ({ ...prev, riderVoidMaxItems: e.target.value }));
                setShippingDirty(true);
              }}
              placeholder="Optional"
              className="h-11"
            />
          </div>
        </div>
      )}
      {shippingDirty && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="min-h-[32px]"
            onClick={() => saveShippingMutation.mutate()}
            disabled={saveShippingMutation.isPending}
          >
            {saveShippingMutation.isPending ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5 mr-1.5" />
            )}
            Save shipping behavior
          </Button>
        </div>
      )}
    </div>
  );
}
