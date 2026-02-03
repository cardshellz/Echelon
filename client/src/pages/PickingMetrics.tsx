import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  BarChart3, 
  Clock, 
  Package, 
  TrendingUp, 
  AlertTriangle, 
  CheckCircle2,
  Users,
  Target,
  Zap,
  Timer,
  ScanLine,
  Hand
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  Legend
} from "recharts";

type DateRange = "today" | "week" | "month" | "quarter";

interface MetricsData {
  throughput: {
    ordersPerHour: number;
    linesPerHour: number;
    itemsPerHour: number;
    totalOrdersCompleted: number;
    totalLinesPicked: number;
    totalItemsPicked: number;
  };
  productivity: {
    averagePickTime: number;
    averageClaimToComplete: number;
    averageQueueWait: number;
    pickersActive: number;
    utilizationRate: number;
  };
  quality: {
    shortPickRate: number;
    totalShortPicks: number;
    scanPickRate: number;
    manualPickRate: number;
    exceptionRate: number;
    totalExceptions: number;
  };
  pickerPerformance: Array<{
    pickerId: string;
    pickerName: string;
    ordersCompleted: number;
    itemsPicked: number;
    avgPickTime: number;
    shortPicks: number;
    scanRate: number;
  }>;
  hourlyTrend: Array<{
    hour: string;
    orders: number;
    items: number;
  }>;
  shortReasons: Array<{
    reason: string;
    count: number;
  }>;
}

const COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export default function PickingMetrics() {
  const [dateRange, setDateRange] = useState<DateRange>("today");
  const [activeTab, setActiveTab] = useState("overview");

  const { data: metrics, isLoading } = useQuery<MetricsData>({
    queryKey: ["/api/picking/metrics", dateRange],
    queryFn: async () => {
      const res = await fetch(`/api/picking/metrics?range=${dateRange}`);
      if (!res.ok) throw new Error("Failed to fetch metrics");
      return res.json();
    },
  });

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    const mins = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${mins}m ${secs}s`;
  };

  const formatPercent = (value: number) => `${(value * 100).toFixed(1)}%`;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  const defaultMetrics: MetricsData = {
    throughput: { ordersPerHour: 0, linesPerHour: 0, itemsPerHour: 0, totalOrdersCompleted: 0, totalLinesPicked: 0, totalItemsPicked: 0 },
    productivity: { averagePickTime: 0, averageClaimToComplete: 0, averageQueueWait: 0, pickersActive: 0, utilizationRate: 0 },
    quality: { shortPickRate: 0, totalShortPicks: 0, scanPickRate: 0, manualPickRate: 0, exceptionRate: 0, totalExceptions: 0 },
    pickerPerformance: [],
    hourlyTrend: [],
    shortReasons: []
  };

  const data = metrics || defaultMetrics;

  return (
    <div className="space-y-4 md:space-y-6 p-2 md:p-6" data-testid="picking-metrics-page">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="h-5 w-5 md:h-6 md:w-6" />
            Picking Metrics
          </h1>
          <p className="text-muted-foreground text-xs md:text-sm mt-1">
            Warehouse picking performance and quality analytics
          </p>
        </div>
        <Select value={dateRange} onValueChange={(v) => setDateRange(v as DateRange)}>
          <SelectTrigger className="w-[150px] h-11" data-testid="date-range-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Today</SelectItem>
            <SelectItem value="week">This Week</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
            <SelectItem value="quarter">This Quarter</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="productivity">Productivity</TabsTrigger>
          <TabsTrigger value="quality">Quality</TabsTrigger>
          <TabsTrigger value="pickers">By Picker</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 md:space-y-6 mt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Package className="h-4 w-4" />
                  Orders Completed
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{data.throughput.totalOrdersCompleted}</div>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {data.throughput.ordersPerHour.toFixed(1)}/hour avg
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Zap className="h-4 w-4" />
                  Items Picked
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{data.throughput.totalItemsPicked}</div>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {data.throughput.itemsPerHour.toFixed(1)}/hour avg
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Timer className="h-4 w-4" />
                  Avg Pick Time
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{formatTime(data.productivity.averagePickTime)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">per item</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Short Pick Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{formatPercent(data.quality.shortPickRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {data.quality.totalShortPicks} total shorts
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Hourly Throughput</CardTitle>
                <CardDescription>Orders and items picked by hour</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  {data.hourlyTrend.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={data.hourlyTrend}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="hour" />
                        <YAxis yAxisId="left" />
                        <YAxis yAxisId="right" orientation="right" />
                        <Tooltip />
                        <Legend />
                        <Line yAxisId="left" type="monotone" dataKey="orders" stroke="#3b82f6" name="Orders" />
                        <Line yAxisId="right" type="monotone" dataKey="items" stroke="#22c55e" name="Items" />
                      </LineChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      No data for selected period
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Short Pick Reasons</CardTitle>
                <CardDescription>Breakdown of why items were shorted</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  {data.shortReasons.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={data.shortReasons}
                          dataKey="count"
                          nameKey="reason"
                          cx="50%"
                          cy="50%"
                          outerRadius={100}
                          label={({ reason, percent }) => `${reason}: ${(percent * 100).toFixed(0)}%`}
                        >
                          {data.shortReasons.map((_, index) => (
                            <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  ) : (
                    <div className="h-full flex items-center justify-center text-muted-foreground">
                      No short picks in selected period
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="productivity" className="space-y-4 md:space-y-6 mt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  Avg Queue Wait
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{formatTime(data.productivity.averageQueueWait)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">Time until claimed</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Timer className="h-4 w-4" />
                  Avg Claim to Complete
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{formatTime(data.productivity.averageClaimToComplete)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">Per order</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  Active Pickers
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{data.productivity.pickersActive}</div>
                <p className="text-xs md:text-sm text-muted-foreground">In selected period</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Utilization Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold">{formatPercent(data.productivity.utilizationRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">Active picking time</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="p-2 md:p-6">
              <CardTitle className="text-base md:text-lg">Flow Metrics</CardTitle>
              <CardDescription className="text-xs md:text-sm">Order processing timeline breakdown</CardDescription>
            </CardHeader>
            <CardContent className="p-2 md:p-6">
              <div className="space-y-3 md:space-y-4">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-2 md:p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 md:h-10 md:w-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                      <Clock className="h-4 w-4 md:h-5 md:w-5 text-blue-600" />
                    </div>
                    <div>
                      <div className="font-medium text-sm md:text-base">Queue Wait Time</div>
                      <div className="text-xs md:text-sm text-muted-foreground">Time from order sync to picker claim</div>
                    </div>
                  </div>
                  <div className="text-xl md:text-2xl font-bold md:text-right">{formatTime(data.productivity.averageQueueWait)}</div>
                </div>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-2 md:p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 md:h-10 md:w-10 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                      <Zap className="h-4 w-4 md:h-5 md:w-5 text-green-600" />
                    </div>
                    <div>
                      <div className="font-medium text-sm md:text-base">Pick Time</div>
                      <div className="text-xs md:text-sm text-muted-foreground">Average time to pick each item</div>
                    </div>
                  </div>
                  <div className="text-xl md:text-2xl font-bold md:text-right">{formatTime(data.productivity.averagePickTime)}</div>
                </div>
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 p-2 md:p-4 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 md:h-10 md:w-10 rounded-full bg-purple-100 flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 className="h-4 w-4 md:h-5 md:w-5 text-purple-600" />
                    </div>
                    <div>
                      <div className="font-medium text-sm md:text-base">Total Fulfillment Time</div>
                      <div className="text-xs md:text-sm text-muted-foreground">Claim to order completion</div>
                    </div>
                  </div>
                  <div className="text-xl md:text-2xl font-bold md:text-right">{formatTime(data.productivity.averageClaimToComplete)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="quality" className="space-y-4 md:space-y-6 mt-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <ScanLine className="h-4 w-4" />
                  Scan Pick Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold text-green-600">{formatPercent(data.quality.scanPickRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">Items verified by scan</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <Hand className="h-4 w-4" />
                  Manual Pick Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold text-amber-600">{formatPercent(data.quality.manualPickRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">Items confirmed manually</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Short Pick Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold text-red-600">{formatPercent(data.quality.shortPickRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">{data.quality.totalShortPicks} total shorts</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2 p-2 md:p-6 md:pb-2">
                <CardTitle className="text-xs md:text-sm font-medium text-muted-foreground flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4" />
                  Exception Rate
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 md:p-6 pt-0 md:pt-0">
                <div className="text-2xl md:text-3xl font-bold text-orange-600">{formatPercent(data.quality.exceptionRate)}</div>
                <p className="text-xs md:text-sm text-muted-foreground">{data.quality.totalExceptions} total exceptions</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Pick Method Breakdown</CardTitle>
              <CardDescription>How items are being verified during picking</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={[
                        { name: 'Scanned', value: data.quality.scanPickRate },
                        { name: 'Manual', value: data.quality.manualPickRate },
                        { name: 'Short', value: data.quality.shortPickRate }
                      ]}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={100}
                      label={({ name, value }) => `${name}: ${(value * 100).toFixed(1)}%`}
                    >
                      <Cell fill="#22c55e" />
                      <Cell fill="#f59e0b" />
                      <Cell fill="#ef4444" />
                    </Pie>
                    <Tooltip formatter={(value: number) => formatPercent(value)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pickers" className="space-y-6 mt-6">
          <Card>
            <CardHeader className="p-2 md:p-6">
              <CardTitle className="text-base md:text-lg">Picker Performance</CardTitle>
              <CardDescription className="text-xs md:text-sm">Individual picker statistics for selected period</CardDescription>
            </CardHeader>
            <CardContent className="p-2 md:p-6">
              {data.pickerPerformance.length > 0 ? (
                <>
                  {/* Mobile card layout */}
                  <div className="md:hidden space-y-3">
                    {data.pickerPerformance.map((picker) => (
                      <div key={picker.pickerId} className="border rounded-lg p-3">
                        <div className="font-medium text-sm mb-2">{picker.pickerName}</div>
                        <div className="grid grid-cols-2 gap-2 text-sm">
                          <div>
                            <span className="text-muted-foreground text-xs">Orders:</span>
                            <div>{picker.ordersCompleted}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">Items:</span>
                            <div>{picker.itemsPicked}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">Avg Time:</span>
                            <div>{formatTime(picker.avgPickTime)}</div>
                          </div>
                          <div>
                            <span className="text-muted-foreground text-xs">Shorts:</span>
                            <div>
                              {picker.shortPicks > 0 ? (
                                <Badge variant="destructive" className="text-xs">{picker.shortPicks}</Badge>
                              ) : (
                                <Badge variant="secondary" className="text-xs">0</Badge>
                              )}
                            </div>
                          </div>
                          <div className="col-span-2">
                            <span className="text-muted-foreground text-xs">Scan Rate:</span>
                            <div>
                              <Badge variant={picker.scanRate > 0.8 ? "default" : "secondary"} className="text-xs">
                                {formatPercent(picker.scanRate)}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {/* Desktop table layout */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-3 px-2 font-medium">Picker</th>
                          <th className="text-right py-3 px-2 font-medium">Orders</th>
                          <th className="text-right py-3 px-2 font-medium">Items</th>
                          <th className="text-right py-3 px-2 font-medium">Avg Pick Time</th>
                          <th className="text-right py-3 px-2 font-medium">Shorts</th>
                          <th className="text-right py-3 px-2 font-medium">Scan Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.pickerPerformance.map((picker) => (
                          <tr key={picker.pickerId} className="border-b hover:bg-muted/50">
                            <td className="py-3 px-2 font-medium">{picker.pickerName}</td>
                            <td className="text-right py-3 px-2">{picker.ordersCompleted}</td>
                            <td className="text-right py-3 px-2">{picker.itemsPicked}</td>
                            <td className="text-right py-3 px-2">{formatTime(picker.avgPickTime)}</td>
                            <td className="text-right py-3 px-2">
                              {picker.shortPicks > 0 ? (
                                <Badge variant="destructive">{picker.shortPicks}</Badge>
                              ) : (
                                <Badge variant="secondary">0</Badge>
                              )}
                            </td>
                            <td className="text-right py-3 px-2">
                              <Badge variant={picker.scanRate > 0.8 ? "default" : "secondary"}>
                                {formatPercent(picker.scanRate)}
                              </Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No picker data for selected period
                </div>
              )}
            </CardContent>
          </Card>

          {data.pickerPerformance.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Items Picked by Picker</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.pickerPerformance} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis type="number" />
                      <YAxis dataKey="pickerName" type="category" width={100} />
                      <Tooltip />
                      <Bar dataKey="itemsPicked" fill="#3b82f6" name="Items Picked" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
