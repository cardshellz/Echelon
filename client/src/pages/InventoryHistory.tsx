import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { 
  Search, 
  Filter, 
  Clock, 
  ArrowRight,
  ArrowLeft,
  Package,
  Truck,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  FileText,
  Download,
  Upload,
  ArrowUpDown,
  Warehouse,
  RotateCcw,
  PackagePlus,
  PackageMinus,
  MapPin
} from "lucide-react";
import { format, subDays } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface WarehouseLocation {
  id: number;
  code: string;
  locationType: string;
}

interface Product {
  id: number;
  baseSku: string;
  name: string;
}

interface InventoryTransaction {
  id: number;
  productVariantId: number;
  variantId: number | null;
  fromLocationId: number | null;
  toLocationId: number | null;
  warehouseLocationId: number | null;
  transactionType: string;
  reasonId: number | null;
  variantQtyDelta: number;
  variantQtyBefore: number | null;
  variantQtyAfter: number | null;
  baseQtyDelta: number;
  batchId: string | null;
  sourceState: string | null;
  targetState: string | null;
  orderId: number | null;
  orderItemId: number | null;
  receivingOrderId: number | null;
  cycleCountId: number | null;
  referenceType: string | null;
  referenceId: string | null;
  notes: string | null;
  userId: string | null;
  createdAt: string;
  fromLocation: WarehouseLocation | null;
  toLocation: WarehouseLocation | null;
  warehouseLocation: WarehouseLocation | null;
  product: Product | null;
}

const transactionTypeConfig: Record<string, { label: string; icon: React.ElementType; color: string }> = {
  receipt: { label: "Received", icon: Download, color: "bg-green-500" },
  pick: { label: "Picked", icon: PackageMinus, color: "bg-blue-500" },
  adjustment: { label: "Adjusted", icon: ArrowUpDown, color: "bg-yellow-500" },
  transfer: { label: "Transferred", icon: ArrowRight, color: "bg-purple-500" },
  ship: { label: "Shipped", icon: Truck, color: "bg-indigo-500" },
  return: { label: "Returned", icon: RotateCcw, color: "bg-orange-500" },
  replenish: { label: "Replenished", icon: PackagePlus, color: "bg-teal-500" },
  reserve: { label: "Reserved", icon: Package, color: "bg-cyan-500" },
  unreserve: { label: "Unreserved", icon: Package, color: "bg-gray-500" },
  csv_upload: { label: "CSV Import", icon: Upload, color: "bg-emerald-500" },
};

const stateColors: Record<string, string> = {
  on_hand: "bg-green-100 text-green-800",
  committed: "bg-blue-100 text-blue-800",
  picked: "bg-yellow-100 text-yellow-800",
  shipped: "bg-indigo-100 text-indigo-800",
  external: "bg-gray-100 text-gray-800",
};

