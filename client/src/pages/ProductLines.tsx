import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  AlertTriangle,
  ArrowRight,
  Copy,
  X,
  Package,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface ProductRow {
  id: number;
  name: string;
  sku: string | null;
  status: string | null;
  brand: string | null;
  imageUrl: string | null;
  inventoryQty: number;
  inventoryValueCents: number;
  lineIds: number[];
}

interface ProductsPage {
  rows: ProductRow[];
  total: number;
  page: number;
  limit: number;
}

interface LineStats {
  productCount: number;
  variantCount: number;
  inventoryQty: number;
  inventoryValueCents: number;
  channelCount: number;
}

type Selection =
  | { kind: "all" }
  | { kind: "unassigned" }
  | { kind: "line"; lineId: number };

function selectionToFilter(sel: Selection): string {
  if (sel.kind === "all") return "all";
  if (sel.kind === "unassigned") return "unassigned";
  return `line:${sel.lineId}`;
}

function selectionToUrlParam(sel: Selection): string {
  if (sel.kind === "all") return "all";
  if (sel.kind === "unassigned") return "unassigned";
  return String(sel.lineId);
}

function parseSelectionFromUrl(raw: string | null, lines: ProductLine[]): Selection {
  if (!raw || raw === "all") return { kind: "all" };
  if (raw === "unassigned") return { kind: "unassigned" };
  const id = parseInt(raw);
  if (Number.isInteger(id) && lines.some((l) => l.id === id)) {
    return { kind: "line", lineId: id };
  }
  return { kind: "unassigned" };
}

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// New / Edit product line dialog (kept from previous page)
// ---------------------------------------------------------------------------

