import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Package,
  Save,
  Image as ImageIcon,
  Layers,
  BarChart3,
  Plus,
  Pencil,
  Trash2,
  FileText,
  Star,
  X,
  ChevronUp,
  ChevronDown,
  Send,
  Globe,
  CheckCircle2,
  AlertCircle,
  Clock,
  Loader2,
  MapPin,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Archive,
  CircleCheck,
  CircleAlert,
  ArrowRightLeft,
  ChevronsUpDown,
  Check,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import { Link } from "wouter";

const HIERARCHY_TYPES = [
  { level: 1, label: "Pack", prefix: "P" },
  { level: 2, label: "Box", prefix: "B" },
  { level: 3, label: "Case", prefix: "C" },
  { level: 4, label: "Skid", prefix: "SK" },
] as const;

function getHierarchyLabel(level: number) {
  return HIERARCHY_TYPES.find((t) => t.level === level)?.label || `Level ${level}`;
}

function getHierarchyPrefix(level: number) {
  return HIERARCHY_TYPES.find((t) => t.level === level)?.prefix || "X";
}

interface ProductVariantRow {
  id: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  barcode: string | null;
  imageUrl: string | null;
  hierarchyLevel: number;
  parentVariantId: number | null;
}

interface ProductDetailData {
  id: number;
  productId: number;
  sku: string;
  name: string;
  title: string | null;
  description: string | null;
  category: string | null;
  subcategory: string | null;
  brand: string | null;
  manufacturer: string | null;
  bulletPoints: string[] | null;
  tags: string[] | null;
  seoTitle: string | null;
  seoDescription: string | null;
  status: string | null;
  baseUnit: string;
  isActive: boolean;
  leadTimeDays: number;
  safetyStockDays: number;
  shopifyProductId: string | null;
  variants: ProductVariantRow[];
  assets: Array<{
    id: number;
    url: string;
    altText: string | null;
    assetType: string;
    isPrimary: number;
    position: number;
    productVariantId: number | null;
  }>;
}

interface Settings {
  [key: string]: string;
}

