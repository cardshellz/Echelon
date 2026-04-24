import React, { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Loader2,
  Tag,
  Store,
  Package,
  Pencil,
  Trash2,
  Search,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

// --- Types ---

interface ProductLine {
  id: number;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
  channelCount: number;
}

interface ProductLineDetail extends ProductLine {
  products: Array<{ productId: number; productName: string; sku: string }>;
  channels: Array<{ channelId: number; channelName: string; provider: string; isActive: boolean }>;
}

interface ChannelOption {
  id: number;
  name: string;
  provider: string;
  status: string;
}

interface ProductOption {
  id: number;
  name: string;
  sku: string;
}

// --- Create/Edit Dialog ---

function ProductLineDialog({
  line,
  onSaved,
}: {
  line?: ProductLine;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (open && line) {
      setName(line.name);
      setCode(line.code);
      setDescription(line.description || "");
    } else if (open) {
      setName("");
      setCode("");
      setDescription("");
    }
  }, [open, line]);

  // Auto-generate code from name
  useEffect(() => {
    if (!line && name) {
      setCode(name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, ""));
    }
  }, [name, line]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = line ? `/api/product-lines/${line.id}` : "/api/product-lines";
      const method = line ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, code, description: description || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      onSaved();
      toast({ title: line ? "Product line updated" : "Product line created" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {line ? (
          <Button variant="ghost" size="sm" className="h-8 px-2">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <Button>
            <Plus className="h-4 w-4 mr-2" /> New Product Line
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{line ? "Edit Product Line" : "New Product Line"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Trading Card Supplies" autoComplete="off" />
          </div>
          <div>
            <Label>Code</Label>
            <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))} placeholder="TRADING_CARD_SUPPLIES" autoComplete="off" disabled={!!line} className="font-mono" />
            {!line && <p className="text-xs text-muted-foreground mt-1">Auto-generated. Used as unique identifier.</p>}
          </div>
          <div>
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description..." rows={2} />
          </div>
          <Button className="w-full" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !name.trim() || !code.trim()}>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {line ? "Save Changes" : "Create Product Line"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface Product {
  id: number;
  sku: string | null;
  name: string;
  category: string | null;
  status: string | null;
  isActive: boolean;
}

function ManageProductsModal({
  lineId,
  lineName,
  assignedProductIds,
  onChanged,
}: {
  lineId: number;
  lineName: string;
  assignedProductIds: Set<number>;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [assignmentFilter, setAssignmentFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const { data: products = [], isLoading } = useQuery<Product[]>({
    queryKey: ["/api/products", { includeInactive: true }],
    queryFn: async () => {
      const res = await fetch("/api/products?includeInactive=true", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load products");
      return res.json();
    },
    enabled: open,
  });

  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(assignedProductIds));
    }
  }, [open, assignedProductIds]);

  const saveMutation = useMutation({
    mutationFn: async (productIds: number[]) => {
      const res = await fetch(`/api/product-lines/${lineId}/products`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productIds }),
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
    },
    onSuccess: () => {
      setOpen(false);
      onChanged();
      toast({ title: "Product assignments updated" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const categories = Array.from(new Set(products.map((p) => p.category).filter(Boolean))) as string[];

  const filteredProducts = products.filter((p) => {
    const matchesSearch = !search || p.name.toLowerCase().includes(search.toLowerCase()) || p.sku?.toLowerCase().includes(search.toLowerCase());
    const matchesCategory = categoryFilter === "all" || p.category === categoryFilter;
    const matchesAssignment = assignmentFilter === "all" || (assignmentFilter === "assigned" && selectedIds.has(p.id)) || (assignmentFilter === "unassigned" && !selectedIds.has(p.id));
    return matchesSearch && matchesCategory && matchesAssignment;
  });

  const allFilteredSelected = filteredProducts.length > 0 && filteredProducts.every((p) => selectedIds.has(p.id));

  const toggleAll = (checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) {
      filteredProducts.forEach((p) => next.add(p.id));
    } else {
      filteredProducts.forEach((p) => next.delete(p.id));
    }
    setSelectedIds(next);
  };

  const toggleOne = (id: number, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    setSelectedIds(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">
          <Package className="h-4 w-4 mr-2" />
          Manage Products
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 py-4 border-b">
          <DialogTitle>Manage Products: {lineName}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-wrap gap-3 px-6 py-4 bg-muted/30 border-b">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name or SKU..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-10"
              autoComplete="off"
            />
          </div>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="w-40 h-10">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={assignmentFilter} onValueChange={setAssignmentFilter}>
            <SelectTrigger className="w-40 h-10">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="assigned">Assigned</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
          ) : filteredProducts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">No products found matching filters.</div>
          ) : (
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10 shadow-sm">
                <TableRow>
                  <TableHead className="w-12 text-center">
                    <Checkbox checked={allFilteredSelected} onCheckedChange={toggleAll} />
                  </TableHead>
                  <TableHead>Product Name</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer" onClick={() => toggleOne(p.id, !selectedIds.has(p.id))}>
                    <TableCell className="text-center" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selectedIds.has(p.id)} onCheckedChange={(checked) => toggleOne(p.id, !!checked)} />
                    </TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="font-mono text-xs">{p.sku || "-"}</TableCell>
                    <TableCell>{p.category || "-"}</TableCell>
                    <TableCell>
                      <Badge variant={p.isActive ? "default" : "secondary"}>{p.isActive ? "Active" : "Inactive"}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t bg-muted/10 gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={() => saveMutation.mutate(Array.from(selectedIds))} disabled={saveMutation.isPending}>
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Save Assignments ({selectedIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Product assignment panel ---

function ProductAssignmentPanel({ lineId, lineName, assignedProducts, onChanged }: {
  lineId: number;
  lineName: string;
  assignedProducts: Array<{ productId: number; productName: string; sku: string }>;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const assignedIds = new Set(assignedProducts.map((p) => p.productId));

  const removeMutation = useMutation({
    mutationFn: async (productId: number) => {
      const res = await fetch(`/api/product-lines/${lineId}/products/${productId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
    },
    onSuccess: () => { onChanged(); toast({ title: "Product removed" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <ManageProductsModal lineId={lineId} lineName={lineName} assignedProductIds={assignedIds} onChanged={onChanged} />

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          Assigned ({assignedProducts.length})
        </p>
        {assignedProducts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No products assigned yet.</p>
        ) : (
          <div className="border rounded-md max-h-60 overflow-y-auto">
            {assignedProducts.map((p) => (
              <div key={p.productId} className="flex items-center justify-between px-3 py-1.5 border-b last:border-b-0 hover:bg-muted/50">
                <div>
                  <span className="text-sm">{p.productName}</span>
                  <span className="text-xs text-muted-foreground ml-2 font-mono">{p.sku}</span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-red-500 hover:text-red-600"
                  onClick={() => removeMutation.mutate(p.productId)}
                  disabled={removeMutation.isPending}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Channel assignment panel ---

function ChannelAssignmentPanel({ lineId, assignedChannels, onChanged }: {
  lineId: number;
  assignedChannels: Array<{ channelId: number; channelName: string; provider: string; isActive: boolean }>;
  onChanged: () => void;
}) {
  const { toast } = useToast();

  const { data: allChannels } = useQuery<ChannelOption[]>({
    queryKey: ["/api/channels/all"],
    queryFn: async () => {
      const res = await fetch("/api/channels", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  const assignedIds = new Set(assignedChannels.map((c) => c.channelId));

  const saveMutation = useMutation({
    mutationFn: async (channelIds: number[]) => {
      // For each channel that should have this line, update via channel endpoint
      // We'll save per-line by updating which channels carry this line
      // But the API is channel-centric... let's use the product-line channels approach
      // Actually we need a line-centric endpoint. For now, toggle per channel.
      for (const ch of allChannels || []) {
        const shouldHave = channelIds.includes(ch.id);
        const hasIt = assignedIds.has(ch.id);
        if (shouldHave === hasIt) continue;

        // Get current lines for this channel
        const res = await fetch(`/api/channels/${ch.id}/product-lines`, { credentials: "include" });
        const currentLines: Array<{ id: number }> = await res.json();
        const currentIds = currentLines.map((l) => l.id);

        let newIds: number[];
        if (shouldHave && !hasIt) {
          newIds = [...currentIds, lineId];
        } else {
          newIds = currentIds.filter((id) => id !== lineId);
        }

        await fetch(`/api/channels/${ch.id}/product-lines`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ productLineIds: newIds }),
        });
      }
    },
    onSuccess: () => { onChanged(); toast({ title: "Channel assignments updated" }); },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    setSelectedIds(new Set(assignedChannels.map((c) => c.channelId)));
  }, [assignedChannels]);

  const toggle = (id: number) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const hasChanges = (() => {
    if (selectedIds.size !== assignedIds.size) return true;
    return Array.from(selectedIds).some((id) => !assignedIds.has(id));
  })();

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Which channels carry this product line?
      </p>
      {(allChannels || []).length === 0 ? (
        <p className="text-sm text-muted-foreground">No channels configured.</p>
      ) : (
        <div className="space-y-2">
          {(allChannels || []).filter((c) => c.status === "active").map((ch) => (
            <label key={ch.id} className="flex items-center gap-3 p-2 border rounded-md hover:bg-muted/50 cursor-pointer">
              <Checkbox
                checked={selectedIds.has(ch.id)}
                onCheckedChange={() => toggle(ch.id)}
              />
              <div className="flex-1">
                <span className="text-sm font-medium">{ch.name}</span>
                <span className="text-xs text-muted-foreground ml-2">{ch.provider}</span>
              </div>
              {assignedIds.has(ch.id) && <Badge variant="secondary" className="text-[10px]">Active</Badge>}
            </label>
          ))}
        </div>
      )}
      {hasChanges && (
        <Button
          className="w-full"
          onClick={() => saveMutation.mutate(Array.from(selectedIds))}
          disabled={saveMutation.isPending}
        >
          {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Save Channel Assignments
        </Button>
      )}
    </div>
  );
}

// --- Expanded detail row ---

function ProductLineDetail({ lineId }: { lineId: number }) {
  const queryClient = useQueryClient();

  const { data: detail, isLoading } = useQuery<ProductLineDetail>({
    queryKey: [`/api/product-lines/${lineId}`],
    queryFn: async () => {
      const res = await fetch(`/api/product-lines/${lineId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load product line detail");
      return res.json();
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: [`/api/product-lines/${lineId}`] });
    queryClient.invalidateQueries({ queryKey: ["/api/product-lines"] });
  };

  if (isLoading || !detail) {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-4">
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
          <Package className="h-4 w-4" /> Products
        </h3>
        <ProductAssignmentPanel lineId={lineId} lineName={detail.name} assignedProducts={detail.products} onChanged={invalidate} />
      </div>
      <div>
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
          <Store className="h-4 w-4" /> Channels
        </h3>
        <ChannelAssignmentPanel lineId={lineId} assignedChannels={detail.channels} onChanged={invalidate} />
      </div>
    </div>
  );
}

// --- Main page ---

export default function ProductLinesPage() {
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: lines, isLoading } = useQuery<ProductLine[]>({
    queryKey: ["/api/product-lines"],
    queryFn: async () => {
      const res = await fetch("/api/product-lines", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load product lines");
      return res.json();
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/product-lines"] });

  return (
    <div className="space-y-4 p-2 md:p-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Product Lines</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Backend catalog groupings that control which products are available on which channels.
          </p>
        </div>
        <ProductLineDialog onSaved={invalidate} />
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : !lines || lines.length === 0 ? (
            <div className="text-center py-16">
              <Tag className="h-12 w-12 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-muted-foreground">No product lines yet. Create one to start organizing your catalog.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Code</TableHead>
                  <TableHead className="text-center">Products</TableHead>
                  <TableHead className="text-center">Channels</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="w-20"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <React.Fragment key={line.id}>
                    <TableRow
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => setExpandedId(expandedId === line.id ? null : line.id)}
                    >
                      <TableCell className="w-8">
                        {expandedId === line.id ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </TableCell>
                      <TableCell className="font-medium">{line.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{line.code}</TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{line.productCount}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{line.channelCount}</Badge>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant={line.isActive ? "default" : "outline"}>
                          {line.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <ProductLineDialog line={line} onSaved={invalidate} />
                        </div>
                      </TableCell>
                    </TableRow>
                    {expandedId === line.id && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-muted/20 p-0">
                          <ProductLineDetail lineId={line.id} />
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
