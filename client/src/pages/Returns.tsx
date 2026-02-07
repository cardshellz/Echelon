import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { RotateCcw, Search, Package, AlertCircle } from "lucide-react";

interface OrderLookup {
  order: {
    id: number;
    orderNumber: string;
    customerName: string | null;
    customerEmail: string | null;
    orderPlacedAt: string | null;
    warehouseStatus: string | null;
    financialStatus: string | null;
    itemCount: number | null;
    totalAmount: number | null;
  };
  items: Array<{
    id: number;
    sku: string | null;
    name: string | null;
    quantity: number;
    pickedQuantity: number | null;
    fulfilledQuantity: number | null;
    status: string | null;
    productVariantId: number | null;
  }>;
  returnHistory: Array<{
    orderItemId: number;
    sku: string;
    qty: number;
    condition: string;
    returnedAt: string;
  }>;
}

interface WarehouseLocation {
  id: number;
  code: string;
  zone: string | null;
  name: string | null;
}

interface ReturnItemState {
  selected: boolean;
  qty: number;
  condition: "sellable" | "damaged" | "defective";
  reason: string;
}

export default function Returns() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [returnItems, setReturnItems] = useState<Record<number, ReturnItemState>>({});
  const [locationId, setLocationId] = useState<string>("");
  const [notes, setNotes] = useState("");

  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"],
  });

  const {
    data: lookupData,
    isLoading: lookupLoading,
    error: lookupError,
  } = useQuery<OrderLookup>({
    queryKey: ["/api/returns/order-lookup", orderNumber],
    queryFn: async () => {
      const res = await fetch(`/api/returns/order-lookup/${encodeURIComponent(orderNumber!)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Order not found");
      }
      return res.json();
    },
    enabled: !!orderNumber,
  });

  // When lookup data arrives, initialize return item states
  const initReturnItems = (items: OrderLookup["items"], history: OrderLookup["returnHistory"]) => {
    const states: Record<number, ReturnItemState> = {};
    for (const item of items) {
      const alreadyReturned = history
        .filter((h) => h.orderItemId === item.id)
        .reduce((sum, h) => sum + h.qty, 0);
      const maxReturnable = item.quantity - alreadyReturned;
      states[item.id] = {
        selected: false,
        qty: Math.max(0, maxReturnable),
        condition: "sellable",
        reason: "",
      };
    }
    return states;
  };

  const handleSearch = () => {
    const trimmed = searchInput.trim();
    if (!trimmed) return;
    setOrderNumber(trimmed);
    setReturnItems({});
    setLocationId("");
    setNotes("");
  };

  // Initialize return items when data loads
  if (lookupData && Object.keys(returnItems).length === 0) {
    setReturnItems(initReturnItems(lookupData.items, lookupData.returnHistory));
  }

  const processReturnMutation = useMutation({
    mutationFn: async (body: {
      orderId: number;
      items: Array<{ orderItemId: number; productVariantId: number; qty: number; condition: string; reason?: string }>;
      warehouseLocationId: number;
      notes?: string;
    }) => {
      const res = await fetch("/api/returns/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to process return");
      }
      return res.json();
    },
    onSuccess: (result) => {
      toast({
        title: "Return processed",
        description: `${result.processed} item(s) returned — ${result.sellable} sellable, ${result.damaged} damaged/defective`,
      });
      // Refresh order lookup to show updated return history
      queryClient.invalidateQueries({ queryKey: ["/api/returns/order-lookup", orderNumber] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      setReturnItems({});
      setNotes("");
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  const handleProcessReturn = () => {
    if (!lookupData || !locationId) return;

    const selectedItems = Object.entries(returnItems)
      .filter(([, state]) => state.selected && state.qty > 0)
      .map(([itemId, state]) => {
        const item = lookupData.items.find((i) => i.id === Number(itemId));
        return {
          orderItemId: Number(itemId),
          productVariantId: item?.productVariantId ?? 0,
          qty: state.qty,
          condition: state.condition,
          reason: state.reason || undefined,
        };
      })
      .filter((i) => i.productVariantId > 0);

    if (selectedItems.length === 0) {
      toast({ title: "No items selected", description: "Select at least one item to return", variant: "destructive" });
      return;
    }

    processReturnMutation.mutate({
      orderId: lookupData.order.id,
      items: selectedItems,
      warehouseLocationId: parseInt(locationId),
      notes: notes || undefined,
    });
  };

  const selectedCount = Object.values(returnItems).filter((s) => s.selected && s.qty > 0).length;
  const hasItemsWithoutVariant = lookupData?.items.some(
    (item) => returnItems[item.id]?.selected && !item.productVariantId,
  );

  const getAlreadyReturned = (itemId: number) => {
    if (!lookupData) return 0;
    return lookupData.returnHistory
      .filter((h) => h.orderItemId === itemId)
      .reduce((sum, h) => sum + h.qty, 0);
  };

  return (
    <div className="p-2 md:p-6 space-y-4 md:space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
          <RotateCcw className="h-5 w-5 md:h-6 md:w-6" />
          Returns
        </h1>
        <p className="text-sm text-muted-foreground">
          Process customer returns and restock inventory
        </p>
      </div>

      {/* Order Search */}
      <Card>
        <CardContent className="p-3 md:p-4">
          <div className="flex gap-2">
            <Input
              placeholder="Enter order number..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              className="h-11 flex-1"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button
              onClick={handleSearch}
              disabled={!searchInput.trim() || lookupLoading}
              className="min-h-[44px]"
            >
              <Search className="h-4 w-4 mr-2" />
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Loading */}
      {lookupLoading && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Looking up order...
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {lookupError && (
        <Card>
          <CardContent className="p-4 flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            {(lookupError as Error).message}
          </CardContent>
        </Card>
      )}

      {/* Order Info */}
      {lookupData && (
        <>
          <Card>
            <CardHeader className="p-3 md:p-4 pb-2">
              <CardTitle className="text-base md:text-lg flex items-center gap-2">
                <Package className="h-4 w-4" />
                Order {lookupData.order.orderNumber}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 md:p-4 pt-0">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <span className="text-muted-foreground">Customer</span>
                  <div className="font-medium">{lookupData.order.customerName || "N/A"}</div>
                </div>
                <div>
                  <span className="text-muted-foreground">Date</span>
                  <div className="font-medium">
                    {lookupData.order.orderPlacedAt
                      ? format(new Date(lookupData.order.orderPlacedAt), "MMM d, yyyy")
                      : "N/A"}
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Status</span>
                  <div>
                    <Badge variant="outline">{lookupData.order.warehouseStatus || "unknown"}</Badge>
                  </div>
                </div>
                <div>
                  <span className="text-muted-foreground">Total</span>
                  <div className="font-medium">
                    {lookupData.order.totalAmount != null
                      ? `$${(Number(lookupData.order.totalAmount) / 100).toFixed(2)}`
                      : "N/A"}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Return Items */}
          <Card>
            <CardHeader className="p-3 md:p-4 pb-2">
              <CardTitle className="text-base">Select Items to Return</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {/* Mobile card view */}
              <div className="md:hidden p-2 space-y-2">
                {lookupData.items.map((item) => {
                  const state = returnItems[item.id];
                  if (!state) return null;
                  const alreadyReturned = getAlreadyReturned(item.id);
                  const maxReturnable = item.quantity - alreadyReturned;

                  return (
                    <Card key={item.id} className="border">
                      <CardContent className="p-3 space-y-2">
                        <div className="flex items-start gap-3">
                          <Checkbox
                            checked={state.selected}
                            onCheckedChange={(checked) =>
                              setReturnItems((prev) => ({
                                ...prev,
                                [item.id]: { ...prev[item.id], selected: !!checked },
                              }))
                            }
                            disabled={maxReturnable <= 0}
                            className="mt-1"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-sm font-medium truncate">{item.sku || "-"}</div>
                            <div className="text-xs text-muted-foreground truncate">{item.name || "-"}</div>
                            <div className="flex gap-3 text-xs mt-1">
                              <span>Ordered: {item.quantity}</span>
                              {alreadyReturned > 0 && (
                                <span className="text-orange-600">Returned: {alreadyReturned}</span>
                              )}
                            </div>
                            {!item.productVariantId && (
                              <div className="text-xs text-orange-600 mt-1">SKU not matched to inventory</div>
                            )}
                          </div>
                        </div>
                        {state.selected && maxReturnable > 0 && (
                          <div className="pl-7 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <div>
                                <Label className="text-xs">Qty</Label>
                                <Input
                                  type="number"
                                  inputMode="numeric"
                                  value={state.qty}
                                  onChange={(e) =>
                                    setReturnItems((prev) => ({
                                      ...prev,
                                      [item.id]: {
                                        ...prev[item.id],
                                        qty: Math.min(Math.max(0, parseInt(e.target.value) || 0), maxReturnable),
                                      },
                                    }))
                                  }
                                  min={0}
                                  max={maxReturnable}
                                  className="h-10"
                                  autoComplete="off"
                                />
                              </div>
                              <div>
                                <Label className="text-xs">Condition</Label>
                                <Select
                                  value={state.condition}
                                  onValueChange={(v) =>
                                    setReturnItems((prev) => ({
                                      ...prev,
                                      [item.id]: { ...prev[item.id], condition: v as any },
                                    }))
                                  }
                                >
                                  <SelectTrigger className="h-10">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="sellable">Sellable</SelectItem>
                                    <SelectItem value="damaged">Damaged</SelectItem>
                                    <SelectItem value="defective">Defective</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </div>
                            <div>
                              <Label className="text-xs">Reason (optional)</Label>
                              <Input
                                value={state.reason}
                                onChange={(e) =>
                                  setReturnItems((prev) => ({
                                    ...prev,
                                    [item.id]: { ...prev[item.id], reason: e.target.value },
                                  }))
                                }
                                placeholder="Reason for return..."
                                className="h-10"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                              />
                            </div>
                          </div>
                        )}
                        {maxReturnable <= 0 && (
                          <div className="pl-7 text-xs text-muted-foreground">Fully returned</div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>

              {/* Desktop table view */}
              <Table className="hidden md:table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Ordered</TableHead>
                    <TableHead>Returned</TableHead>
                    <TableHead>Return Qty</TableHead>
                    <TableHead>Condition</TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lookupData.items.map((item) => {
                    const state = returnItems[item.id];
                    if (!state) return null;
                    const alreadyReturned = getAlreadyReturned(item.id);
                    const maxReturnable = item.quantity - alreadyReturned;

                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          <Checkbox
                            checked={state.selected}
                            onCheckedChange={(checked) =>
                              setReturnItems((prev) => ({
                                ...prev,
                                [item.id]: { ...prev[item.id], selected: !!checked },
                              }))
                            }
                            disabled={maxReturnable <= 0}
                          />
                        </TableCell>
                        <TableCell className="font-mono whitespace-nowrap">
                          {item.sku || "-"}
                          {!item.productVariantId && (
                            <div className="text-xs text-orange-600">No variant match</div>
                          )}
                        </TableCell>
                        <TableCell>{item.name || "-"}</TableCell>
                        <TableCell>{item.quantity}</TableCell>
                        <TableCell>
                          {alreadyReturned > 0 ? (
                            <span className="text-orange-600">{alreadyReturned}</span>
                          ) : (
                            "0"
                          )}
                        </TableCell>
                        <TableCell>
                          {maxReturnable > 0 ? (
                            <Input
                              type="number"
                              value={state.qty}
                              onChange={(e) =>
                                setReturnItems((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...prev[item.id],
                                    qty: Math.min(Math.max(0, parseInt(e.target.value) || 0), maxReturnable),
                                  },
                                }))
                              }
                              min={0}
                              max={maxReturnable}
                              className="w-20 h-10"
                              disabled={!state.selected}
                              autoComplete="off"
                            />
                          ) : (
                            <span className="text-muted-foreground text-sm">Full</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {maxReturnable > 0 && (
                            <Select
                              value={state.condition}
                              onValueChange={(v) =>
                                setReturnItems((prev) => ({
                                  ...prev,
                                  [item.id]: { ...prev[item.id], condition: v as any },
                                }))
                              }
                              disabled={!state.selected}
                            >
                              <SelectTrigger className="w-28 h-10">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="sellable">Sellable</SelectItem>
                                <SelectItem value="damaged">Damaged</SelectItem>
                                <SelectItem value="defective">Defective</SelectItem>
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell>
                          {maxReturnable > 0 && (
                            <Input
                              value={state.reason}
                              onChange={(e) =>
                                setReturnItems((prev) => ({
                                  ...prev,
                                  [item.id]: { ...prev[item.id], reason: e.target.value },
                                }))
                              }
                              placeholder="Optional..."
                              className="w-40 h-10"
                              disabled={!state.selected}
                              autoComplete="off"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {/* Return Options */}
          <Card>
            <CardContent className="p-3 md:p-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <Label className="text-sm">Putback Location *</Label>
                  <Select value={locationId} onValueChange={setLocationId}>
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder="Select location..." />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((loc) => (
                        <SelectItem key={loc.id} value={loc.id.toString()}>
                          {loc.code}{loc.name ? ` — ${loc.name}` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-sm">Notes (optional)</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Return notes..."
                    className="min-h-[44px]"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              {hasItemsWithoutVariant && (
                <div className="flex items-center gap-2 text-sm text-orange-600">
                  <AlertCircle className="h-4 w-4" />
                  Some selected items don't have a matched inventory variant and will be skipped.
                </div>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={handleProcessReturn}
                  disabled={selectedCount === 0 || !locationId || processReturnMutation.isPending}
                  className="min-h-[44px]"
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Process Return ({selectedCount} item{selectedCount !== 1 ? "s" : ""})
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Return History */}
          {lookupData.returnHistory.length > 0 && (
            <Card>
              <CardHeader className="p-3 md:p-4 pb-2">
                <CardTitle className="text-base">Return History</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {/* Mobile card view */}
                <div className="md:hidden p-2 space-y-2">
                  {lookupData.returnHistory.map((entry, i) => (
                    <Card key={i} className="border">
                      <CardContent className="p-3">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-sm">{entry.sku}</span>
                          <Badge
                            variant={
                              entry.condition === "sellable"
                                ? "default"
                                : entry.condition === "damaged"
                                  ? "destructive"
                                  : "secondary"
                            }
                            className="text-xs"
                          >
                            {entry.condition}
                          </Badge>
                        </div>
                        <div className="flex justify-between text-xs text-muted-foreground mt-1">
                          <span>Qty: {entry.qty}</span>
                          <span>{format(new Date(entry.returnedAt), "MMM d, yyyy h:mm a")}</span>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Desktop table view */}
                <Table className="hidden md:table">
                  <TableHeader>
                    <TableRow>
                      <TableHead>SKU</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Condition</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lookupData.returnHistory.map((entry, i) => (
                      <TableRow key={i}>
                        <TableCell className="font-mono">{entry.sku}</TableCell>
                        <TableCell>{entry.qty}</TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              entry.condition === "sellable"
                                ? "default"
                                : entry.condition === "damaged"
                                  ? "destructive"
                                  : "secondary"
                            }
                          >
                            {entry.condition}
                          </Badge>
                        </TableCell>
                        <TableCell>{format(new Date(entry.returnedAt), "MMM d, yyyy h:mm a")}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
