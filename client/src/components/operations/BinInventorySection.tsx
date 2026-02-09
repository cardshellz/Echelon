import { useState, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MoreHorizontal,
  ArrowLeftRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Edit,
  History,
  Filter,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface BinItem {
  variantId: number;
  sku: string;
  name: string;
  variantQty: number;
  reservedQty: number;
}

interface Bin {
  locationId: number;
  locationCode: string;
  zone: string | null;
  locationType: string;
  binType: string;
  isPickable: number;
  pickSequence: number | null;
  warehouseId: number | null;
  warehouseCode: string | null;
  capacityCubicMm: number | null;
  skuCount: number;
  totalVariantQty: number;
  totalReservedQty: number;
  items: BinItem[];
}

interface BinInventoryResponse {
  bins: Bin[];
  total: number;
  page: number;
  pageSize: number;
}

interface BinInventorySectionProps {
  warehouseId: number | null;
  searchQuery: string;
  canEdit: boolean;
  onTransfer: (fromLocationId: number, fromLocationCode: string, variantId?: number, sku?: string) => void;
  onAdjust: (locationId: number, locationCode: string, variantId: number, sku: string, currentQty: number) => void;
  onViewActivity: (locationId: number) => void;
}

interface FlatRow {
  bin: Bin;
  item: BinItem | null;
  isFirst: boolean;
  rowCount: number;
  groupIndex: number;
}

const LOCATION_TYPES = [
  { value: "all", label: "All Types" },
  { value: "pick", label: "Pick" },
  { value: "reserve", label: "Reserve" },
  { value: "receiving", label: "Receiving" },
  { value: "staging", label: "Staging" },
];

const INVENTORY_FILTER = [
  { value: "all", label: "All Bins" },
  { value: "true", label: "With Inventory" },
  { value: "false", label: "Empty Bins" },
];

export default function BinInventorySection({
  warehouseId,
  searchQuery,
  canEdit,
  onTransfer,
  onAdjust,
  onViewActivity,
}: BinInventorySectionProps) {
  const [page, setPage] = useState(1);
  const [locationType, setLocationType] = useState("all");
  const [hasInventory, setHasInventory] = useState("all");
  const [binSearch, setBinSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sortField, setSortField] = useState("code");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const pageSize = 50;

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(1);
  };

  const SortIcon = ({ field }: { field: string }) => {
    if (sortField !== field) return <ArrowUpDown className="h-3 w-3 text-muted-foreground" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  };

  // Debounce bin search input (300ms)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(binSearch);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [binSearch]);

  const effectiveSearch = debouncedSearch || searchQuery;

  const { data, isLoading } = useQuery<BinInventoryResponse>({
    queryKey: ["/api/operations/bin-inventory", warehouseId, locationType, hasInventory, effectiveSearch, page, sortField, sortDir],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (warehouseId) params.set("warehouseId", warehouseId.toString());
      if (locationType !== "all") params.set("locationType", locationType);
      if (hasInventory !== "all") params.set("hasInventory", hasInventory);
      if (effectiveSearch) params.set("search", effectiveSearch);
      params.set("page", page.toString());
      params.set("pageSize", pageSize.toString());
      params.set("sortField", sortField);
      params.set("sortDir", sortDir);
      const res = await fetch(`/api/operations/bin-inventory?${params}`);
      if (!res.ok) throw new Error("Failed to fetch bin inventory");
      return res.json();
    },
    staleTime: 30_000,
  });

  const flatRows = useMemo<FlatRow[]>(() => {
    if (!data?.bins) return [];
    return data.bins.flatMap((bin, groupIndex) => {
      if (bin.items.length === 0) {
        return [{ bin, item: null, isFirst: true, rowCount: 1, groupIndex }];
      }
      return bin.items.map((item, i) => ({
        bin, item, isFirst: i === 0, rowCount: bin.items.length, groupIndex,
      }));
    });
  }, [data]);

  const totalPages = data ? Math.ceil(data.total / pageSize) : 0;

  const locationTypeBadge = (type: string) => {
    const colors: Record<string, string> = {
      pick: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
      reserve: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
      receiving: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400",
      staging: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
    };
    return colors[type] || "bg-muted text-muted-foreground";
  };

  return (
    <div className="rounded-lg border bg-card">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold text-base">Bin Inventory</h3>
          {data && (
            <span className="text-sm text-muted-foreground">
              {data.total.toLocaleString()} locations
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <div className="relative w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search bins..."
              value={binSearch}
              onChange={(e) => setBinSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Select value={locationType} onValueChange={(v) => { setLocationType(v); setPage(1); }}>
            <SelectTrigger className="w-[160px] h-9">
              <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCATION_TYPES.map((lt) => (
                <SelectItem key={lt.value} value={lt.value}>{lt.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={hasInventory} onValueChange={(v) => { setHasInventory(v); setPage(1); }}>
            <SelectTrigger className="w-[150px] h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INVENTORY_FILTER.map((f) => (
                <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Desktop table */}
      <div className="hidden md:block overflow-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("code")}>
                <div className="flex items-center gap-1">Location <SortIcon field="code" /></div>
              </TableHead>
              <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("zone")}>
                <div className="flex items-center gap-1">Zone <SortIcon field="zone" /></div>
              </TableHead>
              <TableHead className="cursor-pointer hover:bg-muted/60" onClick={() => handleSort("type")}>
                <div className="flex items-center gap-1">Type <SortIcon field="type" /></div>
              </TableHead>
              <TableHead>SKU</TableHead>
              <TableHead>Item</TableHead>
              <TableHead className="text-right cursor-pointer hover:bg-muted/60" onClick={() => handleSort("qty")}>
                <div className="flex items-center justify-end gap-1">Qty <SortIcon field="qty" /></div>
              </TableHead>
              <TableHead className="text-right cursor-pointer hover:bg-muted/60" onClick={() => handleSort("reserved")}>
                <div className="flex items-center justify-end gap-1">Reserved <SortIcon field="reserved" /></div>
              </TableHead>
              {canEdit && <TableHead className="w-[50px]"></TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={canEdit ? 8 : 7} className="text-center py-8 text-muted-foreground">
                  Loading...
                </TableCell>
              </TableRow>
            ) : !flatRows.length ? (
              <TableRow>
                <TableCell colSpan={canEdit ? 8 : 7} className="text-center py-8 text-muted-foreground">
                  No locations found
                </TableCell>
              </TableRow>
            ) : (
              flatRows.map((row) => {
                const key = row.item
                  ? `${row.bin.locationId}-${row.item.variantId}`
                  : `${row.bin.locationId}-empty`;
                const isEvenGroup = row.groupIndex % 2 === 0;
                return (
                  <TableRow
                    key={key}
                    className={`${isEvenGroup ? "" : "bg-muted/10"} ${row.isFirst && row.groupIndex > 0 ? "border-t" : ""}`}
                  >
                    {/* Location */}
                    <TableCell className="font-mono text-sm font-medium">
                      {row.isFirst ? (
                        <>
                          {row.bin.locationCode}
                          {row.bin.warehouseCode && (
                            <span className="ml-1.5 text-xs text-muted-foreground">[{row.bin.warehouseCode}]</span>
                          )}
                          {row.rowCount > 1 && (
                            <Badge variant="outline" className="ml-1.5 text-[9px] px-1 py-0">
                              {row.rowCount}
                            </Badge>
                          )}
                        </>
                      ) : null}
                    </TableCell>
                    {/* Zone */}
                    <TableCell className="text-sm">
                      {row.isFirst ? (row.bin.zone || "—") : null}
                    </TableCell>
                    {/* Type */}
                    <TableCell>
                      {row.isFirst ? (
                        <Badge variant="outline" className={`text-[10px] ${locationTypeBadge(row.bin.locationType)}`}>
                          {row.bin.locationType.replace("_", " ")}
                        </Badge>
                      ) : null}
                    </TableCell>
                    {/* SKU */}
                    <TableCell className={`font-mono text-xs ${!row.isFirst ? "border-l-2 border-primary/20" : ""}`}>
                      {row.item ? row.item.sku : "—"}
                    </TableCell>
                    {/* Item Name */}
                    <TableCell className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {row.item ? row.item.name : "—"}
                    </TableCell>
                    {/* Qty */}
                    <TableCell className="text-right font-mono font-medium">
                      {row.item ? row.item.variantQty.toLocaleString() : row.bin.totalVariantQty.toLocaleString()}
                    </TableCell>
                    {/* Reserved */}
                    <TableCell className="text-right font-mono text-muted-foreground">
                      {row.item
                        ? (row.item.reservedQty > 0 ? row.item.reservedQty.toLocaleString() : "—")
                        : (row.bin.totalReservedQty > 0 ? row.bin.totalReservedQty.toLocaleString() : "—")}
                    </TableCell>
                    {/* Actions */}
                    {canEdit && (
                      <TableCell className="px-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {row.item && (
                              <>
                                <DropdownMenuItem onClick={() => onTransfer(row.bin.locationId, row.bin.locationCode, row.item!.variantId, row.item!.sku)}>
                                  <ArrowLeftRight className="h-4 w-4 mr-2" />
                                  Transfer SKU
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onAdjust(row.bin.locationId, row.bin.locationCode, row.item!.variantId, row.item!.sku, row.item!.variantQty)}>
                                  <Edit className="h-4 w-4 mr-2" />
                                  Adjust Qty
                                </DropdownMenuItem>
                              </>
                            )}
                            {row.isFirst && (
                              <>
                                <DropdownMenuItem onClick={() => onTransfer(row.bin.locationId, row.bin.locationCode)}>
                                  <ArrowLeftRight className="h-4 w-4 mr-2" />
                                  Transfer From Bin
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onViewActivity(row.bin.locationId)}>
                                  <History className="h-4 w-4 mr-2" />
                                  View History
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile card layout */}
      <div className="md:hidden p-3 space-y-2">
        {isLoading ? (
          <div className="text-center py-8 text-muted-foreground">Loading...</div>
        ) : !data?.bins.length ? (
          <div className="text-center py-8 text-muted-foreground">No locations found</div>
        ) : (
          data.bins.map((bin) => (
            <div key={bin.locationId} className="rounded-md border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-mono font-medium text-sm">{bin.locationCode}</div>
                  <div className="flex gap-1.5 mt-1">
                    <Badge variant="outline" className={`text-[10px] ${locationTypeBadge(bin.locationType)}`}>
                      {bin.locationType.replace("_", " ")}
                    </Badge>
                    {bin.zone && <Badge variant="outline" className="text-[10px]">{bin.zone}</Badge>}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-bold">{bin.totalVariantQty.toLocaleString()}</div>
                  <div className="text-xs text-muted-foreground">{bin.skuCount} SKUs</div>
                </div>
              </div>
              {bin.items.length > 0 && (
                <div className="mt-2 pt-2 border-t space-y-1">
                  {bin.items.map((item) => (
                    <div key={item.variantId} className="flex justify-between text-xs">
                      <span className="font-mono text-muted-foreground">{item.sku}</span>
                      <span className="font-mono">{item.variantQty}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 pt-2 border-t flex gap-2">
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs flex-1"
                    onClick={() => onTransfer(bin.locationId, bin.locationCode)}
                  >
                    <ArrowLeftRight className="h-3 w-3 mr-1" />
                    Transfer
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => onViewActivity(bin.locationId)}
                >
                  <History className="h-3 w-3 mr-1" />
                  History
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="p-3 border-t flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
