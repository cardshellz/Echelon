import React, { useState } from "react";
import { 
  Scan, 
  CheckCircle2, 
  Box, 
  ArrowRight, 
  AlertTriangle,
  PackageCheck,
  Printer,
  ChevronRight,
  MapPin,
  XCircle,
  AlertOctagon,
  Package,
  HelpCircle,
  Camera
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  RadioGroup,
  RadioGroupItem,
} from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

// Mock "Pick List" Data
const batchPickData = {
  id: "BATCH-4921",
  type: "Batch Pick",
  assignedTo: "John Doe",
  totalItems: 12,
  completedItems: 7,
  source: "Shopify",
  zones: ["A-01", "B-12"],
  items: [
    { id: 1, sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02-B", qty: 2, picked: 2, status: "completed", orderId: "#1024", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
    { id: 2, sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "A-01-04-A", qty: 1, picked: 1, status: "completed", orderId: "#1025", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
    { id: 3, sku: "NB-990-NVY", name: "New Balance 990v5", location: "B-12-01-C", qty: 3, picked: 0, status: "pending", orderId: "#1026", image: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=100&q=80" },
    { id: 4, sku: "PM-102-GRY", name: "Puma RS-X", location: "B-12-04-D", qty: 1, picked: 0, status: "pending", orderId: "#1024", image: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=100&q=80" },
  ]
};

const singlePickData = {
  id: "ORD-1029",
  type: "Single Order",
  assignedTo: "John Doe",
  totalItems: 1,
  completedItems: 0,
  source: "Shopify",
  zones: ["A-01"],
  items: [
    { id: 5, sku: "NK-292-RED", name: "Nike Air Max 90 Red", location: "A-01-02-A", qty: 1, picked: 0, status: "pending", orderId: "#1029", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
  ]
};

export default function Picking() {
  const [pickMode, setPickMode] = useState<"batch" | "single">("batch");
  const [workflowMode, setWorkflowMode] = useState<"solo" | "enterprise">("solo");
  const [scanInput, setScanInput] = useState("");
  const [step, setStep] = useState<"pick" | "pack_ship">("pick");
  const [shortPickOpen, setShortPickOpen] = useState(false);
  const [shortPickReason, setShortPickReason] = useState("");
  const [shortPickQty, setShortPickQty] = useState("0");
  const [shortPickNotes, setShortPickNotes] = useState("");
  const [shortPickSubmitted, setShortPickSubmitted] = useState(false);
  const [multiQtyConfirmOpen, setMultiQtyConfirmOpen] = useState(false);
  const [scanConfirmed, setScanConfirmed] = useState(false);
  
  const activeData = pickMode === "batch" ? batchPickData : singlePickData;
  const currentItem = activeData.items[pickMode === "batch" ? 2 : 0];

  const handleScan = (value: string) => {
    setScanInput(value);
    if (value.toUpperCase() === currentItem.sku.replace(/-/g, "").toUpperCase() || 
        value.toUpperCase() === currentItem.sku.toUpperCase()) {
      // Valid scan - check if multi-quantity
      if (currentItem.qty > 1) {
        setMultiQtyConfirmOpen(true);
      } else {
        // Single item - auto confirm
        setScanConfirmed(true);
        setTimeout(() => {
          handleAction();
          setScanConfirmed(false);
          setScanInput("");
        }, 600);
      }
    }
  };

  const handleMultiQtyConfirm = (confirmAll: boolean) => {
    setMultiQtyConfirmOpen(false);
    setScanConfirmed(true);
    setTimeout(() => {
      handleAction();
      setScanConfirmed(false);
      setScanInput("");
    }, 600);
  };

  const handleShortPickSubmit = () => {
    setShortPickSubmitted(true);
    setTimeout(() => {
      setShortPickOpen(false);
      setShortPickSubmitted(false);
      setShortPickReason("");
      setShortPickQty("0");
      setShortPickNotes("");
    }, 1500);
  };

  const handleAction = () => {
    // Pick confirmed - move to next item (shipping handled in ShipStation)
    setScanInput("");
    // In real implementation, this would advance to next item in the list
    // For now, just resets the input for demo purposes
  };

  return (
    <div className="flex flex-col min-h-full bg-muted/20 overflow-auto">
      {/* Header - Mobile Optimized */}
      <div className="bg-card border-b p-4 md:p-6 sticky top-0 z-10">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <PackageCheck className="h-6 w-6 text-primary" />
              Picking
            </h1>
            <p className="text-muted-foreground text-sm hidden md:block">
              {workflowMode === "solo" ? "Solo Mode: Pick & Ship in one flow." : "Enterprise Mode: Pick to Tote."}
            </p>
          </div>
          
          <div className="flex flex-col gap-2 items-end">
             <div className="flex items-center gap-2 bg-muted/50 p-1 rounded-lg">
                <Button 
                  size="sm" 
                  variant={pickMode === "batch" ? "default" : "ghost"}
                  onClick={() => setPickMode("batch")}
                  className="text-xs h-7"
                >
                  Batch
                </Button>
                <Button 
                  size="sm" 
                  variant={pickMode === "single" ? "default" : "ghost"}
                  onClick={() => setPickMode("single")}
                  className="text-xs h-7"
                >
                  Single
                </Button>
             </div>
             <div className="flex items-center gap-2">
               <span className="text-xs text-muted-foreground uppercase font-semibold">Workflow:</span>
               <div className="flex items-center gap-1 bg-muted/50 p-1 rounded-lg">
                  <Button 
                    size="icon" 
                    variant={workflowMode === "solo" ? "default" : "ghost"}
                    onClick={() => setWorkflowMode("solo")}
                    className="h-6 w-6"
                    title="Solo Mode (Pick & Ship)"
                  >
                    <Printer size={12} />
                  </Button>
                  <Button 
                    size="icon" 
                    variant={workflowMode === "enterprise" ? "default" : "ghost"}
                    onClick={() => setWorkflowMode("enterprise")}
                    className="h-6 w-6"
                    title="Enterprise Mode (Pick to Tote)"
                  >
                    <Box size={12} />
                  </Button>
               </div>
             </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 mb-2">
            <Badge variant="outline" className="h-8 px-3 bg-primary/10 text-primary border-primary/20 flex items-center gap-2">
              <img src="https://upload.wikimedia.org/wikipedia/commons/0/0e/Shopify_logo_2018.svg" className="w-4 h-4 object-contain" alt="Shopify" />
              {activeData.id}
            </Badge>
            <span className="text-xs font-mono text-muted-foreground uppercase">{activeData.type}</span>
        </div>

        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm font-medium">
            <span>Progress ({activeData.completedItems}/{activeData.totalItems})</span>
            <span>{Math.round((activeData.completedItems / activeData.totalItems) * 100)}%</span>
          </div>
          <Progress value={(activeData.completedItems / activeData.totalItems) * 100} className="h-3" />
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-4 md:p-6 overflow-hidden flex flex-col max-w-4xl mx-auto w-full">
        
        <Tabs defaultValue="current" className="flex-1 flex flex-col">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="current">Current Task</TabsTrigger>
            <TabsTrigger value="list">Full Pick List</TabsTrigger>
          </TabsList>

          {/* "Current Task" - The Scanner Interface */}
          <TabsContent value="current" className="mt-0 flex-1 flex flex-col gap-4">
            {/* The Item to Pick */}
            <Card className={cn("flex-1 shadow-md flex flex-col transition-colors duration-500", step === "pack_ship" ? "border-emerald-500/50 bg-emerald-50/10" : "border-primary/50")}>
              
              {step === "pick" ? (
                <>
                <CardHeader className="bg-muted/30 pb-2">
                  <div className="flex justify-between items-start">
                    <div className="flex flex-col items-start gap-1">
                      <span className="text-[10px] uppercase font-bold text-muted-foreground tracking-wider">Current Stop</span>
                      <Badge variant="secondary" className="text-xl py-1 px-3 font-mono border-2 border-primary/20 bg-background text-foreground">
                        <MapPin className="w-5 h-5 mr-2 text-primary" /> {activeData.items[pickMode === "batch" ? 2 : 0].location}
                      </Badge>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant="destructive" className="animate-pulse text-sm px-3 py-1">
                        PICK {activeData.items[pickMode === "batch" ? 2 : 0].qty} UNITS
                      </Badge>
                      <span className="text-xs text-muted-foreground font-medium">Order {activeData.items[pickMode === "batch" ? 2 : 0].orderId}</span>
                    </div>
                  </div>
                  {/* Path Visualization */}
                  <div className="mt-4 flex items-center gap-1 text-xs text-muted-foreground">
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500"></div>
                    <div className="h-0.5 w-4 bg-emerald-500"></div>
                    <div className="h-1.5 w-1.5 rounded-full bg-emerald-500"></div>
                    <div className="h-0.5 w-4 bg-emerald-500"></div>
                    <div className="h-2 w-2 rounded-full border-2 border-primary bg-background"></div>
                    <div className="h-0.5 w-4 bg-border"></div>
                    <div className="h-1.5 w-1.5 rounded-full bg-border"></div>
                    <span className="ml-2">Stop 3 of 5</span>
                  </div>
                </CardHeader>
                <CardContent className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6">
                  <div className="relative">
                    <img 
                      src={activeData.items[pickMode === "batch" ? 2 : 0].image} 
                      alt={activeData.items[pickMode === "batch" ? 2 : 0].name}
                      className="w-48 h-48 object-cover rounded-lg border-2 border-muted shadow-sm"
                    />
                    <div className="absolute -bottom-3 -right-3 bg-card border shadow-sm p-2 rounded-full">
                      <Scan className="w-6 h-6 text-primary" />
                    </div>
                  </div>
                  
                  <div className="space-y-1">
                    <h2 className="text-2xl font-bold">{activeData.items[pickMode === "batch" ? 2 : 0].sku}</h2>
                    <p className="text-muted-foreground text-lg">{activeData.items[pickMode === "batch" ? 2 : 0].name}</p>
                  </div>

                  <div className="w-full max-w-sm space-y-3 mt-4">
                    {scanConfirmed ? (
                      <div className="h-12 bg-emerald-100 border-2 border-emerald-500 rounded-md flex items-center justify-center gap-2 text-emerald-700 font-medium animate-in zoom-in-95">
                        <CheckCircle2 className="h-5 w-5" />
                        Scan Confirmed!
                      </div>
                    ) : (
                      <div className="relative">
                        <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <Input 
                          placeholder="Scan SKU barcode..." 
                          className="pl-10 h-12 text-lg border-primary/30 focus-visible:ring-primary"
                          value={scanInput}
                          onChange={(e) => handleScan(e.target.value)}
                          autoFocus
                          data-testid="input-scan-sku"
                        />
                      </div>
                    )}
                    <div className="text-xs text-center text-muted-foreground bg-muted/50 rounded-md py-2 px-3">
                      <span className="font-medium text-foreground">Scan = Auto-Confirm</span>
                      {currentItem.qty > 1 && <span> • Multi-qty will prompt for count</span>}
                    </div>
                    <Button 
                      variant="outline"
                      className="w-full h-10 text-sm"
                      onClick={handleAction}
                      data-testid="button-manual-confirm"
                    >
                      Or Manually Confirm Without Scan
                    </Button>
                    <Button 
                      variant="ghost" 
                      className="w-full text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                      onClick={() => setShortPickOpen(true)}
                      data-testid="button-short-pick"
                    >
                      <AlertTriangle className="mr-2 h-4 w-4" />
                      Can't Find / Short Pick
                    </Button>
                  </div>
                </CardContent>
                </>
              ) : (
                /* PACK & SHIP STEP - Reserved for future use */
                <CardContent className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6 animate-in fade-in zoom-in-95 duration-200">
                   <div className="h-24 w-24 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-2">
                     <Printer className="w-12 h-12" />
                   </div>
                   <div className="space-y-1">
                     <h2 className="text-2xl font-bold text-emerald-700">Ready to Ship</h2>
                     <p className="text-muted-foreground">Label generated for Order {currentItem.orderId}</p>
                   </div>
                   
                   <div className="w-full max-w-sm border-2 border-dashed border-emerald-200 bg-emerald-50 rounded-lg p-6 my-2">
                      <div className="font-mono text-sm mb-2 text-left">TRACKING: 1Z 999 999 99 9999 9999</div>
                      <div className="h-16 bg-white w-full opacity-80" />
                      <div className="mt-4 text-xs text-left text-muted-foreground">
                        SHIP TO:<br/>
                        ALICE FREEMAN<br/>
                        123 MAIN ST, NY
                      </div>
                   </div>

                   <div className="w-full max-w-sm space-y-3">
                     <Button 
                       className="w-full h-12 text-lg font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
                       onClick={() => setStep("pick")}
                     >
                       <CheckCircle2 className="mr-2 h-5 w-5" /> Print & Complete
                     </Button>
                     <Button variant="ghost" onClick={() => setStep("pick")}>
                       Cancel / Go Back
                     </Button>
                   </div>
                </CardContent>
              )}

            </Card>
            
            {/* Next Up Preview (Only for Batch) */}
            {pickMode === "batch" && (
              <div className="h-24 bg-card border rounded-lg p-3 flex items-center gap-4 opacity-60 grayscale hover:grayscale-0 transition-all cursor-pointer">
                <div className="bg-muted h-16 w-16 rounded-md flex items-center justify-center shrink-0">
                  <Box className="text-muted-foreground" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold text-muted-foreground uppercase">Next Item</p>
                  <p className="font-medium truncate">{activeData.items[3].sku}</p>
                  <p className="text-sm text-muted-foreground">{activeData.items[3].location}</p>
                </div>
                <ChevronRight className="text-muted-foreground" />
              </div>
            )}
          </TabsContent>

          {/* "Full List" View */}
          <TabsContent value="list" className="mt-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-4">
              <div className="space-y-3">
                {activeData.items.map((item) => (
                  <Card key={item.id} className={item.status === "completed" ? "bg-muted/30 border-muted" : "border-l-4 border-l-primary"}>
                    <CardContent className="p-4 flex items-center gap-4">
                      <div className="h-16 w-16 bg-white rounded-md border p-1 shrink-0">
                        <img src={item.image} alt={item.name} className="w-full h-full object-cover rounded-sm" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-sm">{item.sku}</span>
                          {item.status === "completed" ? (
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border-emerald-200">In Tote</Badge>
                          ) : (
                            <Badge variant="outline">{item.qty} QTY</Badge>
                          )}
                        </div>
                        <p className="text-sm font-medium truncate">{item.name}</p>
                        <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                          <MapPin size={12} /> {item.location}
                        </p>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>

      {/* Multi-Quantity Confirmation Dialog */}
      <Dialog open={multiQtyConfirmOpen} onOpenChange={setMultiQtyConfirmOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center">Confirm Quantity</DialogTitle>
            <DialogDescription className="text-center">
              Picking <span className="font-bold text-foreground">{currentItem.qty} units</span> of {currentItem.sku}
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-4 space-y-3">
            <Button 
              className="w-full h-14 text-lg bg-emerald-600 hover:bg-emerald-700"
              onClick={() => handleMultiQtyConfirm(true)}
              data-testid="button-confirm-all-qty"
            >
              <CheckCircle2 className="mr-2 h-5 w-5" />
              Confirm All {currentItem.qty}
            </Button>
            
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">or enter actual count</span>
              </div>
            </div>
            
            <div className="flex gap-2">
              <Input 
                type="number" 
                placeholder="Qty found" 
                className="text-center text-lg h-12"
                min={0}
                max={currentItem.qty}
                data-testid="input-partial-qty"
              />
              <Button 
                variant="outline" 
                className="h-12 px-6"
                onClick={() => {
                  setMultiQtyConfirmOpen(false);
                  setShortPickOpen(true);
                  setShortPickReason("partial");
                }}
              >
                Partial Pick
              </Button>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMultiQtyConfirmOpen(false)} className="w-full">
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Short Pick Dialog */}
      <Dialog open={shortPickOpen} onOpenChange={setShortPickOpen}>
        <DialogContent className="sm:max-w-md">
          {!shortPickSubmitted ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 text-amber-600">
                  <AlertOctagon className="h-5 w-5" />
                  Short Pick Report
                </DialogTitle>
                <DialogDescription>
                  Report an issue with picking {currentItem.sku} from {currentItem.location}
                </DialogDescription>
              </DialogHeader>
              
              <div className="space-y-4 py-4">
                <div className="space-y-3">
                  <Label className="text-sm font-medium">What's the issue?</Label>
                  <RadioGroup value={shortPickReason} onValueChange={setShortPickReason}>
                    <div className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="not_found" id="not_found" />
                      <Label htmlFor="not_found" className="flex-1 cursor-pointer">
                        <div className="font-medium flex items-center gap-2">
                          <XCircle className="h-4 w-4 text-red-500" />
                          Item Not Found
                        </div>
                        <p className="text-xs text-muted-foreground">Bin is empty or item is missing</p>
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="partial" id="partial" />
                      <Label htmlFor="partial" className="flex-1 cursor-pointer">
                        <div className="font-medium flex items-center gap-2">
                          <Package className="h-4 w-4 text-amber-500" />
                          Partial Quantity
                        </div>
                        <p className="text-xs text-muted-foreground">Found some but not all requested units</p>
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="damaged" id="damaged" />
                      <Label htmlFor="damaged" className="flex-1 cursor-pointer">
                        <div className="font-medium flex items-center gap-2">
                          <AlertTriangle className="h-4 w-4 text-orange-500" />
                          Item Damaged
                        </div>
                        <p className="text-xs text-muted-foreground">Item found but not in sellable condition</p>
                      </Label>
                    </div>
                    <div className="flex items-center space-x-3 p-3 border rounded-lg hover:bg-muted/50 cursor-pointer">
                      <RadioGroupItem value="wrong_item" id="wrong_item" />
                      <Label htmlFor="wrong_item" className="flex-1 cursor-pointer">
                        <div className="font-medium flex items-center gap-2">
                          <HelpCircle className="h-4 w-4 text-blue-500" />
                          Wrong Item in Bin
                        </div>
                        <p className="text-xs text-muted-foreground">Different SKU found at this location</p>
                      </Label>
                    </div>
                  </RadioGroup>
                </div>

                {shortPickReason === "partial" && (
                  <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                    <Label className="text-sm font-medium">How many units were you able to find?</Label>
                    <div className="flex items-center gap-2">
                      <Input 
                        type="number" 
                        min="0" 
                        max={currentItem.qty - 1}
                        value={shortPickQty}
                        onChange={(e) => setShortPickQty(e.target.value)}
                        className="w-24"
                        data-testid="input-short-pick-qty"
                      />
                      <span className="text-sm text-muted-foreground">of {currentItem.qty} requested</span>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <Label className="text-sm font-medium">Additional Notes (optional)</Label>
                  <Textarea 
                    placeholder="e.g., 'Checked alternate location A-01-03, also empty'"
                    value={shortPickNotes}
                    onChange={(e) => setShortPickNotes(e.target.value)}
                    className="resize-none"
                    rows={2}
                    data-testid="textarea-short-pick-notes"
                  />
                </div>

                <Button variant="outline" className="w-full" size="sm">
                  <Camera className="h-4 w-4 mr-2" />
                  Take Photo of Empty Bin
                </Button>
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => setShortPickOpen(false)} className="w-full sm:w-auto">
                  Cancel
                </Button>
                <Button 
                  onClick={handleShortPickSubmit}
                  disabled={!shortPickReason}
                  className="w-full sm:w-auto bg-amber-600 hover:bg-amber-700"
                  data-testid="button-submit-short-pick"
                >
                  Submit Short Pick
                </Button>
              </DialogFooter>
            </>
          ) : (
            <div className="py-12 text-center animate-in fade-in zoom-in-95">
              <div className="h-16 w-16 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="h-8 w-8 text-emerald-600" />
              </div>
              <h3 className="text-lg font-semibold text-emerald-700">Short Pick Logged</h3>
              <p className="text-sm text-muted-foreground mt-1">Moving to next item...</p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
