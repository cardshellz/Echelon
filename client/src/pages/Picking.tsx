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
  MapPin
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
  
  const activeData = pickMode === "batch" ? batchPickData : singlePickData;

  const handleAction = () => {
    if (workflowMode === "solo") {
       if (step === "pick") {
         setStep("pack_ship");
       } else {
         // Would normally submit and go to next item
         setStep("pick");
         setScanInput("");
       }
    } else {
       // Enterprise mode just confirms pick
       setScanInput("");
    }
  };

  return (
    <div className="flex flex-col h-full bg-muted/20">
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
                    <div className="relative">
                      <Scan className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                      <Input 
                        placeholder="Scan SKU barcode..." 
                        className="pl-10 h-12 text-lg border-primary/30 focus-visible:ring-primary"
                        value={scanInput}
                        onChange={(e) => setScanInput(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <Button 
                      className="w-full h-12 text-lg font-medium shadow-lg shadow-primary/20"
                      onClick={handleAction}
                    >
                      {workflowMode === "solo" ? "Confirm & Ship" : "Confirm to Tote"}
                    </Button>
                    <div className="text-xs text-center text-muted-foreground">
                      {workflowMode === "solo" ? "Next step: Print Label" : "Next step: Packing Station"}
                    </div>
                    <Button variant="ghost" className="w-full text-muted-foreground">
                      Report Issue / Missing Item
                    </Button>
                  </div>
                </CardContent>
                </>
              ) : (
                /* PACK & SHIP STEP (SOLO MODE) */
                <CardContent className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6 animate-in fade-in zoom-in-95 duration-200">
                   <div className="h-24 w-24 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center mb-2">
                     <Printer className="w-12 h-12" />
                   </div>
                   <div className="space-y-1">
                     <h2 className="text-2xl font-bold text-emerald-700">Ready to Ship</h2>
                     <p className="text-muted-foreground">Label generated for Order {activeData.items[pickMode === "batch" ? 2 : 0].orderId}</p>
                   </div>
                   
                   <div className="w-full max-w-sm border-2 border-dashed border-emerald-200 bg-emerald-50 rounded-lg p-6 my-2">
                      <div className="font-mono text-sm mb-2 text-left">TRACKING: 1Z 999 999 99 9999 9999</div>
                      <div className="h-16 bg-white w-full opacity-80" /> {/* Fake Barcode */}
                      <div className="mt-4 text-xs text-left text-muted-foreground">
                        SHIP TO:<br/>
                        ALICE FREEMAN<br/>
                        123 MAIN ST, NY
                      </div>
                   </div>

                   <div className="w-full max-w-sm space-y-3">
                     <Button 
                       className="w-full h-12 text-lg font-medium bg-emerald-600 hover:bg-emerald-700 text-white"
                       onClick={handleAction}
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
    </div>
  );
}
