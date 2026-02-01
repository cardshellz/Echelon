import { useState, useRef } from "react";
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
  Upload
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

interface UomVariant {
  id: number;
  sku: string | null;
  name: string;
  inventoryItemId: number;
  unitsPerVariant: number;
  hierarchyLevel: number;
}

interface InventoryItem {
  id: number;
  baseSku: string | null;
}

interface ReplenRule {
  id: number;
  catalogProductId: number;
  pickVariantId: number;
  sourceVariantId: number;
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
  catalogProduct?: CatalogProduct;
  pickVariant?: UomVariant;
  sourceVariant?: UomVariant;
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

const LOCATION_TYPES = [
  { value: "forward_pick", label: "Forward Pick" },
  { value: "bulk_storage", label: "Bulk Storage" },
  { value: "overflow", label: "Overflow" },
  { value: "receiving", label: "Receiving" },
  { value: "staging", label: "Staging" },
];

const SOURCE_PRIORITIES = [
  { value: "fifo", label: "FIFO (Oldest First)" },
  { value: "smallest_first", label: "Smallest First (Consolidate)" },
];

export default function Replenishment() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("tasks");
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [showCsvDialog, setShowCsvDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<ReplenRule | null>(null);
  const [taskFilter, setTaskFilter] = useState("pending");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [ruleForm, setRuleForm] = useState({
    catalogProductId: "",
    pickVariantId: "",
    sourceVariantId: "",
    pickLocationType: "forward_pick",
    sourceLocationType: "bulk_storage",
    sourcePriority: "fifo",
    minQty: "10",
    maxQty: "",
    replenMethod: "case_break",
    priority: "5",
  });

  const [taskForm, setTaskForm] = useState({
    fromLocationId: "",
    toLocationId: "",
    catalogProductId: "",
    qtyTargetUnits: "",
    priority: "5",
    notes: "",
  });

  const { data: rules = [], isLoading: rulesLoading } = useQuery<ReplenRule[]>({
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
    queryKey: ["/api/warehouse-locations"],
  });

  const { data: products = [] } = useQuery<CatalogProduct[]>({
    queryKey: ["/api/catalog-products"],
  });

  const { data: variants = [] } = useQuery<UomVariant[]>({
    queryKey: ["/api/uom-variants"],
  });

  const { data: inventoryItems = [] } = useQuery<InventoryItem[]>({
    queryKey: ["/api/inventory-items"],
  });

  // Filter variants by selected product
  // Links: product.inventoryItemId -> inventoryItem.id -> variant.inventoryItemId
  const getVariantsForProduct = (productId: string) => {
    if (!productId || productId === "none") return [];
    const product = products.find(p => p.id === parseInt(productId));
    if (!product) return [];
    
    // Find product's inventoryItemId via matching (product's sku can match inventoryItem's baseSku)
    // Or we can match via the link in catalog_products
    // For now, we find all variants that share an inventoryItemId with this product
    const productInventoryItemId = (product as any).inventoryItemId;
    if (!productInventoryItemId) {
      // Fallback: match by baseSku if product doesn't have direct inventoryItemId
      const matchingItem = inventoryItems.find(i => i.baseSku === product.sku);
      if (matchingItem) {
        return variants.filter(v => v.inventoryItemId === matchingItem.id);
      }
      return [];
    }
    
    return variants.filter(v => v.inventoryItemId === productInventoryItemId);
  };

  const createRuleMutation = useMutation({
    mutationFn: async (data: typeof ruleForm) => {
      const res = await fetch("/api/replen/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          catalogProductId: parseInt(data.catalogProductId),
          pickVariantId: parseInt(data.pickVariantId),
          sourceVariantId: parseInt(data.sourceVariantId),
          pickLocationType: data.pickLocationType,
          sourceLocationType: data.sourceLocationType,
          sourcePriority: data.sourcePriority,
          minQty: parseInt(data.minQty) || 0,
          maxQty: data.maxQty ? parseInt(data.maxQty) : null,
          replenMethod: data.replenMethod,
          priority: parseInt(data.priority),
        }),
      });
      if (!res.ok) throw new Error("Failed to create rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      setShowRuleDialog(false);
      resetRuleForm();
      toast({ title: "Replen rule created" });
    },
    onError: () => {
      toast({ title: "Failed to create rule", variant: "destructive" });
    },
  });

  const updateRuleMutation = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: Partial<ReplenRule> }) => {
      const res = await fetch(`/api/replen/rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error("Failed to update rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      setShowRuleDialog(false);
      setEditingRule(null);
      resetRuleForm();
      toast({ title: "Replen rule updated" });
    },
  });

  const deleteRuleMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/replen/rules/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to delete rule");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/replen/rules"] });
      toast({ title: "Replen rule deleted" });
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

  const resetRuleForm = () => {
    setRuleForm({
      catalogProductId: "",
      pickVariantId: "",
      sourceVariantId: "",
      pickLocationType: "forward_pick",
      sourceLocationType: "bulk_storage",
      sourcePriority: "fifo",
      minQty: "10",
      maxQty: "",
      replenMethod: "case_break",
      priority: "5",
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

  const handleEditRule = (rule: ReplenRule) => {
    setEditingRule(rule);
    setRuleForm({
      catalogProductId: rule.catalogProductId.toString(),
      pickVariantId: rule.pickVariantId.toString(),
      sourceVariantId: rule.sourceVariantId.toString(),
      pickLocationType: rule.pickLocationType,
      sourceLocationType: rule.sourceLocationType,
      sourcePriority: rule.sourcePriority,
      minQty: rule.minQty.toString(),
      maxQty: rule.maxQty?.toString() || "",
      replenMethod: rule.replenMethod,
      priority: rule.priority.toString(),
    });
    setShowRuleDialog(true);
  };

  const handleSaveRule = () => {
    if (editingRule) {
      updateRuleMutation.mutate({
        id: editingRule.id,
        data: {
          catalogProductId: parseInt(ruleForm.catalogProductId),
          pickVariantId: parseInt(ruleForm.pickVariantId),
          sourceVariantId: parseInt(ruleForm.sourceVariantId),
          pickLocationType: ruleForm.pickLocationType,
          sourceLocationType: ruleForm.sourceLocationType,
          sourcePriority: ruleForm.sourcePriority,
          minQty: parseInt(ruleForm.minQty) || 0,
          maxQty: ruleForm.maxQty ? parseInt(ruleForm.maxQty) : null,
          replenMethod: ruleForm.replenMethod,
          priority: parseInt(ruleForm.priority),
        },
      });
    } else {
      createRuleMutation.mutate(ruleForm);
    }
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

  const pendingCount = tasks.filter(t => t.status === "pending").length;
  const inProgressCount = tasks.filter(t => t.status === "in_progress").length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold">Replenishment</h1>
          <p className="text-muted-foreground">Manage inventory flow from bulk storage to pick locations</p>
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
        </TabsList>

        <TabsContent value="tasks" className="space-y-4">
          <div className="flex justify-between items-center">
            <div className="flex gap-2">
              <Select value={taskFilter} onValueChange={setTaskFilter}>
                <SelectTrigger className="w-40" data-testid="select-task-filter">
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
              <Button 
                variant="outline" 
                size="icon"
                onClick={() => queryClient.invalidateQueries({ queryKey: ["/api/replen/tasks"] })}
                data-testid="button-refresh-tasks"
              >
                <RefreshCw className="w-4 h-4" />
              </Button>
            </div>
            <div className="flex gap-2">
              <Button 
                variant="outline" 
                onClick={() => generateTasksMutation.mutate()}
                disabled={generateTasksMutation.isPending}
                data-testid="button-auto-generate"
              >
                {generateTasksMutation.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <AlertCircle className="w-4 h-4 mr-2" />
                )}
                Auto-Generate
              </Button>
              <Button onClick={() => setShowTaskDialog(true)} data-testid="button-create-task">
                <Plus className="w-4 h-4 mr-2" />
                Create Task
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {tasksLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : tasks.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Package className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No replenishment tasks</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>From</TableHead>
                      <TableHead></TableHead>
                      <TableHead>To</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Assigned</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tasks.map((task) => (
                      <TableRow key={task.id} data-testid={`row-task-${task.id}`}>
                        <TableCell>
                          <div className="font-mono text-sm">
                            {task.fromLocation?.code || `LOC-${task.fromLocationId}`}
                          </div>
                        </TableCell>
                        <TableCell>
                          <ArrowRight className="w-4 h-4 text-muted-foreground" />
                        </TableCell>
                        <TableCell>
                          <div className="font-mono text-sm">
                            {task.toLocation?.code || `LOC-${task.toLocationId}`}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {task.catalogProduct?.sku || task.catalogProduct?.title || "-"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {task.qtyCompleted}/{task.qtyTargetUnits}
                          </div>
                        </TableCell>
                        <TableCell>{getStatusBadge(task.status)}</TableCell>
                        <TableCell>{getTriggerBadge(task.triggeredBy)}</TableCell>
                        <TableCell>
                          <span className="text-sm text-muted-foreground">
                            {task.assignedTo || "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            {task.status === "pending" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => updateTaskMutation.mutate({
                                  id: task.id,
                                  data: { status: "in_progress" }
                                })}
                                data-testid={`button-start-task-${task.id}`}
                              >
                                <Play className="w-3 h-3 mr-1" />
                                Start
                              </Button>
                            )}
                            {task.status === "in_progress" && (
                              <Button
                                size="sm"
                                className="bg-green-500 hover:bg-green-600"
                                onClick={() => updateTaskMutation.mutate({
                                  id: task.id,
                                  data: { 
                                    status: "completed",
                                    qtyCompleted: task.qtyTargetUnits
                                  }
                                })}
                                data-testid={`button-complete-task-${task.id}`}
                              >
                                <CheckCircle className="w-3 h-3 mr-1" />
                                Complete
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-4">
          <div className="flex justify-between items-center">
            <p className="text-muted-foreground">
              Product-based rules with dynamic source location lookup
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowCsvDialog(true)} data-testid="button-upload-csv">
                <Upload className="w-4 h-4 mr-2" />
                Upload CSV
              </Button>
              <Button onClick={() => { resetRuleForm(); setEditingRule(null); setShowRuleDialog(true); }} data-testid="button-create-rule">
                <Plus className="w-4 h-4 mr-2" />
                Add Rule
              </Button>
            </div>
          </div>

          <Card>
            <CardContent className="p-0">
              {rulesLoading ? (
                <div className="flex justify-center p-8">
                  <Loader2 className="w-6 h-6 animate-spin" />
                </div>
              ) : rules.length === 0 ? (
                <div className="text-center p-8 text-muted-foreground">
                  <Settings className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>No replenishment rules configured</p>
                  <p className="text-sm">Add rules to define how inventory flows by product and variant</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Pick Variant</TableHead>
                      <TableHead>Source Variant</TableHead>
                      <TableHead>Location Types</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Min/Max</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id} data-testid={`row-rule-${rule.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Package className="w-4 h-4 text-blue-500" />
                            <span className="text-sm font-medium">
                              {rule.catalogProduct?.sku || rule.catalogProduct?.title || `Product ${rule.catalogProductId}`}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {rule.pickVariant?.sku || rule.pickVariant?.name || `Variant ${rule.pickVariantId}`}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {rule.sourceVariant?.sku || rule.sourceVariant?.name || `Variant ${rule.sourceVariantId}`}
                          </span>
                        </TableCell>
                        <TableCell>
                          <div className="text-xs space-y-1">
                            <div><Badge variant="outline" className="text-xs">{rule.pickLocationType}</Badge></div>
                            <div className="text-muted-foreground">← {rule.sourceLocationType}</div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{rule.sourcePriority}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-sm">
                            {rule.minQty} / {rule.maxQty ?? "auto"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{rule.replenMethod}</Badge>
                        </TableCell>
                        <TableCell>
                          {rule.isActive ? (
                            <Badge className="bg-green-500">Active</Badge>
                          ) : (
                            <Badge variant="secondary">Inactive</Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleEditRule(rule)}
                              data-testid={`button-edit-rule-${rule.id}`}
                            >
                              <Edit className="w-4 h-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => {
                                if (confirm("Delete this replenishment rule?")) {
                                  deleteRuleMutation.mutate(rule.id);
                                }
                              }}
                              data-testid={`button-delete-rule-${rule.id}`}
                            >
                              <Trash2 className="w-4 h-4 text-red-500" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Rule Dialog */}
      <Dialog open={showRuleDialog} onOpenChange={setShowRuleDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Edit Replen Rule" : "Create Replen Rule"}</DialogTitle>
            <DialogDescription>
              Define product-based replenishment with dynamic source location lookup
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Product</Label>
              <Select 
                value={ruleForm.catalogProductId} 
                onValueChange={(v) => setRuleForm({ ...ruleForm, catalogProductId: v })}
              >
                <SelectTrigger data-testid="select-product">
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
            
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Pick Variant (Destination)</Label>
                <Select 
                  value={ruleForm.pickVariantId} 
                  onValueChange={(v) => setRuleForm({ ...ruleForm, pickVariantId: v })}
                >
                  <SelectTrigger data-testid="select-pick-variant">
                    <SelectValue placeholder="Select variant..." />
                  </SelectTrigger>
                  <SelectContent>
                    {getVariantsForProduct(ruleForm.catalogProductId).map((v) => (
                      <SelectItem key={v.id} value={v.id.toString()}>
                        {v.sku || v.name} ({v.unitsPerVariant} units)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Source Variant</Label>
                <Select 
                  value={ruleForm.sourceVariantId} 
                  onValueChange={(v) => setRuleForm({ ...ruleForm, sourceVariantId: v })}
                >
                  <SelectTrigger data-testid="select-source-variant">
                    <SelectValue placeholder="Select variant..." />
                  </SelectTrigger>
                  <SelectContent>
                    {getVariantsForProduct(ruleForm.catalogProductId).map((v) => (
                      <SelectItem key={v.id} value={v.id.toString()}>
                        {v.sku || v.name} ({v.unitsPerVariant} units)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Pick Location Type</Label>
                <Select 
                  value={ruleForm.pickLocationType} 
                  onValueChange={(v) => setRuleForm({ ...ruleForm, pickLocationType: v })}
                >
                  <SelectTrigger data-testid="select-pick-location-type">
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
                <Label>Source Location Type</Label>
                <Select 
                  value={ruleForm.sourceLocationType} 
                  onValueChange={(v) => setRuleForm({ ...ruleForm, sourceLocationType: v })}
                >
                  <SelectTrigger data-testid="select-source-location-type">
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
              <Label>Source Priority</Label>
              <Select 
                value={ruleForm.sourcePriority} 
                onValueChange={(v) => setRuleForm({ ...ruleForm, sourcePriority: v })}
              >
                <SelectTrigger data-testid="select-source-priority">
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
                <Label>Min Qty (Trigger)</Label>
                <Input
                  type="number"
                  value={ruleForm.minQty}
                  onChange={(e) => setRuleForm({ ...ruleForm, minQty: e.target.value })}
                  data-testid="input-min-qty"
                />
              </div>
              <div>
                <Label>Max Qty (Fill To)</Label>
                <Input
                  type="number"
                  value={ruleForm.maxQty}
                  onChange={(e) => setRuleForm({ ...ruleForm, maxQty: e.target.value })}
                  placeholder="Auto (1 source unit)"
                  data-testid="input-max-qty"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Replen Method</Label>
                <Select 
                  value={ruleForm.replenMethod} 
                  onValueChange={(v) => setRuleForm({ ...ruleForm, replenMethod: v })}
                >
                  <SelectTrigger data-testid="select-replen-method">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="case_break">Case Break</SelectItem>
                    <SelectItem value="full_case">Full Case</SelectItem>
                    <SelectItem value="pallet_drop">Pallet Drop</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Priority (1 = highest)</Label>
                <Input
                  type="number"
                  min="1"
                  max="99"
                  value={ruleForm.priority}
                  onChange={(e) => setRuleForm({ ...ruleForm, priority: e.target.value })}
                  data-testid="input-priority"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowRuleDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveRule}
                disabled={!ruleForm.catalogProductId || !ruleForm.pickVariantId || !ruleForm.sourceVariantId}
                data-testid="button-save-rule"
              >
                {editingRule ? "Update Rule" : "Create Rule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* CSV Upload Dialog */}
      <Dialog open={showCsvDialog} onOpenChange={setShowCsvDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload Replen Rules CSV</DialogTitle>
            <DialogDescription>
              Bulk import replenishment rules from a CSV file
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-muted p-4 rounded-lg text-sm">
              <p className="font-medium mb-2">CSV Format:</p>
              <code className="text-xs block overflow-x-auto">
                product_sku,pick_variant_sku,source_variant_sku,pick_location_type,source_location_type,source_priority,min_qty,max_qty,replen_method,priority
              </code>
              <p className="mt-2 text-muted-foreground">
                Example: SKU-A,SKU-A-P1,SKU-A-C10,forward_pick,bulk_storage,fifo,3,,case_break,5
              </p>
            </div>
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
              className="w-full"
              data-testid="button-select-csv"
            >
              {uploadCsvMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Upload className="w-4 h-4 mr-2" />
              )}
              Select CSV File
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Task Dialog */}
      <Dialog open={showTaskDialog} onOpenChange={setShowTaskDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create Manual Replen Task</DialogTitle>
            <DialogDescription>
              Create a task to move inventory between locations
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>From Location (Source)</Label>
              <Select 
                value={taskForm.fromLocationId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, fromLocationId: v })}
              >
                <SelectTrigger data-testid="select-from-location">
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
              <Label>To Location (Destination)</Label>
              <Select 
                value={taskForm.toLocationId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, toLocationId: v })}
              >
                <SelectTrigger data-testid="select-to-location">
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
              <Label>Product (Optional)</Label>
              <Select 
                value={taskForm.catalogProductId} 
                onValueChange={(v) => setTaskForm({ ...taskForm, catalogProductId: v })}
              >
                <SelectTrigger data-testid="select-task-product">
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
              <Label>Quantity (Units)</Label>
              <Input
                type="number"
                value={taskForm.qtyTargetUnits}
                onChange={(e) => setTaskForm({ ...taskForm, qtyTargetUnits: e.target.value })}
                placeholder="Enter quantity..."
                data-testid="input-qty"
              />
            </div>
            <div>
              <Label>Notes (Optional)</Label>
              <Input
                value={taskForm.notes}
                onChange={(e) => setTaskForm({ ...taskForm, notes: e.target.value })}
                placeholder="Optional notes..."
                data-testid="input-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowTaskDialog(false)}>
                Cancel
              </Button>
              <Button 
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
