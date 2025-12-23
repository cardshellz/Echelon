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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";

// Mock "Pick List" Data
// This module functions independently. It takes a "Batch ID" and allows a worker to process it.
const activeBatch = {
  id: "BATCH-4921",
  assignedTo: "John Doe",
  totalItems: 12,
  completedItems: 7,
  zones: ["A-01", "B-12"],
  priority: "High",
  items: [
    { id: 1, sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02-B", qty: 2, picked: 2, status: "completed", image: "https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=100&q=80" },
    { id: 2, sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "A-01-04-A", qty: 1, picked: 1, status: "completed", image: "https://images.unsplash.com/photo-1551107696-a4b0c5a0d9a2?auto=format&fit=crop&w=100&q=80" },
    { id: 3, sku: "NB-990-NVY", name: "New Balance 990v5", location: "B-12-01-C", qty: 3, picked: 0, status: "pending", image: "https://images.unsplash.com/photo-1539185441755-769473a23570?auto=format&fit=crop&w=100&q=80" },
    { id: 4, sku: "PM-102-GRY", name: "Puma RS-X", location: "B-12-04-D", qty: 1, picked: 0, status: "pending", image: "https://images.unsplash.com/photo-1608231387042-66d1773070a5?auto=format&fit=crop&w=100&q=80" },
  ]
};

export default function Picking() {
  const [activeTab, setActiveTab] = useState("current");
  const [scanInput, setScanInput] = useState("");

  return (
    <div className="flex flex-col h-full bg-muted/20">
      {/* Header - Mobile Optimized */}
      <div className="bg-card border-b p-4 md:p-6 sticky top-0 z-10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight flex items-center gap-2">
              <PackageCheck className="h-6 w-6 text-primary" />
              Picking
            </h1>
            <p className="text-muted-foreground text-sm hidden md:block">
              Batch Picking Mode • Zone A & B
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="h-8 px-3 bg-primary/10 text-primary border-primary/20">
              {activeBatch.id}
            </Badge>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm font-medium">
            <span>Progress ({activeBatch.completedItems}/{activeBatch.totalItems})</span>
            <span>{Math.round((activeBatch.completedItems / activeBatch.totalItems) * 100)}%</span>
          </div>
          <Progress value={(activeBatch.completedItems / activeBatch.totalItems) * 100} className="h-3" />
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
            <Card className="flex-1 border-primary/50 shadow-md flex flex-col">
              <CardHeader className="bg-muted/30 pb-2">
                <div className="flex justify-between items-start">
                  <Badge variant="secondary" className="text-lg py-1 px-3 font-mono">
                     <MapPin className="w-4 h-4 mr-1" /> {activeBatch.items[2].location}
                  </Badge>
                  <Badge variant="destructive" className="animate-pulse">
                    PICK {activeBatch.items[2].qty}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex-1 flex flex-col items-center justify-center text-center p-6 gap-6">
                <div className="relative">
                  <img 
                    src={activeBatch.items[2].image} 
                    alt={activeBatch.items[2].name}
                    className="w-48 h-48 object-cover rounded-lg border-2 border-muted shadow-sm"
                  />
                  <div className="absolute -bottom-3 -right-3 bg-card border shadow-sm p-2 rounded-full">
                    <Scan className="w-6 h-6 text-primary" />
                  </div>
                </div>
                
                <div className="space-y-1">
                  <h2 className="text-2xl font-bold">{activeBatch.items[2].sku}</h2>
                  <p className="text-muted-foreground text-lg">{activeBatch.items[2].name}</p>
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
                  <Button className="w-full h-12 text-lg font-medium shadow-lg shadow-primary/20">
                    Confirm Pick
                  </Button>
                  <Button variant="ghost" className="w-full text-muted-foreground">
                    Report Issue / Missing Item
                  </Button>
                </div>
              </CardContent>
            </Card>
            
            {/* Next Up Preview */}
            <div className="h-24 bg-card border rounded-lg p-3 flex items-center gap-4 opacity-60 grayscale hover:grayscale-0 transition-all cursor-pointer">
              <div className="bg-muted h-16 w-16 rounded-md flex items-center justify-center shrink-0">
                <Box className="text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-muted-foreground uppercase">Next Item</p>
                <p className="font-medium truncate">{activeBatch.items[3].sku}</p>
                <p className="text-sm text-muted-foreground">{activeBatch.items[3].location}</p>
              </div>
              <ChevronRight className="text-muted-foreground" />
            </div>
          </TabsContent>

          {/* "Full List" View */}
          <TabsContent value="list" className="mt-0 flex-1 overflow-hidden">
            <ScrollArea className="h-full pr-4">
              <div className="space-y-3">
                {activeBatch.items.map((item) => (
                  <Card key={item.id} className={item.status === "completed" ? "bg-muted/30 border-muted" : "border-l-4 border-l-primary"}>
                    <CardContent className="p-4 flex items-center gap-4">
                      <div className="h-16 w-16 bg-white rounded-md border p-1 shrink-0">
                        <img src={item.image} alt={item.name} className="w-full h-full object-cover rounded-sm" />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-mono font-bold text-sm">{item.sku}</span>
                          {item.status === "completed" ? (
                            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700 border-emerald-200">Done</Badge>
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
                
                <div className="flex justify-center pt-4">
                   <Button variant="outline" className="gap-2">
                     <Printer size={16} /> Print Pick List
                   </Button>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
