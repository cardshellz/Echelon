import { useState, useEffect, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import {
  Save,
  Globe,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Archive,
  ArrowRightLeft,
  Check,
  Upload,
  Download,
  ExternalLink,
  Copy,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ShopifyProductConnectionActions } from "@/components/catalog/ShopifyProductConnection";
import { InventoryProductSyncButton } from "@/features/channel-inventory/components/InventoryProductSync";
import { invalidateCatalogImages } from "@/lib/catalog-image-queries";
import { describeDelistedShopifyVariants, formatShopifyMappingRepairError } from "@/lib/shopify-product-mapping";
import type { AllocationData, ChannelStatus } from "./product-detail-types-and-helpers";

// --- Inline edit row for product-level channel allocation ---
export function ProductChannelRow({
  channel,
  alloc,
  productId,
  onSave,
  isSaving,
}: {
  channel: { id: number; name: string; provider: string };
  alloc: { id: number; channelId: number; productId: number; minAtpBase: number | null; maxAtpBase: number | null; isListed: number } | null;
  productId: number;
  onSave: (data: { channelId: number; productId: number; minAtpBase: number | null; maxAtpBase: number | null; isListed: number }) => void;
  isSaving: boolean;
}) {
  const [floor, setFloor] = useState(alloc?.minAtpBase != null ? String(alloc.minAtpBase) : "");
  const [cap, setCap] = useState(alloc?.maxAtpBase != null ? String(alloc.maxAtpBase) : "");
  const [listed, setListed] = useState(alloc?.isListed ?? 1);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setFloor(alloc?.minAtpBase != null ? String(alloc.minAtpBase) : "");
    setCap(alloc?.maxAtpBase != null ? String(alloc.maxAtpBase) : "");
    setListed(alloc?.isListed ?? 1);
    setDirty(false);
  }, [alloc]);

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="font-medium text-sm">{channel.name}</span>
          <Badge variant="outline" className="text-[10px]">{channel.provider}</Badge>
        </div>
      </TableCell>
      <TableCell className="text-center">
        <button
          className={cn(
            "inline-flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors",
            listed ? "text-green-600 hover:bg-green-50 dark:hover:bg-green-950" : "text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
          )}
          onClick={() => { setListed(listed ? 0 : 1); setDirty(true); }}
        >
          {listed ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldOff className="h-3.5 w-3.5" />}
          {listed ? "Yes" : "No"}
        </button>
      </TableCell>
      <TableCell className="text-right">
        <Input
          type="number"
          min={0}
          placeholder="—"
          value={floor}
          onChange={(e) => { setFloor(e.target.value); setDirty(true); }}
          className="w-24 h-8 text-right ml-auto"
          autoComplete="off"
        />
      </TableCell>
      <TableCell className="text-right">
        <Input
          type="number"
          min={0}
          placeholder="—"
          value={cap}
          onChange={(e) => { setCap(e.target.value); setDirty(true); }}
          className="w-24 h-8 text-right ml-auto"
          autoComplete="off"
        />
      </TableCell>
      <TableCell>
        {dirty && (
          <Button
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              onSave({
                channelId: channel.id,
                productId,
                minAtpBase: floor === "" ? null : parseInt(floor, 10),
                maxAtpBase: cap === "" ? null : parseInt(cap, 10),
                isListed: listed,
              });
              setDirty(false);
            }}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

