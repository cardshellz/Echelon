import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { 
  RefreshCw, 
  ExternalLink, 
  CheckCircle2, 
  AlertCircle,
  ArrowRight,
  Globe,
  Plus,
  Store,
  LinkIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
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
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription, EmptyMedia } from "@/components/ui/empty";

const platforms = [
  { id: "shopify", name: "Shopify", icon: "https://upload.wikimedia.org/wikipedia/commons/0/0e/Shopify_logo_2018.svg" },
  { id: "ebay", name: "eBay", icon: "https://upload.wikimedia.org/wikipedia/commons/1/1b/EBay_logo.svg" },
  { id: "amazon", name: "Amazon", icon: "https://upload.wikimedia.org/wikipedia/commons/a/a9/Amazon_logo.svg" },
];

export default function Dropship() {
  const [isConnectOpen, setIsConnectOpen] = useState(false);

  const { data: vendorsResponse } = useQuery({
    queryKey: ["/api/admin/vendors"],
    queryFn: async () => {
      const res = await fetch("/api/admin/vendors");
      if (!res.ok) throw new Error("Failed to fetch vendors");
      return res.json();
    }
  });
  
  const { data: catalogResponse } = useQuery({
    queryKey: ["/api/admin/dropship-catalog"],
    queryFn: async () => {
      const res = await fetch("/api/admin/dropship-catalog");
      if (!res.ok) throw new Error("Failed to fetch catalog");
      return res.json();
    }
  });

  const vendorsList = vendorsResponse?.vendors || [];
  const vendors = vendorsList.map((v: any) => ({
    id: v.id,
    name: v.name,
    status: v.status === "active" ? "Active" : v.status === "suspended" ? "Suspended" : "Pending",
    platform: v.ebay_connected ? "eBay" : "Shopify",
    lastSync: new Date(v.created_at).toLocaleDateString(),
    health: 100,
    listings: 0,
    balance: "$" + ((v.wallet_balance_cents || 0) / 100).toFixed(2),
  }));

  const syncCatalog = catalogResponse?.catalog || [];

  const totalUnsettled = vendorsList.reduce((acc: number, v: any) => acc + (v.wallet_balance_cents || 0), 0);
  const formattedUnsettled = "$" + (totalUnsettled / 100).toFixed(2);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b bg-card p-2 md:p-6 pb-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2" data-testid="text-page-title">
              <Globe className="h-6 w-6 text-primary" />
              Dropship Network
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage external vendors, sync inventory to their stores, and automate fulfillment.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2 min-h-[44px]" data-testid="button-force-sync">
              <RefreshCw size={16} /> Force Sync
            </Button>
            
            <Dialog open={isConnectOpen} onOpenChange={setIsConnectOpen}>
              <DialogTrigger asChild>
                <Button className="gap-2 min-h-[44px]" data-testid="button-connect-store">
                  <Plus size={16} /> Connect Store
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto p-4">
                <DialogHeader>
                  <DialogTitle>Connect New Store</DialogTitle>
                  <DialogDescription>
                    Select a platform to integrate. Orders will automatically sync to your WMS.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid grid-cols-1 gap-4">
                     {platforms.map((platform) => (
                       <Button key={platform.id} variant="outline" className="h-16 min-h-[44px] justify-start px-4 hover:border-primary hover:bg-primary/5 group relative overflow-hidden" data-testid={`button-platform-${platform.id}`}>
                         <div className="absolute inset-0 bg-gradient-to-r from-transparent via-transparent to-primary/5 translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-1000" />
                         <div className="h-8 w-8 mr-4 flex items-center justify-center">
                            <img src={platform.icon} alt={platform.name} className="max-h-full max-w-full object-contain" />
                         </div>
                         <div className="flex flex-col items-start">
                           <span className="font-semibold text-base">{platform.name}</span>
                           <span className="text-xs text-muted-foreground">Connect via OAuth 2.0</span>
                         </div>
                         <ArrowRight className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-primary" size={16} />
                       </Button>
                     ))}
                  </div>
                  <div className="relative my-2">
                    <div className="absolute inset-0 flex items-center">
                      <span className="w-full border-t" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-background px-2 text-muted-foreground">
                        Or manual API
                      </span>
                    </div>
                  </div>
                  <div className="grid w-full items-center gap-1.5">
                    <Label htmlFor="api-key" className="text-sm">Custom API Key</Label>
                    <Input 
                      id="api-key" 
                      placeholder="sk_live_..." 
                      className="w-full h-11"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      data-testid="input-api-key"
                    />
                  </div>
                </div>
                <DialogFooter className="flex-col gap-2 sm:flex-row">
                  <Button variant="outline" onClick={() => setIsConnectOpen(false)} className="min-h-[44px]" data-testid="button-cancel-connect">Cancel</Button>
                  <Button type="submit" className="min-h-[44px]" data-testid="button-verify-connection">Verify Connection</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4 mb-2">
          <div className="bg-muted/30 p-2 md:p-3 rounded-md border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Active Channels</div>
            <div className="text-xl md:text-2xl font-bold font-mono text-foreground mt-1" data-testid="text-active-channels">{vendors.length}</div>
          </div>
          <div className="bg-muted/30 p-2 md:p-3 rounded-md border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Synced Listings</div>
            <div className="text-xl md:text-2xl font-bold font-mono text-foreground mt-1" data-testid="text-synced-listings">{syncCatalog.length}</div>
          </div>
          <div className="bg-muted/30 p-2 md:p-3 rounded-md border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Pending Orders</div>
            <div className="text-xl md:text-2xl font-bold font-mono text-primary mt-1" data-testid="text-pending-orders">0</div>
          </div>
          <div className="bg-muted/30 p-2 md:p-3 rounded-md border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Unsettled Balance</div>
            <div className="text-xl md:text-2xl font-bold font-mono text-emerald-600 mt-1" data-testid="text-unsettled-balance">{formattedUnsettled}</div>
          </div>
        </div>
      </div>

      <div className="flex-1 p-2 md:p-6 overflow-hidden flex flex-col">
        <Tabs defaultValue="vendors" className="flex-1 flex flex-col">
          <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent mb-4 md:mb-6 flex-wrap">
            <TabsTrigger 
              value="vendors" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 md:px-4 py-2 text-sm"
              data-testid="tab-vendors"
            >
              Connected Vendors
            </TabsTrigger>
            <TabsTrigger 
              value="catalog" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 md:px-4 py-2 text-sm"
              data-testid="tab-catalog"
            >
              Catalog Sync
            </TabsTrigger>
            <TabsTrigger 
              value="reconciliation" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-2 md:px-4 py-2 text-sm"
              data-testid="tab-reconciliation"
            >
              Financials
            </TabsTrigger>
          </TabsList>

          <TabsContent value="vendors" className="mt-0">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {vendors.length === 0 ? (
                <div className="col-span-full">
                  <Empty data-testid="empty-vendors">
                    <EmptyMedia variant="icon">
                      <Store />
                    </EmptyMedia>
                    <EmptyHeader>
                      <EmptyTitle>No Vendors Connected</EmptyTitle>
                      <EmptyDescription>
                        Connect an external store to start syncing inventory and automating fulfillment.
                      </EmptyDescription>
                    </EmptyHeader>
                    <Button onClick={() => setIsConnectOpen(true)} className="gap-2" data-testid="button-connect-first-store">
                      <Plus size={16} /> Connect Store
                    </Button>
                  </Empty>
                </div>
              ) : (
                <>
                  {vendors.map((vendor: any) => (
                    <Card key={vendor.id} className="overflow-visible" data-testid={`card-vendor-${vendor.id}`}>
                      <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2 bg-muted/20">
                        <CardTitle className="text-base font-medium">
                          {vendor.name}
                        </CardTitle>
                        <Badge variant={vendor.status === "Active" ? "outline" : "destructive"} className={vendor.status === "Active" ? "bg-emerald-50 text-emerald-700 border-emerald-200" : ""}>
                          {vendor.status}
                        </Badge>
                      </CardHeader>
                      <CardContent className="pt-4">
                        <div className="flex items-center gap-4 mb-4">
                          <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center border text-slate-500 font-bold overflow-hidden p-2">
                             {vendor.platform === "Shopify" && <img src="https://upload.wikimedia.org/wikipedia/commons/0/0e/Shopify_logo_2018.svg" alt="Shopify" className="w-full h-full object-contain" />}
                             {vendor.platform === "eBay" && <img src="https://upload.wikimedia.org/wikipedia/commons/1/1b/EBay_logo.svg" alt="eBay" className="w-full h-full object-contain" />}
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

                        <Button variant="outline" className="w-full mt-4 min-h-[44px] text-xs" data-testid={`button-manage-vendor-${vendor.id}`}>
                          Manage Settings
                        </Button>
                      </CardContent>
                    </Card>
                  ))}
                  <Card 
                    className="border-dashed border-2 flex flex-col items-center justify-center p-6 text-center cursor-pointer hover-elevate"
                    onClick={() => setIsConnectOpen(true)}
                    data-testid="card-add-vendor"
                  >
                    <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-4">
                      <Plus className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <h3 className="font-semibold">Add New Vendor</h3>
                    <p className="text-sm text-muted-foreground mt-1 mb-4">Connect an eBay, Shopify, or Amazon account.</p>
                    <Button variant="secondary" size="sm" className="min-h-[44px]">Connect Store</Button>
                  </Card>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="catalog" className="mt-0 flex-1 overflow-auto">
            {syncCatalog.length === 0 ? (
              <Empty data-testid="empty-catalog">
                <EmptyMedia variant="icon">
                  <LinkIcon />
                </EmptyMedia>
                <EmptyHeader>
                  <EmptyTitle>No Catalog Listings</EmptyTitle>
                  <EmptyDescription>
                    Connect a vendor and sync products to see catalog listings here.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <div className="md:hidden space-y-3">
                  {syncCatalog.map((item: any, i: number) => (
                    <Card key={i} className="p-3" data-testid={`card-catalog-${i}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-mono text-sm font-medium">{item.sku}</p>
                          <p className="text-sm text-muted-foreground">{item.name}</p>
                        </div>
                        <div className="flex items-center gap-1">
                          {item.status.includes("Synced") && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                          {item.status.includes("Pending") && <RefreshCw className="h-4 w-4 text-amber-500 animate-spin-slow" />}
                          {(item.status.includes("Error") || item.status.includes("OOS")) && <AlertCircle className="h-4 w-4 text-rose-500" />}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                        <div>
                          <span className="text-muted-foreground">Vendor: </span>
                          <span>{item.vendor}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Price: </span>
                          <span className="font-mono">{item.price}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Ext ID: </span>
                          <span className="font-mono">{item.extId}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Status: </span>
                          <span>{item.status}</span>
                        </div>
                      </div>
                      <Button variant="ghost" size="sm" className="w-full min-h-[44px]">Details</Button>
                    </Card>
                  ))}
                </div>
                
                <div className="hidden md:block rounded-md border bg-card">
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
                      {syncCatalog.map((item: any, i: number) => (
                        <TableRow key={i} data-testid={`row-catalog-${i}`}>
                          <TableCell className="font-mono-sku font-medium">{item.sku}</TableCell>
                          <TableCell>{item.name}</TableCell>
                          <TableCell>
                            <span className="text-xs">{item.vendor}</span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-muted-foreground flex items-center gap-1">
                            {item.extId} <ExternalLink size={10} />
                          </TableCell>
                          <TableCell className="font-mono">{item.price}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              {item.status.includes("Synced") && <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                              {item.status.includes("Pending") && <RefreshCw className="h-4 w-4 text-amber-500 animate-spin-slow" />}
                              {(item.status.includes("Error") || item.status.includes("OOS")) && <AlertCircle className="h-4 w-4 text-rose-500" />}
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
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
