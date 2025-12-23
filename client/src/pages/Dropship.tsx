import React from "react";
import { 
  Store, 
  RefreshCw, 
  Link as LinkIcon, 
  ExternalLink, 
  DollarSign, 
  CheckCircle2, 
  AlertCircle,
  ArrowRight,
  Globe
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Progress } from "@/components/ui/progress";

// Mock Data
const vendors = [
  { id: 1, name: "SneakerHeadz eBay", platform: "eBay", status: "Active", listings: 142, lastSync: "2 mins ago", balance: "$1,240.50", health: 100 },
  { id: 2, name: "LuxuryKicks Direct", platform: "Shopify", status: "Active", listings: 89, lastSync: "1 hour ago", balance: "$4,120.00", health: 98 },
  { id: 3, name: "Vintage Vault", platform: "eBay", status: "Error", listings: 12, lastSync: "2 days ago", balance: "$0.00", health: 45 },
];

const syncCatalog = [
  { sku: "NK-292-BLK", name: "Nike Air Max 90", stock: 45, vendor: "SneakerHeadz eBay", extId: "EBAY-192834", price: "$129.00", status: "Synced" },
  { sku: "AD-550-WHT", name: "Adidas Ultraboost", stock: 12, vendor: "SneakerHeadz eBay", extId: "EBAY-992831", price: "$180.00", status: "Synced" },
  { sku: "AD-550-WHT", name: "Adidas Ultraboost", stock: 12, vendor: "LuxuryKicks", extId: "SHO-112233", price: "$195.00", status: "Pending Price Update" },
  { sku: "PM-102-GRY", name: "Puma RS-X", stock: 0, vendor: "Vintage Vault", extId: "EBAY-772211", price: "$85.00", status: "Out of Sync (OOS)" },
];

export default function Dropship() {
  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-card p-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Globe className="h-6 w-6 text-primary" />
              Dropship Network
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage external vendors, sync inventory to their stores, and automate fulfillment.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2">
              <RefreshCw size={16} /> Force Sync
            </Button>
            <Button className="gap-2">
              <LinkIcon size={16} /> Connect Vendor
            </Button>
          </div>
        </div>

        {/* Network Stats */}
        <div className="grid grid-cols-4 gap-4 mb-2">
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Active Channels</div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">3</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Synced Listings</div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">243</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Pending Orders</div>
            <div className="text-2xl font-bold font-mono text-primary mt-1">8</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Unsettled Balance</div>
            <div className="text-2xl font-bold font-mono text-emerald-600 mt-1">$5,360.50</div>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-hidden flex flex-col">
        <Tabs defaultValue="vendors" className="flex-1 flex flex-col">
          <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-6">
            <TabsTrigger 
              value="vendors" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Connected Vendors
            </TabsTrigger>
            <TabsTrigger 
              value="catalog" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Catalog Sync
            </TabsTrigger>
            <TabsTrigger 
              value="reconciliation" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Financials
            </TabsTrigger>
          </TabsList>

          <TabsContent value="vendors" className="mt-0">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {vendors.map((vendor) => (
                <Card key={vendor.id} className="border-l-4 border-l-primary/50 overflow-hidden">
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 bg-muted/20">
                    <CardTitle className="text-base font-medium">
                      {vendor.name}
                    </CardTitle>
                    <Badge variant={vendor.status === "Active" ? "outline" : "destructive"} className={vendor.status === "Active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}>
                      {vendor.status}
                    </Badge>
                  </CardHeader>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-4 mb-4">
                      <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center border text-slate-500 font-bold">
                        {vendor.platform[0]}
                      </div>
                      <div className="space-y-1">
                        <p className="text-sm font-medium leading-none">Platform: {vendor.platform}</p>
                        <p className="text-xs text-muted-foreground">Last sync: {vendor.lastSync}</p>
                      </div>
                    </div>
                    
                    <div className="space-y-3">
                      <div>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-muted-foreground">API Health</span>
                          <span className={vendor.health > 90 ? "text-emerald-600" : "text-amber-600"}>{vendor.health}%</span>
                        </div>
                        <Progress value={vendor.health} className="h-1.5" />
                      </div>
                      
                      <div className="flex justify-between items-center pt-2 border-t">
                        <span className="text-sm text-muted-foreground">Listings</span>
                        <span className="font-mono font-medium">{vendor.listings}</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-sm text-muted-foreground">Owed Balance</span>
                        <span className="font-mono font-bold text-emerald-600">{vendor.balance}</span>
                      </div>
                    </div>

                    <Button variant="outline" className="w-full mt-4 h-8 text-xs">
                      Manage Settings
                    </Button>
                  </CardContent>
                </Card>
              ))}
              
              <Card className="border-dashed border-2 flex flex-col items-center justify-center p-6 text-center hover:bg-muted/5 transition-colors cursor-pointer">
                <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                  <Store className="h-6 w-6 text-muted-foreground" />
                </div>
                <h3 className="font-semibold">Add New Vendor</h3>
                <p className="text-sm text-muted-foreground mt-1 mb-4">Connect an eBay, Shopify, or Amazon account.</p>
                <Button variant="secondary" size="sm">Connect Store</Button>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="catalog" className="mt-0 flex-1 overflow-auto rounded-md border bg-card">
            <Table>
              <TableHeader className="bg-muted/40 sticky top-0">
                <TableRow>
                  <TableHead className="w-[180px]">Internal SKU</TableHead>
                  <TableHead>Product</TableHead>
                  <TableHead>Vendor</TableHead>
                  <TableHead>External ID</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Sync Status</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {syncCatalog.map((item, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono-sku font-medium">{item.sku}</TableCell>
                    <TableCell>{item.name}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                         <span className="text-xs bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200 text-slate-600">
                           {item.vendor}
                         </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground flex items-center gap-1">
                      {item.extId} <ExternalLink size={10} />
                    </TableCell>
                    <TableCell className="font-mono">{item.price}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {item.status.includes("Synced") && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                        {item.status.includes("Pending") && <RefreshCw className="h-4 w-4 text-amber-500 animate-spin-slow" />}
                        {item.status.includes("Error") || item.status.includes("OOS") && <AlertCircle className="h-4 w-4 text-rose-500" />}
                        <span className="text-sm">{item.status}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" className="h-8">Details</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
