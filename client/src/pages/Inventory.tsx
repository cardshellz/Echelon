import React, { useState } from "react";
import { 
  Package, 
  Search, 
  Filter, 
  Plus, 
  MoreHorizontal, 
  ArrowUpDown, 
  Download,
  Printer,
  Edit,
  Move,
  History
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Mock WMS Data
const inventoryItems = [
  { id: 1, sku: "NK-292-BLK-09", name: "Nike Air Max 90 - Black / US 9", location: "A-01-02-B", onHand: 45, allocated: 12, available: 33, category: "Footwear", status: "Active" },
  { id: 2, sku: "NK-292-BLK-10", name: "Nike Air Max 90 - Black / US 10", location: "A-01-02-C", onHand: 28, allocated: 0, available: 28, category: "Footwear", status: "Active" },
  { id: 3, sku: "AD-550-WHT-08", name: "Adidas Ultraboost - White / US 8", location: "B-12-04-A", onHand: 12, allocated: 2, available: 10, category: "Footwear", status: "Low Stock" },
  { id: 4, sku: "PM-102-GRY-M", name: "Puma RS-X T-Shirt - Grey / M", location: "Z-04-01-A", onHand: 0, allocated: 0, available: 0, category: "Apparel", status: "Out of Stock" },
  { id: 5, sku: "NB-990-NVY-09", name: "New Balance 990v5 - Navy / US 9", location: "C-09-02-A", onHand: 89, allocated: 45, available: 44, category: "Footwear", status: "Active" },
  { id: 6, sku: "AS-200-BLU-11", name: "Asics Gel-Lyte III - Blue / US 11", location: "B-03-05-D", onHand: 3, allocated: 1, available: 2, category: "Footwear", status: "Critical" },
  { id: 7, sku: "NK-SOCK-WHT-L", name: "Nike Performance Socks - White / L", location: "K-01-01-A", onHand: 450, allocated: 10, available: 440, category: "Accessories", status: "Active" },
];

export default function Inventory() {
  const [activeTab, setActiveTab] = useState("all");

  return (
    <div className="flex flex-col h-full">
      {/* Module Header */}
      <div className="border-b bg-card p-6 pb-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" />
              Inventory Management
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Manage stock levels, locations, and inventory adjustments.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" className="gap-2">
              <Download size={16} /> Export
            </Button>
            <Button className="gap-2">
              <Plus size={16} /> Add Item
            </Button>
          </div>
        </div>

        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-4 mb-4">
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total SKUs</div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">1,248</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Total Units</div>
            <div className="text-2xl font-bold font-mono text-foreground mt-1">45,291</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Low Stock</div>
            <div className="text-2xl font-bold font-mono text-amber-600 mt-1">12</div>
          </div>
          <div className="bg-muted/30 p-3 rounded-lg border">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Value on Hand</div>
            <div className="text-2xl font-bold font-mono text-emerald-600 mt-1">$1.2M</div>
          </div>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between gap-4 mt-6">
          <div className="flex items-center gap-2 flex-1 max-w-lg">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input 
                placeholder="Search by SKU, Name, or Location..." 
                className="pl-9 h-9" 
              />
            </div>
            <Button variant="outline" size="sm" className="h-9 gap-2">
              <Filter size={16} /> Filters
            </Button>
          </div>
          
          <div className="flex items-center bg-muted/50 p-1 rounded-md">
            <Button 
              variant={activeTab === "all" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("all")}
            >
              All Items
            </Button>
            <Button 
              variant={activeTab === "low" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("low")}
            >
              Low Stock
            </Button>
            <Button 
              variant={activeTab === "adjust" ? "default" : "ghost"} 
              size="sm" 
              className="h-7 text-xs"
              onClick={() => setActiveTab("adjust")}
            >
              Allocated
            </Button>
          </div>
        </div>
      </div>

      {/* Main Content Area - The Data Grid */}
      <div className="flex-1 p-6 overflow-hidden flex flex-col">
        <div className="rounded-md border bg-card flex-1 overflow-auto">
          <Table>
            <TableHeader className="bg-muted/40 sticky top-0 z-10">
              <TableRow>
                <TableHead className="w-[50px]">
                  <input type="checkbox" className="rounded border-gray-300" />
                </TableHead>
                <TableHead className="w-[180px]">SKU</TableHead>
                <TableHead>Product Name</TableHead>
                <TableHead className="w-[120px]">Location</TableHead>
                <TableHead className="text-right w-[100px]">On Hand</TableHead>
                <TableHead className="text-right w-[100px]">Allocated</TableHead>
                <TableHead className="text-right w-[100px]">Available</TableHead>
                <TableHead className="w-[120px]">Status</TableHead>
                <TableHead className="w-[50px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {inventoryItems.map((item) => (
                <TableRow key={item.id} className="hover:bg-muted/5">
                  <TableCell>
                    <input type="checkbox" className="rounded border-gray-300" />
                  </TableCell>
                  <TableCell className="font-mono-sku font-medium text-primary cursor-pointer hover:underline">
                    {item.sku}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{item.name}</span>
                      <span className="text-xs text-muted-foreground">{item.category}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono-sku text-xs bg-secondary/50">
                      {item.location}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono-sku">{item.onHand}</TableCell>
                  <TableCell className="text-right font-mono-sku text-muted-foreground">{item.allocated}</TableCell>
                  <TableCell className="text-right font-mono-sku font-bold">
                    {item.available}
                  </TableCell>
                  <TableCell>
                    <Badge 
                      variant="secondary"
                      className={
                        item.status === "Out of Stock" ? "bg-rose-100 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-400" :
                        item.status === "Low Stock" || item.status === "Critical" ? "bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400" :
                        "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400"
                      }
                    >
                      {item.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Actions</DropdownMenuLabel>
                        <DropdownMenuItem className="gap-2">
                          <Edit size={14} /> Adjust Stock
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2">
                          <Move size={14} /> Move / Transfer
                        </DropdownMenuItem>
                        <DropdownMenuItem className="gap-2">
                          <Printer size={14} /> Print Label
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem className="gap-2">
                          <History size={14} /> View History
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
          <div>Showing 1-7 of 1,248 items</div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled>Previous</Button>
            <Button variant="outline" size="sm">Next</Button>
          </div>
        </div>
      </div>
    </div>
  );
}
