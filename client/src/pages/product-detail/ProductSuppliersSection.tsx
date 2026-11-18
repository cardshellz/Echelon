import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Truck, Trash2 } from "lucide-react";
import {
  VendorCatalogQuoteEditor,
  buildVendorCatalogQuoteWrite,
  createVendorCatalogQuoteDraft,
  formatVendorCatalogQuoteSummary,
} from "@/features/supplier-catalog/VendorCatalogQuoteEditor";
import {
  createEmptySupplierMappingForm,
  supplierMappingError,
  supplierMappingSaveError,
  supplierOperationalValues,
  type SupplierMappingForm,
} from "./product-detail-types-and-helpers";

export function ProductSuppliersSection({
  productId,
  routeProductId,
  enabled,
}: {
  productId: number;
  routeProductId: number;
  enabled: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: vendorProducts = [] } = useQuery<any[]>({
    queryKey: [`/api/products/${routeProductId}/vendors`],
    enabled: !!routeProductId && enabled,
  });
  const { data: supplierVendors = [] } = useQuery<any[]>({
    queryKey: ["/api/vendors"],
    enabled,
  });

  const [showAddSupplierDialog, setShowAddSupplierDialog] = useState(false);
  const [supplierForm, setSupplierForm] = useState<SupplierMappingForm>(
    () => createEmptySupplierMappingForm(),
  );
  const [editingSupplierId, setEditingSupplierId] = useState<number | null>(null);
  const supplierSaveError = supplierMappingSaveError(supplierForm);

  const createSupplierMutation = useMutation({
    mutationFn: async (data: SupplierMappingForm) => {
      const quoteWrite = buildVendorCatalogQuoteWrite(data.quote);
      const operationalValues = supplierOperationalValues(data);
      const res = await fetch("/api/vendor-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorId: data.vendorId,
          productId,
          vendorSku: data.vendorSku || null,
          ...quoteWrite,
          ...operationalValues,
          isPreferred: data.isPreferred ? 1 : 0,
          isActive: 1,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw await supplierMappingError(res, "Failed to add supplier");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}/vendors`] });
      setShowAddSupplierDialog(false);
      setSupplierForm(createEmptySupplierMappingForm());
      toast({ title: "Supplier added" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add supplier", description: error.message, variant: "destructive" });
    },
  });

  const updateSupplierMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: SupplierMappingForm }) => {
      const quoteWrite = buildVendorCatalogQuoteWrite(data.quote, data.originalQuote);
      const operationalValues = supplierOperationalValues(data);
      const res = await fetch(`/api/vendor-products/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vendorSku: data.vendorSku || null,
          ...quoteWrite,
          ...operationalValues,
          isPreferred: data.isPreferred ? 1 : 0,
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw await supplierMappingError(res, "Failed to update supplier");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}/vendors`] });
      setEditingSupplierId(null);
      setShowAddSupplierDialog(false);
      setSupplierForm(createEmptySupplierMappingForm());
      toast({ title: "Supplier updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update supplier", description: error.message, variant: "destructive" });
    },
  });

  const deleteSupplierMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/vendor-products/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to remove supplier");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}/vendors`] });
      toast({ title: "Supplier removed" });
    },
    onError: () => {
      toast({ title: "Failed to remove supplier", variant: "destructive" });
    },
  });

  return (
    <>
      <Card>
        <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base md:text-lg">Suppliers</CardTitle>
            <CardDescription className="text-xs md:text-sm">
              Vendors that supply this product, with negotiated costs and lead times
            </CardDescription>
          </div>
          <Button size="sm" className="min-h-[44px]" onClick={() => {
            setEditingSupplierId(null);
            setSupplierForm(createEmptySupplierMappingForm());
            setShowAddSupplierDialog(true);
          }}>
            <Plus className="h-4 w-4 mr-2" />
            Add Supplier
          </Button>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          {vendorProducts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Truck className="h-10 w-10 mx-auto mb-2 opacity-50" />
              <p className="text-sm">No suppliers linked to this product yet.</p>
              <p className="text-xs mt-1">Add a supplier to enable auto-population of PO costs and vendor SKUs.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {vendorProducts.map((vp: any) => {
                const vendor = supplierVendors.find((v: any) => v.id === vp.vendorId);
                const quoteSummary = formatVendorCatalogQuoteSummary(vp);
                return (
                  <div key={vp.id} className="border rounded-md p-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{vendor?.name || `Vendor #${vp.vendorId}`}</span>
                        {vp.isPreferred === 1 && (
                          <Badge variant="default" className="text-[10px] px-1.5 py-0">Preferred</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                        {vp.vendorSku && <span>Vendor SKU: <span className="font-mono">{vp.vendorSku}</span></span>}
                        <span>{quoteSummary.amount}</span>
                        <span className={quoteSummary.reviewRequired ? "text-amber-700" : ""}>
                          {quoteSummary.detail}
                        </span>
                        {vp.packSize > 1 && <span>Pack: {vp.packSize}</span>}
                        {vp.moq > 1 && <span>MOQ: {vp.moq} base pieces</span>}
                        {vp.leadTimeDays > 0 && <span>Lead: {vp.leadTimeDays}d</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => {
                        setEditingSupplierId(vp.id);
                        setSupplierForm({
                          vendorId: vp.vendorId,
                          vendorSku: vp.vendorSku || "",
                          packSize: String(vp.packSize || 1),
                          moq: String(vp.moq || 1),
                          leadTimeDays: vp.leadTimeDays != null ? String(vp.leadTimeDays) : "",
                          isPreferred: vp.isPreferred === 1,
                          notes: vp.notes || "",
                          quote: createVendorCatalogQuoteDraft(vp),
                          originalQuote: vp,
                        });
                        setShowAddSupplierDialog(true);
                      }}>
                        <Pencil className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-600" onClick={() => deleteSupplierMutation.mutate(vp.id)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Supplier Dialog */}
      <Dialog open={showAddSupplierDialog} onOpenChange={setShowAddSupplierDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle>{editingSupplierId ? "Edit Supplier" : "Add Supplier"}</DialogTitle>
            <DialogDescription className="sr-only">Form to add or edit a supplier</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {!editingSupplierId && (
              <div>
                <Label className="text-sm">Vendor</Label>
                <Select value={supplierForm.vendorId ? String(supplierForm.vendorId) : ""} onValueChange={(v) => setSupplierForm((prev) => ({ ...prev, vendorId: parseInt(v) }))}>
                  <SelectTrigger className="h-11">
                    <SelectValue placeholder="Select vendor..." />
                  </SelectTrigger>
                  <SelectContent>
                    {supplierVendors.filter((v: any) => v.active !== 0).map((v: any) => (
                      <SelectItem key={v.id} value={String(v.id)}>{v.name} ({v.code})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div>
              <Label className="text-sm">Vendor SKU</Label>
              <Input className="h-11" value={supplierForm.vendorSku} onChange={(e) => setSupplierForm((prev) => ({ ...prev, vendorSku: e.target.value }))} placeholder="Vendor's catalog #" />
            </div>

            <VendorCatalogQuoteEditor
              value={supplierForm.quote}
              onChange={(quote) => setSupplierForm((previous) => ({ ...previous, quote }))}
            />

            <div className="grid grid-cols-3 gap-4">
              <div>
                <Label className="text-sm">Operational pack</Label>
                <Input className="h-11" type="number" min="1" step="1" value={supplierForm.packSize} onChange={(e) => setSupplierForm((prev) => ({ ...prev, packSize: e.target.value }))} />
              </div>
              <div>
                <Label className="text-sm">MOQ (base pieces)</Label>
                <Input className="h-11" type="number" min="1" step="1" value={supplierForm.moq} onChange={(e) => setSupplierForm((prev) => ({ ...prev, moq: e.target.value }))} />
              </div>
              <div>
                <Label className="text-sm">Lead Time (d)</Label>
                <Input className="h-11" type="number" min="0" step="1" value={supplierForm.leadTimeDays} onChange={(e) => setSupplierForm((prev) => ({ ...prev, leadTimeDays: e.target.value }))} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              MOQ is counted in base pieces and is independent of the supplier quote UOM and warehouse receiving configuration.
            </p>
            <div className="flex items-center gap-2">
              <Checkbox checked={supplierForm.isPreferred} onCheckedChange={(checked) => setSupplierForm((prev) => ({ ...prev, isPreferred: !!checked }))} />
              <Label className="text-sm">Preferred supplier (used for auto-PO generation)</Label>
            </div>
            <div>
              <Label className="text-sm">Notes</Label>
              <Textarea value={supplierForm.notes} onChange={(e) => setSupplierForm((prev) => ({ ...prev, notes: e.target.value }))} placeholder="Optional notes..." rows={2} />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowAddSupplierDialog(false)}>Cancel</Button>
              <Button className="min-h-[44px]" disabled={!supplierForm.vendorId || !!supplierSaveError || createSupplierMutation.isPending || updateSupplierMutation.isPending}
                onClick={() => {
                  if (editingSupplierId) {
                    updateSupplierMutation.mutate({ id: editingSupplierId, data: supplierForm });
                  } else {
                    createSupplierMutation.mutate(supplierForm);
                  }
                }}>
                {editingSupplierId ? "Update" : "Add Supplier"}
              </Button>
            </div>
            {supplierSaveError && (
              <p className="text-xs text-amber-700 text-right" aria-live="polite">
                {supplierSaveError}
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
