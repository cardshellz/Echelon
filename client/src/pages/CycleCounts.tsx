import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDebounce } from "@/hooks/use-debounce";
import { 
  ClipboardList, 
  Plus, 
  Play, 
  CheckCircle, 
  XCircle, 
  AlertTriangle, 
  ChevronRight,
  Search,
  Package,
  MapPin,
  Check,
  RotateCcw,
  Trash2
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
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

interface CycleCount {
  id: number;
  name: string;
  description: string | null;
  status: string;
  warehouseId: number | null;
  zoneFilter: string | null;
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
  inventoryItemId: number | null;
  catalogProductId: number | null;
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
  const [selectedItem, setSelectedItem] = useState<CycleCountItem | null>(null);
  const [newCountForm, setNewCountForm] = useState({ name: "", description: "", zoneFilter: "", locationTypes: [] as string[], binTypes: [] as string[] });
  const locationTypeOptions = [
    { value: "forward_pick", label: "Forward Pick" },
    { value: "bulk_storage", label: "Bulk Storage" },
    { value: "overflow", label: "Overflow" },
    { value: "receiving", label: "Receiving" },
    { value: "staging", label: "Staging" },
  ];
  const binTypeOptions = [
    { value: "bin", label: "Bin" },
    { value: "pallet", label: "Pallet" },
    { value: "carton_flow", label: "Carton Flow" },
    { value: "bulk_reserve", label: "Bulk Reserve" },
    { value: "shelf", label: "Shelf" },
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
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "variance" | "ok">("all");
  
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

  // SKU search for typeahead
  interface SkuSearchResult {
    sku: string;
    name: string;
    source: string;
    inventoryItemId: number | null;
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
    mutationFn: async (data: { name: string; description?: string; zoneFilter?: string }) => {
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
      setNewCountForm({ name: "", description: "", zoneFilter: "", locationTypes: [], binTypes: [] });
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
    if (item.varianceType && item.status === "approved") return <Badge className="bg-blue-100 text-blue-700">Adjusted</Badge>;
    if (item.varianceType) return <Badge className="bg-amber-100 text-amber-700">Variance</Badge>;
    return <Badge variant="outline">{item.status}</Badge>;
  };

  const getVarianceTypeBadge = (type: string | null) => {
    if (!type) return null;
    switch (type) {
      case "quantity_over": return <Badge className="bg-emerald-100 text-emerald-700">+Over</Badge>;
      case "quantity_under": return <Badge className="bg-rose-100 text-rose-700">-Under</Badge>;
      case "sku_mismatch": return <Badge variant="destructive">Wrong SKU</Badge>;
      case "unexpected_item": return <Badge className="bg-amber-100 text-amber-700">Unexpected</Badge>;
      case "missing_item": return <Badge className="bg-rose-100 text-rose-700">Missing</Badge>;
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

  const filteredItems = cycleCountDetail?.items.filter(item => {
    const matchesSearch = !searchQuery || 
      item.locationCode?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.expectedSku?.toLowerCase().includes(searchQuery.toLowerCase());
    
    if (!matchesSearch) return false;
    
    switch (statusFilter) {
      case "pending":
        return item.status === "pending";
      case "variance":
        return item.varianceType && item.status !== "approved";
      case "ok":
        return item.status !== "pending" && !item.varianceType;
      default:
        return true;
    }
  }) || [];

  const handleCountClick = (item: CycleCountItem) => {
    setSelectedItem(item);
    setCountForm({
      countedSku: item.expectedSku || "",
      countedQty: "",
      notes: "",
    });
    setSkuSearch("");
    setSkuDropdownOpen(false);
    setUnknownSkuMode(false);
    setCountDialogOpen(true);
  };

  const handleApproveClick = (item: CycleCountItem) => {
    setSelectedItem(item);
    setApproveDialogOpen(true);
  };

  // Mobile counting mode state
  const [mobileCountMode, setMobileCountMode] = useState(false);
  const [currentBinIndex, setCurrentBinIndex] = useState(0);
  const [quickCountQty, setQuickCountQty] = useState("");
  const [differentSkuMode, setDifferentSkuMode] = useState(false);
  const [foundSku, setFoundSku] = useState("");
  
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

  if (selectedCount && cycleCountDetail) {
    const pendingCount = cycleCountDetail.items.filter(i => i.status === "pending").length;
    const varianceCount = cycleCountDetail.items.filter(i => i.varianceType && i.status !== "approved").length;
    
    // Get pending items for mobile mode
    const pendingItems = cycleCountDetail.items.filter(i => i.status === "pending");
    const currentItem = pendingItems[currentBinIndex];
    
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
          // Note: useEffect will handle loading draft for next bin and resetting state
          // Auto-advance to next bin (useEffect handles draft loading)
          if (currentBinIndex < pendingItems.length - 1) {
            setCurrentBinIndex(currentBinIndex + 1);
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
    
    // Centralized draft loading via useEffect - triggers on bin change or entering mobile mode
    React.useEffect(() => {
      if (mobileCountMode && currentItem) {
        const draft = loadDraft(cycleCountDetail.id, currentItem.id);
        if (draft) {
          setQuickCountQty(draft.qty);
          if (draft.sku && draft.sku !== currentItem.expectedSku) {
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
    }, [mobileCountMode, currentBinIndex, currentItem?.id]);
    
    // Mobile counting view
    if (mobileCountMode && pendingItems.length > 0) {
      return (
        <div className="flex flex-col h-full bg-slate-50">
          {/* Header */}
          <div className="bg-white border-b px-4 py-3 flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={handleExitCountMode}>
              <RotateCcw className="h-4 w-4 mr-2" /> Exit
            </Button>
            <div className="text-center">
              <div className="text-sm text-muted-foreground">Bin {currentBinIndex + 1} of {pendingItems.length}</div>
            </div>
            <div className="w-16" />
          </div>
          
          {/* Progress bar */}
          <div className="h-2 bg-slate-200">
            <div 
              className="h-full bg-emerald-500 transition-all" 
              style={{ width: `${((cycleCountDetail.countedBins) / cycleCountDetail.totalBins) * 100}%` }}
            />
          </div>
          
          {/* Main counting card */}
          <div className="flex-1 p-4 flex flex-col gap-4">
            <Card className="flex-1">
              <CardContent className="pt-6 flex flex-col items-center justify-center h-full gap-6">
                {/* Location - BIG and prominent */}
                <div className="text-center">
                  <div className="text-sm text-muted-foreground mb-1">Go to bin</div>
                  <div className="text-5xl font-bold font-mono text-blue-600">
                    {currentItem?.locationCode}
                  </div>
                </div>
                
                {/* SKU */}
                <div className="text-center">
                  <div className="text-sm text-muted-foreground mb-1">Product</div>
                  <div className="text-xl font-semibold">
                    {currentItem?.expectedSku || "(Empty bin)"}
                  </div>
                </div>
                
                {/* Expected quantity hint */}
                <div className="text-center bg-slate-100 rounded-lg px-6 py-3">
                  <div className="text-sm text-muted-foreground">Expected</div>
                  <div className="text-3xl font-bold">{currentItem?.expectedQty}</div>
                </div>
                
                {/* Quantity input */}
                <div className="w-full max-w-xs">
                  <div className="text-sm text-muted-foreground text-center mb-2">Count what you see</div>
                  <div className="flex items-center gap-3">
                    <Button 
                      variant="outline" 
                      size="lg"
                      className="h-16 w-16 text-2xl"
                      onClick={() => setQuickCountQty(String(Math.max(0, (parseInt(quickCountQty) || 0) - 1)))}
                      data-testid="button-decrease-qty"
                    >
                      -
                    </Button>
                    <Input
                      type="number"
                      inputMode="numeric"
                      value={quickCountQty}
                      onChange={(e) => setQuickCountQty(e.target.value)}
                      className="h-16 text-3xl text-center font-mono flex-1"
                      placeholder="0"
                      data-testid="input-quick-count"
                    />
                    <Button 
                      variant="outline" 
                      size="lg"
                      className="h-16 w-16 text-2xl"
                      onClick={() => setQuickCountQty(String((parseInt(quickCountQty) || 0) + 1))}
                      data-testid="button-increase-qty"
                    >
                      +
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
            
            {/* Navigation and confirm */}
            <div className="flex gap-3">
              <Button 
                variant="outline" 
                size="lg"
                className="h-14"
                onClick={() => {
                  // Save current draft before navigating
                  if (quickCountQty !== "" && currentItem) {
                    const skuToSave = differentSkuMode ? foundSku : currentItem.expectedSku;
                    saveDraft(cycleCountDetail.id, currentItem.id, quickCountQty, skuToSave || "");
                  }
                  // useEffect will handle loading drafts when currentBinIndex changes
                  setCurrentBinIndex(Math.max(0, currentBinIndex - 1));
                }}
                disabled={currentBinIndex === 0}
              >
                Prev
              </Button>
              <Button 
                size="lg"
                className="flex-1 h-14 text-lg"
                onClick={handleQuickCount}
                disabled={countMutation.isPending || quickCountQty === ""}
                data-testid="button-confirm-count"
              >
                <Check className="h-5 w-5 mr-2" />
                Confirm & Next
              </Button>
              <Button 
                variant="outline" 
                size="lg"
                className="h-14"
                onClick={() => {
                  // Save current draft before navigating
                  if (quickCountQty !== "" && currentItem) {
                    const skuToSave = differentSkuMode ? foundSku : currentItem.expectedSku;
                    saveDraft(cycleCountDetail.id, currentItem.id, quickCountQty, skuToSave || "");
                  }
                  // useEffect will handle loading drafts when currentBinIndex changes
                  setCurrentBinIndex(Math.min(pendingItems.length - 1, currentBinIndex + 1));
                }}
                disabled={currentBinIndex === pendingItems.length - 1}
              >
                Skip
              </Button>
            </div>
            
            {/* Quick actions */}
            <div className="flex gap-2">
              <Button 
                variant="secondary" 
                size="lg"
                className="flex-1 h-12"
                onClick={() => {
                  setQuickCountQty(String(currentItem?.expectedQty || 0));
                }}
                data-testid="button-match-expected"
              >
                Matches ({currentItem?.expectedQty})
              </Button>
              <Button 
                variant={differentSkuMode ? "default" : "outline"}
                size="lg"
                className="h-12"
                onClick={() => {
                  setDifferentSkuMode(!differentSkuMode);
                  if (!differentSkuMode) {
                    setFoundSku("");
                  }
                }}
                data-testid="button-different-sku"
              >
                <AlertTriangle className="h-4 w-4 mr-1" />
                Wrong SKU
              </Button>
            </div>
            
            {/* Different SKU input */}
            {differentSkuMode && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <Label className="text-amber-800">What SKU is actually in this bin?</Label>
                <Input
                  value={foundSku}
                  onChange={(e) => setFoundSku(e.target.value)}
                  placeholder="Enter or scan actual SKU"
                  className="mt-2 text-lg"
                  autoFocus
                  data-testid="input-found-sku"
                />
                <p className="text-xs text-amber-600 mt-2">
                  This will be flagged as a SKU mismatch for review
                </p>
              </div>
            )}
            
            {/* Add unexpected item found */}
            {addFoundItemMode ? (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
                <Label className="text-blue-800">Add Unexpected Item Found in This Bin</Label>
                <Input
                  value={foundItemForm.sku}
                  onChange={(e) => setFoundItemForm({ ...foundItemForm, sku: e.target.value })}
                  placeholder="Enter or scan SKU"
                  className="text-lg"
                  autoFocus
                  data-testid="input-add-found-sku"
                />
                <Input
                  type="number"
                  value={foundItemForm.quantity}
                  onChange={(e) => setFoundItemForm({ ...foundItemForm, quantity: e.target.value })}
                  placeholder="Quantity"
                  className="text-lg"
                  data-testid="input-add-found-qty"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAddFoundItemMode(false);
                      setFoundItemForm({ sku: "", quantity: "" });
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

            {/* Empty bin option */}
            <Button 
              variant="ghost" 
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setQuickCountQty("0");
              }}
              data-testid="button-bin-empty"
            >
              Bin is empty
            </Button>
          </div>
        </div>
      );
    }
    
    // Mobile done state
    if (mobileCountMode && pendingItems.length === 0) {
      return (
        <div className="flex flex-col h-full items-center justify-center p-6 gap-6">
          <CheckCircle className="h-20 w-20 text-emerald-500" />
          <h2 className="text-2xl font-bold text-center">All Bins Counted!</h2>
          <p className="text-muted-foreground text-center">
            {varianceCount > 0 
              ? `${varianceCount} variance(s) need review`
              : "No variances found - ready to complete"}
          </p>
          <Button size="lg" onClick={() => setMobileCountMode(false)}>
            View Results
          </Button>
        </div>
      );
    }
    
    return (
      <div className="flex flex-col h-full p-4 md:p-6 gap-4">
        <div className="flex flex-wrap items-center gap-2 md:gap-4">
          <Button variant="ghost" size="sm" onClick={() => setSelectedCount(null)}>
            <RotateCcw className="h-4 w-4 mr-2" /> Back
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-xl md:text-2xl font-bold truncate">{cycleCountDetail.name}</h1>
            <p className="text-muted-foreground text-sm">
              {cycleCountDetail.countedBins} / {cycleCountDetail.totalBins} bins counted
            </p>
          </div>
          {getStatusBadge(cycleCountDetail.status)}
        </div>
        
        {/* Action buttons row */}
        <div className="flex flex-wrap gap-2">
          {cycleCountDetail.status === "draft" && (
            <Button 
              size="lg" 
              className="flex-1 md:flex-none"
              onClick={() => initializeMutation.mutate(selectedCount)}
              disabled={initializeMutation.isPending}
              data-testid="button-initialize-count"
            >
              <Play className="h-4 w-4 mr-2" /> {initializeMutation.isPending ? "Initializing..." : "Initialize Count"}
            </Button>
          )}
          {cycleCountDetail.status === "in_progress" && pendingCount > 0 && (
            <Button 
              size="lg" 
              className="flex-1 md:flex-none"
              onClick={() => {
                setCurrentBinIndex(0);
                // useEffect will handle loading drafts when mobileCountMode becomes true
                setMobileCountMode(true);
              }}
              data-testid="button-start-counting"
            >
              <Play className="h-4 w-4 mr-2" /> Start Counting ({pendingCount} bins)
            </Button>
          )}
          {cycleCountDetail.status === "in_progress" && pendingCount === 0 && varianceCount === 0 && (
            <Button onClick={() => completeMutation.mutate(selectedCount)} disabled={completeMutation.isPending}>
              <CheckCircle className="h-4 w-4 mr-2" /> Complete
            </Button>
          )}
          {cycleCountDetail.status !== "completed" && (
            <Button 
              variant="destructive" 
              size="sm"
              onClick={() => {
                if (confirm("Are you sure you want to delete this cycle count? This cannot be undone.")) {
                  deleteMutation.mutate(selectedCount);
                }
              }}
              disabled={deleteMutation.isPending}
            >
              <Trash2 className="h-4 w-4 mr-2" /> Delete
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <Card 
            className={`cursor-pointer transition-all hover:ring-2 hover:ring-primary/50 ${statusFilter === "all" ? "ring-2 ring-primary" : ""}`}
            onClick={() => setStatusFilter("all")}
            data-testid="card-filter-all"
          >
            <CardContent className="pt-4 p-3 md:p-6">
              <div className="text-xl md:text-2xl font-bold">{cycleCountDetail.totalBins}</div>
              <div className="text-xs md:text-sm text-muted-foreground">Total</div>
            </CardContent>
          </Card>
          <Card 
            className={`cursor-pointer transition-all hover:ring-2 hover:ring-blue-500/50 ${statusFilter === "pending" ? "ring-2 ring-blue-500" : ""}`}
            onClick={() => setStatusFilter("pending")}
            data-testid="card-filter-pending"
          >
            <CardContent className="pt-4 p-3 md:p-6">
              <div className="text-xl md:text-2xl font-bold">{pendingCount}</div>
              <div className="text-xs md:text-sm text-muted-foreground">Pending</div>
            </CardContent>
          </Card>
          <Card 
            className={`cursor-pointer transition-all hover:ring-2 hover:ring-amber-500/50 ${statusFilter === "variance" ? "ring-2 ring-amber-500" : ""}`}
            onClick={() => setStatusFilter("variance")}
            data-testid="card-filter-variance"
          >
            <CardContent className="pt-4 p-3 md:p-6">
              <div className="text-xl md:text-2xl font-bold text-amber-600">{varianceCount}</div>
              <div className="text-xs md:text-sm text-muted-foreground">Variances</div>
            </CardContent>
          </Card>
          <Card 
            className={`cursor-pointer transition-all hover:ring-2 hover:ring-emerald-500/50 ${statusFilter === "ok" ? "ring-2 ring-emerald-500" : ""}`}
            onClick={() => setStatusFilter("ok")}
            data-testid="card-filter-ok"
          >
            <CardContent className="pt-4 p-3 md:p-6">
              <div className="text-xl md:text-2xl font-bold text-emerald-600">
                {cycleCountDetail.countedBins - varianceCount}
              </div>
              <div className="text-xs md:text-sm text-muted-foreground">OK</div>
            </CardContent>
          </Card>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by location or SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
            data-testid="input-search"
          />
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
                      {item.mismatchType === "unexpected_found" 
                        ? <span className="text-amber-700">Found: {item.countedSku}</span>
                        : (item.expectedSku || "(empty)")
                      }
                    </div>
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
                    {/* Show linked item indicator */}
                    {item.relatedItemId && (
                      <div className="mt-2 text-xs text-purple-600 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        Linked to mismatch pair
                      </div>
                    )}
                    {item.varianceNotes && (
                      <div className="mt-1 text-xs text-muted-foreground truncate">{item.varianceNotes}</div>
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
                    {item.varianceType && item.status !== "approved" && (
                      <Button size="sm" variant="outline" onClick={() => handleApproveClick(item)}>
                        {item.relatedItemId ? "Approve Pair" : "Approve"}
                      </Button>
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
                <TableHead className="w-[120px]">Location</TableHead>
                <TableHead>Expected SKU</TableHead>
                <TableHead className="text-right w-[100px]">Expected</TableHead>
                <TableHead className="text-right w-[100px]">Counted</TableHead>
                <TableHead className="text-right w-[100px]">Variance</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[120px]">Type</TableHead>
                <TableHead className="w-[100px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((item) => (
                <TableRow key={item.id} className={item.varianceType ? "bg-amber-50/50" : ""}>
                  <TableCell className="font-mono font-medium">{item.locationCode}</TableCell>
                  <TableCell>{item.expectedSku || <span className="text-muted-foreground">(empty)</span>}</TableCell>
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
                  <TableCell>
                    {item.status === "pending" && (
                      <Button size="sm" variant="outline" onClick={() => handleCountClick(item)}>
                        Count
                      </Button>
                    )}
                    {item.varianceType && item.status !== "approved" && (
                      <Button size="sm" variant="outline" onClick={() => handleApproveClick(item)}>
                        Approve
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <Dialog open={countDialogOpen} onOpenChange={setCountDialogOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-blue-600" />
                {selectedItem?.locationCode}
              </DialogTitle>
            </DialogHeader>
            
            {/* Expected info - prominent display */}
            <div className="bg-slate-100 rounded-lg p-4 text-center">
              <div className="text-sm text-muted-foreground">Expected</div>
              <div className="font-semibold text-lg">{selectedItem?.expectedSku || "(empty bin)"}</div>
              <div className="text-3xl font-bold text-blue-600">{selectedItem?.expectedQty}</div>
            </div>
            
            <div className="space-y-4">
              {/* Primary action: Confirm match */}
              <Button 
                variant="default" 
                size="lg"
                className="w-full h-14 text-lg bg-emerald-600 hover:bg-emerald-700"
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
                <Check className="h-5 w-5 mr-2" />
                Confirm Match (SKU & Qty)
              </Button>
              
              <div className="text-center text-sm text-muted-foreground">— or enter different count —</div>
              
              {/* Quantity section */}
              <div>
                <Label>Actual Quantity in Bin</Label>
                <div className="flex gap-2 mt-1">
                  <Button 
                    variant="outline" 
                    size="icon"
                    className="h-12 w-14 text-xl"
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
                    className="text-center text-xl h-12 flex-1"
                    data-testid="input-counted-qty"
                  />
                  <Button 
                    variant="outline" 
                    size="icon"
                    className="h-12 w-14 text-xl"
                    onClick={() => setCountForm({ 
                      ...countForm, 
                      countedQty: String((parseInt(countForm.countedQty) || 0) + 1) 
                    })}
                  >
                    +
                  </Button>
                </div>
                <div className="flex gap-2 mt-2">
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="flex-1"
                    onClick={() => setCountForm({ ...countForm, countedQty: "0" })}
                  >
                    Bin Empty
                  </Button>
                  <Button 
                    variant="outline" 
                    size="sm"
                    className="flex-1"
                    onClick={() => setCountForm({ ...countForm, countedQty: String(selectedItem?.expectedQty || 0) })}
                  >
                    Same as Expected
                  </Button>
                </div>
              </div>
              
              {/* SKU section - searchable typeahead */}
              <div>
                <div className="flex items-center justify-between">
                  <Label>Different SKU in Bin?</Label>
                  <span className="text-xs text-muted-foreground">Search if different product found</span>
                </div>
                <div className="relative mt-1">
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                      <Input
                        ref={skuInputRef}
                        value={skuSearch}
                        onChange={(e) => {
                          setSkuSearch(e.target.value);
                          setSkuDropdownOpen(true);
                          setUnknownSkuMode(false);
                        }}
                        onFocus={() => setSkuDropdownOpen(true)}
                        onBlur={() => setTimeout(() => setSkuDropdownOpen(false), 200)}
                        placeholder="Search SKU..."
                        className="pl-10"
                        data-testid="input-sku-search"
                      />
                      {/* Dropdown */}
                      {skuDropdownOpen && skuSearch.length >= 2 && (
                        <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
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
              
              {/* Notes */}
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  value={countForm.notes}
                  onChange={(e) => setCountForm({ ...countForm, notes: e.target.value })}
                  placeholder="Any observations..."
                  rows={2}
                  data-testid="textarea-notes"
                />
              </div>
            </div>
            
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button 
                className="w-full"
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
                Save Count
              </Button>
              <Button variant="outline" className="w-full" onClick={() => setCountDialogOpen(false)}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Approve Variance</DialogTitle>
              <DialogDescription>
                {selectedItem?.locationCode}: Expected {selectedItem?.expectedQty}, Counted {selectedItem?.countedQty} 
                ({selectedItem?.varianceQty && selectedItem.varianceQty > 0 ? "+" : ""}{selectedItem?.varianceQty})
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
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
                      <div className="text-sm text-muted-foreground">
                        {format(new Date(count.createdAt), "MMM d, yyyy")}
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Cycle Count</DialogTitle>
            <DialogDescription>
              Create a new inventory reconciliation session
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={newCountForm.name}
                onChange={(e) => setNewCountForm({ ...newCountForm, name: e.target.value })}
                placeholder="e.g., January 2026 Full Count"
                data-testid="input-count-name"
              />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Textarea
                value={newCountForm.description}
                onChange={(e) => setNewCountForm({ ...newCountForm, description: e.target.value })}
                placeholder="Notes about this count..."
                data-testid="textarea-description"
              />
            </div>
            <div>
              <Label>Zone Filter (optional)</Label>
              <Input
                value={newCountForm.zoneFilter}
                onChange={(e) => setNewCountForm({ ...newCountForm, zoneFilter: e.target.value })}
                placeholder="e.g., A to count only zone A"
                data-testid="input-zone-filter"
              />
            </div>
            <div>
              <Label>Location Purpose (where inventory is used)</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {locationTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer">
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
                      className="h-4 w-4"
                      data-testid={`checkbox-location-type-${type.value}`}
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Leave all unchecked to include all purposes</p>
            </div>
            <div>
              <Label>Storage Type (physical container type)</Label>
              <div className="grid grid-cols-2 gap-2 mt-2">
                {binTypeOptions.map((type) => (
                  <label key={type.value} className="flex items-center gap-2 cursor-pointer">
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
                      className="h-4 w-4"
                      data-testid={`checkbox-bin-type-${type.value}`}
                    />
                    <span className="text-sm">{type.label}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-1">Leave all unchecked to include all storage types</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => createMutation.mutate({
                name: newCountForm.name,
                description: newCountForm.description || undefined,
                zoneFilter: newCountForm.zoneFilter || undefined,
                locationTypeFilter: newCountForm.locationTypes.length > 0 ? newCountForm.locationTypes.join(",") : undefined,
                binTypeFilter: newCountForm.binTypes.length > 0 ? newCountForm.binTypes.join(",") : undefined,
              })}
              disabled={createMutation.isPending || !newCountForm.name}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
