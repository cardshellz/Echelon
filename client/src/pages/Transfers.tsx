import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { ArrowRight, ArrowLeftRight, Undo2, Check, ChevronLeft, ChevronRight, Search, Package, MapPin, ScanLine, Loader2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { format } from "date-fns";
import { playSoundWithHaptic } from "@/lib/sounds";

interface Transfer {
  id: number;
  fromLocation: string;
  toLocation: string;
  sku: string;
  productName: string;
  quantity: number;
  userId: string;
  createdAt: string;
  canUndo: boolean;
}

interface WarehouseLocation {
  id: number;
  code: string;
  zone?: string;
  locationType?: string;
}

interface SkuResult {
  sku: string;
  name: string;
  variantId: number;
  available: number;
  locationId?: number;
  location?: string;
}

type MobileStep = "source" | "sku" | "quantity" | "destination" | "confirm";

export default function Transfers() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [isMobile, setIsMobile] = useState(false);
  
  // Desktop form state
  const [fromLocationId, setFromLocationId] = useState<number | null>(null);
  const [toLocationId, setToLocationId] = useState<number | null>(null);
  const [variantId, setVariantId] = useState<number | null>(null);
  const [quantity, setQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [skuSearch, setSkuSearch] = useState("");
  const [skuDropdownOpen, setSkuDropdownOpen] = useState(false);
  const [locationSearch, setLocationSearch] = useState("");
  const [destLocationSearch, setDestLocationSearch] = useState("");
  
  // Mobile wizard state
  const [mobileStep, setMobileStep] = useState<MobileStep>("source");
  const [sourceLocationCode, setSourceLocationCode] = useState("");
  const [destLocationCode, setDestLocationCode] = useState("");
  const [selectedSku, setSelectedSku] = useState<SkuResult | null>(null);
  const [mobileQuantity, setMobileQuantity] = useState("");
  
  useEffect(() => {
    const checkMobile = () => setIsMobile(window.innerWidth < 768);
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);
  
  const { data: transfers = [], isLoading: transfersLoading } = useQuery<Transfer[]>({
    queryKey: ["/api/inventory/transfers"],
    refetchInterval: 10000
  });
  
  const { data: locations = [] } = useQuery<WarehouseLocation[]>({
    queryKey: ["/api/warehouse/locations"]
  });
  
  const { data: skuResults = [] } = useQuery<SkuResult[]>({
    queryKey: ["/api/inventory/skus/search", skuSearch, fromLocationId],
    queryFn: async () => {
      if (!skuSearch || skuSearch.length < 2) return [];
      const params = new URLSearchParams({ q: skuSearch });
      if (fromLocationId) params.append("locationId", fromLocationId.toString());
      const res = await fetch(`/api/inventory/skus/search?${params}`);
      return res.json();
    },
    enabled: skuSearch.length >= 2
  });
  
  const { data: skusAtLocation = [] } = useQuery<SkuResult[]>({
    queryKey: ["/api/inventory/skus/search", "location", fromLocationId],
    queryFn: async () => {
      if (!fromLocationId) return [];
      const res = await fetch(`/api/inventory/skus/search?locationId=${fromLocationId}&limit=50`);
      return res.json();
    },
    enabled: !!fromLocationId
  });
  
  const transferMutation = useMutation({
    mutationFn: async (data: { fromLocationId: number; toLocationId: number; variantId: number; quantity: number; notes?: string }) => {
      const res = await apiRequest("POST", "/api/inventory/transfer", data);
      return res.json();
    },
    onSuccess: () => {
      playSoundWithHaptic("success", "classic", true);
      toast({ title: "Transfer Complete", description: "Inventory moved successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
      resetForm();
    },
    onError: (error: Error) => {
      playSoundWithHaptic("error", "error", true);
      toast({ title: "Transfer Failed", description: error.message, variant: "destructive" });
    }
  });
  
  const undoMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/inventory/transfer/${id}/undo`, {});
      return res.json();
    },
    onSuccess: () => {
      playSoundWithHaptic("success", "classic", true);
      toast({ title: "Transfer Undone", description: "Inventory restored to original location" });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/transfers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory/levels"] });
    },
    onError: (error: Error) => {
      toast({ title: "Undo Failed", description: error.message, variant: "destructive" });
    }
  });
  
  const resetForm = () => {
    setFromLocationId(null);
    setToLocationId(null);
    setVariantId(null);
    setQuantity("");
    setNotes("");
    setSkuSearch("");
    setLocationSearch("");
    setDestLocationSearch("");
    setMobileStep("source");
    setSourceLocationCode("");
    setDestLocationCode("");
    setSelectedSku(null);
    setMobileQuantity("");
  };
  
  const filteredLocations = locations.filter(loc => 
    loc.code.toLowerCase().includes(locationSearch.toLowerCase())
  );
  
  const filteredDestLocations = locations.filter(loc => 
    loc.code.toLowerCase().includes(destLocationSearch.toLowerCase()) && loc.id !== fromLocationId
  );
  
  const handleDesktopSubmit = () => {
    if (!fromLocationId || !toLocationId || !variantId || !quantity) {
      toast({ title: "Missing Fields", description: "Please fill all required fields", variant: "destructive" });
      return;
    }
    transferMutation.mutate({
      fromLocationId,
      toLocationId,
      variantId,
      quantity: parseInt(quantity),
      notes: notes || undefined
    });
  };
  
  const handleMobileSubmit = () => {
    const sourceLoc = locations.find(l => l.code.toUpperCase() === sourceLocationCode.toUpperCase());
    const destLoc = locations.find(l => l.code.toUpperCase() === destLocationCode.toUpperCase());
    
    if (!sourceLoc || !destLoc || !selectedSku || !mobileQuantity) {
      toast({ title: "Missing Fields", description: "Please complete all steps", variant: "destructive" });
      return;
    }
    
    transferMutation.mutate({
      fromLocationId: sourceLoc.id,
      toLocationId: destLoc.id,
      variantId: selectedSku.variantId,
      quantity: parseInt(mobileQuantity)
    });
  };
  
  if (isMobile) {
    return (
      <div className="min-h-screen bg-slate-50 p-4">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" />
            Transfer
          </h1>
          <Badge variant="outline">{mobileStep}</Badge>
        </div>
        
        <Card className="mb-4">
          <CardContent className="pt-4">
            {mobileStep === "source" && (
              <div className="space-y-4">
                <Label className="text-lg font-semibold">Scan Source Bin</Label>
                <p className="text-sm text-muted-foreground">Scan or enter the bin you're moving FROM</p>
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    value={sourceLocationCode}
                    onChange={(e) => setSourceLocationCode(e.target.value.toUpperCase())}
                    placeholder="A-01-01"
                    className="pl-10 h-14 text-xl text-center uppercase"
                    autoFocus
                    data-testid="input-source-location"
                  />
                </div>
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!sourceLocationCode || !locations.find(l => l.code.toUpperCase() === sourceLocationCode)}
                  onClick={() => {
                    const loc = locations.find(l => l.code.toUpperCase() === sourceLocationCode);
                    if (loc) {
                      setFromLocationId(loc.id);
                      playSoundWithHaptic("success", "classic", true);
                      setMobileStep("sku");
                    }
                  }}
                  data-testid="button-next-source"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "sku" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Select SKU</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("source")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">Items in bin {sourceLocationCode}:</p>
                
                <Input
                  value={skuSearch}
                  onChange={(e) => setSkuSearch(e.target.value)}
                  placeholder="Search SKU..."
                  className="h-12"
                  data-testid="input-search-sku"
                />
                
                <div className="max-h-[300px] overflow-y-auto space-y-2">
                  {(skuSearch ? skuResults : skusAtLocation).map((item) => (
                    <button
                      key={item.sku}
                      type="button"
                      className={`w-full p-3 text-left rounded-lg border transition-colors ${
                        selectedSku?.sku === item.sku 
                          ? "border-primary bg-primary/10" 
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                      onClick={() => {
                        setSelectedSku(item);
                        setVariantId(item.variantId);
                        playSoundWithHaptic("tap", "classic", true);
                      }}
                      data-testid={`button-select-sku-${item.sku}`}
                    >
                      <div className="font-medium">{item.sku}</div>
                      <div className="text-sm text-muted-foreground truncate">{item.name}</div>
                      <div className="text-sm text-green-600">Available: {item.available}</div>
                    </button>
                  ))}
                  {skusAtLocation.length === 0 && !skuSearch && (
                    <p className="text-center text-muted-foreground py-4">No items in this bin</p>
                  )}
                </div>
                
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!selectedSku}
                  onClick={() => {
                    playSoundWithHaptic("success", "classic", true);
                    setMobileStep("quantity");
                  }}
                  data-testid="button-next-sku"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "quantity" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Enter Quantity</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("sku")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <div className="bg-slate-100 rounded-lg p-3">
                  <p className="font-medium">{selectedSku?.sku}</p>
                  <p className="text-sm text-muted-foreground">{selectedSku?.name}</p>
                  <p className="text-sm text-green-600">Available: {selectedSku?.available}</p>
                </div>
                
                <Input
                  type="number"
                  value={mobileQuantity}
                  onChange={(e) => setMobileQuantity(e.target.value)}
                  placeholder="0"
                  className="h-20 text-4xl text-center"
                  max={selectedSku?.available}
                  min={1}
                  autoFocus
                  data-testid="input-quantity"
                />
                
                <div className="grid grid-cols-3 gap-2">
                  {[1, 5, 10].map(n => (
                    <Button
                      key={n}
                      variant="outline"
                      onClick={() => setMobileQuantity(String(Math.min(n, selectedSku?.available || n)))}
                    >
                      {n}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    className="col-span-3"
                    onClick={() => setMobileQuantity(String(selectedSku?.available || 0))}
                  >
                    All ({selectedSku?.available})
                  </Button>
                </div>
                
                <Button
                  className="w-full h-14 text-lg"
                  disabled={!mobileQuantity || parseInt(mobileQuantity) <= 0 || parseInt(mobileQuantity) > (selectedSku?.available || 0)}
                  onClick={() => {
                    playSoundWithHaptic("success", "classic", true);
                    setMobileStep("destination");
                  }}
                  data-testid="button-next-quantity"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Next
                </Button>
              </div>
            )}
            
            {mobileStep === "destination" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Scan Destination Bin</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("quantity")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground">Scan or enter the bin you're moving TO</p>
                
                <div className="relative">
                  <ScanLine className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
                  <Input
                    value={destLocationCode}
                    onChange={(e) => setDestLocationCode(e.target.value.toUpperCase())}
                    placeholder="B-02-03"
                    className="pl-10 h-14 text-xl text-center uppercase"
                    autoFocus
                    data-testid="input-dest-location"
                  />
                </div>
                
                {destLocationCode && destLocationCode.toUpperCase() === sourceLocationCode.toUpperCase() && (
                  <p className="text-sm text-red-500">Destination must be different from source</p>
                )}
                
                <Button
                  className="w-full h-14 text-lg"
                  disabled={
                    !destLocationCode || 
                    !locations.find(l => l.code.toUpperCase() === destLocationCode) ||
                    destLocationCode.toUpperCase() === sourceLocationCode.toUpperCase()
                  }
                  onClick={() => {
                    const loc = locations.find(l => l.code.toUpperCase() === destLocationCode);
                    if (loc) {
                      setToLocationId(loc.id);
                      playSoundWithHaptic("success", "classic", true);
                      setMobileStep("confirm");
                    }
                  }}
                  data-testid="button-next-dest"
                >
                  <ChevronRight className="h-5 w-5 mr-2" />
                  Review
                </Button>
              </div>
            )}
            
            {mobileStep === "confirm" && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label className="text-lg font-semibold">Confirm Transfer</Label>
                  <Button variant="ghost" size="sm" onClick={() => setMobileStep("destination")}>
                    <ChevronLeft className="h-4 w-4 mr-1" /> Back
                  </Button>
                </div>
                
                <div className="bg-slate-100 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">From:</span>
                    <Badge variant="outline" className="text-lg px-3 py-1">{sourceLocationCode}</Badge>
                  </div>
                  <div className="flex justify-center">
                    <ArrowRight className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">To:</span>
                    <Badge variant="outline" className="text-lg px-3 py-1">{destLocationCode}</Badge>
                  </div>
                  <hr />
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">SKU:</span>
                    <span className="font-medium">{selectedSku?.sku}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Quantity:</span>
                    <span className="font-bold text-xl">{mobileQuantity}</span>
                  </div>
                </div>
                
                <Button
                  className="w-full h-16 text-xl bg-green-600 hover:bg-green-700"
                  onClick={handleMobileSubmit}
                  disabled={transferMutation.isPending}
                  data-testid="button-confirm-transfer"
                >
                  {transferMutation.isPending ? (
                    <Loader2 className="h-6 w-6 animate-spin mr-2" />
                  ) : (
                    <Check className="h-6 w-6 mr-2" />
                  )}
                  Confirm Transfer
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        
        {transfers.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Recent Transfers</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {transfers.slice(0, 5).map((t) => (
                <div key={t.id} className="flex items-center justify-between p-2 bg-slate-50 rounded text-sm">
                  <div>
                    <div className="font-medium">{t.sku}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.fromLocation} → {t.toLocation} ({t.quantity})
                    </div>
                  </div>
                  {t.canUndo && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => undoMutation.mutate(t.id)}
                      disabled={undoMutation.isPending}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    );
  }
  
  return (
    <div className="container mx-auto py-6 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <ArrowLeftRight className="h-6 w-6" />
          Inventory Transfers
        </h1>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>New Transfer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Source Location</Label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={locationSearch}
                  onChange={(e) => {
                    setLocationSearch(e.target.value);
                    const match = locations.find(l => l.code.toLowerCase() === e.target.value.toLowerCase());
                    if (match) setFromLocationId(match.id);
                  }}
                  placeholder="Search bin location..."
                  className="pl-10"
                  data-testid="input-source-search"
                />
              </div>
              {locationSearch && filteredLocations.length > 0 && !fromLocationId && (
                <div className="border rounded-md max-h-32 overflow-y-auto">
                  {filteredLocations.slice(0, 10).map(loc => (
                    <button
                      key={loc.id}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-100 text-sm"
                      onClick={() => {
                        setFromLocationId(loc.id);
                        setLocationSearch(loc.code);
                      }}
                    >
                      {loc.code} {loc.zone && <span className="text-muted-foreground">({loc.zone})</span>}
                    </button>
                  ))}
                </div>
              )}
              {fromLocationId && (
                <Badge variant="secondary">
                  Selected: {locations.find(l => l.id === fromLocationId)?.code}
                </Badge>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>SKU</Label>
              <div className="relative">
                <Package className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={skuSearch}
                  onChange={(e) => {
                    setSkuSearch(e.target.value);
                    setSkuDropdownOpen(true);
                  }}
                  onFocus={() => setSkuDropdownOpen(true)}
                  placeholder="Search SKU..."
                  className="pl-10"
                  data-testid="input-sku-search"
                />
                {skuDropdownOpen && skuResults.length > 0 && (
                  <div className="absolute z-50 w-full mt-1 bg-white border rounded-md shadow-lg max-h-48 overflow-y-auto">
                    {skuResults.map((result) => (
                      <button
                        key={result.sku}
                        type="button"
                        className="w-full px-3 py-2 text-left hover:bg-slate-100 border-b last:border-b-0"
                        onClick={() => {
                          setSkuSearch(result.sku);
                          setVariantId(result.variantId);
                          setSkuDropdownOpen(false);
                        }}
                      >
                        <div className="font-medium">{result.sku}</div>
                        <div className="text-xs text-muted-foreground truncate">{result.name}</div>
                        <div className="text-xs text-green-600">Available: {result.available}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {variantId && (
                <Badge variant="secondary">
                  Selected: {skuSearch}
                </Badge>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>Quantity</Label>
              <Input
                type="number"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                min={1}
                data-testid="input-desktop-quantity"
              />
            </div>
            
            <div className="space-y-2">
              <Label>Destination Location</Label>
              <div className="relative">
                <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={destLocationSearch}
                  onChange={(e) => {
                    setDestLocationSearch(e.target.value);
                    const match = locations.find(l => l.code.toLowerCase() === e.target.value.toLowerCase());
                    if (match && match.id !== fromLocationId) setToLocationId(match.id);
                  }}
                  placeholder="Search destination..."
                  className="pl-10"
                  data-testid="input-dest-search"
                />
              </div>
              {destLocationSearch && filteredDestLocations.length > 0 && !toLocationId && (
                <div className="border rounded-md max-h-32 overflow-y-auto">
                  {filteredDestLocations.slice(0, 10).map(loc => (
                    <button
                      key={loc.id}
                      type="button"
                      className="w-full px-3 py-2 text-left hover:bg-slate-100 text-sm"
                      onClick={() => {
                        setToLocationId(loc.id);
                        setDestLocationSearch(loc.code);
                      }}
                    >
                      {loc.code} {loc.zone && <span className="text-muted-foreground">({loc.zone})</span>}
                    </button>
                  ))}
                </div>
              )}
              {toLocationId && (
                <Badge variant="secondary">
                  Selected: {locations.find(l => l.id === toLocationId)?.code}
                </Badge>
              )}
            </div>
            
            <div className="space-y-2">
              <Label>Notes (Optional)</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Reason for transfer..."
                rows={2}
                data-testid="input-notes"
              />
            </div>
            
            <Button
              className="w-full"
              onClick={handleDesktopSubmit}
              disabled={!fromLocationId || !toLocationId || !variantId || !quantity || transferMutation.isPending}
              data-testid="button-desktop-transfer"
            >
              {transferMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <ArrowRight className="h-4 w-4 mr-2" />
              )}
              Move Inventory
            </Button>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader>
            <CardTitle>Recent Transfers</CardTitle>
          </CardHeader>
          <CardContent>
            {transfersLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : transfers.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No transfers yet</p>
            ) : (
              <div className="space-y-3 max-h-[500px] overflow-y-auto">
                {transfers.map((t) => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between p-3 bg-slate-50 rounded-lg"
                    data-testid={`transfer-row-${t.id}`}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{t.fromLocation}</Badge>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                        <Badge variant="outline">{t.toLocation}</Badge>
                      </div>
                      <div className="mt-1">
                        <span className="font-medium">{t.sku}</span>
                        <span className="text-muted-foreground ml-2">x{t.quantity}</span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {format(new Date(t.createdAt), "MMM d, h:mm a")} by {t.userId}
                      </div>
                    </div>
                    {t.canUndo && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => undoMutation.mutate(t.id)}
                        disabled={undoMutation.isPending}
                        data-testid={`button-undo-${t.id}`}
                      >
                        <Undo2 className="h-4 w-4 mr-1" />
                        Undo
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
