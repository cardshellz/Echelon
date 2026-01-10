import React from "react";
import { 
  Cable, 
  ArrowRightLeft, 
  ShoppingCart, 
  Truck, 
  Database,
  CheckCircle2,
  AlertCircle,
  Plus,
  Settings2,
  Power
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

export default function Integrations() {
  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card p-6 pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Cable className="h-6 w-6 text-primary" />
            System Architecture
          </h1>
          <p className="text-muted-foreground mt-1 text-sm max-w-2xl">
            Configure your modular stack. Replace individual components without disrupting operations 
            by switching data providers.
          </p>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-auto bg-muted/20">
        <div className="grid gap-8 max-w-5xl mx-auto">
          
          {/* SECTION 1: INBOUND (OMS) */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Inbound</Badge>
              <h2 className="text-lg font-semibold">Order Sources (OMS)</h2>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {/* Active Adapter */}
              <Card className="border-l-4 border-l-emerald-500 shadow-sm relative overflow-hidden">
                <div className="absolute top-3 right-3">
                  <Switch checked={true} />
                </div>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-slate-100 rounded-md flex items-center justify-center p-2">
                       <img src="https://upload.wikimedia.org/wikipedia/commons/0/0e/Shopify_logo_2018.svg" className="w-full h-full object-contain" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Shopify Connector</CardTitle>
                      <CardDescription>Direct API Integration (Source of Truth for SKUs)</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground mb-4">
                    Current "Master" source for orders. Pulls active orders every 2 mins.
                  </div>
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded w-fit">
                    <CheckCircle2 size={14} /> Connected • 14ms latency
                  </div>
                </CardContent>
              </Card>

              {/* Future Adapter */}
              <Card className="border-l-4 border-l-slate-200 opacity-60 hover:opacity-100 transition-opacity border-dashed">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-slate-100 rounded-md flex items-center justify-center">
                       <Database size={20} className="text-slate-500" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Custom OMS</CardTitle>
                      <CardDescription>Echelon Internal Order System</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground mb-4">
                    Future-state centralized order management. Currently disabled.
                  </div>
                  <Button variant="outline" size="sm" className="w-full">
                    <Plus size={14} className="mr-2" /> Configure
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="flex justify-center -my-2 relative z-0">
             <ArrowRightLeft className="text-muted-foreground/30 rotate-90" size={32} />
          </div>

          {/* SECTION 2: CORE (WMS) */}
          <div className="space-y-4 relative z-10">
             <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">Core</Badge>
              <h2 className="text-lg font-semibold">Warehouse Management (WMS)</h2>
            </div>
            <Card className="border-2 border-primary shadow-md bg-card">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="h-12 w-12 bg-primary/10 rounded-md flex items-center justify-center text-primary">
                       <Settings2 size={24} />
                    </div>
                    <div>
                      <CardTitle className="text-lg">Echelon Core</CardTitle>
                      <CardDescription>Inventory Ledger & Logic Engine</CardDescription>
                    </div>
                  </div>
                  <Badge className="bg-primary text-primary-foreground">Active Hub</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">
                  The central source of truth. It standardizes data from any OMS (Shopify or Custom) 
                  into a unified format for Picking/Packing, then routes it to the active Shipping Engine.
                </p>
                <div className="grid grid-cols-3 gap-4 mt-6">
                   <div className="bg-muted p-3 rounded text-center">
                      <div className="text-2xl font-bold">1,240</div>
                      <div className="text-xs uppercase text-muted-foreground font-semibold">SKUs</div>
                   </div>
                   <div className="bg-muted p-3 rounded text-center">
                      <div className="text-2xl font-bold">48</div>
                      <div className="text-xs uppercase text-muted-foreground font-semibold">Locations</div>
                   </div>
                   <div className="bg-muted p-3 rounded text-center">
                      <div className="text-2xl font-bold">12</div>
                      <div className="text-xs uppercase text-muted-foreground font-semibold">Batches</div>
                   </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex justify-center -my-2 relative z-0">
             <ArrowRightLeft className="text-muted-foreground/30 rotate-90" size={32} />
          </div>

          {/* SECTION 3: OUTBOUND (SHIPPING) */}
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Outbound</Badge>
              <h2 className="text-lg font-semibold">Shipping Engine</h2>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              {/* Active Adapter */}
              <Card className="border-l-4 border-l-emerald-500 shadow-sm relative overflow-hidden">
                <div className="absolute top-3 right-3">
                  <Switch checked={true} />
                </div>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                     <div className="h-10 w-10 bg-slate-100 rounded-md flex items-center justify-center p-1">
                       {/* Placeholder for ShipStation Logo */}
                       <Truck size={20} className="text-slate-700" />
                    </div>
                    <div>
                      <CardTitle className="text-base">ShipStation</CardTitle>
                      <CardDescription>Label Generation API</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground mb-4">
                    Current provider. Labels generated via API call upon "Pack" completion.
                  </div>
                  <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-1 rounded w-fit">
                    <CheckCircle2 size={14} /> Active Provider
                  </div>
                </CardContent>
              </Card>

              {/* Future Adapter */}
              <Card className="border-l-4 border-l-slate-200 opacity-60 hover:opacity-100 transition-opacity border-dashed">
                 <div className="absolute top-3 right-3">
                  <Switch checked={false} />
                </div>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 bg-slate-100 rounded-md flex items-center justify-center">
                       <Power size={20} className="text-slate-500" />
                    </div>
                    <div>
                      <CardTitle className="text-base">Echelon Shipping</CardTitle>
                      <CardDescription>Direct Carrier Integration</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="text-sm text-muted-foreground mb-4">
                    Future direct integration with UPS/FedEx/USPS. Removes middleman fees.
                  </div>
                   <Button variant="outline" size="sm" className="w-full">
                    <Plus size={14} className="mr-2" /> Configure
                  </Button>
                </CardContent>
              </Card>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