export default function InventoryHistory() {
  const [transactionType, setTransactionType] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("7");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  const startDate = subDays(new Date(), parseInt(dateRange));
  const endDate = new Date();
  
  const { data: transactions = [], isLoading, refetch } = useQuery<InventoryTransaction[]>({
    queryKey: ["/api/inventory/transactions", transactionType, dateRange, page],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (transactionType !== "all") params.set("transactionType", transactionType);
      params.set("startDate", startDate.toISOString());
      params.set("endDate", endDate.toISOString());
      params.set("limit", limit.toString());
      params.set("offset", (page * limit).toString());
      
      const res = await fetch(`/api/inventory/transactions?${params}`);
      if (!res.ok) throw new Error("Failed to fetch transactions");
      return res.json();
    },
  });

  const filteredTransactions = transactions.filter(tx => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return (
      tx.product?.baseSku?.toLowerCase().includes(term) ||
      tx.product?.name?.toLowerCase().includes(term) ||
      tx.fromLocation?.code?.toLowerCase().includes(term) ||
      tx.toLocation?.code?.toLowerCase().includes(term) ||
      tx.batchId?.toLowerCase().includes(term) ||
      tx.referenceId?.toLowerCase().includes(term) ||
      tx.notes?.toLowerCase().includes(term)
    );
  });

  const getLocationDisplay = (tx: InventoryTransaction) => {
    const from = tx.fromLocation?.code || (tx.sourceState === "external" ? "External" : null);
    const to = tx.toLocation?.code || (tx.targetState === "shipped" ? "Shipped" : null);
    
    if (from && to) {
      return (
        <div className="flex items-center gap-1 text-sm">
          <span className="font-mono">{from}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{to}</span>
        </div>
      );
    }
    if (from) {
      return (
        <div className="flex items-center gap-1 text-sm">
          <ArrowLeft className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{from}</span>
        </div>
      );
    }
    if (to) {
      return (
        <div className="flex items-center gap-1 text-sm">
          <ArrowRight className="h-3 w-3 text-muted-foreground" />
          <span className="font-mono">{to}</span>
        </div>
      );
    }
    if (tx.warehouseLocation) {
      return <span className="font-mono text-sm">{tx.warehouseLocation.code}</span>;
    }
    return <span className="text-muted-foreground text-sm">-</span>;
  };

  return (
    <div className="container mx-auto p-2 md:p-6 space-y-4 md:space-y-6" data-testid="inventory-history-page">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold" data-testid="page-title">Inventory History</h1>
          <p className="text-sm text-muted-foreground">View complete audit trail of all inventory movements</p>
        </div>
        <Button onClick={() => refetch()} variant="outline" data-testid="button-refresh" className="min-h-[44px] w-full md:w-auto">
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="p-3 md:pb-3">
          <CardTitle className="text-base md:text-lg">Filters</CardTitle>
        </CardHeader>
        <CardContent className="p-3 md:p-6">
          <div className="flex flex-col md:flex-row flex-wrap gap-3 md:gap-4">
            <div className="w-full md:w-64">
              <Input
                placeholder="Search SKU, location, reference..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full h-11"
                data-testid="input-search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </div>
            
            <Select value={transactionType} onValueChange={setTransactionType}>
              <SelectTrigger className="w-full md:w-40 h-11" data-testid="select-transaction-type">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="receipt">Received</SelectItem>
                <SelectItem value="pick">Picked</SelectItem>
                <SelectItem value="ship">Shipped</SelectItem>
                <SelectItem value="adjustment">Adjusted</SelectItem>
                <SelectItem value="transfer">Transferred</SelectItem>
                <SelectItem value="replenish">Replenished</SelectItem>
                <SelectItem value="reserve">Reserved</SelectItem>
                <SelectItem value="unreserve">Unreserved</SelectItem>
                <SelectItem value="csv_upload">CSV Import</SelectItem>
              </SelectContent>
            </Select>
            
            <Select value={dateRange} onValueChange={setDateRange}>
              <SelectTrigger className="w-full md:w-36 h-11" data-testid="select-date-range">
                <SelectValue placeholder="Date Range" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Last 24 hours</SelectItem>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <>
              {/* Mobile card layout */}
              <div className="md:hidden space-y-3 p-3">
                {filteredTransactions.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground text-sm">
                    No transactions found
                  </div>
                ) : (
                  filteredTransactions.map((tx) => {
                    const config = transactionTypeConfig[tx.transactionType] || {
                      label: tx.transactionType,
                      icon: Package,
                      color: "bg-gray-500"
                    };
                    const Icon = config.icon;
                    
                    return (
                      <div key={tx.id} className="rounded-md border bg-card p-3" data-testid={`card-transaction-${tx.id}`}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className={cn("p-1.5 rounded", config.color)}>
                              <Icon className="h-3 w-3 text-white" />
                            </div>
                            <span className="text-sm font-medium">{config.label}</span>
                          </div>
                          <span className={cn(
                            "font-mono font-bold text-sm",
                            tx.variantQtyDelta > 0 ? "text-green-600" : 
                            tx.variantQtyDelta < 0 ? "text-red-600" : "text-muted-foreground"
                          )}>
                            {tx.variantQtyDelta > 0 ? "+" : ""}{tx.variantQtyDelta}
                          </span>
                        </div>
                        <div className="space-y-1">
                          <div className="font-mono text-sm text-primary">{tx.product?.baseSku || "-"}</div>
                          <div className="text-xs text-muted-foreground truncate">{tx.product?.name}</div>
                        </div>
                        <div className="flex items-center justify-between mt-2 pt-2 border-t">
                          <div className="text-xs text-muted-foreground">
                            {format(new Date(tx.createdAt), "MMM d, h:mm a")}
                          </div>
                          {getLocationDisplay(tx)}
                        </div>
                        {(tx.sourceState && tx.targetState && tx.sourceState !== tx.targetState) && (
                          <div className="flex items-center gap-1 mt-2">
                            <Badge variant="outline" className={cn("text-xs", stateColors[tx.sourceState] || "")}>
                              {tx.sourceState}
                            </Badge>
                            <ArrowRight className="h-3 w-3 text-muted-foreground" />
                            <Badge variant="outline" className={cn("text-xs", stateColors[tx.targetState] || "")}>
                              {tx.targetState}
                            </Badge>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* Desktop table layout */}
              <div className="hidden md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-40">Timestamp</TableHead>
                      <TableHead className="w-28">Type</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead className="w-32">State Change</TableHead>
                      <TableHead className="w-20 text-right">Qty</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead>User</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredTransactions.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
                          No transactions found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredTransactions.map((tx) => {
                        const config = transactionTypeConfig[tx.transactionType] || {
                          label: tx.transactionType,
                          icon: Package,
                          color: "bg-gray-500"
                        };
                        const Icon = config.icon;
                        
                        return (
                          <TableRow key={tx.id} data-testid={`row-transaction-${tx.id}`}>
                            <TableCell className="text-sm text-muted-foreground">
                              {format(new Date(tx.createdAt), "MMM d, h:mm a")}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <div className={cn("p-1 rounded", config.color)}>
                                  <Icon className="h-3 w-3 text-white" />
                                </div>
                                <span className="text-sm font-medium">{config.label}</span>
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                <span className="font-mono text-sm">{tx.product?.baseSku || "-"}</span>
                                <span className="text-xs text-muted-foreground truncate max-w-48">
                                  {tx.product?.name}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell>
                              {getLocationDisplay(tx)}
                            </TableCell>
                            <TableCell>
                              {tx.sourceState && tx.targetState && tx.sourceState !== tx.targetState ? (
                                <div className="flex items-center gap-1">
                                  <Badge variant="outline" className={cn("text-xs", stateColors[tx.sourceState] || "")}>
                                    {tx.sourceState}
                                  </Badge>
                                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                                  <Badge variant="outline" className={cn("text-xs", stateColors[tx.targetState] || "")}>
                                    {tx.targetState}
                                  </Badge>
                                </div>
                              ) : tx.targetState ? (
                                <Badge variant="outline" className={cn("text-xs", stateColors[tx.targetState] || "")}>
                                  {tx.targetState}
                                </Badge>
                              ) : (
                                <span className="text-muted-foreground">-</span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <span className={cn(
                                "font-mono font-medium",
                                tx.variantQtyDelta > 0 ? "text-green-600" : 
                                tx.variantQtyDelta < 0 ? "text-red-600" : "text-muted-foreground"
                              )}>
                                {tx.variantQtyDelta > 0 ? "+" : ""}{tx.variantQtyDelta}
                              </span>
                            </TableCell>
                            <TableCell>
                              <div className="flex flex-col">
                                {tx.referenceId && (
                                  <span className="font-mono text-xs">{tx.referenceId}</span>
                                )}
                                {tx.orderId && (
                                  <span className="text-xs text-muted-foreground">Order #{tx.orderId}</span>
                                )}
                                {tx.notes && (
                                  <span className="text-xs text-muted-foreground truncate max-w-32" title={tx.notes}>
                                    {tx.notes}
                                  </span>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {tx.userId || "-"}
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
              
              <div className="flex flex-col md:flex-row items-center justify-between p-3 md:p-4 border-t gap-3">
                <div className="text-xs md:text-sm text-muted-foreground">
                  Showing {filteredTransactions.length} transactions
                </div>
                <div className="flex items-center gap-2 w-full md:w-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    data-testid="button-prev-page"
                    className="min-h-[44px] flex-1 md:flex-none"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="hidden sm:inline ml-1">Previous</span>
                  </Button>
                  <span className="text-sm text-muted-foreground">Page {page + 1}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage(p => p + 1)}
                    disabled={transactions.length < limit}
                    data-testid="button-next-page"
                    className="min-h-[44px] flex-1 md:flex-none"
                  >
                    <span className="hidden sm:inline mr-1">Next</span>
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