function ProductLineDialog({
  line,
  onSaved,
  trigger,
}: {
  line?: ProductLine;
  onSaved: () => void;
  trigger?: React.ReactNode;
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

  useEffect(() => {
    if (!line && name) {
      setCode(
        name
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")
          .replace(/^_|_$/g, ""),
      );
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
        body: JSON.stringify({
          name,
          code,
          description: description || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || res.statusText);
      }
      return res.json();
    },
    onSuccess: () => {
      setOpen(false);
      onSaved();
      toast({ title: line ? "Product line updated" : "Product line created" });
    },
    onError: (err: Error) =>
      toast({ title: err.message, variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus className="h-4 w-4 mr-2" /> New Product Line
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {line ? "Edit Product Line" : "New Product Line"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div>
            <Label>Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Trading Card Supplies"
              autoComplete="off"
            />
          </div>
          <div>
            <Label>Code</Label>
            <Input
              value={code}
              onChange={(e) =>
                setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))
              }
              placeholder="TRADING_CARD_SUPPLIES"
              autoComplete="off"
              disabled={!!line}
              className="font-mono"
            />
            {!line && (
              <p className="text-xs text-muted-foreground mt-1">
                Auto-generated. Used as unique identifier.
              </p>
            )}
          </div>
          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description..."
              rows={2}
            />
          </div>
          <Button
            className="w-full"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !name.trim() || !code.trim()}
          >
            {saveMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            )}
            {line ? "Save Changes" : "Create Product Line"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sidebar: lines list
// ---------------------------------------------------------------------------

function LineSidebar({
  lines,
  selection,
  onSelect,
  search,
  onSearchChange,
  onDrop,
  totalProducts,
  unassignedCount,
}: {
  lines: ProductLine[];
  selection: Selection;
  onSelect: (sel: Selection) => void;
  search: string;
  onSearchChange: (s: string) => void;
  onDrop?: (targetLineId: number) => void;
  totalProducts: number;
  unassignedCount: number;
}) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.code.toLowerCase().includes(q),
    );
  }, [lines, search]);

  const [dragOverId, setDragOverId] = useState<number | "unassigned" | null>(null);

  const allowDropFromRows = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/x-echelon-products")) {
      e.preventDefault();
    }
  };

  return (
    <aside className="flex flex-col border rounded-lg bg-background overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Lines ({lines.length})
        </span>
      </div>
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search lines…"
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {/* Special: All Products */}
        <button
          type="button"
          onClick={() => onSelect({ kind: "all" })}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 rounded-md text-left font-semibold",
            selection.kind === "all"
              ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
              : "hover:bg-muted",
          )}
        >
          <div>
            <div className="text-sm">All Products</div>
            <div className="text-[11px] font-mono text-muted-foreground">—</div>
          </div>
          <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-foreground text-background">
            {totalProducts.toLocaleString()}
          </span>
        </button>

        {/* Special: Unassigned */}
        <button
          type="button"
          onClick={() => onSelect({ kind: "unassigned" })}
          onDragOver={allowDropFromRows}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes("application/x-echelon-products")) {
              setDragOverId("unassigned");
            }
          }}
          onDragLeave={() => setDragOverId((p) => (p === "unassigned" ? null : p))}
          onDrop={() => {
            // Not supported via drag-drop; users unassign via batch bar
            setDragOverId(null);
          }}
          className={cn(
            "w-full flex items-center justify-between px-3 py-2 mt-0.5 rounded-md text-left font-semibold",
            selection.kind === "unassigned"
              ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
              : "hover:bg-muted",
            dragOverId === "unassigned" && "ring-2 ring-amber-400",
          )}
        >
          <div>
            <div className="text-sm flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              Unassigned
            </div>
            <div className="text-[11px] font-mono text-muted-foreground">
              No line
            </div>
          </div>
          <span
            className={cn(
              "text-[11px] font-semibold px-2 py-0.5 rounded-full",
              unassignedCount > 0
                ? "bg-amber-600 text-white"
                : "bg-muted text-muted-foreground",
            )}
          >
            {unassignedCount.toLocaleString()}
          </span>
        </button>

        <div className="h-px bg-border my-2 mx-1" />

        {filtered.map((line) => {
          const active =
            selection.kind === "line" && selection.lineId === line.id;
          return (
            <button
              key={line.id}
              type="button"
              onClick={() => onSelect({ kind: "line", lineId: line.id })}
              onDragOver={allowDropFromRows}
              onDragEnter={(e) => {
                if (
                  e.dataTransfer.types.includes("application/x-echelon-products")
                ) {
                  setDragOverId(line.id);
                }
              }}
              onDragLeave={() =>
                setDragOverId((p) => (p === line.id ? null : p))
              }
              onDrop={(e) => {
                e.preventDefault();
                setDragOverId(null);
                if (onDrop) onDrop(line.id);
              }}
              className={cn(
                "w-full flex items-center justify-between px-3 py-2 mt-0.5 rounded-md text-left",
                active
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "hover:bg-muted",
                dragOverId === line.id && "ring-2 ring-blue-400",
              )}
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{line.name}</div>
                <div className="text-[11px] font-mono text-muted-foreground truncate">
                  {line.code}
                </div>
              </div>
              <span
                className={cn(
                  "text-[11px] font-semibold px-2 py-0.5 rounded-full shrink-0",
                  active ? "bg-blue-600 text-white" : "bg-muted",
                )}
              >
                {line.productCount.toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Center: products table with toolbar + batch bar
// ---------------------------------------------------------------------------

function ProductsTable({
  selection,
  lines,
  search,
  setSearch,
  vendor,
  setVendor,
  status,
  setStatus,
  page,
  setPage,
  selectedIds,
  setSelectedIds,
  data,
  isLoading,
  onMoveToLine,
  onDuplicateToLine,
  onUnassign,
}: {
  selection: Selection;
  lines: ProductLine[];
  search: string;
  setSearch: (s: string) => void;
  vendor: string;
  setVendor: (s: string) => void;
  status: string;
  setStatus: (s: string) => void;
  page: number;
  setPage: (n: number) => void;
  selectedIds: Set<number>;
  setSelectedIds: (updater: (prev: Set<number>) => Set<number>) => void;
  data: ProductsPage | undefined;
  isLoading: boolean;
  onMoveToLine: (lineId: number) => void;
  onDuplicateToLine: (lineId: number) => void;
  onUnassign: () => void;
}) {
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const lineById = useMemo(
    () => new Map(lines.map((l) => [l.id, l])),
    [lines],
  );

  const togglePageAll = (checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const r of rows) {
        if (checked) next.add(r.id);
        else next.delete(r.id);
      }
      return next;
    });
  };

  const toggleOne = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const pageAllSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.id));
  const pageSomeSelected =
    rows.some((r) => selectedIds.has(r.id)) && !pageAllSelected;

  const selectedCount = selectedIds.size;

  // Drag handler for drag-to-sidebar
  const onRowDragStart = (e: React.DragEvent, productId: number) => {
    // If the dragged row isn't selected, drag only that one; else drag the whole selection.
    const dragIds = selectedIds.has(productId)
      ? Array.from(selectedIds)
      : [productId];
    e.dataTransfer.setData(
      "application/x-echelon-products",
      JSON.stringify(dragIds),
    );
    e.dataTransfer.effectAllowed = "move";
  };

  const selectionLabel = (() => {
    if (selection.kind === "all") return "All Products";
    if (selection.kind === "unassigned") return "⚠ Unassigned";
    const ln = lineById.get(selection.lineId);
    return ln ? ln.name : "Line";
  })();

  const otherLines = lines.filter(
    (l) => selection.kind !== "line" || l.id !== selection.lineId,
  );

  return (
    <section className="flex flex-col border rounded-lg bg-background overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          Products in:{" "}
          <span
            className={cn(
              "ml-1 font-bold",
              selection.kind === "unassigned" && "text-amber-600",
            )}
          >
            {selectionLabel}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {total.toLocaleString()} product{total === 1 ? "" : "s"}
        </span>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b bg-muted/30">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Filter by name or SKU…"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Input
          value={vendor}
          onChange={(e) => {
            setVendor(e.target.value);
            setPage(1);
          }}
          placeholder="Vendor / brand"
          className="h-8 text-sm w-[160px]"
        />
        <Select
          value={status}
          onValueChange={(v) => {
            setStatus(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="h-8 w-[130px] text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Batch bar */}
      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm font-medium">
          <span>
            {selectedCount.toLocaleString()} selected
          </span>
          <div className="flex-1" />
          <MoveToLinePopover
            lines={otherLines}
            label="Move to Line"
            icon={<ArrowRight className="h-3.5 w-3.5 mr-1" />}
            onPick={onMoveToLine}
            variant="primary"
          />
          <MoveToLinePopover
            lines={lines}
            label="Duplicate assignment"
            icon={<Copy className="h-3.5 w-3.5 mr-1" />}
            onPick={onDuplicateToLine}
            variant="outline"
          />
          {selection.kind !== "unassigned" && (
            <Button size="sm" variant="outline" onClick={onUnassign}>
              Unassign all
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setSelectedIds(() => new Set())
            }
          >
            <X className="h-3.5 w-3.5 mr-1" /> Clear
          </Button>
        </div>
      )}

      {/* Table body */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-16 text-sm text-muted-foreground">
            <Package className="h-10 w-10 mx-auto opacity-30 mb-2" />
            No products match the current filters.
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 bg-muted/50 z-10">
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      pageAllSelected
                        ? true
                        : pageSomeSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={(c) => togglePageAll(!!c)}
                  />
                </TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="w-[140px]">SKU</TableHead>
                <TableHead className="w-[160px]">Current Line</TableHead>
                <TableHead className="w-[100px] text-right">Inventory</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const checked = selectedIds.has(p.id);
                const primaryLineId = p.lineIds[0];
                const primaryLine = primaryLineId
                  ? lineById.get(primaryLineId)
                  : undefined;
                return (
                  <TableRow
                    key={p.id}
                    className={cn(
                      checked && "bg-blue-50/60 dark:bg-blue-950/30",
                      "cursor-default",
                    )}
                    draggable
                    onDragStart={(e) => onRowDragStart(e, p.id)}
                  >
                    <TableCell>
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) => toggleOne(p.id, !!c)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <div className="h-8 w-8 rounded bg-muted border overflow-hidden shrink-0">
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt=""
                              className="h-full w-full object-cover"
                              loading="lazy"
                            />
                          ) : null}
                        </div>
                        <span className="text-sm font-medium truncate">
                          {p.name}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {p.sku ?? "—"}
                    </TableCell>
                    <TableCell>
                      {primaryLine ? (
                        <Badge variant="secondary" className="font-normal">
                          {primaryLine.name}
                          {p.lineIds.length > 1 && (
                            <span className="ml-1 opacity-60">
                              +{p.lineIds.length - 1}
                            </span>
                          )}
                        </Badge>
                      ) : (
                        <Badge
                          variant="outline"
                          className="font-normal bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300"
                        >
                          Unassigned
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">
                      {p.inventoryQty.toLocaleString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t bg-muted/20 text-xs text-muted-foreground">
          <span>
            Page {page} of {pageCount} — showing{" "}
            {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
          </span>
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage(Math.max(1, page - 1))}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= pageCount}
              onClick={() => setPage(Math.min(pageCount, page + 1))}
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Move-to-line popover
// ---------------------------------------------------------------------------

function MoveToLinePopover({
  lines,
  label,
  icon,
  onPick,
  variant,
}: {
  lines: ProductLine[];
  label: string;
  icon?: React.ReactNode;
  onPick: (lineId: number) => void;
  variant: "primary" | "outline";
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter(
      (l) =>
        l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q),
    );
  }, [lines, filter]);

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (v) setFilter("");
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant={variant === "primary" ? "default" : "outline"}
        >
          {icon}
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="end">
        <div className="p-2 border-b">
          <Input
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter lines…"
            className="h-8 text-sm"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              No lines match.
            </div>
          ) : (
            filtered.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => {
                  onPick(l.id);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-1.5 text-sm hover:bg-muted flex items-center justify-between"
              >
                <span className="truncate">{l.name}</span>
                <span className="text-[11px] text-muted-foreground shrink-0 ml-2">
                  {l.productCount}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Right drawer: line detail, stats, quick filters, activity
// ---------------------------------------------------------------------------

interface ActivityEntry {
  id: string;
  text: React.ReactNode;
  when: number;
}

function LineDrawer({
  selection,
  line,
  stats,
  lines,
  onQuickSelect,
  activity,
  onEditLine,
}: {
  selection: Selection;
  line: ProductLine | null;
  stats: LineStats | null;
  lines: ProductLine[];
  onQuickSelect: (chip: QuickFilter) => void;
  activity: ActivityEntry[];
  onEditLine: () => void;
}) {
  const isUnassigned = selection.kind === "unassigned";
  const isAll = selection.kind === "all";

  const title = isUnassigned
    ? "⚠ Unassigned"
    : isAll
      ? "All Products"
      : line?.name ?? "Line";
  const code = isUnassigned
    ? "No line code"
    : isAll
      ? "—"
      : line?.code ?? "";

  return (
    <aside className="flex flex-col border rounded-lg bg-background overflow-hidden">
      <div className="px-4 py-3 border-b">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
          Selected line
        </div>
        <div className="text-lg font-semibold mt-0.5">{title}</div>
        <div className="text-xs font-mono text-muted-foreground mt-0.5">
          {code}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 bg-border gap-px">
        <StatTile
          label="Products"
          value={stats?.productCount.toLocaleString() ?? "—"}
        />
        <StatTile
          label="Inventory value"
          value={
            stats
              ? formatCurrencyShort(stats.inventoryValueCents)
              : "—"
          }
        />
        <StatTile
          label="Channels"
          value={stats?.channelCount.toLocaleString() ?? "—"}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Action card */}
        {isUnassigned && stats && stats.productCount > 0 && (
          <div className="p-4 border-b bg-amber-50 dark:bg-amber-950/40">
            <div className="text-[11px] uppercase tracking-wide text-amber-700 dark:text-amber-400 font-bold mb-1">
              Action needed
            </div>
            <p className="text-xs text-amber-900 dark:text-amber-200 mb-2">
              {stats.productCount.toLocaleString()} products aren't assigned to
              any product line. Bulk-assign them to reveal channel routing and
              fulfillment rules.
            </p>
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              Select rows in the center table, then use{" "}
              <strong>→ Move to Line</strong>.
            </p>
          </div>
        )}

        {!isUnassigned && !isAll && line && (
          <div className="p-4 border-b">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
              Details
            </div>
            {line.description && (
              <p className="text-sm text-muted-foreground mb-3">
                {line.description}
              </p>
            )}
            <Button size="sm" variant="outline" onClick={onEditLine}>
              Edit line…
            </Button>
          </div>
        )}

        {/* Quick filters */}
        {(isUnassigned || isAll) && (
          <div className="p-4 border-b">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
              Quick filters
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_FILTERS.map((q) => (
                <Button
                  key={q.id}
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onQuickSelect(q)}
                >
                  {q.label}
                </Button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2">
              One click filters and auto-selects matching products for bulk
              move.
            </p>
          </div>
        )}

        {/* Available lines shortcut */}
        {!isAll && (
          <div className="p-4 border-b">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
              Jump to line
            </div>
            <div className="flex flex-wrap gap-1">
              {lines.slice(0, 8).map((l) => (
                <Badge
                  key={l.id}
                  variant="secondary"
                  className="text-[11px] font-normal"
                >
                  {l.name} · {l.productCount}
                </Badge>
              ))}
              {lines.length > 8 && (
                <Badge variant="outline" className="text-[11px] font-normal">
                  +{lines.length - 8} more
                </Badge>
              )}
            </div>
          </div>
        )}

        {/* Recent activity */}
        <div className="p-4">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-bold mb-2">
            Recent activity
          </div>
          {activity.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No activity yet this session.
            </p>
          ) : (
            <ul className="space-y-1.5 text-xs text-muted-foreground">
              {activity.slice(0, 8).map((a) => (
                <li key={a.id} className="flex justify-between gap-2">
                  <span className="truncate">{a.text}</span>
                  <span className="shrink-0 text-[11px] opacity-70">
                    {formatRelative(a.when)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </aside>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-background p-3">
      <div className="text-lg font-bold leading-tight">{value}</div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground mt-0.5">
        {label}
      </div>
    </div>
  );
}

function formatCurrencyShort(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1000) return `$${Math.round(dollars / 1000)}k`;
  return `$${dollars.toFixed(0)}`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// Quick filters — pure client-side matchers that operate on rows
// ---------------------------------------------------------------------------

interface QuickFilter {
  id: string;
  label: string;
  // Returns true if the row matches the chip
  match: (row: ProductRow) => boolean;
}

const QUICK_FILTERS: QuickFilter[] = [
  {
    id: "sports",
    label: "Sports cards",
    match: (r) =>
      /\b(topps|panini|bowman|upper deck|donruss|prizm|sports|football|basketball|baseball|hockey)\b/i.test(
        `${r.name} ${r.brand ?? ""}`,
      ),
  },
  {
    id: "tcg",
    label: "TCG (Pokémon / MTG / YGO)",
    match: (r) =>
      /\b(pok[eé]mon|magic|mtg|yu-?gi-?oh|ygo|lorcana)\b/i.test(
        `${r.name} ${r.brand ?? ""}`,
      ),
  },
  {
    id: "supplies",
    label: "Supplies (sleeves, tops)",
    match: (r) =>
      /\b(sleeve|toploader|top loader|one[- ]touch|holder|binder|box)\b/i.test(
        r.name,
      ),
  },
  {
    id: "zero-inv",
    label: "Out of stock",
    match: (r) => r.inventoryQty === 0,
  },
];

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProductLinesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, setLocation] = useLocation();

  // ---------- URL state ----------
  const initialParams = useMemo(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      line: p.get("line"),
      page: Math.max(1, parseInt(p.get("page") ?? "1") || 1),
      search: p.get("q") ?? "",
    };
  }, []);

  const [selection, setSelection] = useState<Selection>({ kind: "unassigned" });
  const [page, setPage] = useState(initialParams.page);
  const [search, setSearch] = useState(initialParams.search);
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState<string>("active");

  // Sidebar search
  const [lineSearch, setLineSearch] = useState("");

  // Selection across pages (productId -> kept)
  const [selectedIds, setSelectedIdsRaw] = useState<Set<number>>(new Set());
  const setSelectedIds = (
    updater: (prev: Set<number>) => Set<number>,
  ) => setSelectedIdsRaw((prev) => updater(prev));

  // Activity feed (session-local)
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const pushActivity = (text: React.ReactNode) => {
    setActivity((prev) =>
      [
        {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          text,
          when: Date.now(),
        },
        ...prev,
      ].slice(0, 20),
    );
  };

  // ---------- Data: all lines ----------
  // The sidebar per-line counts and the sidebar "Unassigned" badge MUST
  // honor the same `status` scope that the product list below them uses,
  // otherwise the badges disagree with the list contents. See the shared
  // `product-line-scope` helper on the server side.
  const { data: lines = [], isLoading: linesLoading } = useQuery<ProductLine[]>({
    queryKey: ["/api/product-lines", status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const qs = params.toString();
      const res = await fetch(`/api/product-lines${qs ? `?${qs}` : ""}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to load product lines");
      return res.json();
    },
  });

  // Hydrate selection from URL once lines are loaded
  const [selectionHydrated, setSelectionHydrated] = useState(false);
  useEffect(() => {
    if (selectionHydrated) return;
    if (linesLoading) return;
    setSelection(parseSelectionFromUrl(initialParams.line, lines));
    setSelectionHydrated(true);
  }, [initialParams.line, lines, linesLoading, selectionHydrated]);

  // ---------- Sync URL when selection / page changes ----------
  useEffect(() => {
    if (!selectionHydrated) return;
    const p = new URLSearchParams();
    p.set("line", selectionToUrlParam(selection));
    if (page > 1) p.set("page", String(page));
    if (search.trim()) p.set("q", search.trim());
    const qs = p.toString();
    const target = `/product-lines${qs ? `?${qs}` : ""}`;
    if (target !== location) {
      setLocation(target, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, page, search, selectionHydrated]);

  // Reset page when selection changes
  const selKey = selectionToFilter(selection);
  useEffect(() => {
    setPage(1);
  }, [selKey]);

  // ---------- Data: products page ----------
  const productsQueryKey = [
    "/api/product-lines/products",
    selKey,
    search,
    vendor,
    status,
    page,
  ] as const;

  const { data: productsData, isLoading: productsLoading } = useQuery<ProductsPage>({
    queryKey: productsQueryKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        filter: selKey,
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (search.trim()) params.set("search", search.trim());
      if (vendor.trim()) params.set("vendor", vendor.trim());
      if (status) params.set("status", status);
      const res = await fetch(`/api/product-lines/products?${params}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Failed to load products");
      }
      return res.json();
    },
    enabled: selectionHydrated,
  });

  // ---------- Data: stats for drawer ----------
  const statsKey: number | "unassigned" | "all" =
    selection.kind === "line"
      ? selection.lineId
      : selection.kind === "unassigned"
        ? "unassigned"
        : "all";

  const { data: stats } = useQuery<LineStats>({
    queryKey: ["/api/product-lines/stats", statsKey, status],
    queryFn: async () => {
      if (statsKey === "all") {
        // Aggregate from all lines data (no dedicated endpoint for "all active")
        const totalProducts = lines.reduce(
          (acc, l) => acc + (l.productCount ?? 0),
          0,
        );
        return {
          productCount: totalProducts,
          variantCount: 0,
          inventoryQty: 0,
          inventoryValueCents: 0,
          channelCount: lines.reduce((a, l) => a + (l.channelCount ?? 0), 0),
        };
      }
      const basePath =
        statsKey === "unassigned"
          ? "/api/product-lines/unassigned/stats"
          : `/api/product-lines/${statsKey}/stats`;
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const qs = params.toString();
      const res = await fetch(`${basePath}${qs ? `?${qs}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load stats");
      return res.json();
    },
    enabled: selectionHydrated && statsKey !== "all",
  });

  const allStats: LineStats | null = useMemo(() => {
    if (selection.kind !== "all") return stats ?? null;
    const totalProducts = lines.reduce(
      (acc, l) => acc + (l.productCount ?? 0),
      0,
    );
    return {
      productCount: totalProducts,
      variantCount: 0,
      inventoryQty: 0,
      inventoryValueCents: 0,
      channelCount: lines.reduce((a, l) => a + (l.channelCount ?? 0), 0),
    };
  }, [selection.kind, stats, lines]);

  // Unassigned count for sidebar (query stats whenever lines load).
  // Must pass `status` so the badge matches the list view's scope.
  const { data: unassignedStats } = useQuery<LineStats>({
    queryKey: ["/api/product-lines/stats", "unassigned", status],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      const qs = params.toString();
      const res = await fetch(
        `/api/product-lines/unassigned/stats${qs ? `?${qs}` : ""}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load unassigned stats");
      return res.json();
    },
    enabled: !linesLoading,
  });

  const totalProducts = useMemo(
    () =>
      lines.reduce((a, l) => a + (l.productCount ?? 0), 0) +
      (unassignedStats?.productCount ?? 0),
    [lines, unassignedStats],
  );

  // ---------- Mutations ----------

  const invalidateCore = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/product-lines"] });
    queryClient.invalidateQueries({ queryKey: ["/api/product-lines/products"] });
    queryClient.invalidateQueries({ queryKey: ["/api/product-lines/stats"] });
  };

  /**
   * Optimistic update strategy:
   * - Before the mutation we snapshot lines + current products page cache.
   * - We bump the target line's productCount (+delta) and, for moves,
   *   decrement the source's by the same delta.
   * - We remove moved rows from the currently-visible table if the view
   *   no longer includes them (unassigned → after move the rows disappear).
   * - On success we still invalidate to reconcile server truth.
   */

  const applyOptimisticMove = (
    productIds: number[],
    fromLineId: number | "unassigned" | "any",
    toLineId: number,
    mode: "move" | "duplicate",
  ) => {
    // Lines list: bump counts.
    // The query key now includes `status`, so we match by key prefix
    // instead of an exact key so every cached variant (active / draft /
    // archived / all) gets the same optimistic patch.
    queryClient.setQueriesData<ProductLine[]>(
      { queryKey: ["/api/product-lines"] },
      (prev) => {
        if (!prev) return prev;
        return prev.map((l) => {
          if (l.id === toLineId) {
            return { ...l, productCount: l.productCount + productIds.length };
          }
          if (
            mode === "move" &&
            typeof fromLineId === "number" &&
            l.id === fromLineId
          ) {
            return {
              ...l,
              productCount: Math.max(0, l.productCount - productIds.length),
            };
          }
          return l;
        });
      },
    );

    // Current products page: if moving (not duplicating) and we are NOT
    // looking at the target line, remove the rows that no longer belong here.
    if (mode === "move") {
      queryClient.setQueryData<ProductsPage>(
        productsQueryKey as unknown as readonly unknown[],
        (prev) => {
          if (!prev) return prev;
          const shouldStay = (r: ProductRow): boolean => {
            if (selection.kind === "all") return true;
            if (selection.kind === "unassigned") return false; // no longer unassigned
            if (selection.kind === "line") {
              return selection.lineId === toLineId; // stays only if current view IS the target
            }
            return true;
          };
          const removedIds = new Set(productIds);
          return {
            ...prev,
            rows: prev.rows.filter(
              (r) => !removedIds.has(r.id) || shouldStay(r),
            ),
            total: Math.max(
              0,
              prev.total -
                prev.rows.filter(
                  (r) => removedIds.has(r.id) && !shouldStay(r),
                ).length,
            ),
          };
        },
      );
    }
  };

  const bulkMoveMutation = useMutation({
    mutationFn: async (args: {
      productIds: number[];
      fromLineId: number | "unassigned" | "any";
      toLineId: number;
      mode: "move" | "duplicate";
    }) => {
      if (args.mode === "duplicate") {
        // Duplicate = just add to target without removing from source
        const res = await fetch(
          `/api/product-lines/${args.toLineId}/products`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ productIds: args.productIds }),
          },
        );
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(err.error || "Failed to duplicate assignment");
        }
        return res.json();
      }
      const res = await fetch(
        `/api/product-lines/${args.toLineId}/products/bulk-move`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            productIds: args.productIds,
            fromLineId: args.fromLineId,
          }),
        },
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Failed to move products");
      }
      return res.json();
    },
    onMutate: (args) => {
      applyOptimisticMove(
        args.productIds,
        args.fromLineId,
        args.toLineId,
        args.mode,
      );
    },
    onSuccess: (result, args) => {
      const target = lines.find((l) => l.id === args.toLineId);
      const verb = args.mode === "duplicate" ? "duplicated to" : "moved to";
      toast({
        title: `${args.productIds.length} product${
          args.productIds.length === 1 ? "" : "s"
        } ${verb} ${target?.name ?? "line"}`,
      });
      pushActivity(
        <>
          {args.productIds.length} {verb} <strong>{target?.name}</strong>
        </>,
      );
      invalidateCore();
      // Clear selection after a successful move
      if (args.mode === "move") {
        setSelectedIdsRaw(new Set());
      }
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
      invalidateCore();
    },
  });

  const bulkUnassignMutation = useMutation({
    mutationFn: async (productIds: number[]) => {
      const res = await fetch("/api/product-lines/bulk-unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ productIds }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || "Failed to unassign products");
      }
      return res.json();
    },
    onMutate: (productIds) => {
      // Decrement target-line count if viewing a specific line.
      // Patch every cached status-variant because the query key now
      // includes the `status` scope.
      if (selection.kind === "line") {
        const viewedId = selection.lineId;
        queryClient.setQueriesData<ProductLine[]>(
          { queryKey: ["/api/product-lines"] },
          (prev) =>
            prev?.map((l) =>
              l.id === viewedId
                ? {
                    ...l,
                    productCount: Math.max(0, l.productCount - productIds.length),
                  }
                : l,
            ),
        );
      }
    },
    onSuccess: (_r, productIds) => {
      toast({
        title: `${productIds.length} product${
          productIds.length === 1 ? "" : "s"
        } unassigned`,
      });
      pushActivity(<>{productIds.length} unassigned</>);
      invalidateCore();
      setSelectedIdsRaw(new Set());
    },
    onError: (err: Error) => {
      toast({ title: err.message, variant: "destructive" });
      invalidateCore();
    },
  });

  // ---------- Handlers ----------

  const handleMoveToLine = (targetLineId: number) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const fromLineId: number | "unassigned" | "any" =
      selection.kind === "line"
        ? selection.lineId
        : selection.kind === "unassigned"
          ? "unassigned"
          : "any";
    bulkMoveMutation.mutate({
      productIds: ids,
      fromLineId,
      toLineId: targetLineId,
      mode: "move",
    });
  };

  const handleDuplicateToLine = (targetLineId: number) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkMoveMutation.mutate({
      productIds: ids,
      fromLineId: "any",
      toLineId: targetLineId,
      mode: "duplicate",
    });
  };

  const handleUnassign = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    bulkUnassignMutation.mutate(ids);
  };

  const handleQuickFilter = (chip: QuickFilter) => {
    const rows = productsData?.rows ?? [];
    const hits = rows.filter(chip.match);
    if (hits.length === 0) {
      toast({
        title: "No matches on this page",
        description: "Try broadening the view or paging through the list.",
      });
      return;
    }
    setSelectedIdsRaw((prev) => {
      const next = new Set(prev);
      for (const r of hits) next.add(r.id);
      return next;
    });
    toast({
      title: `${hits.length} matched for "${chip.label}"`,
      description: "Selected rows are ready to bulk-move.",
    });
  };

  // Drag onto sidebar handler
  const handleSidebarDrop = (targetLineId: number) => {
    // Read currently dragged ids from the selection (drag sets the selection
    // to include the dragged row if it wasn't already selected).
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    handleMoveToLine(targetLineId);
  };

  const onEditLine = () => {
    // Edit dialog is owned below — dispatch a synthetic click
    const el = document.getElementById("edit-current-line-trigger");
    if (el) el.click();
  };

  // ---------- Render ----------

  const viewingLine =
    selection.kind === "line"
      ? lines.find((l) => l.id === selection.lineId) ?? null
      : null;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)] p-4 md:p-6 gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Product Lines</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Group products into lines for channel assignment, reporting, and
            fulfillment rules.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => invalidateCore()}
            title="Reload"
          >
            <RefreshCw className="h-4 w-4 mr-2" /> Refresh
          </Button>
          <ProductLineDialog onSaved={invalidateCore} />
        </div>
      </div>

      <div className="grid flex-1 min-h-0 gap-3 [grid-template-columns:280px_minmax(0,1fr)_380px]">
        <LineSidebar
          lines={lines}
          selection={selection}
          onSelect={setSelection}
          search={lineSearch}
          onSearchChange={setLineSearch}
          onDrop={handleSidebarDrop}
          totalProducts={totalProducts}
          unassignedCount={unassignedStats?.productCount ?? 0}
        />

        <ProductsTable
          selection={selection}
          lines={lines}
          search={search}
          setSearch={setSearch}
          vendor={vendor}
          setVendor={setVendor}
          status={status}
          setStatus={setStatus}
          page={page}
          setPage={setPage}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
          data={productsData}
          isLoading={productsLoading || linesLoading}
          onMoveToLine={handleMoveToLine}
          onDuplicateToLine={handleDuplicateToLine}
          onUnassign={handleUnassign}
        />

        <LineDrawer
          selection={selection}
          line={viewingLine}
          stats={allStats}
          lines={lines}
          onQuickSelect={handleQuickFilter}
          activity={activity}
          onEditLine={onEditLine}
        />
      </div>

      {/* Hidden edit dialog, triggered from the drawer */}
      {viewingLine && (
        <ProductLineDialog
          line={viewingLine}
          onSaved={invalidateCore}
          trigger={
            <button
              id="edit-current-line-trigger"
              type="button"
              style={{ display: "none" }}
            />
          }
        />
      )}
    </div>
  );
}
