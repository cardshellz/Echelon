import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, RotateCcw, Search } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  queryErrorMessage,
  type DropshipReturnListItem,
  type DropshipReturnListResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

const statuses = ["all", "requested", "in_transit", "received", "inspecting", "approved", "rejected", "credited", "closed"];

export default function DropshipPortalReturns() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [applied, setApplied] = useState({ search: "", status: "all" });
  const returnsUrl = useMemo(() => buildQueryUrl("/api/dropship/returns", {
    search: applied.search,
    statuses: applied.status === "all" ? undefined : applied.status,
    page: 1,
    limit: 50,
  }), [applied]);
  const returnsQuery = useQuery<DropshipReturnListResponse>({
    queryKey: [returnsUrl],
    queryFn: () => fetchJson<DropshipReturnListResponse>(returnsUrl),
  });

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <RotateCcw className="h-6 w-6 text-[#C060E0]" />
              Returns
            </h1>
            <p className="mt-1 text-sm text-zinc-500">RMA status, inspection progress, and final credit outcomes.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 sm:w-80">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9" placeholder="Search RMAs" />
            </div>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((option) => (
                  <SelectItem key={option} value={option}>{option === "all" ? "All statuses" : formatStatus(option)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={() => setApplied({ search, status })}>
              Apply
            </Button>
          </div>
        </div>

        {returnsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(returnsQuery.error, "Unable to load dropship returns.")}
            </AlertDescription>
          </Alert>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {returnsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : returnsQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Returns unavailable</EmptyTitle>
                <EmptyDescription>The returns API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : returnsQuery.data?.items.length ? (
            <ReturnsTable returns={returnsQuery.data.items} total={returnsQuery.data.total} />
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><RotateCcw /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No returns</EmptyTitle>
                <EmptyDescription>No dropship RMAs match the current filters.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DropshipPortalShell>
  );
}

function ReturnsTable({ returns, total }: { returns: DropshipReturnListItem[]; total: number }) {
  return (
    <>
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 text-sm text-zinc-500">
        <span>{total} return{total === 1 ? "" : "s"}</span>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>RMA</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fault</TableHead>
            <TableHead>Items</TableHead>
            <TableHead>Tracking</TableHead>
            <TableHead>Updated</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {returns.map((rma) => (
            <TableRow key={rma.rmaId}>
              <TableCell>
                <div className="font-medium">{rma.rmaNumber}</div>
                <div className="text-xs text-zinc-500">{rma.reasonCode ? formatStatus(rma.reasonCode) : "No reason"}</div>
              </TableCell>
              <TableCell><Badge variant="outline">{formatStatus(rma.status)}</Badge></TableCell>
              <TableCell>{rma.faultCategory ? formatStatus(rma.faultCategory) : "Pending"}</TableCell>
              <TableCell className="font-mono">{rma.itemCount} / {rma.totalQuantity}</TableCell>
              <TableCell className="font-mono text-xs">{rma.returnTrackingNumber || "None"}</TableCell>
              <TableCell className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(rma.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
