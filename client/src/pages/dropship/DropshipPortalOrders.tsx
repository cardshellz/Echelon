import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ClipboardList, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  buildQueryUrl,
  fetchJson,
  formatDateTime,
  formatStatus,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

const statusOptions = [
  "all",
  "received",
  "processing",
  "accepted",
  "payment_hold",
  "failed",
  "exception",
  "rejected",
  "cancelled",
];

export default function DropshipPortalOrders() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const ordersUrl = useMemo(() => buildQueryUrl("/api/dropship/orders", {
    search: applied.search,
    statuses: applied.status === "all" ? undefined : applied.status,
    page: 1,
    limit: 50,
  }), [applied]);
  const ordersQuery = useQuery<DropshipOrderListResponse>({
    queryKey: [ordersUrl],
    queryFn: () => fetchJson<DropshipOrderListResponse>(ordersUrl),
  });

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <ClipboardList className="h-6 w-6 text-[#C060E0]" />
              Orders
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Marketplace intake, acceptance, payment holds, and fulfillment handoff status.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search orders" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statusOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : formatStatus(option)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, status })}>
              Apply
            </Button>
          </div>
        </div>

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {ordersQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : ordersQuery.data?.items.length ? (
            <OrdersTable orders={ordersQuery.data.items} total={ordersQuery.data.total} />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><ClipboardList /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No orders</EmptyTitle>
                <EmptyDescription>No dropship orders match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DropshipPortalShell>
  );
}

function OrdersTable({ orders, total }: { orders: DropshipOrderListItem[]; total: number }) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} order{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Marketplace order</TableHead>
            <TableHead>Store</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Ship to</TableHead>
            <TableHead>Lines</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.map((order) => (
            <TableRow key={order.intakeId}>
              <TableCell>
                <div className="font-medium">{order.externalOrderNumber || order.externalOrderId}</div>
                <div className="text-xs text-zinc-500">{formatStatus(order.platform)} intake {order.intakeId}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{order.storeConnection.externalDisplayName || formatStatus(order.storeConnection.platform)}</div>
                <div className="text-xs text-zinc-500">{order.storeConnection.shopDomain || formatStatus(order.storeConnection.status)}</div>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={statusTone(order.status)}>{formatStatus(order.status)}</Badge>
                {order.rejectionReason && <div className="mt-1 max-w-60 truncate text-xs text-zinc-500">{order.rejectionReason}</div>}
              </TableCell>
              <TableCell>{shipToLabel(order)}</TableCell>
              <TableCell className="font-mono">{order.lineCount} / {order.totalQuantity}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(order.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function shipToLabel(order: DropshipOrderListItem): string {
  const shipTo = order.shipTo;
  if (!shipTo) return "None";
  const locality = [shipTo.city, shipTo.region, shipTo.postalCode].filter(Boolean).join(", ");
  return locality || shipTo.country || shipTo.name || "Available";
}

function statusTone(status: string): string {
  if (status === "accepted" || status === "processing") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "payment_hold" || status === "retrying") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "failed" || status === "exception" || status === "rejected") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
