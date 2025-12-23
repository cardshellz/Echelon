import React from "react";
import { 
  ShoppingCart, 
  Search, 
  Filter, 
  MoreHorizontal, 
  Clock,
  AlertCircle,
  CheckCircle2,
  Truck
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const orders = [
  { id: "ORD-2024-001", customer: "Alice Freeman", items: 4, total: "$450.00", status: "Allocated", sla: "2h 15m", progress: 30, date: "Today, 10:23 AM" },
  { id: "ORD-2024-002", customer: "Bob Smith", items: 12, total: "$1,250.00", status: "Picking", sla: "45m", progress: 55, date: "Today, 09:15 AM" },
  { id: "ORD-2024-003", customer: "Charlie Davis", items: 1, total: "$85.00", status: "Packing", sla: "1h 30m", progress: 80, date: "Today, 10:45 AM" },
  { id: "ORD-2024-004", customer: "Diana Prince", items: 6, total: "$620.00", status: "Pending", sla: "4h 00m", progress: 10, date: "Today, 11:00 AM" },
  { id: "ORD-2024-005", customer: "Evan Wright", items: 2, total: "$120.00", status: "Shipped", sla: "-", progress: 100, date: "Yesterday" },
];

export default function Orders() {
  return (
    <div className="flex flex-col h-full bg-muted/20">
      <div className="p-6 border-b bg-card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <ShoppingCart className="h-6 w-6 text-primary" />
              Order Management
            </h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Process, allocate, and fulfill customer orders.
            </p>
          </div>
          <Button>Create Manual Order</Button>
        </div>

        <Tabs defaultValue="active" className="w-full">
          <TabsList className="w-full justify-start border-b rounded-none h-auto p-0 bg-transparent">
            <TabsTrigger 
              value="active" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Active Orders (4)
            </TabsTrigger>
            <TabsTrigger 
              value="pending" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Pending Allocation (12)
            </TabsTrigger>
            <TabsTrigger 
              value="exception" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2 text-amber-600"
            >
              Exceptions (2)
            </TabsTrigger>
            <TabsTrigger 
              value="completed" 
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-4 py-2"
            >
              Completed
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="p-6 grid gap-6 md:grid-cols-3">
        {/* Order List Column */}
        <div className="md:col-span-2 space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input placeholder="Search orders..." className="pl-9 bg-card" />
            </div>
            <Button variant="outline" size="icon">
              <Filter className="h-4 w-4" />
            </Button>
          </div>

          <div className="space-y-3">
            {orders.map((order) => (
              <Card key={order.id} className="hover:border-primary/50 transition-colors cursor-pointer group">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-4">
                      <div className="bg-primary/10 p-2 rounded-md group-hover:bg-primary/20 transition-colors">
                        <ShoppingCart className="h-5 w-5 text-primary" />
                      </div>
                      <div>
                        <div className="font-semibold flex items-center gap-2">
                          {order.id}
                          {order.status === "Pending" && <Badge variant="outline" className="text-xs bg-slate-100">Pending</Badge>}
                          {order.status === "Allocated" && <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">Allocated</Badge>}
                          {order.status === "Picking" && <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200 animate-pulse">Picking</Badge>}
                          {order.status === "Packing" && <Badge variant="outline" className="text-xs bg-purple-50 text-purple-700 border-purple-200">Packing</Badge>}
                          {order.status === "Shipped" && <Badge variant="outline" className="text-xs bg-emerald-50 text-emerald-700 border-emerald-200">Shipped</Badge>}
                        </div>
                        <div className="text-sm text-muted-foreground mt-1">
                          {order.customer} • {order.items} items • {order.total}
                        </div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-medium flex items-center justify-end gap-1 text-muted-foreground">
                        <Clock className="h-3 w-3" /> SLA: {order.sla}
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{order.date}</div>
                    </div>
                  </div>
                  
                  {order.status !== "Shipped" && (
                    <div className="mt-4 flex items-center gap-3">
                      <div className="flex-1">
                        <div className="flex justify-between text-xs mb-1.5 text-muted-foreground">
                          <span>Progress</span>
                          <span>{order.progress}%</span>
                        </div>
                        <Progress value={order.progress} className="h-1.5" />
                      </div>
                      <Button variant="ghost" size="sm" className="h-7 text-xs ml-2">
                        View Details
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        {/* Info/Stats Column */}
        <div className="space-y-6">
          <Card className="bg-primary text-primary-foreground border-none">
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Ops Status</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <span className="text-primary-foreground/80 text-sm">Pick Rate</span>
                  <span className="font-bold">124 / hr</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-primary-foreground/80 text-sm">Pack Rate</span>
                  <span className="font-bold">98 / hr</span>
                </div>
                <div className="pt-2 border-t border-primary-foreground/20 mt-2">
                  <div className="flex justify-between items-center text-amber-200">
                    <span className="text-sm flex items-center gap-1"><AlertCircle className="h-3 w-3" /> At Risk</span>
                    <span className="font-bold">3 Orders</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {[1,2,3].map((i) => (
                <div key={i} className="flex gap-3 text-sm">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback>U{i}</AvatarFallback>
                  </Avatar>
                  <div>
                    <p className="font-medium">User {i} picked item NK-292</p>
                    <p className="text-xs text-muted-foreground">2 mins ago • Batch #492</p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
