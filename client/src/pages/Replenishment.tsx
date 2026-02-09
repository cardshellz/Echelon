import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { 
  Plus, 
  Edit, 
  Trash2,
  Play,
  CheckCircle,
  Clock,
  AlertCircle,
  ArrowRight,
  Package,
  MapPin,
  RefreshCw,
  Loader2,
  Settings,
  ListTodo,
  User,
  Upload,
  Download,
  Warehouse,
  Save
} from "lucide-react";

interface WarehouseLocation {
  id: number;
  code: string;
  name: string | null;
  locationType: string | null;
  isPickable: number | null;
}

interface CatalogProduct {
  id: number;
  sku: string | null;
  title: string | null;
}

interface ProductVariant {
  id: number;
  sku: string | null;
  name: string;
  productId: number;
  unitsPerVariant: number;
  hierarchyLevel: number;
}

interface Product {
  id: number;
  baseSku: string | null;
}

interface ReplenTierDefault {
  id: number;
  hierarchyLevel: number;
  sourceHierarchyLevel: number;
  pickLocationType: string;
  sourceLocationType: string;
  sourcePriority: string;
  minQty: number;
  maxQty: number | null;
  replenMethod: string;
  priority: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

interface ReplenRule {
  id: number;
  catalogProductId: number | null;
  pickVariantId: number | null;
  sourceVariantId: number | null;
  pickLocationType: string | null;
  sourceLocationType: string | null;
  sourcePriority: string | null;
  minQty: number | null;
  maxQty: number | null;
  replenMethod: string | null;
  priority: number | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  catalogProduct?: CatalogProduct;
  pickVariant?: ProductVariant;
  sourceVariant?: ProductVariant;
}

interface ReplenTask {
  id: number;
  replenRuleId: number | null;
  fromLocationId: number;
  toLocationId: number;
  catalogProductId: number | null;
  sourceVariantId: number | null;
  pickVariantId: number | null;
  qtySourceUnits: number;
  qtyTargetUnits: number;
  qtyCompleted: number;
  status: string;
  priority: number;
  triggeredBy: string;
  executionMode: string;
  warehouseId: number | null;
  createdBy: string | null;
  assignedTo: string | null;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  notes: string | null;
  createdAt: string;
  fromLocation?: WarehouseLocation;
  toLocation?: WarehouseLocation;
  catalogProduct?: CatalogProduct;
}

interface WarehouseSettings {
  id: number;
  warehouseId: number | null;
  warehouseCode: string;
  warehouseName: string;
  replenMode: string;
  shortPickAction: string;
  autoGenerateTrigger: string;
  inlineReplenMaxUnits: number | null;
  inlineReplenMaxCases: number | null;
  urgentReplenThreshold: number | null;
  stockoutPriority: number | null;
  minMaxPriority: number | null;
  scheduledReplenIntervalMinutes: number | null;
  scheduledReplenEnabled: number | null;
  pickPathOptimization: string | null;
  maxOrdersPerWave: number | null;
  maxItemsPerWave: number | null;
  waveAutoRelease: number | null;
  isActive: number;
  createdAt: string;
  updatedAt: string;
}

const LOCATION_TYPES = [
  { value: "pick", label: "Pick" },
  { value: "reserve", label: "Reserve" },
  { value: "receiving", label: "Receiving" },
  { value: "staging", label: "Staging" },
];

const SOURCE_PRIORITIES = [
  { value: "fifo", label: "FIFO (Oldest First)" },
  { value: "smallest_first", label: "Smallest First (Consolidate)" },
];

const REPLEN_METHODS = [
  { value: "case_break", label: "Case Break" },
  { value: "full_case", label: "Full Case" },
  { value: "pallet_drop", label: "Pallet Drop" },
];

const HIERARCHY_LEVELS = [
  { value: 1, label: "Level 1 (Each/Unit)" },
  { value: 2, label: "Level 2 (Pack/Inner)" },
  { value: 3, label: "Level 3 (Case/Outer)" },
  { value: 4, label: "Level 4 (Pallet/Master)" },
];

export default function Replenishment() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("tasks");
  const [showTierDefaultDialog, setShowTierDefaultDialog] = useState(false);
  const [showOverrideDialog, setShowOverrideDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showCsvDialog, setShowCsvDialog] = useState(false);
  const [editingTierDefault, setEditingTierDefault] = useState<ReplenTierDefault | null>(null);
  const [editingOverride, setEditingOverride] = useState<ReplenRule | null>(null);
  const [taskFilter, setTaskFilter] = useState("pending");
  const [warehouseFilter, setWarehouseFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState("all");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [tierDefaultForm, setTierDefaultForm] = useState({
    hierarchyLevel: "1",
    sourceHierarchyLevel: "3",
    pickLocationType: "pick",
    sourceLocationType: "reserve",
    sourcePriority: "fifo",
    minQty: "0",
    maxQty: "",
    replenMethod: "case_break",
    priority: "5",
  });

  const [overrideForm, setOverrideForm] = useState({
    catalogProductId: "",
    pickVariantId: "",
    sourceVariantId: "",
    pickLocationType: "",
    sourceLocationType: "",
    sourcePriority: "",
    minQty: "",
    maxQty: "",
    replenMethod: "",
    priority: "",
  });

  const [taskForm, setTaskForm] = useState({
    fromLocationId: "",
    toLocationId: "",
    catalogProductId: "",
    qtyTargetUnits: "",
    priority: "5",
    notes: "",
  });

  const { data: tierDefaults = [], isLoading: tierDefaultsLoading } = useQuery<ReplenTierDefault[]>({
    queryKey: ["/api/replen/tier-defaults"],
  });

  const { data: overrides = [], isLoading: overridesLoading } = useQuery<ReplenRule[]>({
    queryKey: ["/api/replen/rules"],
  });

  const { data: tasks = [], isLoading: tasksLoading } = useQuery<ReplenTask[]>({
    queryKey: ["/api/replen/tasks", taskFilter],
    queryFn: async () => {
      const url = taskFilter === "all" 
        ? "/api/replen/tasks" 
        : `/api/replen/tasks?status=${taskFilter}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch tasks");
      return res.json();
    },
  });

  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
  });

  const { data: products = [] } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/catalog/products"],
  });

  const { data: variants = [] } = useQuery<ProductVariant[]>({
    queryKey: ["/api/product-variants"],
  });

  interface WarehouseType {
    id: number;
    code: string;
    name: string;
  }
  
  const { data: warehouses = [] } = useQuery<WarehouseType[]>({
    queryKey: ["/api/warehouses"],
    queryFn: async () => {
      const res = await fetch("/api/warehouses", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch warehouses");
      return res.json();
    },
  });
  
  const { data: allWarehouseSettings = [], isLoading: settingsLoading } = useQuery<WarehouseSettings[]>({
    queryKey: ["/api/warehouse-settings"],
    queryFn: async () => {
      const res = await fetch("/api/warehouse-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch settings");
      return res.json();
    },
  });

  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>("");

  // Find the warehouse from the warehouses table
  const selectedWarehouseData = warehouses.find(w => w.id.toString() === selectedWarehouseId);
  // Find settings for this warehouse (by warehouseId or matching warehouseCode)
  const selectedWarehouse = allWarehouseSettings.find(
    w => w.warehouseId?.toString() === selectedWarehouseId || 
         (selectedWarehouseData && w.warehouseCode === selectedWarehouseData.code)
  );

  const [settingsForm, setSettingsForm] = useState({
    replenMode: "queue",
    shortPickAction: "partial_pick",
    inlineReplenMaxUnits: "50",
  });

  // Auto-select first warehouse when data loads
  useEffect(() => {
    if (warehouses.length > 0 && !selectedWarehouseId) {
      setSelectedWarehouseId(warehouses[0].id.toString());
    }
  }, [warehouses, selectedWarehouseId]);

  // Sync settings form when selected warehouse changes
  useEffect(() => {
    if (selectedWarehouse) {
      setSettingsForm({
        replenMode: selectedWarehouse.replenMode,
        shortPickAction: selectedWarehouse.shortPickAction,
        inlineReplenMaxUnits: selectedWarehouse.inlineReplenMaxUnits?.toString() || "50",
      });
    }
  }, [selectedWarehouse]);

  const saveSettingsMutation = useMutation({
    mutationFn: async (data: { replenMode: string; shortPickAction: string; inlineReplenMaxUnits: number | null }) => {
      if (!selectedWarehouseData) throw new Error("No warehouse selected");
      
      if (selectedWarehouse?.id) {
        // Update existing settings - also ensure warehouseId is set (for legacy rows)
        const res = await fetch(`/api/warehouse-settings/${selectedWarehouse.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            ...data,
            warehouseId: selectedWarehouseData.id, // Ensure warehouseId is linked
          }),
        });
        if (!res.ok) throw new Error("Failed to save settings");
        return res.json();
      } else {
        // Create new settings for this warehouse
        const res = await fetch("/api/warehouse-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            warehouseId: selectedWarehouseData.id,
            warehouseCode: selectedWarehouseData.code,
            warehouseName: selectedWarehouseData.name,
            ...data,
          }),
        });
        if (!res.ok) throw new Error("Failed to create settings");
        return res.json();
      }
    },
    onSuccess: () => {
      toast({ title: "Settings saved" });
      queryClient.invalidateQueries({ queryKey: ["/api/warehouse-settings"] });
    },
    onError: () => {
      toast({ title: "Failed to save settings", variant: "destructive" });
    },
  });

  // Filter variants by selected product
  // product_variants have a direct productId linking to products
  const getVariantsForProduct = (productId: string) => {
    if (!productId || productId === "none") return [];
    const id = parseInt(productId);
    return variants.filter(v => v.productId === id);
  };

  // Tier Default mutations
  const createTierDefaultMutation = useMutation({
    mutationFn: async (data: typeof tierDefaultForm) => {
      const res = await fetch("/api/replen/tier-defaults", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          hierarchyLevel: parseInt(data.hierarchyLevel),
          sourceHierarchyLevel: parseInt(data.sourceHierarchyLevel),
          pickLocationType: data.pickLocationType,
          sourceLocationType: data.sourceLocationType,
          sourcePriority: data.sourcePriority,
          minQty: parseInt(data.minQty) || 0,
          maxQty: data.maxQty ? parseInt(data.maxQty) : null,
          replenMethod: data.replenMethod,
          priority: parseInt(data.priority),
        }),
      });
      if (!res.ok) throw new Error("Failed to create tier default");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tier-defaults"] });
      setShowTierDefaultDialog(false);
      resetTierDefaultForm();
      toast({ title: "Default rule created" });
    },
    onError: () => {
      toast({ title: "Failed to create default rule", variant: "destructive" });
    },
  });

  const updateTierDefaultMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ReplenTierDefault> }) => {
      const res = await fetch(`/api/replen/tier-defaults/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update tier default");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tier-defaults"] });
      setShowTierDefaultDialog(false);
      setEditingTierDefault(null);
      resetTierDefaultForm();
      toast({ title: "Default rule updated" });
    },
  });

  const deleteTierDefaultMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/replen/tier-defaults/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete tier default");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tier-defaults"] });
      toast({ title: "Default rule deleted" });
    },
  });

  // SKU Override mutations
  const createOverrideMutation = useMutation({
    mutationFn: async (data: typeof overrideForm) => {
      const res = await fetch("/api/replen/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          catalogProductId: data.catalogProductId ? parseInt(data.catalogProductId) : null,
          pickVariantId: data.pickVariantId ? parseInt(data.pickVariantId) : null,
          sourceVariantId: data.sourceVariantId ? parseInt(data.sourceVariantId) : null,
          pickLocationType: data.pickLocationType || null,
          sourceLocationType: data.sourceLocationType || null,
          sourcePriority: data.sourcePriority || null,
          minQty: data.minQty ? parseInt(data.minQty) : null,
          maxQty: data.maxQty ? parseInt(data.maxQty) : null,
          replenMethod: data.replenMethod || null,
          priority: data.priority ? parseInt(data.priority) : null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create override");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      setShowOverrideDialog(false);
      resetOverrideForm();
      toast({ title: "SKU override created" });
    },
    onError: () => {
      toast({ title: "Failed to create override", variant: "destructive" });
    },
  });

  const updateOverrideMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ReplenRule> }) => {
      const res = await fetch(`/api/replen/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update override");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      setShowOverrideDialog(false);
      setEditingOverride(null);
      resetOverrideForm();
      toast({ title: "SKU override updated" });
    },
  });

  const deleteOverrideMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/replen/rules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete override");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      toast({ title: "SKU override deleted" });
    },
  });

  const createTaskMutation = useMutation({
    mutationFn: async (data: typeof taskForm) => {
      const res = await fetch("/api/replen/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromLocationId: parseInt(data.fromLocationId),
          toLocationId: parseInt(data.toLocationId),
          catalogProductId: data.catalogProductId && data.catalogProductId !== "none" ? parseInt(data.catalogProductId) : null,
          qtyTargetUnits: parseInt(data.qtyTargetUnits),
          priority: parseInt(data.priority),
          triggeredBy: "manual",
          notes: data.notes || null,
        }),
      });
      if (!res.ok) throw new Error("Failed to create task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] });
      setShowTaskDialog(false);
      resetTaskForm();
      toast({ title: "Replen task created" });
    },
    onError: () => {
      toast({ title: "Failed to create task", variant: "destructive" });
    },
  });

  const generateTasksMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/replen/generate", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to generate tasks");
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] });
      if (data.tasksCreated > 0) {
        toast({ title: `Created ${data.tasksCreated} replen tasks` });
      } else {
        toast({ title: "No replen tasks needed", description: "All pick bins are above minimum levels" });
      }
    },
    onError: () => {
      toast({ title: "Failed to generate tasks", variant: "destructive" });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ReplenTask> }) => {
      const res = await fetch(`/api/replen/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update task");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] });
      toast({ title: "Task updated" });
    },
  });

  const uploadCsvMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/replen/rules/upload-csv", {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to upload CSV");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      setShowCsvDialog(false);
      toast({ 
        title: "CSV uploaded successfully",
        description: `Created ${data.created} rules, skipped ${data.skipped} rows`
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to upload CSV", description: error.message, variant: "destructive" });
    },
  });

  const resetTierDefaultForm = () => {
    setTierDefaultForm({
      hierarchyLevel: "1",
      sourceHierarchyLevel: "3",
      pickLocationType: "pick",
      sourceLocationType: "reserve",
      sourcePriority: "fifo",
      minQty: "0",
      maxQty: "",
      replenMethod: "case_break",
      priority: "5",
    });
  };

  const resetOverrideForm = () => {
    setOverrideForm({
      catalogProductId: "",
      pickVariantId: "",
      sourceVariantId: "",
      pickLocationType: "",
      sourceLocationType: "",
      sourcePriority: "",
      minQty: "",
      maxQty: "",
      replenMethod: "",
      priority: "",
    });
  };

  const resetTaskForm = () => {
    setTaskForm({
      fromLocationId: "",
      toLocationId: "",
      catalogProductId: "",
      qtyTargetUnits: "",
      priority: "5",
      notes: "",
    });
  };

  const handleEditTierDefault = (tierDefault: ReplenTierDefault) => {
    setEditingTierDefault(tierDefault);
    setTierDefaultForm({
      hierarchyLevel: tierDefault.hierarchyLevel.toString(),
      sourceHierarchyLevel: tierDefault.sourceHierarchyLevel.toString(),
      pickLocationType: tierDefault.pickLocationType,
      sourceLocationType: tierDefault.sourceLocationType,
      sourcePriority: tierDefault.sourcePriority,
      minQty: tierDefault.minQty.toString(),
      maxQty: tierDefault.maxQty?.toString() || "",
      replenMethod: tierDefault.replenMethod,
      priority: tierDefault.priority.toString(),
    });
    setShowTierDefaultDialog(true);
  };

  const handleEditOverride = (override: ReplenRule) => {
    setEditingOverride(override);
    setOverrideForm({
      catalogProductId: override.catalogProductId?.toString() || "",
      pickVariantId: override.pickVariantId?.toString() || "",
      sourceVariantId: override.sourceVariantId?.toString() || "",
      pickLocationType: override.pickLocationType || "",
      sourceLocationType: override.sourceLocationType || "",
      sourcePriority: override.sourcePriority || "",
      minQty: override.minQty?.toString() || "",
      maxQty: override.maxQty?.toString() || "",
      replenMethod: override.replenMethod || "",
      priority: override.priority?.toString() || "",
    });
    setShowOverrideDialog(true);
  };

  const handleSaveTierDefault = () => {
    if (editingTierDefault) {
      updateTierDefaultMutation.mutate({
        id: editingTierDefault.id,
        data: {
          hierarchyLevel: parseInt(tierDefaultForm.hierarchyLevel),
          sourceHierarchyLevel: parseInt(tierDefaultForm.sourceHierarchyLevel),
          pickLocationType: tierDefaultForm.pickLocationType,
          sourceLocationType: tierDefaultForm.sourceLocationType,
          sourcePriority: tierDefaultForm.sourcePriority,
          minQty: parseInt(tierDefaultForm.minQty) || 0,
          maxQty: tierDefaultForm.maxQty ? parseInt(tierDefaultForm.maxQty) : null,
          replenMethod: tierDefaultForm.replenMethod,
          priority: parseInt(tierDefaultForm.priority),
        },
      });
    } else {
      createTierDefaultMutation.mutate(tierDefaultForm);
    }
  };

  const handleSaveOverride = () => {
    if (editingOverride) {
      updateOverrideMutation.mutate({
        id: editingOverride.id,
        data: {
          catalogProductId: overrideForm.catalogProductId ? parseInt(overrideForm.catalogProductId) : null,
          pickVariantId: overrideForm.pickVariantId ? parseInt(overrideForm.pickVariantId) : null,
          sourceVariantId: overrideForm.sourceVariantId ? parseInt(overrideForm.sourceVariantId) : null,
          pickLocationType: overrideForm.pickLocationType || null,
          sourceLocationType: overrideForm.sourceLocationType || null,
          sourcePriority: overrideForm.sourcePriority || null,
          minQty: overrideForm.minQty ? parseInt(overrideForm.minQty) : null,
          maxQty: overrideForm.maxQty ? parseInt(overrideForm.maxQty) : null,
          replenMethod: overrideForm.replenMethod || null,
          priority: overrideForm.priority ? parseInt(overrideForm.priority) : null,
        },
      });
    } else {
      createOverrideMutation.mutate(overrideForm);
    }
  };

  const getHierarchyLabel = (level: number) => {
    const found = HIERARCHY_LEVELS.find(h => h.value === level);
    return found?.label || `Level ${level}`;
  };

  const handleCsvUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      uploadCsvMutation.mutate(file);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "pending":
        return <Badge variant="secondary"><Clock className="w-3 h-3 mr-1" />Pending</Badge>;
      case "assigned":
        return <Badge variant="outline"><User className="w-3 h-3 mr-1" />Assigned</Badge>;
      case "in_progress":
        return <Badge className="bg-blue-500"><Play className="w-3 h-3 mr-1" />In Progress</Badge>;
      case "completed":
        return <Badge className="bg-green-500"><CheckCircle className="w-3 h-3 mr-1" />Completed</Badge>;
      case "cancelled":
        return <Badge variant="destructive">Cancelled</Badge>;
      default:
        return <Badge>{status}</Badge>;
    }
  };

  const getTriggerBadge = (trigger: string) => {
    switch (trigger) {
      case "min_max":
        return <Badge variant="outline">Auto</Badge>;
      case "manual":
        return <Badge variant="secondary">Manual</Badge>;
      case "stockout":
        return <Badge variant="destructive">Stockout</Badge>;
      case "wave":
        return <Badge className="bg-purple-500">Wave</Badge>;
      default:
        return <Badge>{trigger}</Badge>;
    }
  };

  const getModeBadge = (mode: string | null | undefined) => {
    switch (mode) {
      case "inline":
        return <Badge className="bg-orange-500">Inline</Badge>;
      case "queue":
        return <Badge variant="outline">Queue</Badge>;
      default:
        return <Badge variant="secondary">-</Badge>;
    }
  };

  // Apply additional client-side filters for warehouse and mode
  const filteredTasks = tasks.filter((task) => {
    // Warehouse filter
    if (warehouseFilter !== "all") {
      if (task.warehouseId !== parseInt(warehouseFilter)) {
        return false;
      }
    }
    // Mode filter
    if (modeFilter !== "all") {
      const taskMode = task.executionMode || "queue";
      if (taskMode !== modeFilter) {
        return false;
      }
    }
    return true;
  });
  
  const pendingCount = tasks.filter(t => t.status === "pending").length;
  const inProgressCount = tasks.filter(t => t.status === "in_progress").length;

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Replenishment</h1>
          <p className="text-sm text-muted-foreground">Manage inventory flow from bulk storage to pick locations</p>
        </div>
        <div className="flex gap-2">
          {pendingCount > 0 && (
            <Badge variant="secondary" className="text-lg px-3 py-1">
              {pendingCount} pending
            </Badge>
          )}
          {inProgressCount > 0 && (
            <Badge className="bg-blue-500 text-lg px-3 py-1">
              {inProgressCount} in progress
            </Badge>
          )}
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="tasks" className="gap-2">
            <ListTodo className="w-4 h-4" />
            Task Queue
          </TabsTrigger>
          <TabsTrigger value="rules" className="gap-2">
            <Settings className="w-4 h-4" />
            Replen Rules
          </TabsTrigger>
          <TabsTrigger value="settings" className="gap-2">
            <Warehouse className="w-4 h-4" />
            Warehouse Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="tasks" className="space-y-4">
          <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-3">
            <div className="flex flex-wrap gap-2">
              <Select value={taskFilter} onValueChange={setTaskFilter}>
                <SelectTrigger className="w-32 sm:w-40 h-10" data-testid="select-task-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="assigned">Assigned</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="completed">Completed</SelectItem>
                  <SelectItem value="all">All Tasks</SelectItem>
                </SelectContent>
              </Select>
              <Select value={modeFilter} onValueChange={setModeFilter}>
                <SelectTrigger className="w-28 sm:w-32 h-10" data-testid="select-mode-filter">
                  <SelectValue placeholder="Mode" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Modes</SelectItem>
                  <SelectItem value="queue">Queue</SelectItem>
                  <SelectItem value="inline">Inline</SelectItem>
                </SelectContent>
              </Select>
              <Select value={warehouseFilter} onValueChange={setWarehouseFilter}>
                <SelectTrigger className="w-32 sm:w-40 h-10" data-testid="select-warehouse-filter">
                  <SelectValue placeholder="Warehouse" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Warehouses</SelectItem>
                  {warehouses.map((wh) => (
                    <SelectItem key={wh.id} value={wh.id.toString()}>
                      {wh.code} - {wh.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button 
                variant="outline" 
                size="icon"
                className="h-10 w-10 min-h-[44px]"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] })}
                data-testid="button-refresh-tasks"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex gap-2 w-full sm:w-auto">
              <Button 
                variant="outline" 
                className="flex-1 sm:flex-none min-h-[44px]"
                onClick={() => generateTasksMutation.mutate()}
                disabled={generateTasksMutation.isPending}
                data-testid="button-auto-generate"
              >
                {generateTasksMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <AlertCircle className="w-4 h-4 mr-2" />
                )}
                <span className="hidden sm:inline">Auto-Generate</span>
                <span className="sm:hidden">Generate</span>
              </Button>
              <Button className="flex-1 sm:flex-none min-h-[44px]" onClick={() => setShowTaskDialog(true)} data-testid="button-create-task">
                <Plus className="w-4 h-4 mr-2" />
                <span className="hidden sm:inline">Create Task</span>
                <span className="sm:hidden">Create</span>
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {tasksLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : filteredTasks.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No replenishment tasks{(warehouseFilter !== "all" || modeFilter !== "all") ? " matching filters" : ""}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">From</TableHead>
                      <TableHead className="hidden sm:table-cell"></TableHead>
                      <TableHead className="text-xs">To</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">Product</TableHead>
                      <TableHead className="text-xs">Qty</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs hidden lg:table-cell">Mode</TableHead>
                      <TableHead className="text-xs hidden lg:table-cell">Trigger</TableHead>
                      <TableHead className="text-xs hidden xl:table-cell">Assigned</TableHead>
                      <TableHead className="text-xs">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTasks.map((task) => (
                      <TableRow key={task.id} data-testid={`row-task-${task.id}`}>
                        <TableCell className="py-2">
                          <div className="font-mono text-xs sm:text-sm">
                            {task.fromLocation?.code || `LOC-${task.fromLocationId}`}
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell py-2">
                          <ArrowRight className="w-4 h-4 text-muted-foreground" />
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="font-mono text-xs sm:text-sm">
                            {task.toLocation?.code || `LOC-${task.toLocationId}`}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell py-2">
                          <div className="text-xs sm:text-sm">
                            {task.catalogProduct?.sku || task.catalogProduct?.title || "-"}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="font-medium text-xs sm:text-sm">
                            {task.qtyCompleted}/{task.qtyTargetUnits}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">{getStatusBadge(task.status)}</TableCell>
                        <TableCell className="hidden lg:table-cell py-2">{getModeBadge(task.executionMode)}</TableCell>
                        <TableCell className="hidden lg:table-cell py-2">{getTriggerBadge(task.triggeredBy)}</TableCell>
                        <TableCell className="hidden xl:table-cell py-2">
                          <span className="text-xs sm:text-sm text-muted-foreground">
                            {task.assignedTo || "-"}
                          </span>
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="flex gap-1">
                            {task.status === "pending" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="min-h-[36px] text-xs"
                                onClick={() => updateTaskMutation.mutate({
                                  id: task.id,
                                  data: { status: "in_progress" }
                                })}
                                data-testid={`button-start-task-${task.id}`}
                              >
                                <Play className="w-3 h-3 sm:mr-1" />
                                <span className="hidden sm:inline">Start</span>
                              </Button>
                            )}
                            {task.status === "in_progress" && (
                              <Button
                                size="sm"
                                className="bg-green-500 hover:bg-green-600 min-h-[36px] text-xs"
                                onClick={() => updateTaskMutation.mutate({
                                  id: task.id,
                                  data: { 
                                    status: "completed",
                                    qtyCompleted: task.qtyTargetUnits
                                  }
                                })}
                                data-testid={`button-complete-task-${task.id}`}
                              >
                                <CheckCircle className="w-3 h-3 sm:mr-1" />
                                <span className="hidden sm:inline">Complete</span>
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-6">
          {/* Default Replen Rules Section */}
          <Card>
            <CardHeader className="p-3 md:p-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                  <CardTitle className="text-base md:text-lg">Default Replen Rules</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Tier-based rules that apply to all products at each hierarchy level
                  </CardDescription>
                </div>
                <Button className="w-full sm:w-auto min-h-[44px]" onClick={() => { resetTierDefaultForm(); setEditingTierDefault(null); setShowTierDefaultDialog(true); }} data-testid="button-add-tier-default">
                  <Plus className="w-4 h-4 mr-2" />
                  Add Default Rule
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {tierDefaultsLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : tierDefaults.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Settings className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No default rules configured</p>
                  <p className="text-sm">Add tier-based rules to define how inventory flows by hierarchy level</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Tier Level</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">Source Level</TableHead>
                      <TableHead className="text-xs hidden lg:table-cell">Location Types</TableHead>
                      <TableHead className="text-xs hidden lg:table-cell">Priority</TableHead>
                      <TableHead className="text-xs hidden sm:table-cell">Min/Max</TableHead>
                      <TableHead className="text-xs hidden md:table-cell">Method</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tierDefaults.map((tierDefault) => (
                      <TableRow key={tierDefault.id} data-testid={`row-tier-default-${tierDefault.id}`}>
                        <TableCell className="py-2">
                          <Badge className="bg-blue-500 text-xs">{getHierarchyLabel(tierDefault.hierarchyLevel)}</Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell py-2">
                          <Badge variant="outline" className="text-xs">{getHierarchyLabel(tierDefault.sourceHierarchyLevel)}</Badge>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell py-2">
                          <div className="text-xs space-y-1">
                            <div><Badge variant="outline" className="text-xs">{tierDefault.pickLocationType}</Badge></div>
                            <div className="text-muted-foreground">← {tierDefault.sourceLocationType}</div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell py-2">
                          <Badge variant="secondary" className="text-xs">{tierDefault.sourcePriority}</Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell py-2">
                          <span className="font-mono text-xs">
                            {tierDefault.minQty} / {tierDefault.maxQty ?? "auto"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell py-2">
                          <Badge variant="outline" className="text-xs">{tierDefault.replenMethod}</Badge>
                        </TableCell>
                        <TableCell className="py-2">
                          {tierDefault.isActive ? (
                            <Badge className="bg-green-500 text-xs">Active</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 min-h-[36px]"
                              onClick={() => handleEditTierDefault(tierDefault)}
                              data-testid={`button-edit-tier-default-${tierDefault.id}`}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 min-h-[36px]"
                              onClick={() => {
                                if (confirm("Delete this default rule?")) {
                                  deleteTierDefaultMutation.mutate(tierDefault.id);
                                }
                              }}
                              data-testid={`button-delete-tier-default-${tierDefault.id}`}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* SKU Overrides Section */}
          <Card>
            <CardHeader className="p-3 md:p-6">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
                <div>
                  <CardTitle className="text-base md:text-lg">SKU Overrides</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Product-specific exceptions that override the default tier rules
                  </CardDescription>
                </div>
                <div className="flex gap-2 w-full sm:w-auto">
                  <Button variant="outline" className="flex-1 sm:flex-none min-h-[44px]" onClick={() => setShowCsvDialog(true)} data-testid="button-upload-csv">
                    <Upload className="w-4 h-4 sm:mr-2" />
                    <span className="hidden sm:inline">Upload CSV</span>
                  </Button>
                  <Button className="flex-1 sm:flex-none min-h-[44px]" onClick={() => { resetOverrideForm(); setEditingOverride(null); setShowOverrideDialog(true); }} data-testid="button-add-override">
                    <Plus className="w-4 h-4 sm:mr-2" />
                    <span className="hidden sm:inline">Add Override</span>
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {overridesLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : overrides.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No SKU overrides configured</p>
                  <p className="text-sm">Add overrides when a product needs different behavior than its tier default</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Product</TableHead>
                      <TableHead className="text-xs hidden sm:table-cell">Overrides</TableHead>
                      <TableHead className="text-xs">Status</TableHead>
                      <TableHead className="text-xs">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overrides.map((override) => (
                      <TableRow key={override.id} data-testid={`row-override-${override.id}`}>
                        <TableCell className="py-2">
                          <div className="flex items-center gap-2">
                            <Package className="w-4 h-4 text-blue-500 shrink-0" />
                            <span className="text-xs sm:text-sm font-medium truncate max-w-[120px] sm:max-w-none">
                              {override.catalogProduct?.sku || override.catalogProduct?.title || `Product ${override.catalogProductId}`}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell py-2">
                          <div className="flex flex-wrap gap-1">
                            {override.replenMethod && <Badge variant="outline" className="text-xs">{override.replenMethod}</Badge>}
                            {override.minQty !== null && <Badge variant="secondary" className="text-xs">Min: {override.minQty}</Badge>}
                            {override.maxQty !== null && <Badge variant="secondary" className="text-xs">Max: {override.maxQty}</Badge>}
                            {override.sourcePriority && <Badge variant="secondary" className="text-xs">{override.sourcePriority}</Badge>}
                            {override.pickLocationType && <Badge variant="outline" className="text-xs">{override.pickLocationType}</Badge>}
                          </div>
                        </TableCell>
                        <TableCell className="py-2">
                          {override.isActive ? (
                            <Badge className="bg-green-500 text-xs">Active</Badge>
                          ) : (
                            <Badge variant="secondary" className="text-xs">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell className="py-2">
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 min-h-[36px]"
                              onClick={() => handleEditOverride(override)}
                              data-testid={`button-edit-override-${override.id}`}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-9 w-9 min-h-[36px]"
                              onClick={() => {
                                if (confirm("Delete this SKU override?")) {
                                  deleteOverrideMutation.mutate(override.id);
                                }
                              }}
                              data-testid={`button-delete-override-${override.id}`}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="space-y-4 md:space-y-6">
          <Card>
            <CardHeader className="p-3 md:p-6">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base md:text-lg">Replenishment Workflow</CardTitle>
                  <CardDescription className="text-xs md:text-sm">
                    Configure how replenishment tasks are handled during picking operations
                  </CardDescription>
                </div>
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <Select value={selectedWarehouseId} onValueChange={setSelectedWarehouseId}>
                    <SelectTrigger className="w-full sm:w-64 h-10" data-testid="select-warehouse">
                      <SelectValue placeholder="Select warehouse..." />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((wh) => (
                        <SelectItem key={wh.id} value={wh.id.toString()}>
                          {wh.name} ({wh.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-3 md:p-6 space-y-4 md:space-y-6">
              {settingsLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : warehouses.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Warehouse className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No warehouses configured. Add warehouses from the Warehouses page first.</p>
                </div>
              ) : !selectedWarehouseData ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Warehouse className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>Select a warehouse to configure its settings.</p>
                </div>
              ) : (
                <>
                  <div className="space-y-4">
                    <div>
                      <Label className="text-sm md:text-base font-semibold">Replenishment Mode</Label>
                      <p className="text-xs md:text-sm text-muted-foreground mb-3">
                        How should low-stock situations be handled during picking?
                      </p>
                      <div className="grid gap-3">
                        <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${settingsForm.replenMode === 'inline' ? 'border-primary bg-primary/5' : ''}`}>
                          <input
                            type="radio"
                            name="replenMode"
                            value="inline"
                            checked={settingsForm.replenMode === "inline"}
                            onChange={(e) => setSettingsForm({ ...settingsForm, replenMode: e.target.value })}
                            className="mt-1 h-5 w-5"
                            data-testid="radio-replen-inline"
                          />
                          <div>
                            <div className="font-medium text-sm md:text-base">Inline Replenishment</div>
                            <div className="text-xs md:text-sm text-muted-foreground">
                              Pickers replenish stock themselves when low. Best for small operations.
                            </div>
                          </div>
                        </label>
                        <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${settingsForm.replenMode === 'queue' ? 'border-primary bg-primary/5' : ''}`}>
                          <input
                            type="radio"
                            name="replenMode"
                            value="queue"
                            checked={settingsForm.replenMode === "queue"}
                            onChange={(e) => setSettingsForm({ ...settingsForm, replenMode: e.target.value })}
                            className="mt-1 h-5 w-5"
                            data-testid="radio-replen-queue"
                          />
                          <div>
                            <div className="font-medium text-sm md:text-base">Queue Mode</div>
                            <div className="text-xs md:text-sm text-muted-foreground">
                              Replenishment tasks are generated for dedicated replen workers. Best for larger operations with specialized roles.
                            </div>
                          </div>
                        </label>
                        <label className={`flex items-start gap-3 p-3 md:p-4 border rounded-lg cursor-pointer hover:bg-muted/50 ${settingsForm.replenMode === 'hybrid' ? 'border-primary bg-primary/5' : ''}`}>
                          <input
                            type="radio"
                            name="replenMode"
                            value="hybrid"
                            checked={settingsForm.replenMode === "hybrid"}
                            onChange={(e) => setSettingsForm({ ...settingsForm, replenMode: e.target.value })}
                            className="mt-1 h-5 w-5"
                            data-testid="radio-replen-hybrid"
                          />
                          <div>
                            <div className="font-medium text-sm md:text-base">Hybrid Mode</div>
                            <div className="text-xs md:text-sm text-muted-foreground">
                              Small replenishments are done inline by pickers, larger ones go to the queue for dedicated workers.
                            </div>
                          </div>
                        </label>
                      </div>
                    </div>

                    {settingsForm.replenMode === "hybrid" && (
                      <div className="ml-0 md:ml-8 p-3 md:p-4 bg-muted/30 rounded-lg">
                        <Label className="text-xs md:text-sm" htmlFor="inlineReplenMaxUnits">Inline Replen Max Units</Label>
                        <p className="text-xs md:text-sm text-muted-foreground mb-2">
                          Tasks below this quantity are handled inline, above go to queue
                        </p>
                        <Input
                          id="inlineReplenMaxUnits"
                          type="number"
                          className="w-full sm:w-32 h-10"
                          value={settingsForm.inlineReplenMaxUnits}
                          onChange={(e) => setSettingsForm({ ...settingsForm, inlineReplenMaxUnits: e.target.value })}
                          min="1"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          data-testid="input-inline-replen-max-units"
                        />
                      </div>
                    )}

                    <div className="pt-4 border-t">
                      <Label className="text-sm md:text-base font-semibold">Short Pick Action</Label>
                      <p className="text-xs md:text-sm text-muted-foreground mb-3">
                        What happens when a picker encounters an empty or insufficient pick location?
                      </p>
                      <Select 
                        value={settingsForm.shortPickAction} 
                        onValueChange={(v) => setSettingsForm({ ...settingsForm, shortPickAction: v })}
                      >
                        <SelectTrigger className="w-full sm:w-80 h-10" data-testid="select-short-pick-action">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="generate_task">Generate replen task automatically</SelectItem>
                          <SelectItem value="alert_supervisor">Alert supervisor only</SelectItem>
                          <SelectItem value="skip_and_continue">Skip and continue picking</SelectItem>
                          <SelectItem value="partial_pick">Allow partial pick</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="flex justify-end pt-4 border-t">
                    <Button 
                      className="w-full sm:w-auto min-h-[44px]"
                      onClick={() => saveSettingsMutation.mutate({
                        replenMode: settingsForm.replenMode,
                        shortPickAction: settingsForm.shortPickAction,
                        inlineReplenMaxUnits: settingsForm.replenMode === "hybrid" 
                          ? parseInt(settingsForm.inlineReplenMaxUnits) || 50 
                          : null,
                      })}
                      disabled={saveSettingsMutation.isPending}
                      data-testid="button-save-settings"
                    >
                      {saveSettingsMutation.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4 mr-2" />
                      )}
                      Save Settings
                    </Button>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Tier Default Dialog */}
      <Dialog open={showTierDefaultDialog} onOpenChange={setShowTierDefaultDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base md:text-lg">{editingTierDefault ? "Edit Default Rule" : "Create Default Rule"}</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Define tier-based replenishment settings by hierarchy level
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Target Tier Level</Label>
                <Select 
                  value={tierDefaultForm.hierarchyLevel} 
                  onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, hierarchyLevel: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-hierarchy-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HIERARCHY_LEVELS.map((h) => (
                      <SelectItem key={h.value} value={h.value.toString()}>{h.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs md:text-sm">Source Tier Level</Label>
                <Select 
                  value={tierDefaultForm.sourceHierarchyLevel} 
                  onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, sourceHierarchyLevel: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-source-hierarchy-level">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HIERARCHY_LEVELS.map((h) => (
                      <SelectItem key={h.value} value={h.value.toString()}>{h.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Pick Location Type</Label>
                <Select 
                  value={tierDefaultForm.pickLocationType} 
                  onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, pickLocationType: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-tier-pick-location-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs md:text-sm">Source Location Type</Label>
                <Select 
                  value={tierDefaultForm.sourceLocationType} 
                  onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, sourceLocationType: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-tier-source-location-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOCATION_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs md:text-sm">Source Priority</Label>
              <Select 
                value={tierDefaultForm.sourcePriority} 
                onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, sourcePriority: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-tier-source-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SOURCE_PRIORITIES.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Min Qty (Trigger)</Label>
                <Input
                  type="number"
                  className="h-10"
                  value={tierDefaultForm.minQty}
                  onChange={(e) => setTierDefaultForm({ ...tierDefaultForm, minQty: e.target.value })}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-tier-min-qty"
                />
              </div>
              <div>
                <Label className="text-xs md:text-sm">Max Qty (Fill To)</Label>
                <Input
                  type="number"
                  className="h-10"
                  value={tierDefaultForm.maxQty}
                  onChange={(e) => setTierDefaultForm({ ...tierDefaultForm, maxQty: e.target.value })}
                  placeholder="Auto (bin capacity)"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-tier-max-qty"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Replen Method</Label>
                <Select 
                  value={tierDefaultForm.replenMethod} 
                  onValueChange={(v) => setTierDefaultForm({ ...tierDefaultForm, replenMethod: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-tier-replen-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REPLEN_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs md:text-sm">Priority (1 = highest)</Label>
                <Input
                  type="number"
                  className="h-10"
                  min="1"
                  max="99"
                  value={tierDefaultForm.priority}
                  onChange={(e) => setTierDefaultForm({ ...tierDefaultForm, priority: e.target.value })}
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-tier-priority"
                />
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowTierDefaultDialog(false)}>
                Cancel
              </Button>
              <Button 
                className="min-h-[44px]"
                onClick={handleSaveTierDefault}
                data-testid="button-save-tier-default"
              >
                {editingTierDefault ? "Update Rule" : "Create Rule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* SKU Override Dialog */}
      <Dialog open={showOverrideDialog} onOpenChange={setShowOverrideDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base md:text-lg">{editingOverride ? "Edit SKU Override" : "Create SKU Override"}</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Override default tier settings for a specific product (leave fields empty to use tier defaults)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs md:text-sm">Product (Required)</Label>
              <Select 
                value={overrideForm.catalogProductId} 
                onValueChange={(v) => setOverrideForm({ ...overrideForm, catalogProductId: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-override-product">
                  <SelectValue placeholder="Select product..." />
                </SelectTrigger>
                <SelectContent>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>
                      {p.sku || p.title || `Product ${p.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Pick Variant (Optional)</Label>
                <Select 
                  value={overrideForm.pickVariantId} 
                  onValueChange={(v) => setOverrideForm({ ...overrideForm, pickVariantId: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-override-pick-variant">
                    <SelectValue placeholder="Use default..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use default</SelectItem>
                    {getVariantsForProduct(overrideForm.catalogProductId).map((v) => (
                      <SelectItem key={v.id} value={v.id.toString()}>
                        {v.sku || v.name} ({v.unitsPerVariant} units)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs md:text-sm">Source Variant (Optional)</Label>
                <Select 
                  value={overrideForm.sourceVariantId} 
                  onValueChange={(v) => setOverrideForm({ ...overrideForm, sourceVariantId: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-override-source-variant">
                    <SelectValue placeholder="Use default..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use default</SelectItem>
                    {getVariantsForProduct(overrideForm.catalogProductId).map((v) => (
                      <SelectItem key={v.id} value={v.id.toString()}>
                        {v.sku || v.name} ({v.unitsPerVariant} units)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Replen Method (Optional)</Label>
                <Select 
                  value={overrideForm.replenMethod} 
                  onValueChange={(v) => setOverrideForm({ ...overrideForm, replenMethod: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-override-replen-method">
                    <SelectValue placeholder="Use default..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use default</SelectItem>
                    {REPLEN_METHODS.map((m) => (
                      <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs md:text-sm">Source Priority (Optional)</Label>
                <Select 
                  value={overrideForm.sourcePriority} 
                  onValueChange={(v) => setOverrideForm({ ...overrideForm, sourcePriority: v })}
                >
                  <SelectTrigger className="h-10" data-testid="select-override-source-priority">
                    <SelectValue placeholder="Use default..." />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use default</SelectItem>
                    {SOURCE_PRIORITIES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-xs md:text-sm">Min Qty Override</Label>
                <Input
                  type="number"
                  className="h-10"
                  value={overrideForm.minQty}
                  onChange={(e) => setOverrideForm({ ...overrideForm, minQty: e.target.value })}
                  placeholder="Use default"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-override-min-qty"
                />
              </div>
              <div>
                <Label className="text-xs md:text-sm">Max Qty Override</Label>
                <Input
                  type="number"
                  className="h-10"
                  value={overrideForm.maxQty}
                  onChange={(e) => setOverrideForm({ ...overrideForm, maxQty: e.target.value })}
                  placeholder="Use default"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-testid="input-override-max-qty"
                />
              </div>
            </div>

            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowOverrideDialog(false)}>
                Cancel
              </Button>
              <Button 
                className="min-h-[44px]"
                onClick={handleSaveOverride}
                disabled={!overrideForm.catalogProductId}
                data-testid="button-save-override"
              >
                {editingOverride ? "Update Override" : "Create Override"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* CSV Upload Dialog */}
      <Dialog open={showCsvDialog} onOpenChange={setShowCsvDialog}>
        <DialogContent className="max-w-md md:max-w-2xl max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base md:text-lg">Import Replenishment Rules</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Bulk import rules from a CSV file. Download the template to get started.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 md:space-y-6">
            {/* Download Template Section */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 md:p-4 bg-primary/5 border border-primary/20 rounded-lg">
              <div>
                <p className="font-medium text-sm md:text-base">Download Template</p>
                <p className="text-xs md:text-sm text-muted-foreground">Pre-formatted CSV with headers and example data</p>
              </div>
              <Button 
                variant="outline"
                className="w-full sm:w-auto min-h-[44px]"
                onClick={() => {
                  const headers = "product_sku,pick_variant_sku,source_variant_sku,pick_location_type,source_location_type,source_priority,min_qty,max_qty,replen_method,priority";
                  const example = "SHELL-001,SHELL-001-EA,SHELL-001-CS12,pick,reserve,fifo,5,60,case_break,5";
                  const instructions = "# INSTRUCTIONS - Delete this row before uploading\n# product_sku: Product SKU from your catalog (REQUIRED)\n# pick_variant_sku: SKU of the variant to pick INTO (eaches) (REQUIRED)\n# source_variant_sku: SKU of the variant to pick FROM (cases) (REQUIRED)\n# pick_location_type: pick or bin (default: pick)\n# source_location_type: reserve or pallet (default: reserve)\n# source_priority: fifo (oldest first) or smallest_first (consolidate partials) (default: fifo)\n# min_qty: Trigger replen when qty drops below this (default: 0)\n# max_qty: Fill up to this qty (leave empty to replen 1 source unit)\n# replen_method: case_break, full_case, or pallet_drop (default: case_break)\n# priority: 1-10 where 1 is highest priority (default: 5)";
                  const csv = instructions + "\n" + headers + "\n" + example;
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'replen_rules_template.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                data-testid="button-download-template"
              >
                <Download className="w-4 h-4 mr-2" />
                Download Template
              </Button>
            </div>

            {/* Field Reference */}
            <div className="border rounded-lg overflow-hidden hidden md:block">
              <div className="bg-muted px-4 py-2 border-b">
                <p className="font-medium text-sm">Column Reference</p>
              </div>
              <div className="divide-y text-sm">
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2 bg-muted/30">
                  <span className="font-medium">Column</span>
                  <span className="font-medium">Description</span>
                  <span className="font-medium text-center">Required</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">product_sku</code>
                  <span className="text-muted-foreground">Product SKU from your catalog</span>
                  <span className="text-center text-green-600 font-medium">Yes</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">pick_variant_sku</code>
                  <span className="text-muted-foreground">Variant SKU to replenish (e.g., eaches)</span>
                  <span className="text-center text-green-600 font-medium">Yes</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">source_variant_sku</code>
                  <span className="text-muted-foreground">Variant SKU to pick from (e.g., cases)</span>
                  <span className="text-center text-green-600 font-medium">Yes</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">pick_location_type</code>
                  <span className="text-muted-foreground">pick, bin (default: pick)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">source_location_type</code>
                  <span className="text-muted-foreground">reserve, pallet (default: reserve)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">source_priority</code>
                  <span className="text-muted-foreground">fifo or smallest_first (default: fifo)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">min_qty</code>
                  <span className="text-muted-foreground">Trigger replen when below this (default: 0)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">max_qty</code>
                  <span className="text-muted-foreground">Fill up to this qty (empty = 1 source unit)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">replen_method</code>
                  <span className="text-muted-foreground">case_break, full_case, pallet_drop</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
                <div className="grid grid-cols-[140px,1fr,80px] gap-2 px-4 py-2">
                  <code className="text-xs bg-muted px-1 rounded">priority</code>
                  <span className="text-muted-foreground">1-10, where 1 is highest (default: 5)</span>
                  <span className="text-center text-muted-foreground">No</span>
                </div>
              </div>
            </div>

            {/* Upload Section */}
            <div className="pt-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleCsvUpload}
                className="hidden"
              />
              <Button 
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadCsvMutation.isPending}
                className="w-full min-h-[44px]"
                size="lg"
                data-testid="button-select-csv"
              >
                {uploadCsvMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-2" />
                )}
                Select CSV File to Upload
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
          <DialogHeader>
            <DialogTitle className="text-base md:text-lg">Create Manual Replen Task</DialogTitle>
            <DialogDescription className="text-xs md:text-sm">
              Create a task to move inventory between locations
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label className="text-xs md:text-sm">From Location (Source)</Label>
              <Select 
                value={taskForm.fromLocationId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, fromLocationId: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-from-location">
                  <SelectValue placeholder="Select source..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.code} {loc.name ? `- ${loc.name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs md:text-sm">To Location (Destination)</Label>
              <Select 
                value={taskForm.toLocationId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, toLocationId: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-to-location">
                  <SelectValue placeholder="Select destination..." />
                </SelectTrigger>
                <SelectContent>
                  {locations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.code} {loc.name ? `- ${loc.name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs md:text-sm">Product (Optional)</Label>
              <Select 
                value={taskForm.catalogProductId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, catalogProductId: v })}
              >
                <SelectTrigger className="h-10" data-testid="select-task-product">
                  <SelectValue placeholder="Any product..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Any Product</SelectItem>
                  {products.map((p) => (
                    <SelectItem key={p.id} value={p.id.toString()}>
                      {p.sku || p.title || `Product ${p.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs md:text-sm">Quantity (Units)</Label>
              <Input
                type="number"
                className="h-10"
                value={taskForm.qtyTargetUnits}
                onChange={(e) => setTaskForm({ ...taskForm, qtyTargetUnits: e.target.value })}
                placeholder="Enter quantity..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-qty"
              />
            </div>
            <div>
              <Label className="text-xs md:text-sm">Notes (Optional)</Label>
              <Input
                className="h-10"
                value={taskForm.notes}
                onChange={(e) => setTaskForm({ ...taskForm, notes: e.target.value })}
                placeholder="Optional notes..."
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="input-notes"
              />
            </div>
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2">
              <Button variant="outline" className="min-h-[44px]" onClick={() => setShowTaskDialog(false)}>
                Cancel
              </Button>
              <Button 
                className="min-h-[44px]"
                onClick={() => createTaskMutation.mutate(taskForm)}
                disabled={!taskForm.fromLocationId || !taskForm.toLocationId || !taskForm.qtyTargetUnits}
                data-testid="button-save-task"
              >
                Create Task
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  );
}
