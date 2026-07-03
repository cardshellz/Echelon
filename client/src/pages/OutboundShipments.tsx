import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDebounce } from "@/hooks/use-debounce";
import {
  Truck,
  Search,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types (API contract: GET /api/outbound-shipments)
// ---------------------------------------------------------------------------

type OutboundShipmentRow = {
  id: number;
  orderId: number;
  orderNumber: string | null;
  customerName: string | null;
  channelName: string | null;
  status: string;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  carrierCostCents: number | null;
};

type OutboundShipmentsResponse = {
  rows: OutboundShipmentRow[];
  total: number;
  summary: {
    byCarrier: Array<{ carrier: string | null; count: number }>;
    byStatus: Array<{ status: string; count: number }>;
  };
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STATUS_BADGES: Record<
  string,
  { variant: "default" | "secondary" | "outline" | "destructive"; label: string; color?: string }
> = {
  shipped: { variant: "default", label: "Shipped", color: "bg-green-600" },
  queued: { variant: "secondary", label: "Queued" },
  planned: { variant: "secondary", label: "Planned" },
  cancelled: { variant: "destructive", label: "Cancelled" },
  voided: { variant: "outline", label: "Voided", color: "text-red-600 border-red-300" },
};

const STATUS_OPTIONS = [
  { value: "all", label: "All Statuses" },
  { value: "shipped", label: "Shipped" },
  { value: "queued", label: "Queued" },
  { value: "planned", label: "Planned" },
  { value: "cancelled", label: "Cancelled" },
  { value: "voided", label: "Voided" },
];

const DAYS_OPTIONS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "365", label: "Last 365 days" },
];

const DEFAULT_CARRIERS = ["USPS", "UPS", "FedEx", "DHL"];

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatShippedDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderStatusBadge(status: string) {
  const config = STATUS_BADGES[status];
  if (!config) return <Badge variant="secondary">{status}</Badge>;
  return (
    <Badge variant={config.variant} className={config.color || ""}>
      {config.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function OutboundShipments() {
  const [search, setSearch] = useState("");
  const [carrierFilter, setCarrierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [days, setDays] = useState("30");
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search.trim(), 300);

  // Full-URL-string query key: every param is part of the key string.
  const params = new URLSearchParams();
  if (debouncedSearch) params.set("search", debouncedSearch);
  if (carrierFilter !== "all") params.set("carrier", carrierFilter);
  if (statusFilter !== "all") params.set("status", statusFilter);
  params.set("days", days);
  params.set("page", String(page));
  params.set("pageSize", String(PAGE_SIZE));
  const url = `/api/outbound-shipments?${params.toString()}`;

  const { data, isLoading, isError } = useQuery<OutboundShipmentsResponse>({
    queryKey: [url],
    queryFn: async () => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch outbound shipments");
      return res.json();
    },
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const byCarrier = data?.summary?.byCarrier ?? [];
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  // Carrier select: defaults + whatever the API actually returned.
  const carrierOptions = [...DEFAULT_CARRIERS];
  for (const entry of byCarrier) {
    if (!entry.carrier) continue;
    if (!carrierOptions.some((c) => c.toLowerCase() === entry.carrier!.toLowerCase())) {
      carrierOptions.push(entry.carrier);
    }
  }

  const hasActiveFilters =
    debouncedSearch !== "" || carrierFilter !== "all" || statusFilter !== "all";

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="h-6 w-6" />
            Shipments
          </h1>
          <p className="text-muted-foreground text-sm">
            Outbound shipments across all channels and carriers
          </p>
        </div>
      </div>

      {/* Summary cards: filtered total + per-carrier counts (summary is stable
          across the carrier/status filters — it respects search + days only). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 md:gap-4">
        <Card>
          <CardContent className="p-3 md:p-4">
            <div className="text-xl md:text-2xl font-bold">
              {isLoading ? <Skeleton className="h-7 w-12" /> : total.toLocaleString()}
            </div>
            <div className="text-xs md:text-sm text-muted-foreground">Total Shipments</div>
          </CardContent>
        </Card>
        {byCarrier.map((entry) => (
          <Card key={entry.carrier ?? "__unknown__"}>
            <CardContent className="p-3 md:p-4">
              <div className="text-xl md:text-2xl font-bold">{entry.count.toLocaleString()}</div>
              <div className="text-xs md:text-sm text-muted-foreground">
                {entry.carrier || "No Carrier"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search order #, tracking, customer..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-9 h-10"
          />
        </div>
        <Select
          value={carrierFilter}
          onValueChange={(v) => {
            setCarrierFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-40 h-10">
            <SelectValue placeholder="Carrier" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Carriers</SelectItem>
            {carrierOptions.map((carrier) => (
              <SelectItem key={carrier} value={carrier}>
                {carrier}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-40 h-10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={days}
          onValueChange={(v) => {
            setDays(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-full sm:w-40 h-10">
            <SelectValue placeholder="Time range" />
          </SelectTrigger>
          <SelectContent>
            {DAYS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead className="w-[110px]">Status</TableHead>
                <TableHead className="w-[100px]">Carrier</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead className="w-[170px]">Shipped</TableHead>
                <TableHead className="w-[100px] text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-4 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-16" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-40" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-28" /></TableCell>
                    <TableCell><Skeleton className="h-4 w-12 ml-auto" /></TableCell>
                  </TableRow>
                ))
              ) : isError ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Failed to load shipments. Try refreshing the page.
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    {hasActiveFilters
                      ? "No shipments match your filters."
                      : "No outbound shipments found in this time range."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      {row.orderId ? (
                        <Link
                          href={`/orders?orderId=${row.orderId}`}
                          className="font-mono text-sm text-primary hover:underline"
                        >
                          {row.orderNumber || `#${row.orderId}`}
                        </Link>
                      ) : (
                        <span className="font-mono text-sm">{row.orderNumber || "—"}</span>
                      )}
                      {row.channelName && (
                        <div className="text-xs text-muted-foreground">{row.channelName}</div>
                      )}
                    </TableCell>
                    <TableCell className="truncate max-w-[200px]">
                      {row.customerName || "—"}
                    </TableCell>
                    <TableCell>{renderStatusBadge(row.status)}</TableCell>
                    <TableCell>{row.carrier || "—"}</TableCell>
                    <TableCell>
                      {row.trackingNumber ? (
                        row.trackingUrl ? (
                          <a
                            href={row.trackingUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-sm inline-flex items-center gap-1 text-primary hover:underline"
                          >
                            {row.trackingNumber}
                            <ExternalLink className="h-3 w-3 shrink-0" />
                          </a>
                        ) : (
                          <span className="font-mono text-sm">{row.trackingNumber}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.shippedAt ? formatShippedDate(row.shippedAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {row.carrierCostCents ? (
                        formatCents(row.carrierCostCents)
                      ) : (
                        <span
                          className="text-muted-foreground"
                          title="Actual costs arrive with first-party label capture"
                        >
                          —
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Pagination */}
      {!isLoading && total > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
            {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline ml-1">Previous</span>
            </Button>
            <span className="text-sm">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <span className="hidden sm:inline mr-1">Next</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