// --- Inline popover cell for variant-level channel allocation ---
export function VariantChannelCell({
  channelId,
  variantId,
  effectiveAtp,
  feed,
  reservation,
  isFresh,
  isStale,
  onSave,
  isSaving,
}: {
  channelId: number;
  variantId: number;
  effectiveAtp: number;
  feed: { lastSyncedQty: number; lastSyncedAt: string | null } | null;
  reservation: { minStockBase: number | null; maxStockBase: number | null } | null;
  isFresh: boolean;
  isStale: boolean;
  onSave: (data: { channelId: number; productVariantId: number; minStockBase: number | null; maxStockBase: number | null }) => void;
  isSaving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [floor, setFloor] = useState(reservation?.minStockBase != null ? String(reservation.minStockBase) : "");
  const [cap, setCap] = useState(reservation?.maxStockBase != null ? String(reservation.maxStockBase) : "");

  const colorClass = !feed
    ? "text-muted-foreground"
    : effectiveAtp === 0 && (reservation?.minStockBase != null && reservation.minStockBase > 0)
      ? "text-red-500"
      : isFresh
        ? "text-green-600 dark:text-green-400"
        : isStale
          ? "text-amber-600 dark:text-amber-400"
          : "text-foreground";

  const hasOverride = reservation?.minStockBase != null || reservation?.maxStockBase != null;

  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o);
      if (o) {
        setFloor(reservation?.minStockBase != null ? String(reservation.minStockBase) : "");
        setCap(reservation?.maxStockBase != null ? String(reservation.maxStockBase) : "");
      }
    }}>
      <PopoverTrigger asChild>
        <button className={cn("w-full text-center px-2 py-1.5 rounded hover:bg-muted/50 transition-colors text-sm", colorClass)}>
          {!feed ? (
            <span>&mdash;</span>
          ) : (
            <span className="flex items-center justify-center gap-1">
              <span className="tabular-nums">{effectiveAtp.toLocaleString()}</span>
              {hasOverride && <span className="text-[10px] text-muted-foreground">*</span>}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" align="start">
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Variant Floor (base units)</label>
            <Input
              type="number"
              min={0}
              placeholder="No floor"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              className="h-8"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Max Cap (base units)</label>
            <Input
              type="number"
              min={0}
              placeholder="No cap"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="h-8"
              autoComplete="off"
            />
          </div>
          <Button
            className="w-full"
            size="sm"
            onClick={() => {
              onSave({
                channelId,
                productVariantId: variantId,
                minStockBase: floor === "" ? null : parseInt(floor, 10),
                maxStockBase: cap === "" ? null : parseInt(cap, 10),
              });
              setOpen(false);
            }}
            disabled={isSaving}
          >
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
            Save
          </Button>
          {feed?.lastSyncedAt && (
            <p className="text-[10px] text-muted-foreground text-center">
              Last synced: {new Date(feed.lastSyncedAt).toLocaleString()}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// --- Channel Listings panel ---------------------------------------------
// Read-only view of every (variant × channel) listing for a product.
// Shows the external listing id with a copy button, a deep link to the
// channel admin (when available), listed-since (relative), and a status
// badge. Backend: GET /api/products/:productId/channel-listings.
export interface ChannelListingDto {
  listingId: number;
  variantId: number | null;
  variantSku: string | null;
  channelId: number;
  channelName: string | null;
  channelProvider: string | null;
  shopDomain: string | null;
  externalListingId: string | null;
  externalListingIdNumeric: string | null;
  externalProductId: string | null;
  status: "active" | "archived" | "pending" | "error";
  syncStatus: string | null;
  syncError: string | null;
  listedSince: string | null;
  lastSynced: string | null;
  adminUrl: string | null;
}

export function ChannelListingStatusBadge({ status }: { status: ChannelListingDto["status"] }) {
  if (status === "active") {
    return (
      <Badge variant="default" className="text-[10px] bg-green-600 hover:bg-green-600">
        <CheckCircle2 className="h-3 w-3 mr-1" />
        Active
      </Badge>
    );
  }
  if (status === "archived") {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        <Archive className="h-3 w-3 mr-1" />
        Archived
      </Badge>
    );
  }
  if (status === "error") {
    return (
      <Badge variant="destructive" className="text-[10px]">
        <AlertCircle className="h-3 w-3 mr-1" />
        Error
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-[10px]">
      <Clock className="h-3 w-3 mr-1" />
      Pending
    </Badge>
  );
}

export function CopyableExternalId({ value }: { value: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      toast({
        title: "Copy failed",
        description: err instanceof Error ? err.message : "Could not copy to clipboard",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span
        className="font-mono text-xs truncate"
        title={value}
        data-testid="channel-listing-external-id"
      >
        {value}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy external id"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-green-600" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

/**
 * Format an ISO date string as a relative time, e.g. "3 days ago".
 * Returns an em dash if missing/invalid; never throws.
 */
function formatRelativeListedSince(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return formatDistanceToNow(d, { addSuffix: true });
}

type ShopifyProductMappingStatus =
  | "unmapped"
  | "catalog_only"
  | "channel_only"
  | "consistent"
  | "incomplete"
  | "mismatch"
  | "conflict";

interface ShopifyProductMappingDto {
  productId: number;
  productName: string;
  productSku: string | null;
  catalogProductId: string | null;
  channel: { id: number; name: string };
  status: ShopifyProductMappingStatus;
  evidenceProductIds: string[];
  recommendedProductId: string | null;
  repairable: boolean;
  activeVariantCount: number;
  archivedVariantCount: number;
  activeVariantIssueIds: number[];
  variants: Array<{
    variantId: number;
    sku: string | null;
    isActive: boolean;
    catalogVariantId: string | null;
    feedId: number | null;
    feedIsActive: boolean | null;
    feedProductId: string | null;
    feedVariantId: string | null;
    listingId: number | null;
    listingProductId: string | null;
    listingVariantId: string | null;
  }>;
}

const SHOPIFY_MAPPING_STATUS: Record<ShopifyProductMappingStatus, {
  label: string;
  className: string;
  detail: string;
}> = {
  consistent: {
    label: "Consistent",
    className: "bg-green-50 text-green-700 border-green-300",
    detail: "The catalog and channel records point to the same Shopify product.",
  },
  incomplete: {
    label: "Active variants incomplete",
    className: "bg-amber-50 text-amber-700 border-amber-300",
    detail: "The parent product agrees, but one or more active variants are missing a complete catalog, feed, or listing identity.",
  },
  mismatch: {
    label: "Mismatch",
    className: "bg-red-50 text-red-700 border-red-300",
    detail: "The catalog parent differs from the product recorded on channel mappings.",
  },
  conflict: {
    label: "Conflict",
    className: "bg-red-50 text-red-700 border-red-300",
    detail: "Channel records point to multiple Shopify products. This requires manual review.",
  },
  channel_only: {
    label: "Catalog missing",
    className: "bg-amber-50 text-amber-700 border-amber-300",
    detail: "Channel records agree, but the catalog parent mapping is empty.",
  },
  catalog_only: {
    label: "Catalog only",
    className: "bg-amber-50 text-amber-700 border-amber-300",
    detail: "The catalog has a Shopify product ID, but no channel product evidence is present.",
  },
  unmapped: {
    label: "Unmapped",
    className: "bg-slate-50 text-slate-700 border-slate-300",
    detail: "No Shopify parent product mapping exists yet.",
  },
};

export function ProductInventorySyncPanel({ productId }: { productId: number }) {
  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 p-3 md:flex-row md:items-center md:justify-between md:p-6">
        <div>
          <CardTitle className="text-base md:text-lg">Product inventory</CardTitle>
          <CardDescription className="mt-1">Recalculate this product through ATP and sync all eligible channel destinations using the saved inventory rules.</CardDescription>
        </div>
        <InventoryProductSyncButton productId={productId} />
      </CardHeader>
    </Card>
  );
}

export function ShopifyProductMappingPanel({ productId, enabled }: { productId: number; enabled: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirmTargetId, setConfirmTargetId] = useState<string | null>(null);
  const [productOnlyTarget, setProductOnlyTarget] = useState("");
  const queryKey = [`/api/products/${productId}/shopify-mapping`];
  const { data, isLoading, isError, error } = useQuery<ShopifyProductMappingDto>({
    queryKey,
    enabled,
  });

  const repairMutation = useMutation({
    mutationFn: async (targetProductId: string) => {
      const response = await fetch(`/api/products/${productId}/shopify-mapping/repair`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId: data?.channel.id, targetProductId, allowProductOnlyAdoption: data?.variants.length === 0 && data?.status === "unmapped" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(formatShopifyMappingRepairError(body));
      return body as { alreadyConsistent: boolean; shippingGroupMetafieldQueued: boolean; delistedVariants?: unknown };
    },
    onSuccess: async (result) => {
      setConfirmTargetId(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey }),
        queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/channel-listings`] }),
        queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/channel-status`] }),
      ]);
      const delistedNote = describeDelistedShopifyVariants(result);
      const outcome = result.shippingGroupMetafieldQueued
        ? "The parent and channel mappings now agree. Shipping-group sync was queued."
        : "The live Shopify product and linked variants were verified; no additional write was needed.";
      toast({
        title: result.alreadyConsistent ? "Shopify mapping already consistent" : "Shopify mapping repaired",
        description: delistedNote ? `${outcome} ${delistedNote}` : outcome,
      });
    },
    onError: (mutationError: Error) => {
      toast({ title: "Mapping repair failed", description: mutationError.message, variant: "destructive" });
    },
  });

  const status = data ? SHOPIFY_MAPPING_STATUS[data.status] : null;
  return (
    <>
      <Card data-testid="shopify-product-mapping-panel">
        <CardHeader className="p-3 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base md:text-lg">Shopify Product Mapping</CardTitle>
              <CardDescription className="text-xs md:text-sm">
                Parent identity used for product metafields and channel synchronization
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {status && <Badge variant="outline" className={status.className}>{status.label}</Badge>}
              <ShopifyProductConnectionActions productId={productId} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading Shopify mapping...
            </div>
          ) : isError ? (
            <div className="py-4 text-sm text-destructive">
              Failed to load Shopify mapping{error instanceof Error ? `: ${error.message}` : ""}
            </div>
          ) : data && status ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{status.detail}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">Catalog parent product ID</p>
                  <p className="font-mono text-sm mt-1">{data.catalogProductId ?? "Not mapped"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">{data.channel.name} product evidence</p>
                  <p className="font-mono text-sm mt-1">
                    {data.evidenceProductIds.length > 0 ? data.evidenceProductIds.join(", ") : "No channel evidence"}
                  </p>
                </div>
              </div>

              {data.status === "unmapped" && data.variants.length === 0 && (
                <div className="space-y-2 border-t pt-4">
                  <Label htmlFor="product-only-shopify-id">Shopify product ID</Label>
                  <Input id="product-only-shopify-id" value={productOnlyTarget} onChange={event => setProductOnlyTarget(event.target.value)} />
                  <p className="text-xs text-muted-foreground">Link this product for order matching without creating warehouse variants. Shopify will verify the product before the mapping is saved.</p>
                  <Button size="sm" disabled={!/^[1-9][0-9]*$/.test(productOnlyTarget.trim()) || repairMutation.isPending}
                    onClick={() => setConfirmTargetId(productOnlyTarget.trim())}>Verify and link product</Button>
                </div>
              )}
              {data.repairable && data.recommendedProductId && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <p className="text-sm">
                    Proposed repair target: <span className="font-mono">{data.recommendedProductId}</span>
                  </p>
                  <Button size="sm" onClick={() => setConfirmTargetId(data.recommendedProductId)} disabled={repairMutation.isPending}>
                    <ArrowRightLeft className="h-4 w-4 mr-2" /> Repair mapping
                  </Button>
                </div>
              )}

              {data.activeVariantCount > 0 && (
                <div className="overflow-x-auto border-t pt-4">
                  {data.archivedVariantCount > 0 && (
                    <p className="mb-3 text-xs text-muted-foreground">
                      {data.archivedVariantCount} archived {data.archivedVariantCount === 1 ? "variant is" : "variants are"} excluded from mapping repair and channel sync.
                    </p>
                  )}
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SKU</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Variant ID</TableHead>
                        <TableHead>Feed product</TableHead>
                        <TableHead>Listing product</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.variants.filter((variant) => variant.isActive).map((variant) => (
                        <TableRow key={variant.variantId}>
                          <TableCell className="font-mono text-xs">{variant.sku ?? "-"}</TableCell>
                          <TableCell>
                            {data.activeVariantIssueIds.includes(variant.variantId) ? (
                              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-300">
                                Needs mapping
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-300">
                                Mapped
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{variant.catalogVariantId ?? "-"}</TableCell>
                          <TableCell className="font-mono text-xs">{variant.feedProductId ?? "-"}</TableCell>
                          <TableCell className="font-mono text-xs">{variant.listingProductId ?? "-"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={confirmTargetId !== null} onOpenChange={(open) => !open && setConfirmTargetId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Repair Shopify product mapping?</DialogTitle>
            <DialogDescription>
              Shopify will be checked before any write. Active variants will be resolved from a verified existing ID or one exact unique SKU.
              Archived variants are excluded. A variant whose linked Shopify variant was deleted in Shopify is marked not listed on this store
              (its stock and other channels are untouched). The catalog, feed, and listing mappings will be updated together for product {confirmTargetId},
              then the shipping-group metafield will be queued.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTargetId(null)} disabled={repairMutation.isPending}>Cancel</Button>
            <Button onClick={() => confirmTargetId && repairMutation.mutate(confirmTargetId)} disabled={!confirmTargetId || repairMutation.isPending}>
              {repairMutation.isPending
                ? <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                : <ArrowRightLeft className="h-4 w-4 mr-2" />}
              Verify and repair
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ChannelListingsPanel({ productId, enabled }: { productId: number; enabled: boolean }) {
  const { data, isLoading, isError, error } = useQuery<{ listings: ChannelListingDto[] }>({
    queryKey: [`/api/products/${productId}/channel-listings`],
    enabled,
  });

  const listings = data?.listings ?? [];

  return (
    <Card data-testid="channel-listings-panel">
      <CardHeader className="p-3 md:p-6">
        <CardTitle className="text-base md:text-lg">Channel Listings</CardTitle>
        <CardDescription className="text-xs md:text-sm">
          External listing IDs and admin links per variant, per channel
        </CardDescription>
      </CardHeader>
      <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
        {isLoading ? (
          <div className="text-center py-6 text-muted-foreground">
            <Loader2 className="h-6 w-6 mx-auto mb-2 animate-spin opacity-50" />
            <p className="text-sm">Loading channel listings…</p>
          </div>
        ) : isError ? (
          <div className="text-center py-6 text-destructive">
            <AlertCircle className="h-6 w-6 mx-auto mb-2 opacity-70" />
            <p className="text-sm">
              Failed to load channel listings
              {error instanceof Error ? `: ${error.message}` : ""}
            </p>
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <Globe className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Not listed on any channels yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[120px]">SKU</TableHead>
                  <TableHead className="min-w-[140px]">Channel</TableHead>
                  <TableHead className="min-w-[220px]">External ID</TableHead>
                  <TableHead className="min-w-[100px]">Status</TableHead>
                  <TableHead className="min-w-[140px]">Listed since</TableHead>
                  <TableHead className="min-w-[140px] text-right">Open</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {listings.map((l) => {
                  const idForCopy = l.externalListingIdNumeric ?? l.externalListingId;
                  const listedSinceLabel = formatRelativeListedSince(l.listedSince);
                  const listedSinceTitle = l.listedSince
                    ? new Date(l.listedSince).toLocaleString()
                    : undefined;
                  return (
                    <TableRow
                      key={l.listingId}
                      data-testid={`channel-listing-row-${l.listingId}`}
                    >
                      <TableCell className="font-mono text-xs">
                        {l.variantSku ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                          <span className="text-sm font-medium">
                            {l.channelName ?? "Unknown"}
                          </span>
                          {l.channelProvider && (
                            <Badge variant="outline" className="text-[10px]">
                              {l.channelProvider}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {idForCopy ? (
                          <CopyableExternalId value={idForCopy} />
                        ) : (
                          <span className="text-xs text-muted-foreground italic">
                            not pushed yet
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <ChannelListingStatusBadge status={l.status} />
                        {l.status === "error" && l.syncError && (
                          <p
                            className="text-[10px] text-destructive mt-1 line-clamp-2"
                            title={l.syncError}
                          >
                            {l.syncError}
                          </p>
                        )}
                      </TableCell>
                      <TableCell
                        className="text-xs text-muted-foreground"
                        title={listedSinceTitle}
                      >
                        {listedSinceLabel}
                      </TableCell>
                      <TableCell className="text-right">
                        {l.adminUrl ? (
                          <a
                            href={l.adminUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            data-testid={`channel-listing-open-${l.listingId}`}
                          >
                            Open in {l.channelName ?? l.channelProvider ?? "channel"}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function useProductLegacyChannelAllocation(productId: number | undefined, enabled: boolean) {
  return useQuery<AllocationData>({
    queryKey: [`/api/products/${productId}/allocation`],
    queryFn: async () => {
      const res = await fetch(`/api/products/${productId}/allocation`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch allocation");
      return res.json();
    },
    enabled: !!productId && enabled,
  });
}

export function ProductChannelsActionToolbar({
  productId,
  routeProductId,
  isLegacyAuthority,
  atpBase,
  authorityBadge,
}: {
  productId: number;
  routeProductId: number;
  isLegacyAuthority: boolean;
  atpBase: number | undefined;
  authorityBadge: ReactNode;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const syncInventoryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/channel-sync/product/${productId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to sync inventory");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/allocation`] });
      queryClient.invalidateQueries({ queryKey: [`/api/products/${routeProductId}/channel-status`] });
      toast({ title: "Inventory synced to channels" });
    },
    onError: () => {
      toast({ title: "Failed to sync inventory", variant: "destructive" });
    },
  });

  const pullImagesMutation = useMutation({
    mutationFn: async (source: string) => {
      const res = await fetch(`/api/images/pull/${source}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productIds: [productId] }),
      });
      if (!res.ok) throw new Error(`Failed to pull images from ${source}`);
      return res.json();
    },
    onSuccess: async (data: any, source: string) => {
      await invalidateCatalogImages(queryClient, routeProductId);
      const added = data?.summary?.imagesAdded ?? 0;
      toast({ title: `Pulled ${added} image${added !== 1 ? "s" : ""} from ${source}` });
    },
    onError: (_err: Error, source: string) => {
      toast({ title: `Failed to pull images from ${source}`, variant: "destructive" });
    },
  });

  const pushImagesMutation = useMutation({
    mutationFn: async (target: string) => {
      const res = await fetch(`/api/images/push/${target}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productIds: [productId] }),
      });
      const text = await res.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!res.ok) throw new Error(data?.error || `Server returned ${res.status}`);
      return data;
    },
    onSuccess: (data: any, target: string) => {
      const pushed = data?.summary?.imagesPushed ?? 0;
      toast({ title: "Push complete", description: `Pushed ${pushed} image${pushed !== 1 ? "s" : ""} to ${target}` });
    },
    onError: (err: Error) => {
      toast({ title: "Push failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="flex items-center justify-between">
      <div className="text-sm text-muted-foreground">
        {isLegacyAuthority ? (
          <>Product ATP: <span className="font-medium text-foreground">{atpBase?.toLocaleString() ?? "—"}</span> base units</>
        ) : (
          authorityBadge
        )}
      </div>
      <div className="flex items-center gap-2">
        {isLegacyAuthority && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncInventoryMutation.mutate()}
            disabled={syncInventoryMutation.isPending}
            className="min-h-[44px]"
          >
            {syncInventoryMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Sync Inventory
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={() => pullImagesMutation.mutate("ebay")}
          disabled={pullImagesMutation.isPending}
          className="min-h-[44px]"
          title="Pull images from eBay listings into catalog"
        >
          {pullImagesMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Download className="h-4 w-4 mr-1" />
          )}
          Pull Images
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => pushImagesMutation.mutate("shopify")}
          disabled={pushImagesMutation.isPending}
          className="min-h-[44px]"
          title="Push catalog images to Shopify"
        >
          {pushImagesMutation.isPending ? (
            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-1" />
          )}
          Push Images
        </Button>
      </div>
    </div>
  );
}

export function LegacyProductChannelAllocationPanels({
  productId,
  routeProductId,
  enabled,
  allocationData,
  allocationLoading,
}: {
  productId: number;
  routeProductId: number;
  enabled: boolean;
  allocationData: AllocationData | undefined;
  allocationLoading: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: channelStatuses } = useQuery<ChannelStatus[]>({
    queryKey: [`/api/products/${routeProductId}/channel-status`],
    enabled: !!routeProductId && enabled,
  });

  const saveProductAllocMutation = useMutation({
    mutationFn: async (data: { channelId: number; productId: number; minAtpBase: number | null; maxAtpBase: number | null; isListed: number }) => {
      const res = await fetch("/api/channel-product-allocation", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save allocation");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/allocation`] });
      toast({ title: "Product allocation updated" });
    },
    onError: () => {
      toast({ title: "Failed to update allocation", variant: "destructive" });
    },
  });

  const saveVariantReservationMutation = useMutation({
    mutationFn: async (data: { channelId: number; productVariantId: number; minStockBase: number | null; maxStockBase: number | null }) => {
      const res = await fetch("/api/channel-reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to save reservation");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/allocation`] });
      toast({ title: "Variant allocation updated" });
    },
    onError: () => {
      toast({ title: "Failed to update variant allocation", variant: "destructive" });
    },
  });

  if (allocationLoading) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin opacity-50" />
        <p className="text-sm">Loading channels...</p>
      </div>
    );
  }

  if (!allocationData || allocationData.channels.length === 0) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="text-center text-muted-foreground">
            <Globe className="h-10 w-10 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No sales channels configured.</p>
            <p className="text-xs">Set up channels in Settings to sync inventory.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      {/* Product-level allocation per channel */}
      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Product Rules</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Product-level floor, cap, and listing controls per channel
          </CardDescription>
        </CardHeader>
        <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="text-center">Listed</TableHead>
                <TableHead className="text-right">Floor (base)</TableHead>
                <TableHead className="text-right">Cap (base)</TableHead>
                <TableHead className="w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allocationData.channels.map((ch) => {
                const alloc = allocationData.productAllocations.find((a) => a.channelId === ch.id);
                return (
                  <ProductChannelRow
                    key={ch.id}
                    channel={ch}
                    alloc={alloc ?? null}
                    productId={productId}
                    onSave={(data) => saveProductAllocMutation.mutate(data)}
                    isSaving={saveProductAllocMutation.isPending}
                  />
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Variant allocation per channel */}
      <Card>
        <CardHeader className="p-3 md:p-6">
          <CardTitle className="text-base md:text-lg">Variant Allocation</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            Per-variant floor and cap overrides, sync status by channel
          </CardDescription>
        </CardHeader>
        <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[100px]">SKU</TableHead>
                  <TableHead className="min-w-[100px]">Variant</TableHead>
                  <TableHead className="text-right min-w-[60px]">ATP</TableHead>
                  {allocationData.channels.map((ch) => (
                    <TableHead key={ch.id} className="text-center min-w-[160px]">
                      {ch.name}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {allocationData.variants.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-mono text-sm">{v.sku}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{v.name}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{v.atpUnits.toLocaleString()}</TableCell>
                    {allocationData.channels.map((ch) => {
                      const res = allocationData.variantReservations.find(
                        (r) => r.channelId === ch.id && r.productVariantId === v.id
                      );
                      const feed = allocationData.feeds.find(
                        (f) => f.channelId === ch.id && f.productVariantId === v.id
                      );
                      const prodAlloc = allocationData.productAllocations.find((a) => a.channelId === ch.id);

                      // Compute effective ATP for display
                      let effective = v.atpUnits;
                      if (prodAlloc?.isListed === 0) effective = 0;
                      else if (prodAlloc?.minAtpBase != null && allocationData.atpBase < prodAlloc.minAtpBase) effective = 0;
                      else {
                        if (res?.minStockBase != null && res.minStockBase > 0 && effective < res.minStockBase) effective = 0;
                        if (res?.maxStockBase != null && effective > 0) {
                          const maxUnits = Math.floor(res.maxStockBase / v.unitsPerVariant);
                          effective = Math.min(effective, maxUnits);
                        }
                      }
                      effective = Math.max(effective, 0);

                      const syncAge = feed?.lastSyncedAt ? Date.now() - new Date(feed.lastSyncedAt).getTime() : null;
                      const isFresh = syncAge != null && syncAge <= 5 * 60 * 1000;
                      const isStale = syncAge != null && syncAge > 5 * 60 * 1000;

                      return (
                        <TableCell key={ch.id} className="p-0">
                          <VariantChannelCell
                            channelId={ch.id}
                            variantId={v.id}
                            effectiveAtp={effective}
                            feed={feed ?? null}
                            reservation={res ?? null}
                            isFresh={isFresh}
                            isStale={isStale}
                            onSave={(data) => saveVariantReservationMutation.mutate(data)}
                            isSaving={saveVariantReservationMutation.isPending}
                          />
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Channel sync status and external listing IDs */}
      {channelStatuses && channelStatuses.length > 0 && (
        <Card>
          <CardHeader className="p-3 md:p-6">
            <CardTitle className="text-base md:text-lg">Listing Status</CardTitle>
            <CardDescription className="text-xs md:text-sm">
              External listing IDs and sync status
            </CardDescription>
          </CardHeader>
          <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
            <div className="space-y-3">
              {channelStatuses.map((cs) => (
                <div key={cs.channelId} className="border rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium text-sm">{cs.channelName}</span>
                      <Badge variant="outline" className="text-[10px]">{cs.provider}</Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      {cs.listings.length > 0 ? (
                        (() => {
                          const hasError = cs.listings.some((l) => l.syncStatus === "error");
                          const allSynced = cs.listings.every((l) => l.syncStatus === "synced");
                          return hasError ? (
                            <Badge variant="destructive" className="text-[10px]">
                              <AlertCircle className="h-3 w-3 mr-1" />Error
                            </Badge>
                          ) : allSynced ? (
                            <Badge variant="default" className="text-[10px] bg-green-600">
                              <CheckCircle2 className="h-3 w-3 mr-1" />Synced
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="text-[10px]">
                              <Clock className="h-3 w-3 mr-1" />Pending
                            </Badge>
                          );
                        })()
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">Not Listed</Badge>
                      )}
                    </div>
                  </div>
                  {cs.listings.length > 0 && (
                    <div className="text-xs text-muted-foreground space-y-1 mt-2 border-t pt-2">
                      {cs.listings.map((l, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <span className="font-mono">
                            {l.externalProductId ? `#${l.externalProductId}` : "—"}
                            {l.externalVariantId ? ` / v${l.externalVariantId}` : ""}
                          </span>
                          <span>
                            {l.lastSyncedAt ? new Date(l.lastSyncedAt).toLocaleDateString() : "Never synced"}
                          </span>
                        </div>
                      ))}
                      {cs.listings.some((l) => l.syncError) && (
                        <p className="text-destructive mt-1">
                          {cs.listings.find((l) => l.syncError)?.syncError}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
