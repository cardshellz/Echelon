import React from "react";
import { 
  ArrowUpRight, 
  ArrowDownRight, 
  Package, 
  ShoppingCart, 
  Truck, 
  DollarSign, 
  Activity,
  AlertCircle
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
  BarChart,
  Bar
} from "recharts";

// Mock Data
const data = [
  { name: "Mon", orders: 400, shipped: 240 },
  { name: "Tue", orders: 300, shipped: 139 },
  { name: "Wed", orders: 200, shipped: 980 },
  { name: "Thu", orders: 278, shipped: 390 },
  { name: "Fri", orders: 189, shipped: 480 },
  { name: "Sat", orders: 239, shipped: 380 },
  { name: "Sun", orders: 349, shipped: 430 },
];

const inventoryData = [
  { sku: "NK-292-BLK", name: "Nike Air Max 90", location: "A-01-02", qty: 45, status: "In Stock" },
  { sku: "AD-550-WHT", name: "Adidas Ultraboost", location: "B-12-04", qty: 12, status: "Low Stock" },
  { sku: "PM-102-GRY", name: "Puma RS-X", location: "A-04-01", qty: 0, status: "Out of Stock" },
  { sku: "NB-990-NVY", name: "New Balance 990", location: "C-09-02", qty: 89, status: "In Stock" },
  { sku: "AS-200-BLU", name: "Asics Gel-Lyte", location: "B-03-05", qty: 3, status: "Low Stock" },
];

export default function Dashboard() {
  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      {/* Header Section */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Overview</h1>
          <p className="text-muted-foreground mt-1">Warehouse activity and performance metrics for today.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="h-9">Download Report</Button>
          <Button className="h-9 bg-primary hover:bg-primary/90">Create Order</Button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="border-l-4 border-l-primary shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">$45,231.89</div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-emerald-600 flex items-center mr-1 font-medium">
                <ArrowUpRight className="h-3 w-3 mr-0.5" /> +20.1%
              </span>
              from last month
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-2 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Orders Shipped</CardTitle>
            <Truck className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">+2350</div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-emerald-600 flex items-center mr-1 font-medium">
                <ArrowUpRight className="h-3 w-3 mr-0.5" /> +15.2%
              </span>
              fulfillment rate
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-3 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Orders</CardTitle>
            <ShoppingCart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">122</div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-rose-600 flex items-center mr-1 font-medium">
                <ArrowDownRight className="h-3 w-3 mr-0.5" /> -4.1%
              </span>
              backlog reduced
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-l-4 border-l-chart-4 shadow-sm hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Low Stock SKUs</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">12</div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center">
              <span className="text-amber-600 flex items-center mr-1 font-medium">
                <AlertCircle className="h-3 w-3 mr-0.5" /> Action needed
              </span>
              reorder soon
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
        {/* Main Chart */}
        <Card className="lg:col-span-4 shadow-sm">
          <CardHeader>
            <CardTitle>Order Fulfillment</CardTitle>
            <CardDescription>Daily order processing vs shipping volume</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                  <defs>
                    <linearGradient id="colorOrders" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorShipped" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="hsl(var(--chart-2))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <XAxis 
                    dataKey="name" 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                  />
                  <YAxis 
                    stroke="#888888" 
                    fontSize={12} 
                    tickLine={false} 
                    axisLine={false} 
                    tickFormatter={(value) => `${value}`} 
                  />
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <Tooltip 
                    contentStyle={{ borderRadius: '6px', borderColor: 'hsl(var(--border))' }}
                  />
                  <Area 
                    type="monotone" 
                    dataKey="orders" 
                    stroke="hsl(var(--primary))" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorOrders)" 
                  />
                  <Area 
                    type="monotone" 
                    dataKey="shipped" 
                    stroke="hsl(var(--chart-2))" 
                    strokeWidth={2}
                    fillOpacity={1} 
                    fill="url(#colorShipped)" 
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Recent Activity / Inventory */}
        <Card className="lg:col-span-3 shadow-sm flex flex-col">
          <CardHeader>
            <CardTitle>Critical Inventory</CardTitle>
            <CardDescription>Items requiring immediate attention</CardDescription>
          </CardHeader>
          <CardContent className="flex-1">
            <Tabs defaultValue="low_stock" className="w-full">
              <TabsList className="grid w-full grid-cols-2 mb-4">
                <TabsTrigger value="low_stock">Low Stock</TabsTrigger>
                <TabsTrigger value="moving_fast">Fast Moving</TabsTrigger>
              </TabsList>
              <TabsContent value="low_stock" className="mt-0">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>SKU</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead className="text-right">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {inventoryData.map((item) => (
                      <TableRow key={item.sku}>
                        <TableCell className="font-mono-sku text-xs font-medium">{item.sku}</TableCell>
                        <TableCell>{item.qty}</TableCell>
                        <TableCell className="text-right">
                          <Badge 
                            variant="secondary" 
                            className={
                              item.status === "Out of Stock" ? "bg-rose-100 text-rose-700 hover:bg-rose-100 dark:bg-rose-900/30 dark:text-rose-400" :
                              item.status === "Low Stock" ? "bg-amber-100 text-amber-700 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400" :
                              "bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400"
                            }
                          >
                            {item.status}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TabsContent>
              <TabsContent value="moving_fast" className="mt-0">
                <div className="flex flex-col items-center justify-center h-48 text-muted-foreground text-sm">
                  <Activity className="h-8 w-8 mb-2 opacity-20" />
                  No fast moving alerts
                </div>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
