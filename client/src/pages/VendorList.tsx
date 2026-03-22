import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Users, Search, RefreshCw, ChevronRight } from "lucide-react";

interface Vendor {
  id: number;
  name: string;
  company_name: string | null;
  email: string;
  status: string;
  tier: string;
  wallet_balance_cents: number;
  total_orders: number;
  ebay_connected: boolean;
  ebay_user_id: string | null;
  created_at: string;
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function statusColor(status: string): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active": return "default";
    case "pending": return "secondary";
    case "suspended": return "destructive";
    case "closed": return "outline";
    default: return "secondary";
  }
}

function tierColor(tier: string): "default" | "secondary" | "outline" {
  switch (tier) {
    case "elite": return "default";
    case "pro": return "secondary";
    default: return "outline";
  }
}

export default function VendorList() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(1);

  const { data, isLoading, refetch } = useQuery<{
    vendors: Vendor[];
    pagination: { page: number; limit: number; total: number; total_pages: number };
  }>({
    queryKey: ["/api/admin/vendors", { search, status: statusFilter, page }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("page", String(page));
      params.set("limit", "50");
      const res = await fetch(`/api/admin/vendors?${params}`);
      if (!res.ok) throw new Error("Failed to fetch vendors");
      return res.json();
    },
  });

  const vendors = data?.vendors || [];
  const pagination = data?.pagination;

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-full">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" />
          <h1 className="text-xl md:text-2xl font-bold">Dropship Vendors</h1>
          {pagination && (
            <Badge variant="secondary" className="ml-2">{pagination.total}</Badge>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw className="h-4 w-4 mr-1" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground h-4 w-4" />
              <Input
                placeholder="Search vendors..."
                className="pl-9"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(1); }}>
              <SelectTrigger className="w-full sm:w-[150px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="suspended">Suspended</SelectItem>
                <SelectItem value="closed">Closed</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : vendors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              No vendors found
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Vendor</TableHead>
                    <TableHead className="hidden md:table-cell">Email</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Tier</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="hidden md:table-cell text-right">Orders</TableHead>
                    <TableHead className="hidden lg:table-cell">eBay</TableHead>
                    <TableHead className="w-10"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vendors.map((v) => (
                    <TableRow
                      key={v.id}
                      className="cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate(`/vendors/${v.id}`)}
                    >
                      <TableCell>
                        <div>
                          <div className="font-medium">{v.name}</div>
                          {v.company_name && (
                            <div className="text-xs text-muted-foreground">{v.company_name}</div>
                          )}
                          <div className="text-xs text-muted-foreground md:hidden">{v.email}</div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm">{v.email}</TableCell>
                      <TableCell>
                        <Badge variant={statusColor(v.status)} className="capitalize text-xs">
                          {v.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Badge variant={tierColor(v.tier)} className="capitalize text-xs">
                          {v.tier}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatCents(v.wallet_balance_cents)}
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-right">{v.total_orders}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {v.ebay_connected ? (
                          <Badge variant="default" className="text-xs">Connected</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}

          {pagination && pagination.total_pages > 1 && (
            <div className="flex items-center justify-between p-4 border-t">
              <span className="text-sm text-muted-foreground">
                Page {pagination.page} of {pagination.total_pages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(page - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pagination.total_pages}
                  onClick={() => setPage(page + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