// --- Inline edit row for product-level channel allocation ---
function ProductChannelRow({
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
function VariantChannelCell({
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

export default function ProductDetail() {
  const [, params] = useRoute("/products/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const productId = params?.id ? parseInt(params.id) : null;
  const [activeTab, setActiveTab] = useState("overview");
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveDeps, setArchiveDeps] = useState<{
    blocked: boolean;
    dependencies: {
      inventory: {
        totalQty: number; bins: number; hasReserved: boolean;
        variants: { variantId: number; sku: string | null; totalQty: number; bins: number; reservedQty: number }[];
        inventoryDetails: { variantId: number; sku: string | null; warehouseLocationId: number; locationCode: string; variantQty: number; reservedQty: number }[];
      };
      shipments: { pending: number };
      channelFeeds: { active: number };
      variants: { total: number; active: number };
    };
  } | null>(null);
  const [archiveScanning, setArchiveScanning] = useState(false);
  const [transferMode, setTransferMode] = useState(false);
  const [transferTargetVariant, setTransferTargetVariant] = useState<{ id: number; sku: string; name: string; unitsPerVariant: number } | null>(null);
  const [variantSearchOpen, setVariantSearchOpen] = useState(false);
  const [variantSearchQuery, setVariantSearchQuery] = useState("");

  // --- Product data ---
  const { data: product, isLoading, error } = useQuery<ProductDetailData>({
    queryKey: [`/api/products/${productId}`],
    enabled: !!productId,
  });

  // --- Global settings for default hints ---
  const { data: settings } = useQuery<Settings>({
    queryKey: ["/api/settings"],
  });
  const globalDefaultLeadTime = parseInt(settings?.default_lead_time_days || "120") || 120;
  const globalDefaultSafetyStock = parseInt(settings?.default_safety_stock_days || "7") || 7;

  // --- Pick location assignments ---
  const { data: productLocations = [] } = useQuery<{ id: number; sku: string | null; location: string; isPrimary: number }[]>({
    queryKey: [`/api/products/${productId}/locations`],
    enabled: !!productId,
  });

  // --- Overview edit state ---
  const [editForm, setEditForm] = useState({
    name: "",
    sku: "",
    baseUnit: "",
    leadTimeDays: 120,
    safetyStockDays: 7,
  });
  const [isDirty, setIsDirty] = useState(false);

  // --- Content edit state ---
  const [contentForm, setContentForm] = useState({
    title: "",
    description: "",
    bulletPoints: "",
    category: "",
    subcategory: "",
    brand: "",
    manufacturer: "",
    tags: "",
    seoTitle: "",
    seoDescription: "",
    status: "active",
  });
  const [contentDirty, setContentDirty] = useState(false);

  // --- Image add state ---
  const [addImageUrl, setAddImageUrl] = useState("");
  const [addImageAlt, setAddImageAlt] = useState("");

  useEffect(() => {
    if (product) {
      setEditForm({
        name: product.name || "",
        sku: product.sku || "",
        baseUnit: product.baseUnit || "piece",
        leadTimeDays: product.leadTimeDays ?? 120,
        safetyStockDays: product.safetyStockDays ?? 7,
      });
      setContentForm({
        title: product.title || "",
        description: product.description || "",
        bulletPoints: (product.bulletPoints || []).join("\n"),
        category: product.category || "",
        subcategory: product.subcategory || "",
        brand: product.brand || "",
        manufacturer: product.manufacturer || "",
        tags: (product.tags || []).join(", "),
        seoTitle: product.seoTitle || "",
        seoDescription: product.seoDescription || "",
        status: product.status || "active",
      });
      setIsDirty(false);
      setContentDirty(false);
    }
  }, [product]);

  const updateField = useCallback((field: string, value: string | number) => {
    setEditForm((prev) => ({ ...prev, [field]: value }));
    setIsDirty(true);
  }, []);

  const updateContentField = useCallback((field: string, value: string) => {
    setContentForm((prev) => ({ ...prev, [field]: value }));
    setContentDirty(true);
  }, []);

  // --- Save product mutation ---
  const saveProductMutation = useMutation({
    mutationFn: async () => {
      const bulletPoints = contentForm.bulletPoints.trim()
        ? contentForm.bulletPoints.split("\n").map((s) => s.trim()).filter(Boolean)
        : null;
      const tags = contentForm.tags.trim()
        ? contentForm.tags.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

      const res = await fetch(`/api/products/${product?.productId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name,
          sku: editForm.sku,
          baseUnit: editForm.baseUnit,
          leadTimeDays: editForm.leadTimeDays,
          safetyStockDays: editForm.safetyStockDays,
          title: contentForm.title || null,
          description: contentForm.description || null,
          bulletPoints,
          category: contentForm.category || null,
          subcategory: contentForm.subcategory || null,
          brand: contentForm.brand || null,
          manufacturer: contentForm.manufacturer || null,
          tags,
          seoTitle: contentForm.seoTitle || null,
          seoDescription: contentForm.seoDescription || null,
          status: contentForm.status || "active",
        }),
      });
      if (!res.ok) throw new Error("Failed to update product");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Product updated" });
      setIsDirty(false);
      setContentDirty(false);
    },
    onError: () => {
      toast({ title: "Failed to update product", variant: "destructive" });
    },
  });

  // --- Archive: variant search for SKU correction transfer ---
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

  // Filter out variants belonging to the product being archived
  const filteredSearchResults = (variantSearchResults.data ?? []).filter(
    (v) => v.productId !== product?.productId
  );

  // --- Archive ---
  const scanArchiveDeps = useCallback(async () => {
    if (!product?.productId) return;
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
  }, [product?.productId, toast]);

  const archiveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, any> = { force: true };
      if (transferMode && transferTargetVariant) {
        body.transferToVariantId = transferTargetVariant.id;
      }
      const res = await fetch(`/api/products/${product?.productId}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to archive product");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      queryClient.invalidateQueries({ queryKey: ["/api/products"] });
      queryClient.invalidateQueries({ queryKey: ["/api/product-variants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      const msg = data.archived.inventoryTransferred > 0
        ? `Archived: transferred ${data.archived.inventoryTransferred} units, ${data.archived.variants} variants deactivated`
        : `Archived: ${data.archived.variants} variants, ${data.archived.inventoryCleared} inventory rows cleared`;
      toast({ title: msg });
      setArchiveDialogOpen(false);
      setArchiveDeps(null);
      setTransferMode(false);
      setTransferTargetVariant(null);
    },
    onError: (err: Error) => {
      toast({ title: err.message || "Failed to archive product", variant: "destructive" });
    },
  });

  // --- Asset mutations ---
  const addAssetMutation = useMutation({
    mutationFn: async ({ url, altText }: { url: string; altText: string }) => {
      const res = await fetch(`/api/products/${product?.productId}/assets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, altText: altText || null, assetType: "image" }),
      });
      if (!res.ok) throw new Error("Failed to add image");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      setAddImageUrl("");
      setAddImageAlt("");
      toast({ title: "Image added" });
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const res = await fetch(`/api/product-assets/${assetId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete image");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Image removed" });
    },
  });

  const setPrimaryMutation = useMutation({
    mutationFn: async (assetId: number) => {
      const res = await fetch(`/api/product-assets/${assetId}/primary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product?.productId }),
      });
      if (!res.ok) throw new Error("Failed to set primary");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Primary image updated" });
    },
  });

  const reorderMutation = useMutation({
    mutationFn: async (orderedIds: number[]) => {
      const res = await fetch(`/api/products/${product?.productId}/assets/reorder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      if (!res.ok) throw new Error("Failed to reorder");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
    },
  });

  // --- Channel status query ---
  interface ChannelStatus {
    channelId: number;
    channelName: string;
    provider: string;
    isListed: boolean;
    listings: Array<{
      variantId: number;
      externalProductId: string | null;
      externalVariantId: string | null;
      syncStatus: string | null;
      syncError: string | null;
      lastSyncedAt: string | null;
    }>;
  }

  const { data: channelStatuses, isLoading: channelStatusLoading } = useQuery<ChannelStatus[]>({
    queryKey: [`/api/products/${productId}/channel-status`],
    enabled: !!productId && activeTab === "channels",
  });

  const pushToChannelMutation = useMutation({
    mutationFn: async ({ channelId }: { channelId?: number }) => {
      const url = channelId
        ? `/api/channel-push/product/${product?.productId}/channel/${channelId}`
        : `/api/channel-push/product/${product?.productId}`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) throw new Error("Failed to push product");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/channel-status`] });
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Product pushed to channel" });
    },
    onError: () => {
      toast({ title: "Failed to push product", variant: "destructive" });
    },
  });

  // --- Channel allocation query ---
  interface AllocationChannel { id: number; name: string; provider: string; status: string; }
  interface AllocationVariant { id: number; sku: string; name: string; unitsPerVariant: number; atpUnits: number; }
  interface ProductAllocation { id: number; channelId: number; productId: number; minAtpBase: number | null; maxAtpBase: number | null; isListed: number; }
  interface VariantReservation { id: number; channelId: number; productVariantId: number; minStockBase: number | null; maxStockBase: number | null; }
  interface FeedData { id: number; channelId: number; productVariantId: number; lastSyncedQty: number; lastSyncedAt: string | null; isActive: number; }
  interface AllocationData {
    channels: AllocationChannel[];
    variants: AllocationVariant[];
    atpBase: number;
    productAllocations: ProductAllocation[];
    variantReservations: VariantReservation[];
    feeds: FeedData[];
  }

  const { data: allocationData, isLoading: allocationLoading } = useQuery<AllocationData>({
    queryKey: [`/api/products/${product?.productId}/allocation`],
    queryFn: async () => {
      const res = await fetch(`/api/products/${product?.productId}/allocation`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch allocation");
      return res.json();
    },
    enabled: !!product?.productId && activeTab === "channels",
  });

  const syncInventoryMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/channel-sync/product/${product?.productId}`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to sync inventory");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${product?.productId}/allocation`] });
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}/channel-status`] });
      toast({ title: "Inventory synced to channels" });
    },
    onError: () => {
      toast({ title: "Failed to sync inventory", variant: "destructive" });
    },
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
      queryClient.invalidateQueries({ queryKey: [`/api/products/${product?.productId}/allocation`] });
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
      queryClient.invalidateQueries({ queryKey: [`/api/products/${product?.productId}/allocation`] });
      toast({ title: "Variant allocation updated" });
    },
    onError: () => {
      toast({ title: "Failed to update variant allocation", variant: "destructive" });
    },
  });

  // --- Variant dialog state ---
  const [variantDialogOpen, setVariantDialogOpen] = useState(false);
  const [editingVariant, setEditingVariant] = useState<ProductVariantRow | null>(null);
  const [variantForm, setVariantForm] = useState({
    hierarchyLevel: 1,
    unitsPerVariant: 1,
    sku: "",
    name: "",
    barcode: "",
    parentVariantId: null as number | null,
  });
  const [skuManuallyEdited, setSkuManuallyEdited] = useState(false);
  const [nameManuallyEdited, setNameManuallyEdited] = useState(false);

  const computeAutoSku = useCallback(
    (level: number, units: number) => {
      const baseSku = product?.sku || "";
      const prefix = getHierarchyPrefix(level);
      return `${baseSku}-${prefix}${units}`;
    },
    [product?.sku],
  );

  const computeAutoName = useCallback(
    (level: number, units: number) => {
      const productName = product?.name || "";
      const typeLabel = getHierarchyLabel(level);
      return `${typeLabel} of ${units}`;
    },
    [product?.name],
  );

  const handleTypeChange = useCallback(
    (level: number) => {
      setVariantForm((prev) => {
        const next = { ...prev, hierarchyLevel: level };
        if (!skuManuallyEdited) next.sku = computeAutoSku(level, prev.unitsPerVariant);
        if (!nameManuallyEdited) next.name = computeAutoName(level, prev.unitsPerVariant);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const handleUnitsChange = useCallback(
    (units: number) => {
      setVariantForm((prev) => {
        const next = { ...prev, unitsPerVariant: units };
        if (!skuManuallyEdited) next.sku = computeAutoSku(prev.hierarchyLevel, units);
        if (!nameManuallyEdited) next.name = computeAutoName(prev.hierarchyLevel, units);
        return next;
      });
    },
    [skuManuallyEdited, nameManuallyEdited, computeAutoSku, computeAutoName],
  );

  const openCreateVariant = useCallback(() => {
    setEditingVariant(null);
    setSkuManuallyEdited(false);
    setNameManuallyEdited(false);
    const defaultLevel = 1;
    const defaultUnits = 1;
    setVariantForm({
      hierarchyLevel: defaultLevel,
      unitsPerVariant: defaultUnits,
      sku: computeAutoSku(defaultLevel, defaultUnits),
      name: computeAutoName(defaultLevel, defaultUnits),
      barcode: "",
      parentVariantId: null,
    });
    setVariantDialogOpen(true);
  }, [computeAutoSku, computeAutoName]);

  const openEditVariant = useCallback((variant: ProductVariantRow) => {
    setEditingVariant(variant);
    setSkuManuallyEdited(true);
    setNameManuallyEdited(true);
    setVariantForm({
      hierarchyLevel: variant.hierarchyLevel,
      unitsPerVariant: variant.unitsPerVariant,
      sku: variant.sku || "",
      name: variant.name,
      barcode: variant.barcode || "",
      parentVariantId: variant.parentVariantId,
    });
    setVariantDialogOpen(true);
  }, []);

  // --- Variant mutations ---
  const createVariantMutation = useMutation({
    mutationFn: async (data: typeof variantForm) => {
      const res = await fetch(`/api/products/${product?.productId}/variants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: data.sku || null,
          name: data.name,
          unitsPerVariant: data.unitsPerVariant,
          hierarchyLevel: data.hierarchyLevel,
          barcode: data.barcode || null,
          parentVariantId: data.parentVariantId,
        }),
      });
      if (!res.ok) throw new Error("Failed to create variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant created" });
      setVariantDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to create variant", variant: "destructive" });
    },
  });

  const updateVariantMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: typeof variantForm }) => {
      const res = await fetch(`/api/product-variants/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sku: data.sku || null,
          name: data.name,
          unitsPerVariant: data.unitsPerVariant,
          hierarchyLevel: data.hierarchyLevel,
          barcode: data.barcode || null,
          parentVariantId: data.parentVariantId,
        }),
      });
      if (!res.ok) throw new Error("Failed to update variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant updated" });
      setVariantDialogOpen(false);
    },
    onError: () => {
      toast({ title: "Failed to update variant", variant: "destructive" });
    },
  });

  const deleteVariantMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/product-variants/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete variant");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/products/${productId}`] });
      toast({ title: "Variant deleted" });
    },
    onError: () => {
      toast({ title: "Failed to delete variant", variant: "destructive" });
    },
  });

  const handleDeleteVariant = useCallback(
    (variant: ProductVariantRow) => {
      if (window.confirm(`Delete variant ${variant.sku || variant.name}?`)) {
        deleteVariantMutation.mutate(variant.id);
      }
    },
    [deleteVariantMutation],
  );

  // --- Sorted variants ---
  const sortedVariants = product?.variants
    ? [...product.variants].sort((a, b) => a.hierarchyLevel - b.hierarchyLevel)
    : [];

  // --- Render ---
  if (!productId) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Invalid product ID</p>
        <Button variant="link" onClick={() => setLocation("/catalog")} className="min-h-[44px]">
          Back to Products
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Loading product...</p>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="p-4 md:p-6 text-center">
        <p className="text-muted-foreground">Product not found</p>
        <Button variant="link" onClick={() => setLocation("/catalog")} className="min-h-[44px]">
          Back to Products
        </Button>
      </div>
    );
  }

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row items-start md:items-center gap-3 md:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setLocation("/catalog")}
          className="min-h-[44px] min-w-[44px]"
          data-testid="btn-back"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-lg md:text-2xl font-bold truncate">
            {product.title || product.name}
          </h1>
          <p className="text-sm text-muted-foreground font-mono">{product.sku}</p>
        </div>
        <div className="flex items-center gap-2">
          {(isDirty || contentDirty) && (
            <Button
              onClick={() => saveProductMutation.mutate()}
              disabled={saveProductMutation.isPending}
              size="sm"
              className="min-h-[44px]"
            >
              <Save className="h-4 w-4 mr-2" />
              {saveProductMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          )}
          <Badge variant={product.isActive ? "default" : "secondary"} className="text-xs">
            {product.status === "archived" ? "Archived" : product.isActive ? "Active" : "Inactive"}
          </Badge>
          {product.isActive && (
            <Button
              variant="outline"
              size="sm"
              className="min-h-[44px] text-muted-foreground"
              onClick={() => { setArchiveDialogOpen(true); scanArchiveDeps(); }}
            >
              <Archive className="h-4 w-4 mr-2" />
              Archive
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        <div className="lg:col-span-2 order-2 lg:order-1">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview" className="min-h-[44px]" data-testid="tab-overview">
                <Package className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Overview</span>
              </TabsTrigger>
              <TabsTrigger value="content" className="min-h-[44px]" data-testid="tab-content">
                <FileText className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Content</span>
              </TabsTrigger>
              <TabsTrigger value="images" className="min-h-[44px]" data-testid="tab-images">
                <ImageIcon className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Images</span>
                <span className="ml-1">({product.assets?.length || 0})</span>
              </TabsTrigger>
              <TabsTrigger value="variants" className="min-h-[44px]" data-testid="tab-variants">
                <Layers className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Variants</span>
                <span className="ml-1">({sortedVariants.length})</span>
              </TabsTrigger>
              <TabsTrigger value="channels" className="min-h-[44px]" data-testid="tab-channels">
                <Globe className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Channels</span>
              </TabsTrigger>
              <TabsTrigger value="inventory" className="min-h-[44px]" data-testid="tab-inventory">
                <BarChart3 className="h-4 w-4 mr-2" />
                <span className="hidden sm:inline">Inventory</span>
              </TabsTrigger>
            </TabsList>

            {/* ===== OVERVIEW TAB ===== */}
            <TabsContent value="overview" className="space-y-4 mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Product Information</CardTitle>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Product Name</Label>
                      <Input
                        value={editForm.name}
                        onChange={(e) => updateField("name", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Base SKU</Label>
                      <Input
                        value={editForm.sku}
                        onChange={(e) => updateField("sku", e.target.value)}
                        className="h-9 font-mono"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Base Unit</Label>
                      <Input
                        value={editForm.baseUnit}
                        onChange={(e) => updateField("baseUnit", e.target.value)}
                        className="h-9 capitalize"
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Procurement */}
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Procurement</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Lead time and safety stock for reorder calculations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Lead Time (days)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.leadTimeDays}
                        onChange={(e) => updateField("leadTimeDays", parseInt(e.target.value) || 0)}
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {globalDefaultLeadTime} days
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Safety Stock (days of cover)</Label>
                      <Input
                        type="number"
                        min={0}
                        value={editForm.safetyStockDays}
                        onChange={(e) => updateField("safetyStockDays", parseInt(e.target.value) || 0)}
                        className="h-9"
                      />
                      <p className="text-xs text-muted-foreground">
                        Default: {globalDefaultSafetyStock} days
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

            </TabsContent>

            {/* ===== CONTENT TAB ===== */}
            <TabsContent value="content" className="space-y-4 mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Product Content</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Marketing title, description, and metadata
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Title</Label>
                      <Input
                        value={contentForm.title}
                        onChange={(e) => updateContentField("title", e.target.value)}
                        placeholder="Marketing title for listings"
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Status</Label>
                      <Select
                        value={contentForm.status}
                        onValueChange={(v) => updateContentField("status", v)}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="draft">Draft</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">Description</Label>
                    <Textarea
                      value={contentForm.description}
                      onChange={(e) => updateContentField("description", e.target.value)}
                      rows={4}
                      className="resize-none"
                      placeholder="Product description for listings"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">Bullet Points</Label>
                    <Textarea
                      value={contentForm.bulletPoints}
                      onChange={(e) => updateContentField("bulletPoints", e.target.value)}
                      rows={4}
                      className="resize-none"
                      placeholder="One bullet point per line"
                    />
                    <p className="text-xs text-muted-foreground">One per line. Used in Amazon, eBay listings.</p>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Classification</CardTitle>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Category</Label>
                      <Input
                        value={contentForm.category}
                        onChange={(e) => updateContentField("category", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Subcategory</Label>
                      <Input
                        value={contentForm.subcategory}
                        onChange={(e) => updateContentField("subcategory", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Brand</Label>
                      <Input
                        value={contentForm.brand}
                        onChange={(e) => updateContentField("brand", e.target.value)}
                        className="h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs md:text-sm">Manufacturer</Label>
                      <Input
                        value={contentForm.manufacturer}
                        onChange={(e) => updateContentField("manufacturer", e.target.value)}
                        className="h-9"
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">Tags</Label>
                    <Input
                      value={contentForm.tags}
                      onChange={(e) => updateContentField("tags", e.target.value)}
                      placeholder="Comma-separated tags"
                      className="h-9"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">SEO</CardTitle>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">SEO Title</Label>
                    <Input
                      value={contentForm.seoTitle}
                      onChange={(e) => updateContentField("seoTitle", e.target.value)}
                      placeholder="Page title for search engines"
                      className="h-9"
                    />
                    <p className="text-xs text-muted-foreground">
                      {contentForm.seoTitle.length}/70 characters
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs md:text-sm">SEO Description</Label>
                    <Textarea
                      value={contentForm.seoDescription}
                      onChange={(e) => updateContentField("seoDescription", e.target.value)}
                      rows={3}
                      className="resize-none"
                      placeholder="Meta description for search engines"
                    />
                    <p className="text-xs text-muted-foreground">
                      {contentForm.seoDescription.length}/160 characters
                    </p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            {/* ===== IMAGES TAB ===== */}
            <TabsContent value="images" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base md:text-lg">Product Images</CardTitle>
                    <CardDescription className="text-xs md:text-sm">
                      Manage product images across all channels
                    </CardDescription>
                  </div>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-4">
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

                  {/* Image gallery */}
                  {product.assets && product.assets.length > 0 ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                      {[...product.assets].sort((a, b) => a.position - b.position).map((asset, idx) => (
                        <div
                          key={asset.id}
                          className="relative group border rounded-lg overflow-hidden"
                        >
                          <div className="aspect-square bg-muted">
                            <img
                              src={asset.url}
                              alt={asset.altText || "Product image"}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          {asset.isPrimary === 1 && (
                            <Badge className="absolute top-1 left-1 text-[10px] px-1.5 py-0">
                              Primary
                            </Badge>
                          )}
                          <div className="absolute top-1 right-1 flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            {asset.isPrimary !== 1 && (
                              <Button
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setPrimaryMutation.mutate(asset.id)}
                                title="Set as primary"
                              >
                                <Star className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {idx > 0 && (
                              <Button
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                  const sorted = [...product.assets].sort((a, b) => a.position - b.position);
                                  const ids = sorted.map((a) => a.id);
                                  [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
                                  reorderMutation.mutate(ids);
                                }}
                                title="Move up"
                              >
                                <ChevronUp className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            {idx < product.assets.length - 1 && (
                              <Button
                                variant="secondary"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => {
                                  const sorted = [...product.assets].sort((a, b) => a.position - b.position);
                                  const ids = sorted.map((a) => a.id);
                                  [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
                                  reorderMutation.mutate(ids);
                                }}
                                title="Move down"
                              >
                                <ChevronDown className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="destructive"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => {
                                if (window.confirm("Remove this image?")) {
                                  deleteAssetMutation.mutate(asset.id);
                                }
                              }}
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-center py-8 text-muted-foreground">
                      <ImageIcon className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No images yet.</p>
                      <p className="text-xs">Add images by URL above, or sync from Shopify.</p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ===== CHANNELS TAB ===== */}
            <TabsContent value="channels" className="mt-4 space-y-4">
              {/* Action buttons row */}
              <div className="flex items-center justify-between">
                <div className="text-sm text-muted-foreground">
                  Product ATP: <span className="font-medium text-foreground">{allocationData?.atpBase?.toLocaleString() ?? "—"}</span> base units
                </div>
                <div className="flex items-center gap-2">
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
                  <Button
                    size="sm"
                    onClick={() => pushToChannelMutation.mutate({})}
                    disabled={pushToChannelMutation.isPending}
                    className="min-h-[44px]"
                  >
                    {pushToChannelMutation.isPending ? (
                      <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4 mr-1" />
                    )}
                    Push Product
                  </Button>
                </div>
              </div>

              {allocationLoading ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin opacity-50" />
                  <p className="text-sm">Loading channels...</p>
                </div>
              ) : !allocationData || allocationData.channels.length === 0 ? (
                <Card>
                  <CardContent className="py-8">
                    <div className="text-center text-muted-foreground">
                      <Globe className="h-10 w-10 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">No sales channels configured.</p>
                      <p className="text-xs">Set up channels in Settings to push product data.</p>
                    </div>
                  </CardContent>
                </Card>
              ) : (
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
                                productId={product!.productId}
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

                  {/* Channel sync status (existing push/listing info) */}
                  {channelStatuses && channelStatuses.length > 0 && (
                    <Card>
                      <CardHeader className="p-3 md:p-6">
                        <CardTitle className="text-base md:text-lg">Listing Status</CardTitle>
                        <CardDescription className="text-xs md:text-sm">
                          External listing IDs and push status
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
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-8 text-xs"
                                    onClick={() => pushToChannelMutation.mutate({ channelId: cs.channelId })}
                                    disabled={pushToChannelMutation.isPending}
                                  >
                                    <Send className="h-3 w-3 mr-1" />Push
                                  </Button>
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
              )}
            </TabsContent>

            {/* ===== VARIANTS TAB ===== */}
            <TabsContent value="variants" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6 flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-base md:text-lg">Product Variants</CardTitle>
                    <CardDescription className="text-xs md:text-sm">
                      Pack sizes and configurations
                    </CardDescription>
                  </div>
                  <Button size="sm" onClick={openCreateVariant} className="min-h-[44px]">
                    <Plus className="h-4 w-4 mr-1" />
                    Add Variant
                  </Button>
                </CardHeader>
                <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                  {sortedVariants.length > 0 ? (
                    <>
                      {/* Mobile cards */}
                      <div className="md:hidden space-y-2">
                        {sortedVariants.map((variant) => {
                          const parentVariant = variant.parentVariantId
                            ? sortedVariants.find((v) => v.id === variant.parentVariantId)
                            : null;
                          const needsConfig = !variant.parentVariantId && variant.hierarchyLevel > 1;
                          return (
                          <div
                            key={variant.id}
                            className="border rounded-lg p-3"
                            data-testid={`variant-card-mobile-${variant.id}`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="font-mono text-sm text-primary">{variant.sku}</span>
                              <div className="flex items-center gap-1.5">
                                {needsConfig && (
                                  <Badge variant="outline" className="text-[10px] bg-yellow-50 text-yellow-700 border-yellow-300">
                                    Needs config
                                  </Badge>
                                )}
                                <Badge variant="outline" className="text-xs">
                                  {getHierarchyLabel(variant.hierarchyLevel)}
                                </Badge>
                              </div>
                            </div>
                            <p className="text-sm mb-2">{variant.name}</p>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Units: {variant.unitsPerVariant}{parentVariant ? ` → ${parentVariant.sku}` : ""}</span>
                              <span className="font-mono">{variant.barcode || "No barcode"}</span>
                            </div>
                            <div className="flex justify-end gap-2 mt-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => openEditVariant(variant)}
                                className="min-h-[44px]"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => handleDeleteVariant(variant)}
                                className="min-h-[44px] text-destructive hover:text-destructive"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
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
                              <TableHead>Breaks Into</TableHead>
                              <TableHead>Barcode</TableHead>
                              <TableHead className="w-[80px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {sortedVariants.map((variant) => {
                              const parentVariant = variant.parentVariantId
                                ? sortedVariants.find((v) => v.id === variant.parentVariantId)
                                : null;
                              const needsConfig = !variant.parentVariantId && variant.hierarchyLevel > 1;
                              return (
                              <TableRow
                                key={variant.id}
                                data-testid={`variant-row-${variant.id}`}
                              >
                                <TableCell className="font-mono">{variant.sku}</TableCell>
                                <TableCell>{variant.name}</TableCell>
                                <TableCell>
                                  <Badge variant="outline" className="text-xs">
                                    {getHierarchyLabel(variant.hierarchyLevel)}
                                  </Badge>
                                </TableCell>
                                <TableCell>{variant.unitsPerVariant}</TableCell>
                                <TableCell>
                                  {parentVariant ? (
                                    <span className="font-mono text-xs">{parentVariant.sku || parentVariant.name}</span>
                                  ) : needsConfig ? (
                                    <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700 border-yellow-300">
                                      Needs config
                                    </Badge>
                                  ) : (
                                    <span className="text-xs text-muted-foreground">Base</span>
                                  )}
                                </TableCell>
                                <TableCell className="font-mono text-sm">
                                  {variant.barcode || "-"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8"
                                      onClick={() => openEditVariant(variant)}
                                    >
                                      <Pencil className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-8 w-8 text-destructive hover:text-destructive"
                                      onClick={() => handleDeleteVariant(variant)}
                                    >
                                      <Trash2 className="h-3.5 w-3.5" />
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
                        onClick={openCreateVariant}
                        className="text-xs mt-1"
                      >
                        Add your first variant
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* ===== INVENTORY TAB ===== */}
            <TabsContent value="inventory" className="mt-4">
              <Card>
                <CardHeader className="p-3 md:p-6">
                  <CardTitle className="text-base md:text-lg">Inventory Levels</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Stock levels across warehouse locations
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
                  <div className="text-center py-8 text-muted-foreground">
                    <BarChart3 className="h-10 w-10 md:h-12 md:w-12 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Inventory tracking coming soon.</p>
                    <p className="text-xs">Connect inventory levels to see stock by location.</p>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-4 order-1 lg:order-2">
          <Card>
            <CardHeader className="p-3 md:p-6">
              <CardTitle className="text-base md:text-lg">Product Image</CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
              <div className="aspect-square bg-muted rounded-lg flex items-center justify-center overflow-hidden">
                {(() => {
                  const primaryAsset = product.assets?.find((a) => a.isPrimary === 1) || product.assets?.[0];
                  return primaryAsset ? (
                    <img
                      src={primaryAsset.url}
                      alt={primaryAsset.altText || product.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon className="h-12 w-12 md:h-16 md:w-16 text-muted-foreground/30" />
                  );
                })()}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-3 md:p-6">
              <CardTitle className="text-base md:text-lg flex items-center gap-2">
                <MapPin className="h-4 w-4" /> Pick Location
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-6 pt-0 md:pt-0">
              {productLocations.length > 0 ? (
                <div className="space-y-1">
                  {productLocations.map(pl => (
                    <div key={pl.id} className="flex items-center gap-2 text-sm">
                      <span className="font-mono font-medium">{pl.location}</span>
                      {pl.sku && <span className="text-muted-foreground text-xs">({pl.sku})</span>}
                      {pl.isPrimary === 1 && <Badge variant="outline" className="text-[10px] px-1">Primary</Badge>}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No pick location assigned</p>
              )}
              <Link href="/bin-assignments" className="text-xs text-blue-600 hover:underline mt-2 inline-block">
                Manage in Bin Assignments
              </Link>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="p-3 md:p-6">
              <CardTitle className="text-base md:text-lg">Quick Stats</CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-6 pt-0 md:pt-0 space-y-3">
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Variants</span>
                <span className="text-sm font-medium">{sortedVariants.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Images</span>
                <span className="text-sm font-medium">{product.assets?.length || 0}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Lead Time</span>
                <span className="text-sm font-medium">{product.leadTimeDays}d</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs md:text-sm text-muted-foreground">Status</span>
                <Badge
                  variant={product.isActive ? "default" : "secondary"}
                  className="text-xs"
                >
                  {product.isActive ? "Active" : "Inactive"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ===== VARIANT EDITOR DIALOG ===== */}
      <Dialog open={variantDialogOpen} onOpenChange={setVariantDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingVariant ? "Edit Variant" : "Add Variant"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={String(variantForm.hierarchyLevel)}
                onValueChange={(v) => handleTypeChange(parseInt(v))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HIERARCHY_TYPES.map((t) => (
                    <SelectItem key={t.level} value={String(t.level)}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Units Per Variant</Label>
              <Input
                type="number"
                min={1}
                value={variantForm.unitsPerVariant}
                onChange={(e) => handleUnitsChange(parseInt(e.target.value) || 1)}
                className="h-11"
              />
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

            <div className="space-y-1.5">
              <Label>Breaks Into (Parent Variant)</Label>
              <Select
                value={variantForm.parentVariantId ? String(variantForm.parentVariantId) : "none"}
                onValueChange={(v) => setVariantForm((prev) => ({ ...prev, parentVariantId: v === "none" ? null : parseInt(v) }))}
              >
                <SelectTrigger className="h-11">
                  <SelectValue placeholder="None (base variant)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (base variant)</SelectItem>
                  {sortedVariants
                    .filter((v) => v.id !== editingVariant?.id && v.unitsPerVariant < variantForm.unitsPerVariant)
                    .map((v) => (
                      <SelectItem key={v.id} value={String(v.id)}>
                        {v.sku || v.name} ({v.unitsPerVariant} units)
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Which smaller variant does this break down into?
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setVariantDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (editingVariant) {
                  updateVariantMutation.mutate({ id: editingVariant.id, data: variantForm });
                } else {
                  createVariantMutation.mutate(variantForm);
                }
              }}
              disabled={createVariantMutation.isPending || updateVariantMutation.isPending}
            >
              {editingVariant
                ? updateVariantMutation.isPending
                  ? "Saving..."
                  : "Save Changes"
                : createVariantMutation.isPending
                  ? "Creating..."
                  : "Create Variant"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Product Dialog */}
      <Dialog open={archiveDialogOpen} onOpenChange={(open) => {
        setArchiveDialogOpen(open);
        if (!open) { setArchiveDeps(null); setTransferMode(false); setTransferTargetVariant(null); setVariantSearchQuery(""); }
      }}>
        <DialogContent className={cn("max-h-[90vh] overflow-y-auto p-4", transferMode ? "max-w-lg" : "max-w-md")}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Archive className="h-5 w-5" />
              Archive Product
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              Archiving <span className="font-mono font-medium text-foreground">{product?.sku}</span> will deactivate the product and all its variants, clear bin assignments, and deactivate channel feeds and replen rules.
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
                    <p className="text-xs text-muted-foreground">
                      {archiveDeps.dependencies.channelFeeds.active > 0
                        ? `${archiveDeps.dependencies.channelFeeds.active} active Shopify feed mappings will be deactivated`
                        : "No active channel feeds"}
                    </p>
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
                        Transfer & Archive
                      </Button>
                      <Button
                        variant={!transferMode ? "outline" : "ghost"}
                        size="sm"
                        className="flex-1 h-9"
                        onClick={() => { setTransferMode(false); setTransferTargetVariant(null); }}
                      >
                        <Archive className="h-3.5 w-3.5 mr-1.5" />
                        Force Archive
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
                        Force-archiving will zero out all inventory and log adjustment transactions. Units will not be transferred.
                      </p>
                    )}
                  </div>
                )}

                {/* Simple blocked message for shipments-only blocking (no inventory) */}
                {archiveDeps.blocked && archiveDeps.dependencies.inventory.totalQty === 0 && (
                  <p className="text-xs text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 p-2 rounded">
                    This product has pending shipments. Complete or cancel them before archiving.
                  </p>
                )}
              </div>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setArchiveDialogOpen(false)} className="min-h-[44px]">
              Cancel
            </Button>
            {archiveDeps && (
              <Button
                variant="destructive"
                onClick={() => archiveMutation.mutate()}
                disabled={
                  archiveMutation.isPending ||
                  archiveScanning ||
                  (archiveDeps.blocked && archiveDeps.dependencies.shipments.pending > 0 && archiveDeps.dependencies.inventory.totalQty === 0) ||
                  (transferMode && !transferTargetVariant)
                }
                className="min-h-[44px]"
              >
                {archiveMutation.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Archiving...</>
                ) : transferMode && transferTargetVariant ? (
                  <><ArrowRightLeft className="h-4 w-4 mr-2" />Transfer & Archive</>
                ) : archiveDeps.blocked ? (
                  <><Archive className="h-4 w-4 mr-2" />Force Archive</>
                ) : (
                  <><Archive className="h-4 w-4 mr-2" />Archive Product</>
                )}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
