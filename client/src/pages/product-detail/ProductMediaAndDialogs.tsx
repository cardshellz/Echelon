import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import {
  Image as ImageIcon,
  Plus,
  Loader2,
  Archive,
  CircleCheck,
  CircleAlert,
  ArrowRightLeft,
  ChevronsUpDown,
  Check,
  Upload,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useInventoryCommand } from "@/lib/inventory-command";
import { ProductImageGallery } from "@/components/catalog/ProductImageGallery";
import { invalidateCatalogImages } from "@/lib/catalog-image-queries";
import { saveProductAssetScope, type ProductAssetScopeAttempt } from "@/lib/product-asset-scope";
import type { ReorderProductAssets } from "@shared/catalog/product-assets";
import { transformationQueryKey } from "@/features/inventory-builds/package-conversion-draft";
import type {
  ProductArchiveDependencies,
  ProductDetailData,
  ProductVariantRow,
  TransferTargetVariant,
  VariantArchiveDependencies,
} from "./product-detail-types-and-helpers";

export function ProductImagesSection({
  product,
  routeProductId,
}: {
  product: ProductDetailData;
  routeProductId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [addImageUrl, setAddImageUrl] = useState("");
  const [addImageAlt, setAddImageAlt] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refreshImageReferences = () => invalidateCatalogImages(queryClient, routeProductId);

  const scopeMutation = useMutation({
    mutationFn: (attempt: ProductAssetScopeAttempt) => saveProductAssetScope(product.productId, attempt),
    onSettled: refreshImageReferences,
  });

  const addAssetMutation = useMutation({
    mutationFn: async ({ url, altText }: { url: string; altText: string }) => {
      const res = await fetch(`/api/products/${product.productId}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, altText: altText || null, assetType: "image", productVariantId: null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "Failed to add image");
      }
      return res.json();
    },
    onSuccess: async (data: { publicationWarning?: { message: string } }) => {
      await refreshImageReferences();
      setAddImageUrl("");
      setAddImageAlt("");
      toast({ title: "Image added", ...(data.publicationWarning ? { description: data.publicationWarning.message } : {}) });
    },
    onError: (error: Error) => {
      toast({ title: "Could not add image", description: error.message, variant: "destructive" });
    },
  });

  const uploadFileMutation = useMutation({
    mutationFn: async ({ file, altText, isPrimary }: { file: File; altText?: string; isPrimary?: boolean }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("productId", String(product.productId));
      if (altText) formData.append("altText", altText);
      if (isPrimary) formData.append("isPrimary", "true");

      const res = await fetch("/api/product-assets/upload", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : "Failed to upload image");
      }
      return res.json();
    },
    onSuccess: async (data: { publicationWarning?: { message: string } }) => {
      await refreshImageReferences();
      toast({ title: "Image uploaded", ...(data.publicationWarning ? { description: data.publicationWarning.message } : {}) });
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const res = await fetch(`/api/product-assets/${assetId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete image");
    },
    onSuccess: async () => {
      await refreshImageReferences();
      toast({ title: "Image removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not remove image", description: error.message, variant: "destructive" });
    },
  });

  const setPrimaryMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const res = await fetch(`/api/product-assets/${assetId}/primary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.productId }),
      });
      if (!res.ok) throw new Error("Failed to set primary");
    },
    onSuccess: async () => {
      await refreshImageReferences();
      toast({ title: "Primary image updated" });
    },
    onError: (error: Error) => {
      toast({ title: "Could not update primary image", description: error.message, variant: "destructive" });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (command: ReorderProductAssets) => {
      const res = await fetch(`/api/products/${product.productId}/assets/reorder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(typeof body?.error === "string" ? body.error : "Refresh the gallery and try again.");
      }
    },
    onSettled: async () => {
      await refreshImageReferences();
    },
  });

  return (
    <Card>
      <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-base md:text-lg">Product Images</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Shared photos apply to all variants. Variant photos apply only to the selected SKU.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
        <p className="text-xs text-muted-foreground">New photos are shared with all variants. Use Applies to on a photo to assign it to one variant.</p>
        {/* Add image by URL */}
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            value={addImageUrl}
            onChange={(e) => setAddImageUrl(e.target.value)}
            placeholder="Image URL"
            className="h-9 flex-1"
          />
          <Input
            value={addImageAlt}
            onChange={(e) => setAddImageAlt(e.target.value)}
            placeholder="Alt text (optional)"
            className="h-9 sm:w-48"
          />
          <Button
            size="sm"
            onClick={() => addImageUrl && addAssetMutation.mutate({ url: addImageUrl, altText: addImageAlt })}
            disabled={!addImageUrl || addAssetMutation.isPending}
            className="min-h-[36px]"
          >
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>

        {/* Upload file */}
        <div className="flex flex-col sm:flex-row gap-2 items-center">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                const isFirstImage = !product.assets || product.assets.length === 0;
                uploadFileMutation.mutate({ file, isPrimary: isFirstImage });
              }
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadFileMutation.isPending}
            className="min-h-[36px]"
          >
            <Upload className="h-4 w-4 mr-1" />
            {uploadFileMutation.isPending ? "Uploading..." : "Upload File"}
          </Button>
          <span className="text-xs text-muted-foreground">JPEG, PNG, WebP, GIF — max 10MB</span>
        </div>

        {/* Image gallery */}
        {product.assets && product.assets.length > 0 ? (
          <ProductImageGallery
            assets={product.assets}
            variants={product.variants}
            onScopeChange={(attempt) => scopeMutation.mutateAsync(attempt)}
            busy={scopeMutation.isPending || reorderMutation.isPending || deleteAssetMutation.isPending || setPrimaryMutation.isPending || uploadFileMutation.isPending || addAssetMutation.isPending}
            onReorder={(command) => reorderMutation.mutateAsync(command)}
            onSetPrimary={(assetId) => setPrimaryMutation.mutate(assetId)}
            onRemove={(assetId) => deleteAssetMutation.mutate(assetId)}
          />
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <ImageIcon className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No images yet.</p>
            <p className="text-xs">Add images by URL above, or sync from Shopify.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function DeleteProductDialog({
  open,
  onOpenChange,
  product,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetailData;
  onDeleted: () => void;
}) {
  const { toast } = useToast();

  const deleteProductMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products/${product.productId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || body?.error || "Failed to delete product");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Product deleted" });
      onDeleted();
    },
    onError: (err: Error) => {
      toast({ title: "Failed to delete product", description: err.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Product</DialogTitle>
          <DialogDescription className="sr-only">Confirm product deletion</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Permanently delete <strong>{product.name}</strong> ({product.sku}) and all its variants? This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => { deleteProductMutation.mutate(); onOpenChange(false); }}
            disabled={deleteProductMutation.isPending}
          >
            {deleteProductMutation.isPending ? "Deleting..." : "Delete Permanently"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DuplicateProductDialog({
  open,
  onOpenChange,
  product,
  routeProductId,
  onDuplicated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetailData;
  routeProductId: number;
  onDuplicated: (createdId: number) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dupName, setDupName] = useState("");
  const [dupSku, setDupSku] = useState("");
  const [dupVariantSkus, setDupVariantSkus] = useState<Record<number, string>>({});

  const activeVariants = (product.variants ?? []).filter((v) => v.isActive);

  useEffect(() => {
    if (!open) return;
    setDupName(`${product.name} (Copy)`);
    setDupSku(product.sku ? `${product.sku}-COPY` : "");
    const seed: Record<number, string> = {};
    for (const v of product.variants.filter((vv) => vv.isActive)) {
      seed[v.id] = v.sku ? `${v.sku}-COPY` : "";
    }
    setDupVariantSkus(seed);
  }, [open, product]);

  const duplicateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/products/${routeProductId}/duplicate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: dupName.trim(),
          sku: dupSku.trim(),
          status: "draft",
          variants: Object.entries(dupVariantSkus).map(([sourceVariantId, sku]) => ({
            sourceVariantId: Number(sourceVariantId),
            sku: (sku ?? "").trim(),
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || "Failed to duplicate product");
      }
      return res.json();
    },
    onSuccess: (created: { id: number }) => {
      toast({ title: "Product duplicated", description: "Choose and apply this copy's inventory behavior before activating it. Conversion permissions and recipes were not copied." });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      onDuplicated(created.id);
    },
    onError: (err: Error) => {
      toast({ title: "Duplicate failed", description: err.message, variant: "destructive" });
    },
  });

  const duplicateValid =
    dupName.trim().length > 0 &&
    dupSku.trim().length > 0 &&
    activeVariants.every((v) => (dupVariantSkus[v.id] ?? "").trim().length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            Duplicate Product
          </DialogTitle>
          <DialogDescription>
            Creates a new <strong>draft</strong> product with these details prefilled. Base fields, images,
            category, brand and procurement settings are copied. Inventory, channels, pick locations and
            suppliers are not. Conversion directions and recipe bindings are not copied. Next, choose and review
            this copy's Inventory behavior on its Variants tab.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="dup-name">Product name</Label>
            <Input id="dup-name" value={dupName} onChange={(e) => setDupName(e.target.value)} data-testid="input-dup-name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dup-sku">Base SKU</Label>
            <Input
              id="dup-sku"
              value={dupSku}
              onChange={(e) => setDupSku(e.target.value)}
              className="font-mono"
              placeholder="New base SKU (required)"
              data-testid="input-dup-sku"
            />
          </div>
          {activeVariants.length > 0 && (
            <div className="space-y-2">
              <Label>Variant SKUs ({activeVariants.length})</Label>
              <p className="text-xs text-muted-foreground">Each variant needs its own new, unique SKU.</p>
              {activeVariants.map((v) => (
                <div key={v.id} className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate" title={v.name}>{v.name}</span>
                  <Input
                    value={dupVariantSkus[v.id] ?? ""}
                    onChange={(e) => setDupVariantSkus((p) => ({ ...p, [v.id]: e.target.value }))}
                    className="font-mono w-48"
                    aria-label={`New SKU for ${v.name}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => duplicateMutation.mutate()}
            disabled={!duplicateValid || duplicateMutation.isPending}
            data-testid="btn-confirm-duplicate"
          >
            {duplicateMutation.isPending ? "Duplicating..." : "Create Draft Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveProductDialog({
  open,
  onOpenChange,
  product,
  routeProductId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  product: ProductDetailData;
  routeProductId: number;
}) {
  const inventoryCommand = useInventoryCommand();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [archiveDeps, setArchiveDeps] = useState<ProductArchiveDependencies | null>(null);
  const [archiveScanning, setArchiveScanning] = useState(false);
  const [transferMode, setTransferMode] = useState(false);
  const [transferTargetVariant, setTransferTargetVariant] = useState<TransferTargetVariant | null>(null);
  const [variantSearchOpen, setVariantSearchOpen] = useState(false);
  const [variantSearchQuery, setVariantSearchQuery] = useState("");

  const variantSearchResults = useQuery<{ sku: string; name: string; productVariantId: number; productId: number; unitsPerVariant: number }[]>({
    queryKey: ["/api/inventory/skus/search", variantSearchQuery],
    queryFn: async () => {
      if (!variantSearchQuery || variantSearchQuery.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(variantSearchQuery)}&limit=20`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: variantSearchQuery.length >= 2,
  });

  const filteredSearchResults = (variantSearchResults.data ?? []).filter(
    (v) => v.productId !== product.productId
  );

  const scanArchiveDeps = useCallback(async () => {
    if (!product.productId) return;
    setArchiveScanning(true);
    try {
      const res = await fetch(`/api/products/${product.productId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      if (!res.ok) {
        toast({ title: `Archive scan failed: ${res.status} ${res.statusText}`, variant: "destructive" });
        return;
      }
      const data = await res.json();
      setArchiveDeps(data);
    } catch {
      toast({ title: "Failed to scan dependencies", variant: "destructive" });
    } finally {
      setArchiveScanning(false);
    }
  }, [product.productId, toast]);

  useEffect(() => {
    if (!open) {
      setArchiveDeps(null);
      setTransferMode(false);
      setTransferTargetVariant(null);
      setVariantSearchQuery("");
      return;
    }
    void scanArchiveDeps();
  }, [open, scanArchiveDeps]);

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = { force: true };
      if (transferMode && transferTargetVariant) {
        body.transferToVariantId = transferTargetVariant.id;
      }
      return inventoryCommand<{ archived: { inventoryTransferred: number; variants: number; inventoryPreserved: number } }>(`/api/products/${product.productId}/archive`, body);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      const msg = data.archived.inventoryTransferred > 0
        ? `Archived: transferred ${data.archived.inventoryTransferred} units, ${data.archived.variants} variants deactivated`
        : `Archived: ${data.archived.variants} variants deactivated, ${data.archived.inventoryPreserved} inventory units preserved`;
      toast({ title: msg });
      if (product.productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(product.productId) });
      onOpenChange(false);
      setArchiveDeps(null);
      setTransferMode(false);
      setTransferTargetVariant(null);
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to archive product", variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      onOpenChange(nextOpen);
      if (!nextOpen) { setArchiveDeps(null); setTransferMode(false); setTransferTargetVariant(null); setVariantSearchQuery(""); }
    }}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto p-4", transferMode ? "max-w-lg" : "max-w-md")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            Archive Product
          </DialogTitle>
          <DialogDescription className="sr-only">Confirm archiving the whole product</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Archiving <span className="font-mono font-medium text-foreground">{product.sku}</span> will deactivate the product, its variants, channel feeds, and replenishment rules. Inventory, bin assignments, and channel listing identities are preserved.
          </p>

          {archiveScanning ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning dependencies...
            </div>
          ) : archiveDeps ? (
            <div className="space-y-2">
              {/* Inventory */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {archiveDeps.dependencies.inventory.totalQty > 0 ? (
                  <CircleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Inventory</p>
                  {archiveDeps.dependencies.inventory.totalQty > 0 ? (
                    <>
                      <p className="text-xs text-muted-foreground mb-1.5">
                        {archiveDeps.dependencies.inventory.variants.length} variant{archiveDeps.dependencies.inventory.variants.length !== 1 ? "s" : ""} with on-hand inventory ({archiveDeps.dependencies.inventory.totalQty.toLocaleString()} units across {archiveDeps.dependencies.inventory.bins} bin{archiveDeps.dependencies.inventory.bins !== 1 ? "s" : ""})
                      </p>
                      <div className="rounded border overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-muted/50">
                              <th className="text-left py-1 px-2 font-medium">SKU</th>
                              <th className="text-left py-1 px-2 font-medium">Bin</th>
                              <th className="text-right py-1 px-2 font-medium">Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {archiveDeps.dependencies.inventory.inventoryDetails.map((d, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="py-1 px-2 font-mono">{d.sku}</td>
                                <td className="py-1 px-2 font-mono">{d.locationCode}</td>
                                <td className="py-1 px-2 text-right">{d.variantQty}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No on-hand inventory</p>
                  )}
                </div>
              </div>

              {/* Shipments */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {archiveDeps.dependencies.shipments.pending > 0 ? (
                  <CircleAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-medium">Shipments</p>
                  <p className="text-xs text-muted-foreground">
                    {archiveDeps.dependencies.shipments.pending > 0
                      ? `${archiveDeps.dependencies.shipments.pending} in-flight shipment items`
                      : "No pending shipments"}
                  </p>
                </div>
              </div>

              {/* Channel Feeds */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {archiveDeps.dependencies.channelFeeds.active > 0 ? (
                  <CircleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-medium">Channel Feeds</p>
                  {archiveDeps.dependencies.channelFeeds.active > 0 ? (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{archiveDeps.dependencies.channelFeeds.active} active feed{archiveDeps.dependencies.channelFeeds.active !== 1 ? "s" : ""} will be deactivated:</p>
                      {archiveDeps.dependencies.channelFeeds.details?.map((d, i) => (
                        <p key={i} className="pl-2 text-foreground/70">
                          {d.channelName} — {d.variantSku}{d.channelSku ? ` (${d.channelSku})` : ""}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No active channel feeds</p>
                  )}
                </div>
              </div>

              {/* Variants */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                <CircleCheck className="h-4 w-4 text-blue-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium">Variants</p>
                  <p className="text-xs text-muted-foreground">
                    {archiveDeps.dependencies.variants.active} active variant{archiveDeps.dependencies.variants.active !== 1 ? "s" : ""} will be deactivated
                  </p>
                </div>
              </div>

              {/* Action options when blocked by inventory */}
              {archiveDeps.blocked && archiveDeps.dependencies.inventory.totalQty > 0 && (
                <div className="space-y-3 pt-1">
                  {archiveDeps.dependencies.inventory.hasReserved && (
                    <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 p-2 rounded">
                      Some inventory has reserved units (allocated to orders). Fulfill or cancel those orders before transferring.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant={transferMode ? "default" : "outline"}
                      size="sm"
                      className="flex-1 h-9"
                      disabled={archiveDeps.dependencies.inventory.hasReserved}
                      onClick={() => setTransferMode(true)}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                      Transfer &amp; Archive
                    </Button>
                    <Button
                      variant={!transferMode ? "outline" : "ghost"}
                      size="sm"
                      className="flex-1 h-9"
                      onClick={() => { setTransferMode(false); setTransferTargetVariant(null); }}
                    >
                      <Archive className="h-3.5 w-3.5 mr-1.5" />
                      Keep Inventory &amp; Archive
                    </Button>
                  </div>

                  {transferMode ? (
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs font-medium mb-1.5 block">Transfer inventory to</Label>
                        <Popover open={variantSearchOpen} onOpenChange={setVariantSearchOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" role="combobox" className="w-full justify-between h-10 font-normal">
                              {transferTargetVariant ? (
                                <span className="font-mono text-sm">{transferTargetVariant.sku}</span>
                              ) : (
                                <span className="text-muted-foreground">Search for target SKU...</span>
                              )}
                              <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50 ml-2" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                            <Command shouldFilter={false}>
                              <CommandInput
                                placeholder="Search SKU or name..."
                                value={variantSearchQuery}
                                onValueChange={setVariantSearchQuery}
                              />
                              <CommandList>
                                <CommandEmpty>{variantSearchQuery.length < 2 ? "Type to search..." : "No variants found"}</CommandEmpty>
                                <CommandGroup>
                                  {filteredSearchResults.slice(0, 50).map((v) => (
                                    <CommandItem
                                      key={v.productVariantId}
                                      value={String(v.productVariantId)}
                                      onSelect={() => {
                                        setTransferTargetVariant({ id: v.productVariantId, sku: v.sku, name: v.name, unitsPerVariant: v.unitsPerVariant });
                                        setVariantSearchOpen(false);
                                      }}
                                    >
                                      <Check className={cn("h-4 w-4 mr-2", transferTargetVariant?.id === v.productVariantId ? "opacity-100" : "opacity-0")} />
                                      <div className="flex flex-col">
                                        <span className="font-mono text-sm">{v.sku}</span>
                                        <span className="text-xs text-muted-foreground truncate">{v.name}</span>
                                      </div>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>

                      {/* Transfer preview */}
                      {transferTargetVariant && (
                        <div className="space-y-2">
                          <div className="rounded-md border overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/50">
                                  <th className="text-left py-1.5 px-2 font-medium">From SKU</th>
                                  <th className="text-left py-1.5 px-2 font-medium">Bin</th>
                                  <th className="text-right py-1.5 px-2 font-medium">Qty</th>
                                  <th className="text-center py-1.5 px-2 font-medium"></th>
                                  <th className="text-left py-1.5 px-2 font-medium">To SKU</th>
                                </tr>
                              </thead>
                              <tbody>
                                {archiveDeps.dependencies.inventory.inventoryDetails.map((d, i) => (
                                  <tr key={i} className="border-t">
                                    <td className="py-1.5 px-2 font-mono">{d.sku}</td>
                                    <td className="py-1.5 px-2 font-mono">{d.locationCode}</td>
                                    <td className="py-1.5 px-2 text-right">{d.variantQty}</td>
                                    <td className="py-1.5 px-2 text-center text-muted-foreground">→</td>
                                    <td className="py-1.5 px-2 font-mono text-green-600 dark:text-green-400">{transferTargetVariant.sku}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {archiveDeps.dependencies.inventory.totalQty.toLocaleString()} units will be transferred, then the product will be archived.
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 p-2 rounded">
                      Inventory and bin assignments will remain on this SKU. Its marketplace availability will be set to zero until the SKU is reactivated.
                    </p>
                  )}
                </div>
              )}

              {/* Simple blocked message for shipments-only blocking (no inventory) */}
              {archiveDeps.dependencies.shipments.pending > 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 p-2 rounded">
                  {archiveDeps.dependencies.shipments.pending} in-flight shipment item(s) will complete normally
                  on the archived product — fulfillment resolves by variant id, not SKU. Safe to archive now.
                </p>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} className="min-h-[44px]">
            Cancel
          </Button>
          {archiveDeps && (
            <Button
              variant="destructive"
              onClick={() => archiveMutation.mutate()}
              disabled={
                archiveMutation.isPending ||
                archiveScanning ||
                (transferMode && !transferTargetVariant)
              }
              className="min-h-[44px]"
            >
              {archiveMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Archiving...</>
              ) : transferMode && transferTargetVariant ? (
                <><ArrowRightLeft className="h-4 w-4 mr-2" />Transfer &amp; Archive</>
              ) : archiveDeps.blocked ? (
                <><Archive className="h-4 w-4 mr-2" />Keep Inventory &amp; Archive</>
              ) : (
                <><Archive className="h-4 w-4 mr-2" />Archive Product</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveVariantDialog({
  archiveVariant,
  onClose,
  productId,
  routeProductId,
}: {
  archiveVariant: ProductVariantRow | null;
  onClose: () => void;
  productId: number;
  routeProductId: number;
}) {
  const inventoryCommand = useInventoryCommand();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [variantArchiveDeps, setVariantArchiveDeps] = useState<VariantArchiveDependencies | null>(null);
  const [variantArchiveScanning, setVariantArchiveScanning] = useState(false);
  const [variantTransferMode, setVariantTransferMode] = useState(false);
  const [variantTransferTarget, setVariantTransferTarget] = useState<TransferTargetVariant | null>(null);
  const [variantTargetSearchOpen, setVariantTargetSearchOpen] = useState(false);
  const [variantTargetSearchQuery, setVariantTargetSearchQuery] = useState("");

  const variantTargetSearchResults = useQuery<{ sku: string; name: string; productVariantId: number; productId: number; unitsPerVariant: number }[]>({
    queryKey: ["/api/inventory/skus/search", variantTargetSearchQuery, "variant-archive"],
    queryFn: async () => {
      if (!variantTargetSearchQuery || variantTargetSearchQuery.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(variantTargetSearchQuery)}&limit=20`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: variantTargetSearchQuery.length >= 2,
  });

  const filteredVariantTargetResults = (variantTargetSearchResults.data ?? []).filter(
    (v) => v.productVariantId !== archiveVariant?.id
  );

  const scanVariantArchiveDeps = useCallback(async (variantId: number) => {
    setVariantArchiveScanning(true);
    try {
      const res = await fetch(`/api/product-variants/${variantId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      if (!res.ok) {
        toast({ title: `Archive scan failed: ${res.status} ${res.statusText}`, variant: "destructive" });
        return;
      }
      setVariantArchiveDeps(await res.json());
    } catch {
      toast({ title: "Failed to scan dependencies", variant: "destructive" });
    } finally {
      setVariantArchiveScanning(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!archiveVariant) {
      setVariantArchiveDeps(null);
      setVariantTransferMode(false);
      setVariantTransferTarget(null);
      setVariantTargetSearchQuery("");
      return;
    }
    void scanVariantArchiveDeps(archiveVariant.id);
  }, [archiveVariant, scanVariantArchiveDeps]);

  const variantArchiveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = { force: true };
      if (variantTransferMode && variantTransferTarget) {
        body.transferToVariantId = variantTransferTarget.id;
      }
      return inventoryCommand<{ archived: { inventoryTransferred: number; variant: { sku: string } } }>(`/api/product-variants/${archiveVariant?.id}/archive`, body);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      const msg = data.archived.inventoryTransferred > 0
        ? `Archived ${data.archived.variant.sku}: transferred ${data.archived.inventoryTransferred} units`
        : `Archived ${data.archived.variant.sku}`;
      toast({ title: msg });
      onClose();
      if (productId) queryClient.invalidateQueries({ queryKey: transformationQueryKey(productId) });
      setVariantArchiveDeps(null);
      setVariantTransferMode(false);
      setVariantTransferTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to archive variant", variant: "destructive" });
    },
  });

  return (
    <Dialog open={!!archiveVariant} onOpenChange={(open) => {
      if (!open) {
        onClose();
        setVariantArchiveDeps(null);
        setVariantTransferMode(false);
        setVariantTransferTarget(null);
        setVariantTargetSearchQuery("");
      }
    }}>
      <DialogContent className={cn("max-h-[90vh] overflow-y-auto p-4", variantTransferMode ? "max-w-lg" : "max-w-md")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            Archive Variant
          </DialogTitle>
          <DialogDescription className="sr-only">Confirm archiving the variant</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Archiving <span className="font-mono font-medium text-foreground">{archiveVariant?.sku}</span> will deactivate the variant and its channel feeds. Inventory, bin assignments, and channel listing identities are preserved.
          </p>

          {variantArchiveScanning ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-4 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              Scanning dependencies...
            </div>
          ) : variantArchiveDeps ? (
            <div className="space-y-2">
              {/* Inventory */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {variantArchiveDeps.dependencies.inventory.totalQty > 0 ? (
                  <CircleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">Inventory</p>
                  {variantArchiveDeps.dependencies.inventory.totalQty > 0 ? (
                    <>
                      <p className="text-xs text-muted-foreground mb-1.5">
                        {variantArchiveDeps.dependencies.inventory.totalQty.toLocaleString()} units across {variantArchiveDeps.dependencies.inventory.bins} bin{variantArchiveDeps.dependencies.inventory.bins !== 1 ? "s" : ""}
                      </p>
                      <div className="rounded border overflow-hidden">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-muted/50">
                              <th className="text-left py-1 px-2 font-medium">Bin</th>
                              <th className="text-right py-1 px-2 font-medium">Qty</th>
                            </tr>
                          </thead>
                          <tbody>
                            {variantArchiveDeps.dependencies.inventory.inventoryDetails.map((d, i) => (
                              <tr key={i} className={i > 0 ? "border-t" : ""}>
                                <td className="py-1 px-2 font-mono">{d.locationCode}</td>
                                <td className="py-1 px-2 text-right">{d.variantQty}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">No on-hand inventory</p>
                  )}
                </div>
              </div>

              {/* Shipments */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {variantArchiveDeps.dependencies.shipments.pending > 0 ? (
                  <CircleAlert className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-medium">Shipments</p>
                  <p className="text-xs text-muted-foreground">
                    {variantArchiveDeps.dependencies.shipments.pending > 0
                      ? `${variantArchiveDeps.dependencies.shipments.pending} in-flight shipment items`
                      : "No pending shipments"}
                  </p>
                </div>
              </div>

              {/* Channel Feeds */}
              <div className="flex items-start gap-2 rounded-md border p-3">
                {variantArchiveDeps.dependencies.channelFeeds.active > 0 ? (
                  <CircleAlert className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                ) : (
                  <CircleCheck className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="text-sm font-medium">Channel Feeds</p>
                  {variantArchiveDeps.dependencies.channelFeeds.active > 0 ? (
                    <div className="text-xs text-muted-foreground space-y-0.5">
                      <p>{variantArchiveDeps.dependencies.channelFeeds.active} active feed{variantArchiveDeps.dependencies.channelFeeds.active !== 1 ? "s" : ""} will be deactivated:</p>
                      {variantArchiveDeps.dependencies.channelFeeds.details?.map((d, i) => (
                        <p key={i} className="pl-2 text-foreground/70">
                          {d.channelName}{d.channelSku ? ` (${d.channelSku})` : ""}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No active channel feeds</p>
                  )}
                </div>
              </div>

              {/* Action options when blocked by inventory */}
              {variantArchiveDeps.blocked && variantArchiveDeps.dependencies.inventory.totalQty > 0 && (
                <div className="space-y-3 pt-1">
                  {variantArchiveDeps.dependencies.inventory.hasReserved && (
                    <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 p-2 rounded">
                      Reserved units exist (allocated to orders). Fulfill or cancel those orders before transferring.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant={variantTransferMode ? "default" : "outline"}
                      size="sm"
                      className="flex-1 h-9"
                      disabled={variantArchiveDeps.dependencies.inventory.hasReserved}
                      onClick={() => setVariantTransferMode(true)}
                    >
                      <ArrowRightLeft className="h-3.5 w-3.5 mr-1.5" />
                      Transfer &amp; Archive
                    </Button>
                    <Button
                      variant={!variantTransferMode ? "outline" : "ghost"}
                      size="sm"
                      className="flex-1 h-9"
                      onClick={() => { setVariantTransferMode(false); setVariantTransferTarget(null); }}
                    >
                      <Archive className="h-3.5 w-3.5 mr-1.5" />
                      Keep Inventory &amp; Archive
                    </Button>
                  </div>

                  {variantTransferMode ? (
                    <div className="space-y-3">
                      <div>
                        <Label className="text-xs font-medium mb-1.5 block">Transfer inventory to</Label>
                        <Popover open={variantTargetSearchOpen} onOpenChange={setVariantTargetSearchOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" role="combobox" className="w-full justify-between h-10 font-normal">
                              {variantTransferTarget ? (
                                <span className="font-mono text-sm">{variantTransferTarget.sku}</span>
                              ) : (
                                <span className="text-muted-foreground">Search for target SKU...</span>
                              )}
                              <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50 ml-2" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                            <Command shouldFilter={false}>
                              <CommandInput
                                placeholder="Search SKU or name..."
                                value={variantTargetSearchQuery}
                                onValueChange={setVariantTargetSearchQuery}
                              />
                              <CommandList>
                                <CommandEmpty>{variantTargetSearchQuery.length < 2 ? "Type to search..." : "No variants found"}</CommandEmpty>
                                <CommandGroup>
                                  {filteredVariantTargetResults.slice(0, 50).map((v) => (
                                    <CommandItem
                                      key={v.productVariantId}
                                      value={String(v.productVariantId)}
                                      onSelect={() => {
                                        setVariantTransferTarget({ id: v.productVariantId, sku: v.sku, name: v.name, unitsPerVariant: v.unitsPerVariant });
                                        setVariantTargetSearchOpen(false);
                                      }}
                                    >
                                      <Check className={cn("h-4 w-4 mr-2", variantTransferTarget?.id === v.productVariantId ? "opacity-100" : "opacity-0")} />
                                      <div className="flex flex-col">
                                        <span className="font-mono text-sm">{v.sku}</span>
                                        <span className="text-xs text-muted-foreground truncate">{v.name}</span>
                                      </div>
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>

                      {variantTransferTarget && (
                        <div className="space-y-2">
                          <div className="rounded-md border overflow-hidden">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/50">
                                  <th className="text-left py-1.5 px-2 font-medium">Bin</th>
                                  <th className="text-right py-1.5 px-2 font-medium">Qty</th>
                                  <th className="text-center py-1.5 px-2 font-medium"></th>
                                  <th className="text-left py-1.5 px-2 font-medium">To SKU</th>
                                </tr>
                              </thead>
                              <tbody>
                                {variantArchiveDeps.dependencies.inventory.inventoryDetails.map((d, i) => (
                                  <tr key={i} className="border-t">
                                    <td className="py-1.5 px-2 font-mono">{d.locationCode}</td>
                                    <td className="py-1.5 px-2 text-right">{d.variantQty}</td>
                                    <td className="py-1.5 px-2 text-center text-muted-foreground">→</td>
                                    <td className="py-1.5 px-2 font-mono text-green-600 dark:text-green-400">{variantTransferTarget.sku}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {variantArchiveDeps.dependencies.inventory.totalQty.toLocaleString()} units will be transferred, then the variant will be archived.
                          </p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 p-2 rounded">
                      Inventory and bin assignments will remain on this SKU. Its marketplace availability will be set to zero until the SKU is reactivated.
                    </p>
                  )}
                </div>
              )}

              {variantArchiveDeps.dependencies.shipments.pending > 0 && (
                <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 p-2 rounded">
                  {variantArchiveDeps.dependencies.shipments.pending} in-flight shipment item(s) will complete
                  normally on the archived SKU — fulfillment resolves by variant id, not SKU. Safe to archive now.
                </p>
              )}
            </div>
          ) : null}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="min-h-[44px]">
            Cancel
          </Button>
          {variantArchiveDeps && (
            <Button
              variant="destructive"
              onClick={() => variantArchiveMutation.mutate()}
              disabled={
                variantArchiveMutation.isPending ||
                variantArchiveScanning ||
                (variantTransferMode && !variantTransferTarget)
              }
              className="min-h-[44px]"
            >
              {variantArchiveMutation.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Archiving...</>
              ) : variantTransferMode && variantTransferTarget ? (
                <><ArrowRightLeft className="h-4 w-4 mr-2" />Transfer &amp; Archive</>
              ) : variantArchiveDeps.blocked ? (
                <><Archive className="h-4 w-4 mr-2" />Keep Inventory &amp; Archive</>
              ) : (
                <><Archive className="h-4 w-4 mr-2" />Archive Variant</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
