import { useState } from "react";
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
  User
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

interface ReplenRule {
  id: number;
  pickLocationId: number;
  sourceLocationId: number;
  catalogProductId: number | null;
  pickUomVariantId: number | null;
  sourceUomVariantId: number | null;
  minQty: number;
  maxQty: number;
  replenMethod: string;
  priority: number;
  isActive: number;
  createdAt: string;
  updatedAt: string;
  pickLocation?: WarehouseLocation;
  sourceLocation?: WarehouseLocation;
  catalogProduct?: CatalogProduct;
}

interface ReplenTask {
  id: number;
  replenRuleId: number | null;
  fromLocationId: number;
  toLocationId: number;
  catalogProductId: number | null;
  sourceUomVariantId: number | null;
  targetUomVariantId: number | null;
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

export default function Replenishment() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState("tasks");
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [showTaskDialog, setShowTaskDialog] = useState(false);
  const [editingRule, setEditingRule] = useState<ReplenRule | null>(null);
  const [taskFilter, setTaskFilter] = useState("pending");

  const [ruleForm, setRuleForm] = useState({
    pickLocationId: "",
    sourceLocationId: "",
    catalogProductId: "",
    minQty: "10",
    maxQty: "50",
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

  const pickLocations = locations.filter(l => l.isPickable === 1);
  const bulkLocations = locations.filter(l => 
    l.locationType === "bulk_storage" || l.locationType === "bulk_reserve" || l.locationType === "pallet"
  );

  const createRuleMutation = useMutation({
    mutationFn: async (data: typeof ruleForm) => {
      const res = await fetch("/api/replen/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          pickLocationId: parseInt(data.pickLocationId),
          sourceLocationId: parseInt(data.sourceLocationId),
          catalogProductId: data.catalogProductId ? parseInt(data.catalogProductId) : null,
          minQty: parseInt(data.minQty),
          maxQty: parseInt(data.maxQty),
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
          catalogProductId: data.catalogProductId ? parseInt(data.catalogProductId) : null,
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

  const resetRuleForm = () => {
    setRuleForm({
      pickLocationId: "",
      sourceLocationId: "",
      catalogProductId: "",
      minQty: "10",
      maxQty: "50",
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
      pickLocationId: rule.pickLocationId.toString(),
      sourceLocationId: rule.sourceLocationId.toString(),
      catalogProductId: rule.catalogProductId?.toString() || "",
      minQty: rule.minQty.toString(),
      maxQty: rule.maxQty.toString(),
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
          pickLocationId: parseInt(ruleForm.pickLocationId),
          sourceLocationId: parseInt(ruleForm.sourceLocationId),
          catalogProductId: ruleForm.catalogProductId ? parseInt(ruleForm.catalogProductId) : null,
          minQty: parseInt(ruleForm.minQty),
          maxQty: parseInt(ruleForm.maxQty),
          replenMethod: ruleForm.replenMethod,
          priority: parseInt(ruleForm.priority),
        },
      });
    } else {
      createRuleMutation.mutate(ruleForm);
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
              Define which bulk storage locations feed which pick bins
            </p>
            <Button onClick={() => { resetRuleForm(); setEditingRule(null); setShowRuleDialog(true); }} data-testid="button-create-rule">
              <Plus className="w-4 h-4 mr-2" />
              Add Rule
            </Button>
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
                  <p className="text-sm">Add rules to define how inventory flows from bulk to pick locations</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Pick Location</TableHead>
                      <TableHead></TableHead>
                      <TableHead>Source Location</TableHead>
                      <TableHead>Product</TableHead>
                      <TableHead>Min/Max</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id} data-testid={`row-rule-${rule.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <MapPin className="w-4 h-4 text-blue-500" />
                            <span className="font-mono text-sm">
                              {rule.pickLocation?.code || `LOC-${rule.pickLocationId}`}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <ArrowRight className="w-4 h-4 text-muted-foreground rotate-180" />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Package className="w-4 h-4 text-orange-500" />
                            <span className="font-mono text-sm">
                              {rule.sourceLocation?.code || `LOC-${rule.sourceLocationId}`}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">
                            {rule.catalogProduct?.sku || rule.catalogProduct?.title || "All Products"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-sm">
                            {rule.minQty} / {rule.maxQty}
                          </span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{rule.replenMethod}</Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{rule.priority}</span>
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

      <Dialog open={showRuleDialog} onOpenChange={setShowRuleDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingRule ? "Edit Replen Rule" : "Create Replen Rule"}</DialogTitle>
            <DialogDescription>
              Define how inventory flows from bulk storage to a pick bin
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Pick Location (Destination)</Label>
              <Select 
                value={ruleForm.pickLocationId} 
                onValueChange={(v) => setRuleForm({ ...ruleForm, pickLocationId: v })}
              >
                <SelectTrigger data-testid="select-pick-location">
                  <SelectValue placeholder="Select pick bin..." />
                </SelectTrigger>
                <SelectContent>
                  {pickLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.code} {loc.name ? `- ${loc.name}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Source Location (Bulk Storage)</Label>
              <Select 
                value={ruleForm.sourceLocationId} 
                onValueChange={(v) => setRuleForm({ ...ruleForm, sourceLocationId: v })}
              >
                <SelectTrigger data-testid="select-source-location">
                  <SelectValue placeholder="Select bulk location..." />
                </SelectTrigger>
                <SelectContent>
                  {bulkLocations.length > 0 ? bulkLocations.map((loc) => (
                    <SelectItem key={loc.id} value={loc.id.toString()}>
                      {loc.code} {loc.name ? `- ${loc.name}` : ""}
                    </SelectItem>
                  )) : locations.map((loc) => (
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
                value={ruleForm.catalogProductId} 
                onValueChange={(v) => setRuleForm({ ...ruleForm, catalogProductId: v })}
              >
                <SelectTrigger data-testid="select-product">
                  <SelectValue placeholder="All products..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Products</SelectItem>
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
                  data-testid="input-max-qty"
                />
              </div>
            </div>
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
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowRuleDialog(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleSaveRule}
                disabled={!ruleForm.pickLocationId || !ruleForm.sourceLocationId}
                data-testid="button-save-rule"
              >
                {editingRule ? "Update Rule" : "Create Rule"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
                  <SelectItem value="">Any Product</SelectItem>
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
