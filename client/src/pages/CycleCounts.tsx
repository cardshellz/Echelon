import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  RotateCcw
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
  const [newCountForm, setNewCountForm] = useState({ name: "", description: "", zoneFilter: "" });
  const [countForm, setCountForm] = useState({ countedSku: "", countedQty: "", notes: "" });
  const [approveForm, setApproveForm] = useState({ reasonCode: "", notes: "" });
  const [searchQuery, setSearchQuery] = useState("");
  
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
      setNewCountForm({ name: "", description: "", zoneFilter: "" });
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
    onSuccess: (data) => {
      toast({ 
        title: "Count recorded", 
        description: data.varianceType ? `Variance detected: ${data.varianceQty}` : "No variance" 
      });
      queryClient.invalidateQueries({ queryKey: ["/api/cycle-counts", selectedCount] });
      setCountDialogOpen(false);
      setSelectedItem(null);
      setCountForm({ countedSku: "", countedQty: "", notes: "" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to record", description: error.message, variant: "destructive" });
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

  const filteredItems = cycleCountDetail?.items.filter(item => 
    !searchQuery || 
    item.locationCode?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.expectedSku?.toLowerCase().includes(searchQuery.toLowerCase())
  ) || [];

  const handleCountClick = (item: CycleCountItem) => {
    setSelectedItem(item);
    setCountForm({
      countedSku: item.expectedSku || "",
      countedQty: "",
      notes: "",
    });
    setCountDialogOpen(true);
  };

  const handleApproveClick = (item: CycleCountItem) => {
    setSelectedItem(item);
    setApproveDialogOpen(true);
  };

  if (selectedCount && cycleCountDetail) {
    const pendingCount = cycleCountDetail.items.filter(i => i.status === "pending").length;
    const varianceCount = cycleCountDetail.items.filter(i => i.varianceType && i.status !== "approved").length;
    
    return (
      <div className="flex flex-col h-full p-4 md:p-6 gap-4">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => setSelectedCount(null)}>
            <RotateCcw className="h-4 w-4 mr-2" /> Back
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">{cycleCountDetail.name}</h1>
            <p className="text-muted-foreground text-sm">
              {cycleCountDetail.countedBins} / {cycleCountDetail.totalBins} bins counted
            </p>
          </div>
          {getStatusBadge(cycleCountDetail.status)}
          {cycleCountDetail.status === "in_progress" && pendingCount === 0 && varianceCount === 0 && (
            <Button onClick={() => completeMutation.mutate(selectedCount)} disabled={completeMutation.isPending}>
              <CheckCircle className="h-4 w-4 mr-2" /> Complete
            </Button>
          )}
        </div>

        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{cycleCountDetail.totalBins}</div>
              <div className="text-sm text-muted-foreground">Total Bins</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{pendingCount}</div>
              <div className="text-sm text-muted-foreground">Pending</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-amber-600">{varianceCount}</div>
              <div className="text-sm text-muted-foreground">Variances</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold text-emerald-600">
                {cycleCountDetail.countedBins - varianceCount}
              </div>
              <div className="text-sm text-muted-foreground">OK</div>
            </CardContent>
          </Card>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by location or SKU..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10 max-w-md"
            data-testid="input-search"
          />
        </div>

        <div className="rounded-md border bg-card flex-1 overflow-auto">
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
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Record Count</DialogTitle>
              <DialogDescription>
                Location: {selectedItem?.locationCode} | Expected: {selectedItem?.expectedSku} ({selectedItem?.expectedQty})
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Counted SKU</Label>
                <Input
                  value={countForm.countedSku}
                  onChange={(e) => setCountForm({ ...countForm, countedSku: e.target.value })}
                  placeholder="Scan or enter SKU"
                  data-testid="input-counted-sku"
                />
              </div>
              <div>
                <Label>Counted Quantity</Label>
                <Input
                  type="number"
                  value={countForm.countedQty}
                  onChange={(e) => setCountForm({ ...countForm, countedQty: e.target.value })}
                  placeholder="Enter quantity"
                  data-testid="input-counted-qty"
                />
              </div>
              <div>
                <Label>Notes (optional)</Label>
                <Textarea
                  value={countForm.notes}
                  onChange={(e) => setCountForm({ ...countForm, notes: e.target.value })}
                  placeholder="Any observations..."
                  data-testid="textarea-notes"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCountDialogOpen(false)}>Cancel</Button>
              <Button 
                onClick={() => selectedItem && countMutation.mutate({
                  itemId: selectedItem.id,
                  data: {
                    countedSku: countForm.countedSku || null,
                    countedQty: parseInt(countForm.countedQty) || 0,
                    notes: countForm.notes || null,
                  }
                })}
                disabled={countMutation.isPending}
              >
                Save Count
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
    <div className="flex flex-col h-full p-4 md:p-6 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cycle Counts</h1>
          <p className="text-muted-foreground">Monthly inventory reconciliation</p>
        </div>
        <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-new-count">
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
        <div className="rounded-md border bg-card">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>Cancel</Button>
            <Button 
              onClick={() => createMutation.mutate({
                name: newCountForm.name,
                description: newCountForm.description || undefined,
                zoneFilter: newCountForm.zoneFilter || undefined,
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
