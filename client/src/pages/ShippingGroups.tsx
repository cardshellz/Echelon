import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  Search,
  Truck,
  Pencil,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ShippingGroup {
  id: number;
  code: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  productCount: number;
}

interface ProductRow {
  id: number;
  name: string;
  sku: string | null;
  status: string | null;
  brand: string | null;
  shippingGroupId: number | null;
}

interface ProductsResponse {
  rows: ProductRow[];
  total: number;
  page: number;
  limit: number;
}

type GroupFilter = "all" | "unassigned" | number;

const PAGE_LIMIT = 50;

function normalizeCode(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Create / edit dialog
// ---------------------------------------------------------------------------
function ShippingGroupDialog({
  group,
  onSaved,
  trigger,
}: {
  group?: ShippingGroup;
  onSaved: () => void;
  trigger?: React.ReactNode;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [description, setDescription] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [isActive, setIsActive] = useState(true);

  useEffect(() => {
    if (open && group) {
      setName(group.name);
      setCode(group.code);
      setDescription(group.description || "");
      setSortOrder(group.sortOrder);
      setIsActive(group.isActive);
    } else if (open) {
      setName("");
      setCode("");
      setDescription("");
      setSortOrder(0);
      setIsActive(true);
    }
  }, [open, group]);

  // Auto-derive code from name on create only (code is immutable on edit).
  useEffect(() => {
    if (!group && name) setCode(normalizeCode(name));
  }, [name, group]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const url = group ? `/api/shipping-groups/${group.id}` : "/api/shipping-groups";
      const method = group ? "PATCH" : "POST";
      const body: Record<string, unknown> = {
        name,
        description: description || null,
        sortOrder,
      };
      if (group) {
        body.isActive = isActive;
      } else {
        body.code = code;
      }
      return jsonFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setOpen(false);
      onSaved();
      toast({ title: group ? "Shipping group updated" : "Shipping group created" });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="h-4 w-4 mr-2" /> New Shipping Group
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{group ? "Edit Shipping Group" : "New Shipping Group"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Storage Boxes"
              autoComplete="off"
            />
          </div>
          <div>
            <Label>Code</Label>
            <Input
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              placeholder="storage_boxes"
              autoComplete="off"
              disabled={!!group}
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {group
                ? "Code is the stable storefront/sync key and can't be changed."
                : "Auto-generated. Stable key used by the storefront/sync."}
            </p>
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="How items in this group are packed / mailed..."
              rows={2}
            />
          </div>
          <div>
            <Label>Sort order</Label>
            <Input
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
              className="w-28"
            />
            <p className="text-xs text-muted-foreground mt-1">Lower numbers sort first.</p>
          </div>
          {group && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={isActive}
                onCheckedChange={(v) => setIsActive(v === true)}
              />
              Active (selectable when assigning products)
            </label>
          )}
          <Button
            className="w-full"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !name.trim() || !code.trim()}
          >
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            {group ? "Save Changes" : "Create Shipping Group"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function ShippingGroups() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [filter, setFilter] = useState<GroupFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [moveTarget, setMoveTarget] = useState<string>("");

  // Debounce the search box into the query key.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Reset paging + selection whenever the scope changes (avoid stale IDs).
  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [filter, search]);

  const groupsQuery = useQuery<ShippingGroup[]>({
    queryKey: ["/api/shipping-groups"],
    queryFn: () => jsonFetch<ShippingGroup[]>("/api/shipping-groups"),
  });

  const filterParam =
    filter === "all" ? "all" : filter === "unassigned" ? "unassigned" : `group:${filter}`;

  const productsQuery = useQuery<ProductsResponse>({
    queryKey: ["/api/shipping-groups/products", filterParam, search, page],
    queryFn: () =>
      jsonFetch<ProductsResponse>(
        `/api/shipping-groups/products?filter=${encodeURIComponent(filterParam)}` +
          `&search=${encodeURIComponent(search)}&page=${page}&limit=${PAGE_LIMIT}`,
      ),
  });

  const groups = groupsQuery.data ?? [];
  const activeGroups = useMemo(() => groups.filter((g) => g.isActive), [groups]);
  const groupNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const rows = productsQuery.data?.rows ?? [];
  const total = productsQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_LIMIT));
  const visibleIds = rows.map((r) => r.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

  function toggleRow(id: number, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function toggleAllVisible(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of visibleIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const assignMutation = useMutation({
    mutationFn: async () => {
      const shippingGroupId = moveTarget === "none" ? null : Number(moveTarget);
      return jsonFetch<{ updated: number }>("/api/shipping-groups/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: Array.from(selectedIds), shippingGroupId }),
      });
    },
    onSuccess: (res) => {
      toast({ title: `Moved ${res.updated} product${res.updated === 1 ? "" : "s"}` });
      setSelectedIds(new Set());
      setMoveTarget("");
      queryClient.invalidateQueries({ queryKey: ["/api/shipping-groups"] });
      queryClient.invalidateQueries({ queryKey: ["/api/shipping-groups/products"] });
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Truck className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-xl md:text-2xl font-semibold">Shipping Groups</h1>
        </div>
        <ShippingGroupDialog onSaved={() => groupsQuery.refetch()} />
      </div>
      <p className="text-sm text-muted-foreground max-w-3xl">
        A shipping group is a fulfillment equivalence class — &ldquo;can this item ship with that
        item.&rdquo; Each product belongs to exactly one group, which governs packing/mailer and
        (later) which storefront free-shipping threshold it counts toward.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {/* Groups sidebar */}
        <div className="space-y-1 rounded-lg border p-2">
          <button
            className={cn(
              "w-full text-left px-3 py-2 rounded-md text-sm hover:bg-muted",
              filter === "all" && "bg-muted font-medium",
            )}
            onClick={() => setFilter("all")}
          >
            All products
          </button>
          <button
            className={cn(
              "w-full text-left px-3 py-2 rounded-md text-sm hover:bg-muted",
              filter === "unassigned" && "bg-muted font-medium",
            )}
            onClick={() => setFilter("unassigned")}
          >
            Unassigned
          </button>
          <div className="h-px bg-border my-1" />
          {groupsQuery.isLoading && (
            <div className="px-3 py-4 text-sm text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </div>
          )}
          {groups.map((g) => (
            <div
              key={g.id}
              className={cn(
                "group flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-muted cursor-pointer",
                filter === g.id && "bg-muted",
              )}
              onClick={() => setFilter(g.id)}
            >
              <div className="flex-1 min-w-0">
                <div className={cn("truncate", filter === g.id && "font-medium")}>
                  {g.name}
                  {!g.isActive && (
                    <Badge variant="outline" className="ml-2 text-[10px]">
                      inactive
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground font-mono truncate">{g.code}</div>
              </div>
              <Badge variant="secondary" className="shrink-0">
                {g.productCount}
              </Badge>
              <ShippingGroupDialog
                group={g}
                onSaved={() => groupsQuery.refetch()}
                trigger={
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 opacity-0 group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                }
              />
            </div>
          ))}
        </div>

        {/* Products panel */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search products by name or SKU…"
                className="pl-8"
              />
            </div>
            <div className="text-sm text-muted-foreground ml-auto">
              {total} product{total === 1 ? "" : "s"}
            </div>
          </div>

          {/* Batch bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-3 py-2">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <div className="flex items-center gap-2 ml-auto">
                <Select value={moveTarget} onValueChange={setMoveTarget}>
                  <SelectTrigger className="h-9 w-56">
                    <SelectValue placeholder="Move to group…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeGroups.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}
                      </SelectItem>
                    ))}
                    <SelectItem value="none">Unassigned (clear)</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  onClick={() => assignMutation.mutate()}
                  disabled={!moveTarget || assignMutation.isPending}
                >
                  {assignMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                  Apply
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setSelectedIds(new Set())}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(v) => toggleAllVisible(v === true)}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Shipping group</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {productsQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading…
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                      No products in this view.
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((r) => (
                    <TableRow key={r.id} data-state={selectedIds.has(r.id) ? "selected" : undefined}>
                      <TableCell>
                        <Checkbox
                          checked={selectedIds.has(r.id)}
                          onCheckedChange={(v) => toggleRow(r.id, v === true)}
                          aria-label={`Select ${r.name}`}
                        />
                      </TableCell>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {r.sku ?? "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{r.brand ?? "—"}</TableCell>
                      <TableCell>
                        {r.shippingGroupId ? (
                          <Badge variant="outline">
                            {groupNameById.get(r.shippingGroupId) ?? `#${r.shippingGroupId}`}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Unassigned</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-end gap-2">
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
