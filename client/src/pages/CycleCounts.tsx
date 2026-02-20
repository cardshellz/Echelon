import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { playSoundWithHaptic } from "@/lib/sounds";
import {
  ClipboardList,
  Plus,
  Play,
  CheckCircle,
  XCircle,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  Search,
  Package,
  MapPin,
  Check,
  RotateCcw,
  Trash2,
  Pencil,
  ArrowRight,
  ChevronDown,
  Eye,
  ListChecks,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface CycleCount {
  id: number;
  name: string;
  description: string | null;
  status: string;
  warehouseId: number | null;
  zoneFilter: string | null;
  aisleFilter: string | null;
  assignedTo: string | null;
  totalBins: number;
  countedBins: number;
  varianceCount: number;
  approvedVariances: number;
  startedAt: string | null;
  completedAt: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface CycleCountItem {
  id: number;
  cycleCountId: number;
  warehouseLocationId: number;
  productVariantId: number | null;
  productId: number | null;
  expectedSku: string | null;
  expectedQty: number;
  countedSku: string | null;
  countedQty: number | null;
  varianceQty: number | null;
  varianceType: string | null;
  varianceReason: string | null;
  varianceNotes: string | null;
  status: string;
  requiresApproval: number;
  approvedBy: string | null;
  approvedAt: string | null;
  countedBy: string | null;
  countedAt: string | null;
  locationCode?: string;
  zone?: string;
  relatedItemId: number | null;
  mismatchType: string | null; // "expected_missing" or "unexpected_found"
}

interface CycleCountDetail extends CycleCount {
  items: CycleCountItem[];
}

interface Warehouse {
  id: number;
  code: string;
  name: string;
}

interface AdjustmentReason {
  id: number;
  code: string;
  name: string;
  transactionType: string;
}

export default function CycleCounts() {
  const [selectedCount, setSelectedCount] = useState<number | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [countDialogOpen, setCountDialogOpen] = useState(false);
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [bulkApproveOpen, setBulkApproveOpen] = useState(false);
  const [bulkSelectedIds, setBulkSelectedIds] = useState<Set<number>>(new Set());
  const [bulkApproveForm, setBulkApproveForm] = useState({ reasonCode: "", notes: "" });
  const [selectedItem, setSelectedItem] = useState<CycleCountItem | null>(null);
  const defaultCountName = () => { const d = new Date(); return `${d.toLocaleDateString("en-US", { month: "long" })} ${d.getDate()} ${d.getFullYear()} Cycle Count`; };
  const [newCountForm, setNewCountForm] = useState({ name: defaultCountName(), description: "", zoneFilter: "", aisleFilter: "", warehouseId: "", locationTypes: [] as string[], binTypes: [] as string[] });
  const locationTypeOptions = [
    { value: "pick", label: "Pick" },
    { value: "reserve", label: "Reserve" },
    { value: "receiving", label: "Receiving" },
    { value: "staging", label: "Staging" },
  ];
  const binTypeOptions = [
    { value: "bin", label: "Bin" },
    { value: "pallet", label: "Pallet" },
    { value: "carton_flow", label: "Carton Flow" },
    { value: "shelf", label: "Shelf" },
    { value: "floor", label: "Floor" },
  ];
  const [countForm, setCountForm] = useState({ countedSku: "", countedQty: "", notes: "" });
  const [skuSearch, setSkuSearch] = useState("");
  const [skuDropdownOpen, setSkuDropdownOpen] = useState(false);
  const [unknownSkuMode, setUnknownSkuMode] = useState(false);
  const debouncedSkuSearch = useDebounce(skuSearch, 300);
  const [addFoundItemMode, setAddFoundItemMode] = useState(false);
  const [foundItemForm, setFoundItemForm] = useState({ sku: "", quantity: "" });
  const skuInputRef = useRef<HTMLInputElement>(null);
  const [approveForm, setApproveForm] = useState({ reasonCode: "", notes: "" });
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "needs_review" | "done">("all");
  const [varianceSummaryOpen, setVarianceSummaryOpen] = useState(false);
  const [expandedSummarySkus, setExpandedSummarySkus] = useState<Set<number>>(new Set());
  
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: cycleCounts = [], isLoading } = useQuery<CycleCount[]>({
    queryKey: ["/api/cycle-counts"],
  });

  const { data: cycleCountDetail } = useQuery<CycleCountDetail>({
    queryKey: ["/api/cycle-counts", selectedCount],
    enabled: !!selectedCount,
  });

  const { data: adjustmentReasons = [] } = useQuery<AdjustmentReason[]>({
    queryKey: ["/api/inventory/adjustment-reasons"],
  });

  interface VarianceSummaryEntry {
    sku: string;
    productVariantId: number;
    locations: { locationId: number; locationCode: string; zone?: string; varianceQty: number; varianceType: string; mismatchType?: string; status: string; itemId: number }[];
    netVariance: number;
    classification: "misplacement" | "surplus" | "shortage";
  }

  const { data: varianceSummary } = useQuery<{ skuSummaries: VarianceSummaryEntry[] }>({
    queryKey: ["/api/cycle-counts", selectedCount, "variance-summary"],
    queryFn: async () => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/variance-summary`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch variance summary");
      return res.json();
    },
    enabled: !!selectedCount && !!cycleCountDetail && cycleCountDetail.varianceCount > 0,
  });

  const { data: warehouses = [] } = useQuery<Warehouse[]>({
    queryKey: ["/api/warehouses"],
  });

  // SKU search for typeahead
  interface SkuSearchResult {
    sku: string;
    name: string;
    source: string;
    productVariantId: number | null;
  }
  
  const { data: skuResults = [] } = useQuery<SkuSearchResult[]>({
    queryKey: ["/api/inventory/skus/search", debouncedSkuSearch],
    queryFn: async () => {
      if (!debouncedSkuSearch || debouncedSkuSearch.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(debouncedSkuSearch)}&limit=10`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedSkuSearch.length >= 2 && skuDropdownOpen,
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string; zoneFilter?: string; aisleFilter?: string; warehouseId?: number; locationTypeFilter?: string; binTypeFilter?: string }) => {
      const res = await fetch("/api/cycle-counts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to create");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cycle count created" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts"] });
      setCreateDialogOpen(false);
      setNewCountForm({ name: defaultCountName(), description: "", zoneFilter: "", aisleFilter: "", warehouseId: "", locationTypes: [], binTypes: [] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create", description: error.message, variant: "destructive" });
    },
  });

  const initializeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/cycle-counts/${id}/initialize`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to initialize");
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Cycle count started", description: `${data.binsCreated} bins ready for counting` });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to start", description: error.message, variant: "destructive" });
    },
  });

  const countMutation = useMutation({
    mutationFn: async ({ itemId, data }: { itemId: number; data: any }) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${itemId}/count`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to record count");
      return res.json();
    },
    onSuccess: (data, variables) => {
      toast({ 
        title: "Count recorded", 
        description: data.varianceType ? `Variance detected: ${data.varianceQty}` : "No variance" 
      });
      // Clear any draft for the item that was just counted (handles all flows)
      if (selectedCount) {
        clearDraft(selectedCount, variables.itemId);
      }
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      setCountDialogOpen(false);
      setSelectedItem(null);
      setCountForm({ countedSku: "", countedQty: "", notes: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to record", description: error.message, variant: "destructive" });
    },
  });

  const addFoundItemMutation = useMutation({
    mutationFn: async ({ sku, quantity, warehouseLocationId }: { sku: string; quantity: number; warehouseLocationId: number }) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/add-found-item`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sku, quantity, warehouseLocationId }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add item");
      }
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Unexpected item recorded", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      setAddFoundItemMode(false);
      setFoundItemForm({ sku: "", quantity: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to add item", description: error.message, variant: "destructive" });
    },
  });

  const approveMutation = useMutation({
    mutationFn: async ({ itemId, data }: { itemId: number; data: any }) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${itemId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to approve");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Variance approved and adjusted" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      setApproveDialogOpen(false);
      setSelectedItem(null);
      setApproveForm({ reasonCode: "", notes: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to approve", description: error.message, variant: "destructive" });
    },
  });

  const bulkApproveMutation = useMutation({
    mutationFn: async ({ itemIds, reasonCode, notes }: { itemIds: number[]; reasonCode: string; notes?: string }) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/bulk-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ itemIds, reasonCode, notes }),
      });
      if (!res.ok) throw new Error("Failed to bulk approve");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Bulk approve complete",
        description: `${data.approved} approved, ${data.adjustmentsMade} adjustments made${data.skipped ? `, ${data.skipped} skipped` : ""}`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount, "variance-summary"] });
      setBulkApproveOpen(false);
      setBulkSelectedIds(new Set());
      setBulkApproveForm({ reasonCode: "", notes: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Bulk approve failed", description: error.message, variant: "destructive" });
    },
  });

  const createVariantMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${itemId}/create-variant`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Failed to create variant" }));
        throw new Error(err.error || "Failed to create variant");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      if (selectedItem && data.item) {
        // Preserve enrichment fields (locationCode, zone) from the current selectedItem
        setSelectedItem({ ...data.item, locationCode: selectedItem.locationCode, zone: selectedItem.zone });
      }
      const verb = data.alreadyExisted ? "Linked existing" : "Created & linked";
      const extra = data.siblingItemsLinked > 0 ? ` (also linked ${data.siblingItemsLinked} other item${data.siblingItemsLinked > 1 ? "s" : ""})` : "";
      toast({ title: `${verb} variant`, description: `${data.variant.sku} (${data.variant.name})${extra}` });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create variant", description: error.message, variant: "destructive" });
    },
  });

  const completeMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/cycle-counts/${id}/complete`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to complete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cycle count completed" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts"] });
      setSelectedCount(null);
    },
    onError: (error: Error) => {
      toast({ title: "Cannot complete", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/cycle-counts/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Cycle count deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts"] });
      setSelectedCount(null);
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete", description: error.message, variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: async (itemId: number) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${itemId}/reset`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to reset");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Item reset to pending" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to reset", description: error.message, variant: "destructive" });
    },
  });

  const investigateMutation = useMutation({
    mutationFn: async ({ itemId, notes }: { itemId: number; notes?: string }) => {
      const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${itemId}/investigate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ notes }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to set investigation hold");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Item marked for investigation" });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to investigate", description: error.message, variant: "destructive" });
    },
  });

  const parseSku = (sku: string | null): { baseSku: string; typeName: string; units: number } | null => {
    if (!sku) return null;
    const match = sku.match(/^(.+)-(P|B|C)(\d+)$/i);
    if (match) {
      const type = match[2].toUpperCase();
      const typeName = type === "P" ? "Pack" : type === "B" ? "Box" : "Case";
      return { baseSku: match[1].toUpperCase(), typeName, units: parseInt(match[3], 10) };
    }
    return { baseSku: sku.toUpperCase(), typeName: "Each", units: 1 };
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "draft": return <Badge variant="outline">Draft</Badge>;
      case "in_progress": return <Badge className="bg-blue-100 text-blue-700">In Progress</Badge>;
      case "pending_review": return <Badge className="bg-amber-100 text-amber-700">Pending Review</Badge>;
      case "completed": return <Badge className="bg-emerald-100 text-emerald-700">Completed</Badge>;
      case "cancelled": return <Badge variant="destructive">Cancelled</Badge>;
      default: return <Badge variant="outline">{status}</Badge>;
    }
  };

  const getItemStatusBadge = (item: CycleCountItem) => {
    if (item.status === "pending") return <Badge variant="outline">Pending</Badge>;
    if (item.status === "counted" && !item.varianceType) return <Badge className="bg-emerald-100 text-emerald-700">OK</Badge>;
    if (item.status === "investigate") return <Badge className="bg-yellow-100 text-yellow-800">Investigating</Badge>;
    if (item.varianceType && item.status === "approved" && item.varianceReason === "within_tolerance") return <Badge className="bg-sky-100 text-sky-700">Auto-Approved</Badge>;
    if (item.varianceType && item.status === "approved") return <Badge className="bg-blue-100 text-blue-700">Adjusted</Badge>;
    if (item.varianceType) return <Badge className="bg-amber-100 text-amber-700">Variance</Badge>;
    return <Badge variant="outline">{item.status}</Badge>;
  };

  const getVarianceTypeBadge = (type: string | null) => {
    if (!type) return null;
    switch (type) {
      case "quantity_over": return <Badge className="bg-emerald-100 text-emerald-700">+Over</Badge>;
      case "quantity_under": return <Badge className="bg-rose-100 text-rose-700">-Shortage</Badge>;
      case "stray_removed": return <Badge className="bg-green-100 text-green-700">Stray Removed</Badge>;
      case "unexpected_sku": return <Badge variant="destructive">Wrong SKU</Badge>;
      case "unexpected_item": return <Badge className="bg-amber-100 text-amber-700">Unexpected</Badge>;
      default: return <Badge variant="outline">{type}</Badge>;
    }
  };

  const getMismatchTypeBadge = (item: CycleCountItem) => {
    if (!item.mismatchType) return null;
    switch (item.mismatchType) {
      case "expected_missing": 
        return <Badge className="bg-rose-100 text-rose-700 text-xs">Expected: {item.expectedSku}</Badge>;
      case "unexpected_found": 
        return <Badge className="bg-amber-100 text-amber-700 text-xs">Found: {item.countedSku}</Badge>;
      default: 
        return null;
    }
  };

  // Build bin-level location sets for filtering (show ALL items in matching bins)
  const binFilterSets = (() => {
    if (!cycleCountDetail) return { pending: new Set<number>(), needsReview: new Set<number>(), done: new Set<number>() };
    const groups = cycleCountDetail.items.reduce((acc, item) => {
      const locId = item.warehouseLocationId;
      if (!acc[locId]) acc[locId] = [];
      acc[locId].push(item);
      return acc;
    }, {} as Record<number, typeof cycleCountDetail.items>);

    const pending = new Set<number>();
    const needsReview = new Set<number>();
    const done = new Set<number>();
    for (const [locId, items] of Object.entries(groups)) {
      const id = Number(locId);
      if (items.some(i => i.status === "pending")) {
        pending.add(id);
      } else if (items.some(i => (i.varianceType && i.status !== "approved") || i.status === "investigate")) {
        needsReview.add(id);
      } else {
        done.add(id);
      }
    }
    return { pending, needsReview, done };
  })();

  const filteredItems = cycleCountDetail?.items.filter(item => {
    const matchesSearch = !searchQuery ||
      item.locationCode?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.expectedSku?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.countedSku?.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    switch (statusFilter) {
      case "pending":
        return binFilterSets.pending.has(item.warehouseLocationId);
      case "needs_review":
        return binFilterSets.needsReview.has(item.warehouseLocationId);
      case "done":
        return binFilterSets.done.has(item.warehouseLocationId);
      default:
        return true;
    }
  }) || [];

  const handleCountClick = (item: CycleCountItem) => {
    setSelectedItem(item);
    // Pre-fill with previous values if editing, empty if new count
    const hasPreviousCount = item.countedQty !== null;
    setCountForm({
      countedSku: (hasPreviousCount && item.countedSku) || item.expectedSku || "",
      countedQty: hasPreviousCount ? String(item.countedQty) : "",
      notes: item.varianceNotes || "",
    });
    setSkuSearch(hasPreviousCount && item.countedSku && item.countedSku !== item.expectedSku ? item.countedSku : "");
    setSkuDropdownOpen(false);
    setUnknownSkuMode(false);
    setCountDialogOpen(true);
  };

  const handleApproveClick = async (item: CycleCountItem) => {
    let linkedItem = item;
    setSelectedItem(item);
    setApproveForm({ reasonCode: "", notes: "" });
    setApproveDialogOpen(true);

    // Auto-link variant if countedSku exists but productVariantId is null
    if (!item.productVariantId && item.countedSku && selectedCount) {
      try {
        const res = await fetch(`/api/cycle-counts/${selectedCount}/items/${item.id}/create-variant`, {
          method: "POST",
          credentials: "include",
        });
        if (res.ok) {
          const data = await res.json();
          if (data.item) {
            // Preserve enrichment fields from the original item
            linkedItem = { ...data.item, locationCode: item.locationCode, zone: item.zone };
            setSelectedItem(linkedItem);
          }
          queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
          const verb = data.alreadyExisted ? "Linked existing" : "Created & linked";
          toast({ title: `${verb} variant`, description: `${data.variant.sku} (${data.variant.name})` });
        }
      } catch (e) {
        // Silently fail auto-link - user can still click "Create & Link SKU" manually
        console.log("[CycleCount] Auto-link failed:", e);
      }
    }

    // Pre-select "misplaced" if this SKU has offsetting (net-zero) variances
    if (linkedItem.productVariantId && cycleCountDetail) {
      const offsetting = cycleCountDetail.items.filter(i =>
        i.id !== linkedItem.id &&
        i.productVariantId === linkedItem.productVariantId &&
        i.varianceQty !== null && i.varianceQty !== 0
      );
      const netVar = offsetting.reduce((s, i) => s + (i.varianceQty ?? 0), linkedItem.varianceQty ?? 0);
      if (offsetting.length > 0 && netVar === 0) {
        setApproveForm({ reasonCode: "MISPLACED", notes: "" });
      }
    }
  };

  // Mobile counting mode state
  const [mobileCountMode, setMobileCountMode] = useState(false);
  const [currentBinIndex, setCurrentBinIndex] = useState(0);
  const [quickCountQty, setQuickCountQty] = useState("");
  const [differentSkuMode, setDifferentSkuMode] = useState(false);
  const [mobileNotes, setMobileNotes] = useState<Record<number, string>>({});
  const [foundSku, setFoundSku] = useState("");
  const [mobileSkuSearch, setMobileSkuSearch] = useState("");
  const [mobileSkuDropdownOpen, setMobileSkuDropdownOpen] = useState(false);
  const debouncedMobileSkuSearch = useDebounce(mobileSkuSearch, 300);
  
  // SKU search query for mobile typeahead
  const { data: mobileSkuResults = [] } = useQuery<Array<{ sku: string; name: string }>>({
    queryKey: ["/api/inventory/skus/search", debouncedMobileSkuSearch],
    queryFn: async () => {
      if (!debouncedMobileSkuSearch || debouncedMobileSkuSearch.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(debouncedMobileSkuSearch)}&limit=10`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedMobileSkuSearch.length >= 2 && mobileSkuDropdownOpen,
  });
  
  // Quick-action state: tracks which shortcut button was last clicked per item
  const [quickActions, setQuickActions] = useState<Record<number, "matches" | "empty">>({});

  // Wrong SKU search state (tracks which item has wrong SKU mode open)
  const [wrongSkuItemId, setWrongSkuItemId] = useState<number | null>(null);
  const [wrongSkuSearch, setWrongSkuSearch] = useState("");
  const [wrongSkuDropdownOpen, setWrongSkuDropdownOpen] = useState(false);
  const debouncedWrongSkuSearch = useDebounce(wrongSkuSearch, 300);
  
  // Wrong SKU search query
  const { data: wrongSkuResults = [] } = useQuery<Array<{ sku: string; name: string }>>({
    queryKey: ["/api/inventory/skus/search", "wrong", debouncedWrongSkuSearch],
    queryFn: async () => {
      if (!debouncedWrongSkuSearch || debouncedWrongSkuSearch.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(debouncedWrongSkuSearch)}&limit=10`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedWrongSkuSearch.length >= 2 && wrongSkuDropdownOpen,
  });
  
  // Extra item SKU search
  const [extraItemSkuDropdownOpen, setExtraItemSkuDropdownOpen] = useState(false);
  const debouncedExtraItemSku = useDebounce(foundItemForm.sku, 300);
  const { data: extraItemSkuResults = [] } = useQuery<Array<{ sku: string; name: string }>>({
    queryKey: ["/api/inventory/skus/search", "extra", debouncedExtraItemSku],
    queryFn: async () => {
      if (!debouncedExtraItemSku || debouncedExtraItemSku.length < 2) return [];
      const res = await fetch(`/api/inventory/skus/search?q=${encodeURIComponent(debouncedExtraItemSku)}&limit=10`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: debouncedExtraItemSku.length >= 2 && extraItemSkuDropdownOpen,
  });
  
  // Draft storage key for local persistence
  const getDraftKey = (cycleCountId: number, itemId: number) => 
    `cycle-count-draft-${cycleCountId}-${itemId}`;
  
  // Save draft to local storage
  const saveDraft = (cycleCountId: number, itemId: number, qty: string, sku: string) => {
    if (qty !== "") {
      localStorage.setItem(getDraftKey(cycleCountId, itemId), JSON.stringify({ qty, sku, savedAt: Date.now() }));
    }
  };
  
  // Load draft from local storage
  const loadDraft = (cycleCountId: number, itemId: number): { qty: string; sku: string } | null => {
    const stored = localStorage.getItem(getDraftKey(cycleCountId, itemId));
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return { qty: parsed.qty, sku: parsed.sku };
      } catch {
        return null;
      }
    }
    return null;
  };
  
  // Clear draft from local storage
  const clearDraft = (cycleCountId: number, itemId: number) => {
    localStorage.removeItem(getDraftKey(cycleCountId, itemId));
  };
  
  // Get all items for mobile mode navigation (must be outside conditional for hook dependencies)
  const allItemsForHook = cycleCountDetail?.items || [];
  const currentItemForHook = allItemsForHook[currentBinIndex];
  
  // Centralized draft loading via useEffect - MUST be at top level, not inside conditional
  useEffect(() => {
    if (mobileCountMode && currentItemForHook && cycleCountDetail) {
      const draft = loadDraft(cycleCountDetail.id, currentItemForHook.id);
      if (draft) {
        setQuickCountQty(draft.qty);
        if (draft.sku && draft.sku !== currentItemForHook.expectedSku) {
          setDifferentSkuMode(true);
          setFoundSku(draft.sku);
        } else {
          setDifferentSkuMode(false);
          setFoundSku("");
        }
      } else {
        // No draft - reset all state to prevent leakage
        setQuickCountQty("");
        setDifferentSkuMode(false);
        setFoundSku("");
      }
    }
  }, [mobileCountMode, currentBinIndex, currentItemForHook?.id, cycleCountDetail?.id]);

  if (selectedCount && cycleCountDetail) {
    // Group items by location (bin) for multi-SKU support
    const itemsByLocation = cycleCountDetail.items.reduce((acc, item) => {
      const locId = item.warehouseLocationId;
      if (!acc[locId]) {
        acc[locId] = {
          locationCode: item.locationCode,
          warehouseLocationId: locId,
          items: []
        };
      }
      acc[locId].items.push(item);
      return acc;
    }, {} as Record<number, { locationCode: string | undefined; warehouseLocationId: number; items: typeof cycleCountDetail.items }>);

    // Convert to array sorted by location code for navigation
    const binGroups = Object.values(itemsByLocation).sort((a, b) =>
      (a.locationCode || "").localeCompare(b.locationCode || "")
    );

    // Bin-level stats based on disposition (does this bin need action?)
    const totalBins = binGroups.length;
    // Pending: has ANY items still pending (not fully counted)
    const pendingCount = binGroups.filter(b => b.items.some(i => i.status === "pending")).length;
    // Needs Review: fully counted but has unapproved variances or items under investigation
    const needsReviewCount = binGroups.filter(b =>
      !b.items.some(i => i.status === "pending") &&
      b.items.some(i =>
        (i.varianceType && i.status !== "approved") ||
        i.status === "investigate"
      )
    ).length;
    // Done: fully counted, no issues OR all variances approved/resolved
    const doneCount = totalBins - pendingCount - needsReviewCount;
    
    // Get current bin group and items
    const currentBinGroup = binGroups[currentBinIndex];
    const currentBinItems = [...(currentBinGroup?.items || [])].sort((a, b) =>
      (a.mismatchType === "unexpected_found" ? 1 : 0) - (b.mismatchType === "unexpected_found" ? 1 : 0)
    );
    // For backwards compatibility, currentItem is the first item in the bin
    const currentItem = currentBinItems[0];
    
    // Quick count submission for mobile
    const handleQuickCount = () => {
      if (!currentItem || quickCountQty === "") return;
      const skuToSubmit = differentSkuMode ? foundSku : currentItem.expectedSku;
      countMutation.mutate({
        itemId: currentItem.id,
        data: {
          countedSku: skuToSubmit || null,
          countedQty: parseInt(quickCountQty) || 0,
          notes: differentSkuMode ? `Found different SKU: ${foundSku}` : null,
        }
      }, {
        onSuccess: () => {
          // Clear the draft after successful submit
          clearDraft(cycleCountDetail.id, currentItem.id);
          // Check if this was the last item
          if (pendingCount <= 1) {
            playSoundWithHaptic("complete", "classic", true); // All done!
          } else {
            playSoundWithHaptic("success", "classic", true); // Count saved
          }
        }
      });
    };
    
    // Exit handler - save draft to local storage (not a real count)
    const handleExitCountMode = () => {
      if (quickCountQty !== "" && currentItem) {
        // Save as draft to local storage - not a real count
        const skuToSubmit = differentSkuMode ? foundSku : currentItem.expectedSku;
        saveDraft(cycleCountDetail.id, currentItem.id, quickCountQty, skuToSubmit || "");
        toast({ title: "Draft saved", description: `Progress saved for ${currentItem.locationCode}. Resume counting to submit.` });
      }
      setQuickCountQty("");
      setDifferentSkuMode(false);
      setFoundSku("");
      setMobileCountMode(false);
    };
    
    // Mobile counting view
    if (mobileCountMode && binGroups.length > 0) {
      return (
        <div className="flex flex-col h-full bg-slate-50">
          {/* Header - compact */}
          <div className="bg-white border-b px-3 py-2 flex items-center justify-between">
            <Button variant="ghost" size="sm" className="h-8 px-2" onClick={handleExitCountMode}>
              <RotateCcw className="h-4 w-4 mr-1" /> Exit
            </Button>
            <div className="text-center">
              <div className="text-xs text-muted-foreground">Bin {currentBinIndex + 1} of {binGroups.length}</div>
            </div>
            <div className="w-14" />
          </div>
          
          {/* Progress bar */}
          <div className="h-1 bg-slate-200">
            <div 
              className="h-full bg-emerald-500 transition-all" 
              style={{ width: `${totalBins > 0 ? ((totalBins - pendingCount) / totalBins) * 100 : 0}%` }}
            />
          </div>
          
          {/* Main counting area - scrollable, with padding for fixed footer */}
          <div className="flex-1 p-2 overflow-y-auto flex flex-col gap-2 pb-16">
            {/* Bin header */}
            <div className="bg-white rounded-lg p-3 shadow-sm shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-muted-foreground">Bin</div>
                  <div className="text-2xl font-bold font-mono text-blue-600 truncate">
                    {currentBinGroup?.locationCode}
                  </div>
                </div>
                <div className="text-center bg-slate-100 rounded-lg px-3 py-1 shrink-0">
                  <div className="text-xs text-muted-foreground">SKUs</div>
                  <div className="text-xl font-bold">{currentBinItems.filter(i => i.mismatchType !== "unexpected_found").length}</div>
                  {currentBinItems.some(i => i.mismatchType === "unexpected_found") && (
                    <div className="text-xs text-amber-600 font-medium">+{currentBinItems.filter(i => i.mismatchType === "unexpected_found").length} stray</div>
                  )}
                </div>
              </div>
            </div>
            
            {/* List of SKUs in this bin */}
            {currentBinItems.map((binItem, idx) => {
              const isPending = binItem.status === "pending";
              const isConfirmed = binItem.status !== "pending";
              return (
                <div 
                  key={binItem.id} 
                  className={`bg-white rounded-lg p-3 shadow-sm shrink-0 ${
                    isConfirmed
                      ? binItem.mismatchType === "expected_missing"
                        ? 'border-2 border-rose-300 bg-rose-50'
                        : binItem.mismatchType === "unexpected_found"
                          ? 'border-2 border-amber-300 bg-amber-50'
                          : binItem.varianceType
                            ? 'border-2 border-amber-300 bg-amber-50'
                            : 'border-2 border-emerald-300 bg-emerald-50'
                      : ''
                  }`}
                >
                  {binItem.mismatchType === "unexpected_found" && (
                    <div className="flex items-center gap-1 mb-2 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />
                      <span className="text-xs text-amber-700 font-medium">Stray — not assigned to this bin</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {binItem.mismatchType === "unexpected_found" ? "Stray SKU" : `SKU ${idx + 1} of ${currentBinItems.length}`}
                      </div>
                      <div className="text-sm font-medium truncate">
                        {binItem.expectedSku || "(Empty bin)"}
                      </div>
                    </div>
                    <div className={`text-center rounded-lg px-3 py-1 shrink-0 ${binItem.mismatchType === "unexpected_found" ? "bg-amber-100" : "bg-slate-100"}`}>
                      <div className="text-xs text-muted-foreground">
                        {binItem.mismatchType === "unexpected_found" ? "System" : "Expected"}
                      </div>
                      <div className="text-lg font-bold">{binItem.expectedQty}</div>
                    </div>
                  </div>
                  
                  {isConfirmed ? (
                    <div className="space-y-1">
                      {binItem.mismatchType === "expected_missing" ? (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-rose-600 font-medium flex items-center gap-1">
                            <XCircle className="h-4 w-4" /> Not Found
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleCountClick(binItem)}
                          >
                            <Pencil className="h-3 w-3 mr-1" /> Edit
                          </Button>
                        </div>
                      ) : binItem.mismatchType === "unexpected_found" ? (
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-amber-600 font-medium flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4" /> Found: {binItem.countedSku} × {binItem.countedQty}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleCountClick(binItem)}
                          >
                            <Pencil className="h-3 w-3 mr-1" /> Edit
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between text-sm">
                          <span className={`font-medium flex items-center gap-1 ${binItem.varianceType ? "text-amber-600" : "text-emerald-600"}`}>
                            <Check className="h-4 w-4" /> Counted: {binItem.countedQty}
                            {binItem.varianceQty !== null && binItem.varianceQty !== 0 && (
                              <span className={binItem.varianceQty > 0 ? "text-emerald-600" : "text-rose-600"}>
                                ({binItem.varianceQty > 0 ? "+" : ""}{binItem.varianceQty})
                              </span>
                            )}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => handleCountClick(binItem)}
                          >
                            <Pencil className="h-3 w-3 mr-1" /> Edit
                          </Button>
                        </div>
                      )}
                      {binItem.varianceNotes && (
                        <div className="text-xs text-muted-foreground truncate pl-5">{binItem.varianceNotes}</div>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="text-xs text-muted-foreground text-center mb-2">Count what you see</div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 text-lg shrink-0"
                          onClick={() => {
                            const current = parseInt((document.getElementById(`count-${binItem.id}`) as HTMLInputElement)?.value || "0");
                            (document.getElementById(`count-${binItem.id}`) as HTMLInputElement).value = String(Math.max(0, current - 1));
                            setQuickActions(prev => { const next = { ...prev }; delete next[binItem.id]; return next; });
                          }}
                        >
                          -
                        </Button>
                        <Input
                          id={`count-${binItem.id}`}
                          type="number"
                          inputMode="numeric"
                          defaultValue=""
                          className="h-10 text-lg text-center font-mono flex-1 min-w-0"
                          placeholder="0"
                          data-testid={`input-count-${binItem.id}`}
                          onChange={() => setQuickActions(prev => { const next = { ...prev }; delete next[binItem.id]; return next; })}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 text-lg shrink-0"
                          onClick={() => {
                            const current = parseInt((document.getElementById(`count-${binItem.id}`) as HTMLInputElement)?.value || "0");
                            (document.getElementById(`count-${binItem.id}`) as HTMLInputElement).value = String(current + 1);
                            setQuickActions(prev => { const next = { ...prev }; delete next[binItem.id]; return next; });
                          }}
                        >
                          +
                        </Button>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <Button
                          variant={quickActions[binItem.id] === "matches" ? "default" : "secondary"}
                          size="sm"
                          className={`flex-1 h-8 text-xs ${quickActions[binItem.id] === "matches" ? "bg-green-600 hover:bg-green-700 text-white" : ""}`}
                          onClick={() => {
                            (document.getElementById(`count-${binItem.id}`) as HTMLInputElement).value = String(binItem.expectedQty);
                            setQuickActions(prev => ({ ...prev, [binItem.id]: "matches" }));
                          }}
                        >
                          {quickActions[binItem.id] === "matches" && <Check className="h-3 w-3 mr-1" />}
                          {binItem.mismatchType === "unexpected_found" ? `Confirm system (${binItem.expectedQty})` : `Matches (${binItem.expectedQty})`}
                        </Button>
                        <Button
                          variant={quickActions[binItem.id] === "empty" ? "default" : "outline"}
                          size="sm"
                          className={`h-8 text-xs ${quickActions[binItem.id] === "empty" ? "bg-orange-500 hover:bg-orange-600 text-white" : ""}`}
                          onClick={() => {
                            (document.getElementById(`count-${binItem.id}`) as HTMLInputElement).value = "0";
                            setQuickActions(prev => ({ ...prev, [binItem.id]: "empty" }));
                          }}
                        >
                          {quickActions[binItem.id] === "empty" && <Check className="h-3 w-3 mr-1" />}
                          Empty
                        </Button>
                        <Button 
                          variant={wrongSkuItemId === binItem.id ? "default" : "outline"}
                          size="sm"
                          className="h-8 text-xs"
                          onClick={() => {
                            if (wrongSkuItemId === binItem.id) {
                              setWrongSkuItemId(null);
                              setWrongSkuSearch("");
                              setWrongSkuDropdownOpen(false);
                            } else {
                              setWrongSkuItemId(binItem.id);
                              setWrongSkuSearch("");
                              setWrongSkuDropdownOpen(false);
                            }
                          }}
                        >
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Wrong SKU
                        </Button>
                      </div>
                      
                      {/* Wrong SKU input with typeahead */}
                      {wrongSkuItemId === binItem.id && (
                        <div className="mt-2 bg-amber-50 border border-amber-200 rounded p-2">
                          <Label className="text-amber-800 text-xs">What SKU is actually here?</Label>
                          <div className="relative mt-1">
                            <Input
                              value={wrongSkuSearch}
                              onChange={(e) => {
                                setWrongSkuSearch(e.target.value);
                                setWrongSkuDropdownOpen(true);
                              }}
                              onFocus={() => setWrongSkuDropdownOpen(true)}
                              placeholder="Type to search SKUs..."
                              className="text-sm h-9"
                              autoFocus
                            />
                            {wrongSkuDropdownOpen && wrongSkuResults.length > 0 && (
                              <div
                                onMouseDown={(e) => e.preventDefault()}
                                className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-40 overflow-y-auto"
                              >
                                {wrongSkuResults.map((result) => (
                                  <button
                                    key={result.sku}
                                    type="button"
                                    className="w-full px-3 py-2 text-left hover:bg-slate-100 border-b last:border-b-0"
                                    onClick={() => {
                                      setWrongSkuSearch(result.sku);
                                      setWrongSkuDropdownOpen(false);
                                    }}
                                  >
                                    <div className="font-medium text-sm">{result.sku}</div>
                                    {result.name && <div className="text-xs text-muted-foreground truncate">{result.name}</div>}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <Button
                            size="sm"
                            className="w-full h-9 mt-2"
                            onClick={() => {
                              const countVal = (document.getElementById(`count-${binItem.id}`) as HTMLInputElement)?.value;
                              if (countVal === "" || !wrongSkuSearch) return;
                              countMutation.mutate({
                                itemId: binItem.id,
                                data: {
                                  countedSku: wrongSkuSearch,
                                  countedQty: parseInt(countVal) || 0,
                                  notes: `Wrong SKU: Expected ${binItem.expectedSku}, found ${wrongSkuSearch}${mobileNotes[binItem.id] ? '. ' + mobileNotes[binItem.id] : ''}`,
                                }
                              }, {
                                onSuccess: () => {
                                  playSoundWithHaptic("success", "classic", true);
                                  setWrongSkuItemId(null);
                                  setWrongSkuSearch("");
                                  const remainingPending = currentBinItems.filter(i => i.status === "pending" && i.id !== binItem.id);
                                  if (remainingPending.length === 0 && currentBinIndex < binGroups.length - 1) {
                                    setTimeout(() => {
                                      setAddFoundItemMode(false);
                                      setFoundItemForm({ sku: "", quantity: "" });
                                      setCurrentBinIndex(currentBinIndex + 1);
                                    }, 300);
                                  }
                                }
                              });
                            }}
                            disabled={countMutation.isPending || !wrongSkuSearch}
                          >
                            <Check className="h-4 w-4 mr-1" />
                            Confirm Wrong SKU
                          </Button>
                        </div>
                      )}
                      
                      {/* Notes (collapsible) */}
                      <details className="text-sm mt-2">
                        <summary className="cursor-pointer text-muted-foreground hover:text-foreground text-xs">
                          Add notes (optional)
                        </summary>
                        <Textarea
                          value={mobileNotes[binItem.id] || ""}
                          onChange={(e) => setMobileNotes(prev => ({ ...prev, [binItem.id]: e.target.value }))}
                          placeholder="Any observations..."
                          rows={2}
                          className="mt-1 text-sm"
                        />
                      </details>

                      {/* Big Confirm button */}
                      <Button
                        size="lg"
                        className="w-full h-12 text-base mt-3"
                        onClick={() => {
                          const countVal = (document.getElementById(`count-${binItem.id}`) as HTMLInputElement)?.value;
                          if (countVal === "") return;
                          countMutation.mutate({
                            itemId: binItem.id,
                            data: {
                              countedSku: binItem.expectedSku || null,
                              countedQty: parseInt(countVal) || 0,
                              notes: mobileNotes[binItem.id] || null,
                            }
                          }, {
                            onSuccess: () => {
                              playSoundWithHaptic("success", "classic", true);
                              setMobileNotes(prev => { const n = { ...prev }; delete n[binItem.id]; return n; });
                              const remainingPending = currentBinItems.filter(i => i.status === "pending" && i.id !== binItem.id);
                              if (remainingPending.length === 0 && currentBinIndex < binGroups.length - 1) {
                                setTimeout(() => {
                                  setAddFoundItemMode(false);
                                  setFoundItemForm({ sku: "", quantity: "" });
                                  setCurrentBinIndex(currentBinIndex + 1);
                                }, 300);
                              }
                            }
                          });
                        }}
                        disabled={countMutation.isPending}
                        data-testid={`button-confirm-${binItem.id}`}
                      >
                        <Check className="h-5 w-5 mr-2" />
                        Confirm
                      </Button>
                      
                    </>
                  )}
                </div>
              );
            })}
            
            {/* Add unexpected item found */}
            {addFoundItemMode ? (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 space-y-2 shrink-0">
                <Label className="text-blue-800 text-sm">Add Unexpected Item Found in This Bin</Label>
                <div className="relative">
                  <Input
                    value={foundItemForm.sku}
                    onChange={(e) => {
                      setFoundItemForm({ ...foundItemForm, sku: e.target.value });
                      setExtraItemSkuDropdownOpen(true);
                    }}
                    onFocus={() => setExtraItemSkuDropdownOpen(true)}
                    placeholder="Type to search SKUs..."
                    className="text-base"
                    autoFocus
                    data-testid="input-add-found-sku"
                  />
                  {extraItemSkuDropdownOpen && extraItemSkuResults.length > 0 && (
                    <div
                      onMouseDown={(e) => e.preventDefault()}
                      className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-40 overflow-y-auto"
                    >
                      {extraItemSkuResults.map((result) => (
                        <button
                          key={result.sku}
                          type="button"
                          className="w-full px-3 py-2 text-left hover:bg-slate-100 border-b last:border-b-0"
                          onClick={() => {
                            setFoundItemForm({ ...foundItemForm, sku: result.sku });
                            setExtraItemSkuDropdownOpen(false);
                          }}
                        >
                          <div className="font-medium text-sm">{result.sku}</div>
                          {result.name && <div className="text-xs text-muted-foreground truncate">{result.name}</div>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={foundItemForm.quantity}
                  onChange={(e) => setFoundItemForm({ ...foundItemForm, quantity: e.target.value })}
                  placeholder="Quantity"
                  className="text-base"
                  data-testid="input-add-found-qty"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAddFoundItemMode(false);
                      setFoundItemForm({ sku: "", quantity: "" });
                      setExtraItemSkuDropdownOpen(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (currentItem && foundItemForm.sku && foundItemForm.quantity) {
                        addFoundItemMutation.mutate({
                          sku: foundItemForm.sku,
                          quantity: parseInt(foundItemForm.quantity),
                          warehouseLocationId: currentItem.warehouseLocationId,
                        });
                      }
                    }}
                    disabled={!foundItemForm.sku || !foundItemForm.quantity || addFoundItemMutation.isPending}
                    data-testid="btn-submit-found-item"
                  >
                    {addFoundItemMutation.isPending ? "Adding..." : "Add Item"}
                  </Button>
                </div>
                <p className="text-xs text-blue-600">
                  Use this when you find extra items that weren't expected
                </p>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="text-blue-600 border-blue-200"
                onClick={() => setAddFoundItemMode(true)}
                data-testid="btn-add-found-item"
              >
                <Plus className="h-4 w-4 mr-1" />
                Found Extra Item
              </Button>
            )}
          </div>
          
          {/* Fixed navigation footer at bottom of viewport */}
          <div className="fixed bottom-0 left-0 right-0 bg-white border-t p-2 flex gap-2 z-50">
            <Button 
              variant="outline" 
              size="sm"
              className="h-11 px-4"
              onClick={() => {
                setAddFoundItemMode(false);
                setFoundItemForm({ sku: "", quantity: "" });
                setCurrentBinIndex(Math.max(0, currentBinIndex - 1));
              }}
              disabled={currentBinIndex === 0}
            >
              <ChevronLeft className="h-4 w-4 mr-1" />
              Prev
            </Button>
            <Button 
              variant="outline"
              size="sm"
              className="h-11 px-3"
              onClick={() => {
                // Move to next bin (incremental)
                if (currentBinIndex < binGroups.length - 1) {
                  setCurrentBinIndex(currentBinIndex + 1);
                  setAddFoundItemMode(false);
                  setFoundItemForm({ sku: "", quantity: "" });
                }
              }}
              disabled={currentBinIndex === binGroups.length - 1}
              data-testid="button-next-bin"
            >
              Next
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
            <Button 
              size="sm"
              className="flex-1 h-11 text-sm"
              onClick={() => {
                // Find next bin with uncounted items
                const nextUncountedIdx = binGroups.findIndex((bin, idx) => 
                  idx > currentBinIndex && bin.items.some(i => i.status === "pending")
                );
                if (nextUncountedIdx !== -1) {
                  setCurrentBinIndex(nextUncountedIdx);
                  setAddFoundItemMode(false);
                  setFoundItemForm({ sku: "", quantity: "" });
                }
              }}
              disabled={!binGroups.some((bin, idx) => idx > currentBinIndex && bin.items.some(i => i.status === "pending"))}
              data-testid="button-next-uncounted"
            >
              Next Uncounted
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </div>
        </div>
      );
    }
    
    // Mobile done state
    if (mobileCountMode && pendingCount === 0) {
      return (
        <div className="flex flex-col h-full items-center justify-center p-6 gap-6">
          <CheckCircle className="h-20 w-20 text-emerald-500" />
          <h2 className="text-2xl font-bold text-center">All Bins Counted!</h2>
          <p className="text-muted-foreground text-center">
            {needsReviewCount > 0
              ? `${needsReviewCount} bin(s) need review`
              : "No variances found - ready to complete"}
          </p>
          <Button size="lg" onClick={() => setMobileCountMode(false)}>
            View Results
          </Button>
        </div>
      );
    }
    
    return (
      <div className="flex flex-col h-full p-2 md:p-6 gap-2 md:gap-4">
        {/* Compact header */}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-8 px-2" onClick={() => setSelectedCount(null)}>
            <RotateCcw className="h-4 w-4" />
          </Button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-lg md:text-2xl font-bold truncate">{cycleCountDetail.name}</h1>
              {getStatusBadge(cycleCountDetail.status)}
            </div>
            <p className="text-muted-foreground text-xs">{totalBins - pendingCount}/{totalBins} counted</p>
          </div>
          {cycleCountDetail.status !== "completed" && (
            <Button 
              variant="ghost" 
              size="sm"
              className="h-8 px-2 text-destructive"
              onClick={() => {
                if (confirm("Delete this cycle count?")) {
                  deleteMutation.mutate(selectedCount);
                }
              }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
        
        {/* Action button - prominent */}
        {cycleCountDetail.status === "draft" && (
          <Button 
            size="default" 
            className="w-full"
            onClick={() => initializeMutation.mutate(selectedCount)}
            disabled={initializeMutation.isPending}
            data-testid="button-initialize-count"
          >
            <Play className="h-4 w-4 mr-2" /> {initializeMutation.isPending ? "Initializing..." : "Initialize Count"}
          </Button>
        )}
        {cycleCountDetail.status === "in_progress" && pendingCount > 0 && (
          <Button 
            size="default" 
            className="w-full"
            onClick={() => {
              setCurrentBinIndex(0);
              setMobileCountMode(true);
            }}
            data-testid="button-start-counting"
          >
            <Play className="h-4 w-4 mr-2" /> Start Counting ({pendingCount} bins)
          </Button>
        )}
        {cycleCountDetail.status === "in_progress" && pendingCount === 0 && needsReviewCount === 0 && (
          <Button className="w-full" onClick={() => completeMutation.mutate(selectedCount)} disabled={completeMutation.isPending}>
            <CheckCircle className="h-4 w-4 mr-2" /> Complete
          </Button>
        )}

        {/* Compact stat row */}
        <div className="grid grid-cols-4 gap-1 md:gap-4">
          <button
            className={`p-2 rounded-lg text-center transition-all ${statusFilter === "all" ? "bg-primary/10 ring-1 ring-primary" : "bg-slate-100"}`}
            onClick={() => setStatusFilter("all")}
            data-testid="card-filter-all"
          >
            <div className="text-lg font-bold">{totalBins}</div>
            <div className="text-[10px] text-muted-foreground">Total</div>
          </button>
          <button
            className={`p-2 rounded-lg text-center transition-all ${statusFilter === "pending" ? "bg-blue-100 ring-1 ring-blue-500" : "bg-slate-100"}`}
            onClick={() => setStatusFilter("pending")}
            data-testid="card-filter-pending"
          >
            <div className="text-lg font-bold">{pendingCount}</div>
            <div className="text-[10px] text-muted-foreground">Pending</div>
          </button>
          <button
            className={`p-2 rounded-lg text-center transition-all ${statusFilter === "needs_review" ? "bg-amber-100 ring-1 ring-amber-500" : "bg-slate-100"}`}
            onClick={() => setStatusFilter("needs_review")}
            data-testid="card-filter-needs-review"
          >
            <div className="text-lg font-bold text-amber-600">{needsReviewCount}</div>
            <div className="text-[10px] text-muted-foreground">Needs Review</div>
          </button>
          <button
            className={`p-2 rounded-lg text-center transition-all ${statusFilter === "done" ? "bg-emerald-100 ring-1 ring-emerald-500" : "bg-slate-100"}`}
            onClick={() => setStatusFilter("done")}
            data-testid="card-filter-done"
          >
            <div className="text-lg font-bold text-emerald-600">{doneCount}</div>
            <div className="text-[10px] text-muted-foreground">Done</div>
          </button>
        </div>

        {/* Variance Summary (collapsible) */}
        {varianceSummary && varianceSummary.skuSummaries.length > 0 && (
          <div className="rounded-md border bg-card">
            <button
              className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/30 transition-colors"
              onClick={() => setVarianceSummaryOpen(!varianceSummaryOpen)}
            >
              <span className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-muted-foreground" />
                Variance Summary by SKU ({varianceSummary.skuSummaries.length} SKUs)
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${varianceSummaryOpen ? "rotate-180" : ""}`} />
            </button>
            {varianceSummaryOpen && (
              <div className="border-t px-3 py-2 space-y-1">
                {varianceSummary.skuSummaries.map(entry => (
                  <div key={entry.productVariantId} className="rounded border">
                    <button
                      className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-muted/20"
                      onClick={() => {
                        const next = new Set(expandedSummarySkus);
                        if (next.has(entry.productVariantId)) next.delete(entry.productVariantId);
                        else next.add(entry.productVariantId);
                        setExpandedSummarySkus(next);
                      }}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-medium">{entry.sku}</span>
                        <Badge className={`text-xs ${
                          entry.classification === "misplacement" ? "bg-blue-100 text-blue-700" :
                          entry.classification === "surplus" ? "bg-emerald-100 text-emerald-700" :
                          "bg-rose-100 text-rose-700"
                        }`}>
                          {entry.classification === "misplacement" ? "Misplacement" :
                           entry.classification === "surplus" ? "Surplus" : "Shortage"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`font-mono font-bold text-sm ${
                          entry.netVariance === 0 ? "text-blue-600" :
                          entry.netVariance > 0 ? "text-emerald-600" : "text-rose-600"
                        }`}>
                          Net: {entry.netVariance > 0 ? "+" : ""}{entry.netVariance}
                        </span>
                        <ChevronDown className={`h-3 w-3 text-muted-foreground transition-transform ${expandedSummarySkus.has(entry.productVariantId) ? "rotate-180" : ""}`} />
                      </div>
                    </button>
                    {expandedSummarySkus.has(entry.productVariantId) && (
                      <div className="border-t px-3 py-1.5 space-y-0.5 text-xs bg-muted/10">
                        {entry.locations.map(loc => (
                          <div key={loc.itemId} className="flex items-center justify-between">
                            <span className="font-mono">{loc.locationCode}</span>
                            <div className="flex items-center gap-2">
                              <span className={`font-mono font-bold ${loc.varianceQty > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                                {loc.varianceQty > 0 ? "+" : ""}{loc.varianceQty}
                              </span>
                              <Badge variant="outline" className="text-[10px]">{loc.status}</Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by location or SKU..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10"
              data-testid="input-search"
            />
          </div>
          {needsReviewCount > 0 && (
            <Button
              variant="outline"
              size="default"
              className="shrink-0"
              onClick={() => {
                setBulkSelectedIds(new Set());
                setBulkApproveForm({ reasonCode: "", notes: "" });
                setBulkApproveOpen(true);
              }}
            >
              <ListChecks className="h-4 w-4 mr-2" />
              Bulk Approve
            </Button>
          )}
        </div>

        {/* Mobile-friendly card list */}
        <div className="flex-1 overflow-auto space-y-2 md:hidden">
          {filteredItems.map((item) => (
            <Card key={item.id} className={
              item.mismatchType 
                ? "border-purple-300 bg-purple-50/50" 
                : item.varianceType 
                  ? "border-amber-300 bg-amber-50/50" 
                  : ""
            }>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono font-bold text-lg text-blue-600">{item.locationCode}</div>
                    <div className="text-sm truncate">
                      {item.expectedSku || <span className="text-muted-foreground">(empty bin)</span>}
                    </div>
                    {item.countedSku && item.countedSku !== item.expectedSku && (
                      <div className="text-sm text-amber-700 font-medium truncate">
                        Actual: {item.countedSku}
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 mt-2 text-sm">
                      <span>Expected: <strong>{item.expectedQty}</strong></span>
                      {item.countedQty !== null && (
                        <span>Counted: <strong>{item.countedQty}</strong></span>
                      )}
                      {item.varianceQty !== null && item.varianceQty !== 0 && (
                        <span className={item.varianceQty > 0 ? "text-emerald-600 font-bold" : "text-rose-600 font-bold"}>
                          {item.varianceQty > 0 ? "+" : ""}{item.varianceQty}
                        </span>
                      )}
                    </div>
                    {item.relatedItemId && (
                      <div className="mt-2 text-xs text-purple-600 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Linked to mismatch pair
                      </div>
                    )}
                    {item.varianceNotes && (
                      <div className="mt-1 text-xs text-muted-foreground">{item.varianceNotes}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    {getItemStatusBadge(item)}
                    {getMismatchTypeBadge(item)}
                    {item.status === "pending" && (
                      <Button size="sm" onClick={() => handleCountClick(item)}>
                        Count
                      </Button>
                    )}
                    {(item.status === "counted" || item.status === "variance") && (
                      <Button size="sm" variant="ghost" onClick={() => handleCountClick(item)}>
                        <Pencil className="h-3 w-3 mr-1" /> Edit
                      </Button>
                    )}
                    {item.varianceType && (item.status === "variance" || item.status === "investigate") && (
                      <>
                        {item.status === "investigate" && (
                          <Button size="sm" variant="ghost" onClick={() => handleCountClick(item)}>
                            <Pencil className="h-3 w-3 mr-1" /> Recount
                          </Button>
                        )}
                        {item.status !== "investigate" && (
                          <Button size="sm" variant="ghost" className="text-yellow-700"
                            onClick={() => investigateMutation.mutate({ itemId: item.id })}
                            disabled={investigateMutation.isPending}
                          >
                            Investigate
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => handleApproveClick(item)}>
                          {item.relatedItemId ? "Approve Pair" : "Approve"}
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Desktop table view */}
        <div className="rounded-md border bg-card flex-1 overflow-auto hidden md:block">
          <Table>
            <TableHeader className="bg-muted/40 sticky top-0">
              <TableRow>
                <TableHead className="w-[100px]">Location</TableHead>
                <TableHead>Expected SKU</TableHead>
                <TableHead>Counted SKU</TableHead>
                <TableHead className="text-right w-[80px]">Expected</TableHead>
                <TableHead className="text-right w-[80px]">Counted</TableHead>
                <TableHead className="text-right w-[80px]">Variance</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[110px]">Type</TableHead>
                <TableHead>Notes</TableHead>
                <TableHead className="w-[120px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow key={item.id} className={
                  item.status === "investigate" ? "bg-yellow-50/50" : item.varianceType ? "bg-amber-50/50" : ""
                }>
                  <TableCell className="font-mono font-medium">{item.locationCode}</TableCell>
                  <TableCell>{item.expectedSku || <span className="text-muted-foreground">(empty)</span>}</TableCell>
                  <TableCell>
                    {item.countedSku ? (
                      <span className={item.countedSku !== item.expectedSku ? "text-amber-700 font-medium" : ""}>
                        {item.countedSku}
                      </span>
                    ) : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-right font-mono">{item.expectedQty}</TableCell>
                  <TableCell className="text-right font-mono">
                    {item.countedQty !== null ? item.countedQty : "-"}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {item.varianceQty !== null && item.varianceQty !== 0 ? (
                      <span className={item.varianceQty > 0 ? "text-emerald-600" : "text-rose-600"}>
                        {item.varianceQty > 0 ? "+" : ""}{item.varianceQty}
                      </span>
                    ) : "-"}
                  </TableCell>
                  <TableCell>{getItemStatusBadge(item)}</TableCell>
                  <TableCell>{getVarianceTypeBadge(item.varianceType)}</TableCell>
                  <TableCell className="max-w-[200px]">
                    {item.varianceNotes && (
                      <span className="text-xs text-muted-foreground truncate block" title={item.varianceNotes}>{item.varianceNotes}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      {item.status === "pending" && (
                        <Button size="sm" variant="outline" onClick={() => handleCountClick(item)}>
                          Count
                        </Button>
                      )}
                      {(item.status === "counted" || item.status === "variance") && (
                        <Button size="sm" variant="ghost" onClick={() => handleCountClick(item)}>
                          <Pencil className="h-3 w-3 mr-1" /> Edit
                        </Button>
                      )}
                      {item.varianceType && (item.status === "variance" || item.status === "investigate") && (
                        <>
                          {item.status === "investigate" && (
                            <Button size="sm" variant="ghost" onClick={() => handleCountClick(item)}>
                              <Pencil className="h-3 w-3 mr-1" /> Recount
                            </Button>
                          )}
                          {item.status !== "investigate" && (
                            <Button size="sm" variant="ghost" className="text-yellow-700"
                              onClick={() => investigateMutation.mutate({ itemId: item.id })}
                              disabled={investigateMutation.isPending}
                            >
                              Investigate
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => handleApproveClick(item)}>
                            Approve
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Dialog open={countDialogOpen} onOpenChange={setCountDialogOpen}>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
            {/* Header: location only (clear of X button) */}
            <div className="flex items-center gap-2 pb-2 border-b">
              <MapPin className="h-4 w-4 text-blue-600 shrink-0" />
              <span className="font-bold text-lg">{selectedItem?.locationCode}</span>
            </div>

            {/* Expected info - prominent, below divider */}
            <div className="rounded-md bg-muted/50 border px-3 py-2 flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Expected</span>
              <span className="font-mono font-bold">
                {selectedItem?.expectedSku || <span className="text-muted-foreground italic">(empty bin)</span>}
                {" "}
                <span className="text-muted-foreground font-normal">×</span>
                {" "}{selectedItem?.expectedQty}
              </span>
            </div>

            <div className="space-y-3">
              {/* Primary action: Confirm match */}
              <Button 
                variant="default" 
                size="lg"
                className="w-full h-12 bg-emerald-600 hover:bg-emerald-700"
                onClick={() => selectedItem && countMutation.mutate({
                  itemId: selectedItem.id,
                  data: {
                    countedSku: selectedItem.expectedSku,
                    countedQty: selectedItem.expectedQty,
                    notes: null,
                  }
                })}
                disabled={countMutation.isPending}
                data-testid="button-confirm-match"
              >
                <Check className="h-4 w-4 mr-2" />
                Confirm Match
              </Button>
              
              <div className="text-center text-xs text-muted-foreground">— or enter different count —</div>
              
              {/* Quantity section - more compact */}
              <div>
                <Label className="text-sm">Quantity</Label>
                <div className="flex gap-1 mt-1">
                  <Button 
                    variant="outline" 
                    size="icon"
                    className="h-10 w-12 text-lg shrink-0"
                    onClick={() => setCountForm({ 
                      ...countForm, 
                      countedQty: String(Math.max(0, (parseInt(countForm.countedQty) || 0) - 1)) 
                    })}
                  >
                    -
                  </Button>
                  <Input
                    type="number"
                    inputMode="numeric"
                    value={countForm.countedQty}
                    onChange={(e) => setCountForm({ ...countForm, countedQty: e.target.value })}
                    placeholder="Qty"
                    className="text-center text-lg h-10 flex-1"
                    data-testid="input-counted-qty"
                  />
                  <Button 
                    variant="outline" 
                    size="icon"
                    className="h-10 w-12 text-lg shrink-0"
                    onClick={() => setCountForm({ 
                      ...countForm, 
                      countedQty: String((parseInt(countForm.countedQty) || 0) + 1) 
                    })}
                  >
                    +
                  </Button>
                </div>
                <div className="flex gap-1 mt-1">
                  <Button
                    variant={countForm.countedQty === "0" ? "default" : "outline"}
                    size="sm"
                    className={`flex-1 h-8 text-xs ${countForm.countedQty === "0" ? "bg-orange-500 hover:bg-orange-600 text-white" : ""}`}
                    onClick={() => setCountForm({ ...countForm, countedQty: "0" })}
                  >
                    {countForm.countedQty === "0" && <Check className="h-3 w-3 mr-1" />}
                    Empty
                  </Button>
                  <Button
                    variant={countForm.countedQty === String(selectedItem?.expectedQty || 0) && countForm.countedQty !== "0" ? "default" : "outline"}
                    size="sm"
                    className={`flex-1 h-8 text-xs ${countForm.countedQty === String(selectedItem?.expectedQty || 0) && countForm.countedQty !== "0" ? "bg-green-600 hover:bg-green-700 text-white" : ""}`}
                    onClick={() => setCountForm({ ...countForm, countedQty: String(selectedItem?.expectedQty || 0) })}
                  >
                    {countForm.countedQty === String(selectedItem?.expectedQty || 0) && countForm.countedQty !== "0" && <Check className="h-3 w-3 mr-1" />}
                    Same as Expected
                  </Button>
                </div>
              </div>
              
              {/* SKU section - searchable typeahead */}
              <div>
                <Label className="text-sm">Different SKU?</Label>
                <div className="relative mt-1">
                  <div className="flex gap-1">
                    <div className="relative flex-1">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        ref={skuInputRef}
                        value={skuSearch}
                        onChange={(e) => {
                          setSkuSearch(e.target.value);
                          setSkuDropdownOpen(true);
                          setUnknownSkuMode(false);
                        }}
                        onFocus={() => setSkuDropdownOpen(true)}
                        onBlur={(e) => {
                          // Don't close if clicking within the dropdown (including scrollbar)
                          if (e.relatedTarget?.closest?.('[data-sku-dropdown]')) return;
                          setTimeout(() => setSkuDropdownOpen(false), 150);
                        }}
                        placeholder="Search SKU..."
                        className="pl-8 h-10"
                        enterKeyHint="search"
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        data-testid="input-sku-search"
                      />
                      {/* Dropdown */}
                      {skuDropdownOpen && skuSearch.length >= 2 && (
                        <div
                          data-sku-dropdown
                          tabIndex={-1}
                          onMouseDown={(e) => e.preventDefault()}
                          className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto"
                        >
                          {skuResults.length > 0 ? (
                            skuResults.map((result) => (
                              <button
                                key={result.sku}
                                type="button"
                                className="w-full px-3 py-2 text-left hover:bg-slate-100 border-b last:border-b-0"
                                onClick={() => {
                                  setCountForm({ ...countForm, countedSku: result.sku });
                                  setSkuSearch(result.sku);
                                  setSkuDropdownOpen(false);
                                }}
                              >
                                <div className="font-mono text-sm font-medium">{result.sku}</div>
                                <div className="text-xs text-muted-foreground truncate">{result.name}</div>
                              </button>
                            ))
                          ) : (
                            <div className="px-3 py-4 text-center">
                              <div className="text-sm text-muted-foreground mb-2">No matching SKUs found</div>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  setUnknownSkuMode(true);
                                  setSkuDropdownOpen(false);
                                }}
                              >
                                <AlertTriangle className="h-3 w-3 mr-1" />
                                Report Unknown SKU
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {countForm.countedSku && countForm.countedSku !== selectedItem?.expectedSku && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          setCountForm({ ...countForm, countedSku: "" });
                          setSkuSearch("");
                          setUnknownSkuMode(false);
                        }}
                      >
                        <XCircle className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                  
                  {/* Selected different SKU */}
                  {countForm.countedSku && countForm.countedSku !== selectedItem?.expectedSku && (
                    <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-sm">
                      <div className="flex items-center gap-1 text-amber-700">
                        <AlertTriangle className="h-3 w-3" />
                        <span>Found: <strong>{countForm.countedSku}</strong></span>
                      </div>
                      <div className="text-xs text-amber-600 mt-1">
                        This will create a SKU mismatch variance for review
                      </div>
                    </div>
                  )}
                  
                  {/* Unknown SKU mode */}
                  {unknownSkuMode && (
                    <div className="mt-2 p-3 bg-rose-50 border border-rose-200 rounded">
                      <div className="flex items-center gap-1 text-rose-700 font-medium">
                        <AlertTriangle className="h-4 w-4" />
                        Unknown SKU Exception
                      </div>
                      <p className="text-xs text-rose-600 mt-1">
                        This SKU is not in the system. Enter the unknown SKU below and it will be routed to a Team Lead for investigation.
                      </p>
                      <Input
                        value={countForm.countedSku}
                        onChange={(e) => setCountForm({ ...countForm, countedSku: e.target.value })}
                        placeholder="Enter unknown SKU as shown on product"
                        className="mt-2"
                        data-testid="input-unknown-sku"
                      />
                    </div>
                  )}
                </div>
              </div>
              
              {/* Notes - collapsible */}
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Add notes (optional)
                </summary>
                <Textarea
                  value={countForm.notes}
                  onChange={(e) => setCountForm({ ...countForm, notes: e.target.value })}
                  placeholder="Any observations..."
                  rows={2}
                  className="mt-2"
                  data-testid="textarea-notes"
                />
              </details>
            </div>
            
            <div className="flex gap-2 pt-2 border-t">
              <Button variant="outline" className="flex-1 h-10" onClick={() => setCountDialogOpen(false)}>
                Cancel
              </Button>
              <Button 
                className="flex-1 h-10"
                onClick={() => selectedItem && countMutation.mutate({
                  itemId: selectedItem.id,
                  data: {
                    countedSku: countForm.countedSku || selectedItem.expectedSku,
                    countedQty: parseInt(countForm.countedQty) || 0,
                    notes: countForm.notes || null,
                  }
                })}
                disabled={countMutation.isPending || countForm.countedQty === ""}
              >
                Save
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
          <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MapPin className="h-4 w-4 text-blue-600" />
                {selectedItem?.locationCode}
                {selectedItem && getVarianceTypeBadge(selectedItem.varianceType)}
              </DialogTitle>
            </DialogHeader>
            {selectedItem && (() => {
              const linkedItem = selectedItem.relatedItemId
                ? cycleCountDetail.items.find(i => i.id === selectedItem.relatedItemId)
                : cycleCountDetail.items.find(i => i.relatedItemId === selectedItem.id);

              // Offsetting variance detection: find other items with same SKU that have variances
              const offsettingItems = selectedItem.productVariantId
                ? cycleCountDetail.items.filter(i =>
                    i.id !== selectedItem.id &&
                    i.productVariantId === selectedItem.productVariantId &&
                    i.varianceQty !== null && i.varianceQty !== 0
                  )
                : [];
              const netVarianceForSku = offsettingItems.reduce(
                (sum, i) => sum + (i.varianceQty ?? 0),
                selectedItem.varianceQty ?? 0
              );
              const hasOffsettingVariances = offsettingItems.length > 0;
              const isNetZero = hasOffsettingVariances && netVarianceForSku === 0;

              return (
                <div className="space-y-4">
                  {/* Offsetting variance banner */}
                  {hasOffsettingVariances && (
                    <div className={`rounded-md border p-3 text-sm space-y-1 ${
                      isNetZero
                        ? "bg-blue-50 border-blue-200"
                        : "bg-slate-50 border-slate-200"
                    }`}>
                      <div className={`font-medium ${isNetZero ? "text-blue-800" : "text-slate-700"}`}>
                        {isNetZero
                          ? "Likely misplacement — net variance for this SKU is zero"
                          : `This SKU has variances in ${offsettingItems.length} other location${offsettingItems.length > 1 ? "s" : ""}`
                        }
                      </div>
                      <div className="space-y-0.5 text-xs text-muted-foreground">
                        {offsettingItems.map(oi => (
                          <div key={oi.id} className="flex items-center gap-1">
                            <span className="font-mono">{oi.locationCode}</span>:
                            <span className={`font-bold ${(oi.varianceQty ?? 0) > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                              {(oi.varianceQty ?? 0) > 0 ? "+" : ""}{oi.varianceQty}
                            </span>
                          </div>
                        ))}
                        <div className="pt-1 border-t mt-1 font-medium">
                          Net variance: <span className={`font-bold ${netVarianceForSku === 0 ? "text-blue-600" : netVarianceForSku > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                            {netVarianceForSku > 0 ? "+" : ""}{netVarianceForSku}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Item details */}
                  <div className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">SKU</span>
                      <span className="font-mono font-medium">{selectedItem.expectedSku || selectedItem.countedSku || "(empty)"}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Expected</span>
                      <span className="font-mono font-bold">{selectedItem.expectedQty}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Counted</span>
                      <span className="font-mono font-bold">{selectedItem.countedQty ?? "—"}</span>
                    </div>
                    {selectedItem.varianceQty !== null && selectedItem.varianceQty !== 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Variance</span>
                        <span className={`font-mono font-bold ${selectedItem.varianceQty > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {selectedItem.varianceQty > 0 ? "+" : ""}{selectedItem.varianceQty}
                        </span>
                      </div>
                    )}
                    {selectedItem.countedBy && (
                      <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t">
                        <span>Counted by {selectedItem.countedBy}</span>
                        {selectedItem.countedAt && <span>{format(new Date(selectedItem.countedAt), "MMM d, h:mm a")}</span>}
                      </div>
                    )}
                    {selectedItem.varianceNotes && (
                      <div className="text-xs bg-muted/50 rounded p-2 mt-1">{selectedItem.varianceNotes}</div>
                    )}
                  </div>

                  {/* Linked mismatch item */}
                  {linkedItem && (
                    <div className="rounded-md border border-purple-200 bg-purple-50/50 p-3 space-y-2">
                      <div className="text-xs font-medium text-purple-700 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" /> Linked Mismatch Item
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">SKU</span>
                        <span className="font-mono font-medium">{linkedItem.expectedSku || linkedItem.countedSku || "(empty)"}</span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-muted-foreground">Variance</span>
                        <span className={`font-mono font-bold ${(linkedItem.varianceQty ?? 0) > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {(linkedItem.varianceQty ?? 0) > 0 ? "+" : ""}{linkedItem.varianceQty}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Adjustment preview */}
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-sm space-y-1">
                    <div className="font-medium text-amber-800">Inventory Adjustment Preview</div>
                    {selectedItem.productVariantId && selectedItem.varianceQty !== null && selectedItem.varianceQty !== 0 && (
                      <div className="flex items-center gap-1 text-amber-700">
                        <ArrowRight className="h-3 w-3" />
                        <span className="font-mono">{selectedItem.expectedSku || selectedItem.countedSku}</span>
                        <span>at {selectedItem.locationCode}:</span>
                        <span className={`font-bold ${selectedItem.varianceQty > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {selectedItem.varianceQty > 0 ? "+" : ""}{selectedItem.varianceQty}
                        </span>
                      </div>
                    )}
                    {linkedItem && linkedItem.productVariantId && linkedItem.varianceQty !== null && linkedItem.varianceQty !== 0 && (
                      <div className="flex items-center gap-1 text-amber-700">
                        <ArrowRight className="h-3 w-3" />
                        <span className="font-mono">{linkedItem.expectedSku || linkedItem.countedSku}</span>
                        <span>at {linkedItem.locationCode}:</span>
                        <span className={`font-bold ${(linkedItem.varianceQty ?? 0) > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {(linkedItem.varianceQty ?? 0) > 0 ? "+" : ""}{linkedItem.varianceQty}
                        </span>
                      </div>
                    )}
                    {!selectedItem.productVariantId && selectedItem.countedSku && (() => {
                      const parsed = parseSku(selectedItem.countedSku);
                      return (
                        <div className="space-y-2">
                          <div className="text-xs text-amber-600 font-medium">No matching product variant</div>
                          <div className="bg-muted/50 border rounded-lg p-3 space-y-2">
                            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                              <span className="text-muted-foreground">Product:</span>
                              <span className="font-mono font-medium">{parsed?.baseSku}</span>
                              <span className="text-muted-foreground">Variant:</span>
                              <span className="font-medium">{parsed?.typeName} of {parsed?.units}</span>
                              <span className="text-muted-foreground">SKU:</span>
                              <span className="font-mono font-medium">{selectedItem.countedSku.toUpperCase()}</span>
                            </div>
                            <p className="text-xs text-muted-foreground">
                              Creates the product (if needed) and variant, then links it so inventory can be adjusted.
                            </p>
                            <Button
                              className="w-full min-h-[44px]"
                              onClick={() => createVariantMutation.mutate(selectedItem.id)}
                              disabled={createVariantMutation.isPending}
                            >
                              {createVariantMutation.isPending ? "Creating..." : (
                                <><Plus className="h-4 w-4 mr-2" /> Create & Link SKU</>
                              )}
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                    {!selectedItem.productVariantId && !selectedItem.countedSku && (
                      <div className="text-xs text-amber-600">No SKU recorded — manual investigation needed</div>
                    )}
                  </div>

                  {/* Reason */}
                  <div>
                    <Label>Reason</Label>
                    <Select value={approveForm.reasonCode} onValueChange={(v) => setApproveForm({ ...approveForm, reasonCode: v })}>
                      <SelectTrigger data-testid="select-reason">
                        <SelectValue placeholder="Select reason" />
                      </SelectTrigger>
                      <SelectContent>
                        {adjustmentReasons.filter(r => r.transactionType === "adjustment").map((reason) => (
                          <SelectItem key={reason.code} value={reason.code}>{reason.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>Notes (optional)</Label>
                    <Textarea
                      value={approveForm.notes}
                      onChange={(e) => setApproveForm({ ...approveForm, notes: e.target.value })}
                      placeholder="Additional notes..."
                      data-testid="textarea-approve-notes"
                    />
                  </div>
                </div>
              );
            })()}
            <DialogFooter>
              <Button variant="outline" onClick={() => setApproveDialogOpen(false)}>Cancel</Button>
              <Button
                onClick={() => selectedItem && approveMutation.mutate({
                  itemId: selectedItem.id,
                  data: {
                    reasonCode: approveForm.reasonCode,
                    notes: approveForm.notes || null,
                  }
                })}
                disabled={approveMutation.isPending || !approveForm.reasonCode}
              >
                Approve & Adjust
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Bulk Approve Dialog */}
        <Dialog open={bulkApproveOpen} onOpenChange={setBulkApproveOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>Bulk Approve Variances</DialogTitle>
              <DialogDescription>
                Select items to approve. {bulkSelectedIds.size > 0 && <strong>{bulkSelectedIds.size} selected</strong>}
              </DialogDescription>
            </DialogHeader>

            {(() => {
              // Get all approvable items (have variance, not yet approved)
              const approvableItems = cycleCountDetail.items.filter(i =>
                i.varianceType &&
                (i.status === "variance" || i.status === "investigate") &&
                i.productVariantId
              );

              // Group by variance type
              const groups: Record<string, CycleCountItem[]> = {};
              for (const item of approvableItems) {
                const key = item.varianceType || "other";
                if (!groups[key]) groups[key] = [];
                groups[key].push(item);
              }

              // Items without productVariantId (can't auto-approve)
              const unlinkableItems = cycleCountDetail.items.filter(i =>
                i.varianceType &&
                (i.status === "variance" || i.status === "investigate") &&
                !i.productVariantId
              );

              const varianceTypeLabels: Record<string, string> = {
                quantity_under: "Shortage",
                quantity_over: "Overage",
                stray_removed: "Stray Removed",
                unexpected_sku: "Wrong SKU",
                unexpected_item: "Unexpected Item",
                other: "Other",
              };

              const toggleGroup = (items: CycleCountItem[]) => {
                const ids = items.map(i => i.id);
                const allSelected = ids.every(id => bulkSelectedIds.has(id));
                const next = new Set(bulkSelectedIds);
                if (allSelected) {
                  ids.forEach(id => next.delete(id));
                } else {
                  ids.forEach(id => next.add(id));
                }
                setBulkSelectedIds(next);
              };

              const toggleItem = (id: number) => {
                const next = new Set(bulkSelectedIds);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setBulkSelectedIds(next);
              };

              const selectAll = () => {
                setBulkSelectedIds(new Set(approvableItems.map(i => i.id)));
              };

              const deselectAll = () => {
                setBulkSelectedIds(new Set());
              };

              return (
                <>
                  <div className="flex items-center justify-between border-b pb-2">
                    <span className="text-sm text-muted-foreground">
                      {approvableItems.length} approvable items
                      {unlinkableItems.length > 0 && (
                        <span className="text-amber-600 ml-2">({unlinkableItems.length} missing SKU link)</span>
                      )}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={selectAll}>Select All</Button>
                      <Button variant="ghost" size="sm" onClick={deselectAll}>Deselect All</Button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-auto space-y-3 min-h-0">
                    {Object.entries(groups).map(([type, items]) => {
                      const groupIds = items.map(i => i.id);
                      const allGroupSelected = groupIds.every(id => bulkSelectedIds.has(id));
                      const someGroupSelected = groupIds.some(id => bulkSelectedIds.has(id));

                      return (
                        <div key={type} className="border rounded-lg">
                          {/* Group header */}
                          <button
                            type="button"
                            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-muted/30 transition-colors"
                            onClick={() => toggleGroup(items)}
                          >
                            <Checkbox
                              checked={allGroupSelected ? true : someGroupSelected ? "indeterminate" : false}
                              onCheckedChange={() => toggleGroup(items)}
                            />
                            <div className="flex items-center gap-2 flex-1">
                              <span className="font-medium text-sm">
                                {varianceTypeLabels[type] || type}
                              </span>
                              <Badge variant="secondary" className="text-xs">{items.length}</Badge>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {items.reduce((s, i) => s + (i.varianceQty ?? 0), 0) > 0 ? "+" : ""}
                              {items.reduce((s, i) => s + (i.varianceQty ?? 0), 0)} net
                            </span>
                          </button>

                          {/* Individual items */}
                          <div className="border-t divide-y">
                            {items.map(item => (
                              <label
                                key={item.id}
                                className="flex items-center gap-3 px-3 py-1.5 hover:bg-muted/20 cursor-pointer text-sm"
                              >
                                <Checkbox
                                  checked={bulkSelectedIds.has(item.id)}
                                  onCheckedChange={() => toggleItem(item.id)}
                                />
                                <span className="font-mono text-xs text-blue-600 w-20 shrink-0">{item.locationCode}</span>
                                <span className="flex-1 truncate">
                                  {item.expectedSku || item.countedSku || "(empty)"}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {item.expectedQty} → {item.countedQty ?? "—"}
                                </span>
                                <span className={`font-mono text-xs font-bold w-10 text-right ${
                                  (item.varianceQty ?? 0) > 0 ? "text-emerald-600" : "text-rose-600"
                                }`}>
                                  {(item.varianceQty ?? 0) > 0 ? "+" : ""}{item.varianceQty}
                                </span>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}

                    {unlinkableItems.length > 0 && (
                      <div className="border rounded-lg border-amber-200 bg-amber-50/50">
                        <div className="px-3 py-2 text-sm text-amber-700 flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4" />
                          <span>{unlinkableItems.length} items can't be bulk approved (no SKU link)</span>
                        </div>
                        <div className="border-t border-amber-200 divide-y divide-amber-100">
                          {unlinkableItems.map(item => (
                            <div key={item.id} className="flex items-center gap-3 px-3 py-1.5 text-sm text-amber-800">
                              <span className="font-mono text-xs w-20 shrink-0">{item.locationCode}</span>
                              <span className="flex-1 truncate">{item.countedSku || "(no SKU)"}</span>
                              <span className="text-xs">Use individual approve to link first</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="border-t pt-3 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label>Reason Code</Label>
                        <Select
                          value={bulkApproveForm.reasonCode}
                          onValueChange={(v) => setBulkApproveForm({ ...bulkApproveForm, reasonCode: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select reason" />
                          </SelectTrigger>
                          <SelectContent>
                            {adjustmentReasons.filter(r => r.transactionType === "adjustment").map((reason) => (
                              <SelectItem key={reason.code} value={reason.code}>{reason.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label>Notes (optional)</Label>
                        <Input
                          value={bulkApproveForm.notes}
                          onChange={(e) => setBulkApproveForm({ ...bulkApproveForm, notes: e.target.value })}
                          placeholder="Bulk approval notes..."
                        />
                      </div>
                    </div>
                  </div>
                </>
              );
            })()}

            <DialogFooter>
              <Button variant="outline" onClick={() => setBulkApproveOpen(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  bulkApproveMutation.mutate({
                    itemIds: Array.from(bulkSelectedIds),
                    reasonCode: bulkApproveForm.reasonCode,
                    notes: bulkApproveForm.notes || undefined,
                  });
                }}
                disabled={bulkApproveMutation.isPending || bulkSelectedIds.size === 0 || !bulkApproveForm.reasonCode}
              >
                {bulkApproveMutation.isPending
                  ? "Approving..."
                  : `Approve ${bulkSelectedIds.size} Items`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full p-4 md:p-6 gap-4 overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Cycle Counts</h1>
          <p className="text-sm text-muted-foreground">Monthly inventory reconciliation</p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-new-count" className="w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" /> New Cycle Count
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">Loading...</div>
      ) : cycleCounts.length === 0 ? (
        <Card className="flex-1 flex flex-col items-center justify-center">
          <CardContent className="text-center py-12">
            <ClipboardList className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h2 className="text-xl font-semibold mb-2">No Cycle Counts Yet</h2>
            <p className="text-muted-foreground mb-4">Create your first cycle count to start reconciling inventory</p>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-2" /> Create Cycle Count
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Mobile card list */}
          <div className="flex-1 overflow-auto space-y-3 md:hidden">
            {cycleCounts.map((count) => (
              <Card 
                key={count.id} 
                className="cursor-pointer active:bg-muted/50"
                onClick={() => setSelectedCount(count.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">{count.name}</div>
                      <div className="text-sm text-muted-foreground flex items-center gap-2">
                        {format(new Date(count.createdAt), "MMM d, yyyy")}
                        {count.warehouseId && (
                          <Badge variant="outline" className="text-xs">{warehouses.find(w => w.id === count.warehouseId)?.code || "—"}</Badge>
                        )}
                      </div>
                      {count.status !== "draft" && (
                        <div className="flex items-center gap-4 mt-2 text-sm">
                          <span>{count.countedBins}/{count.totalBins} bins</span>
                          {count.varianceCount > 0 && (
                            <span className="text-amber-600">{count.varianceCount} variances</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {getStatusBadge(count.status)}
                      <div className="flex items-center gap-2">
                        {count.status === "draft" && (
                          <Button 
                            size="sm" 
                            onClick={(e) => { e.stopPropagation(); initializeMutation.mutate(count.id); }}
                            disabled={initializeMutation.isPending}
                          >
                            <Play className="h-4 w-4 mr-1" /> Start
                          </Button>
                        )}
                        {count.status === "in_progress" && (
                          <Button size="sm" onClick={(e) => { e.stopPropagation(); setSelectedCount(count.id); }}>
                            Continue <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        )}
                        {count.status === "completed" && (
                          <ChevronRight className="h-5 w-5 text-muted-foreground" />
                        )}
                        {count.status !== "completed" && (
                          <Button 
                            size="sm" 
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 p-2"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (confirm("Are you sure you want to delete this cycle count? This cannot be undone.")) {
                                deleteMutation.mutate(count.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Desktop table */}
          <div className="rounded-md border bg-card hidden md:block">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Warehouse</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Progress</TableHead>
                  <TableHead className="text-right">Variances</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-[150px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycleCounts.map((count) => (
                  <TableRow key={count.id} className="cursor-pointer" onClick={() => setSelectedCount(count.id)}>
                    <TableCell className="font-medium">{count.name}</TableCell>
                    <TableCell>
                      {count.warehouseId ? (
                        <Badge variant="outline" className="text-xs">{warehouses.find(w => w.id === count.warehouseId)?.code || "—"}</Badge>
                      ) : <span className="text-muted-foreground text-sm">All</span>}
                    </TableCell>
                    <TableCell>{getStatusBadge(count.status)}</TableCell>
                    <TableCell className="text-right">
                      {count.status !== "draft" ? `${count.countedBins} / ${count.totalBins}` : "-"}
                    </TableCell>
                    <TableCell className="text-right">
                      {count.varianceCount > 0 ? (
                        <span className="text-amber-600">{count.varianceCount}</span>
                      ) : "-"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format(new Date(count.createdAt), "MMM d, yyyy")}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 justify-end">
                        {count.status === "draft" && (
                          <Button 
                            size="sm" 
                            onClick={(e) => { e.stopPropagation(); initializeMutation.mutate(count.id); }}
                            disabled={initializeMutation.isPending}
                          >
                            <Play className="h-4 w-4 mr-1" /> Start
                          </Button>
                        )}
                        {count.status === "in_progress" && (
                          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); setSelectedCount(count.id); }}>
                            Continue <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        )}
                        {count.status === "completed" && (
                          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setSelectedCount(count.id); }}>
                            View <ChevronRight className="h-4 w-4 ml-1" />
                          </Button>
                        )}
                        {count.status !== "completed" && (
                          <Button 
                            size="sm" 
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              if (confirm("Are you sure you want to delete this cycle count? This cannot be undone.")) {
                                deleteMutation.mutate(count.id);
                              }
                            }}
                            disabled={deleteMutation.isPending}
                            data-testid={`button-delete-count-${count.id}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader className="pb-2">
            <DialogTitle className="text-lg">New Cycle Count</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-sm">Name *</Label>
              <Input
                value={newCountForm.name}
                onChange={(e) => setNewCountForm({ ...newCountForm, name: e.target.value })}
                placeholder="e.g., January 2026 Full Count"
                className="h-10"
                autoComplete="off"
                data-testid="input-count-name"
              />
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Description (optional)
              </summary>
              <Textarea
                value={newCountForm.description}
                onChange={(e) => setNewCountForm({ ...newCountForm, description: e.target.value })}
                placeholder="Notes about this count..."
                rows={2}
                className="mt-2"
                data-testid="textarea-description"
              />
            </details>
            <div>
              <Label className="text-sm">Warehouse</Label>
              <Select
                value={newCountForm.warehouseId}
                onValueChange={(v) => setNewCountForm({ ...newCountForm, warehouseId: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-warehouse">
                  <SelectValue placeholder="All warehouses" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.code} — {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Zone Filter (optional)
              </summary>
              <Input
                value={newCountForm.zoneFilter}
                onChange={(e) => setNewCountForm({ ...newCountForm, zoneFilter: e.target.value })}
                placeholder="e.g., A to count only zone A"
                className="mt-2 h-10"
                data-testid="input-zone-filter"
              />
            </details>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Aisle Filter (optional)
              </summary>
              <Input
                value={newCountForm.aisleFilter}
                onChange={(e) => setNewCountForm({ ...newCountForm, aisleFilter: e.target.value })}
                placeholder="e.g., G to count only aisle G"
                className="mt-2 h-10"
                data-testid="input-aisle-filter"
              />
            </details>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Location Purpose
              </summary>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {locationTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={newCountForm.locationTypes.includes(type.value)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewCountForm({ ...newCountForm, locationTypes: [...newCountForm.locationTypes, type.value] });
                        } else {
                          setNewCountForm({ ...newCountForm, locationTypes: newCountForm.locationTypes.filter(t => t !== type.value) });
                        }
                      }}
                      className="h-5 w-5"
                      data-testid={`checkbox-location-type-${type.value}`}
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Leave unchecked for all</p>
            </details>
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Storage Type
              </summary>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {binTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer min-h-[44px]">
                    <input
                      type="checkbox"
                      checked={newCountForm.binTypes.includes(type.value)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewCountForm({ ...newCountForm, binTypes: [...newCountForm.binTypes, type.value] });
                        } else {
                          setNewCountForm({ ...newCountForm, binTypes: newCountForm.binTypes.filter(t => t !== type.value) });
                        }
                      }}
                      className="h-5 w-5"
                      data-testid={`checkbox-bin-type-${type.value}`}
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Leave unchecked for all</p>
            </details>
          </div>
          <div className="flex gap-2 pt-3 border-t mt-3">
            <Button variant="outline" className="flex-1 h-11" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button 
              className="flex-1 h-11"
              onClick={() => createMutation.mutate({
                name: newCountForm.name,
                description: newCountForm.description || undefined,
                zoneFilter: newCountForm.zoneFilter || undefined,
                aisleFilter: newCountForm.aisleFilter || undefined,
                warehouseId: newCountForm.warehouseId ? parseInt(newCountForm.warehouseId) : undefined,
                locationTypeFilter: newCountForm.locationTypes.length > 0 ? newCountForm.locationTypes.join(",") : undefined,
                binTypeFilter: newCountForm.binTypes.length > 0 ? newCountForm.binTypes.join(",") : undefined,
              })}
              disabled={createMutation.isPending || !newCountForm.name}
            >
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
