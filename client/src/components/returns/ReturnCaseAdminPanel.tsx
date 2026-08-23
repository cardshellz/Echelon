import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import { OpenReturnCaseDialog } from "./OpenReturnCaseDialog";
import { ReturnCaseOperationsCard } from "./ReturnCaseOperationsCard";
import {
  getReturnCaseDetail,
  type ReturnCaseDetail,
} from "./return-case-admin-api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface ReturnCaseSummary {
  recordOrigin: "canonical" | "legacy_dropship";
  recordKey: string;
  legacyRmaId: number | null;
  id: number;
  caseNumber: string;
  sourceProvider: string;
  sourceEventType: string;
  sourceEventId: string;
  businessContext: string;
  channelName: string | null;
  vendorName: string | null;
  storeName: string | null;
  omsOrderId: number | null;
  omsOrderNumber: string | null;
  wmsOrderId: number | null;
  wmsOrderNumber: string | null;
  wmsReturnId: number | null;
  caseStatus: string;
  approvalStatus: string;
  logisticsStatus: string;
  inspectionStatus: string;
  customerRefundStatus: string;
  vendorSettlementStatus: string;
  openedAt: string;
  closedAt: string | null;
  itemCount: number;
  unitCount: number;
}

interface ReturnCaseListResponse {
  cases: ReturnCaseSummary[];
  summary: {
    total: number;
    open: number;
    awaitingInspection: number;
    closed: number;
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}


const PAGE_SIZE = 25;

export function ReturnCaseAdminPanel({
  onOpenLegacyRma,
}: {
  onOpenLegacyRma?: (rmaId: number) => void;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [caseStatus, setCaseStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [openCaseDialog, setOpenCaseDialog] = useState(false);
  const queryClient = useQueryClient();

  const listUrl = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (search) params.set("search", search);
    if (caseStatus !== "all") params.set("caseStatus", caseStatus);
    return `/api/returns/admin/cases?${params.toString()}`;
  }, [caseStatus, page, search]);

  const listQuery = useQuery<ReturnCaseListResponse>({
    queryKey: ["return-cases", listUrl],
    queryFn: () => fetchJson<ReturnCaseListResponse>(listUrl),
  });

  const detailQuery = useQuery<ReturnCaseDetail>({
    queryKey: ["return-case", selectedCaseId],
    queryFn: () => {
      if (selectedCaseId === null) {
        throw new Error("A return case must be selected before loading its details.");
      }
      return getReturnCaseDetail(selectedCaseId);
    },
    enabled: selectedCaseId !== null,
  });

  const applyFilters = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const openRma = (returnCase: ReturnCaseSummary) => {
    if (returnCase.recordOrigin === "legacy_dropship") {
      if (returnCase.legacyRmaId === null || !onOpenLegacyRma) return;
      onOpenLegacyRma(returnCase.legacyRmaId);
      return;
    }
    setSelectedCaseId(returnCase.id);
  };

  const refreshReturnCase = async (caseId: number): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["return-case", caseId], exact: true }),
      queryClient.invalidateQueries({ queryKey: ["return-cases"] }),
    ]);
  };

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="All RMAs" value={listQuery.data?.summary.total ?? 0} />
        <SummaryCard label="Open" value={listQuery.data?.summary.open ?? 0} />
        <SummaryCard label="Awaiting inspection" value={listQuery.data?.summary.awaitingInspection ?? 0} />
        <SummaryCard label="Closed" value={listQuery.data?.summary.closed ?? 0} />
      </div>
      <Card>
        <CardHeader className="p-3 pb-2 md:p-4 md:pb-2">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle className="text-base">RMAs</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Lifecycle records across all sales channels.
              </p>
            </div>
            <div className="flex w-full flex-col gap-2 sm:flex-row md:w-auto">
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && applyFilters()}
                placeholder="RMA, order, source, vendor, or store"
                className="h-9 sm:w-72"
              />
              <Select
                value={caseStatus}
                onValueChange={(value) => {
                  setCaseStatus(value);
                  setPage(1);
                }}
              >
                <SelectTrigger className="h-9 sm:w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                  <SelectItem value="exception">Exception</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
              <Button onClick={applyFilters} size="sm" variant="outline" className="h-9">
                <Search className="mr-2 h-4 w-4" />
                Apply
              </Button>
              <Button onClick={() => setOpenCaseDialog(true)} size="sm" className="h-9">
                <Plus className="mr-2 h-4 w-4" />
                Create RMA
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {listQuery.isLoading ? (
            <PanelMessage>Loading RMAs...</PanelMessage>
          ) : listQuery.isError ? (
            <PanelMessage tone="error">RMAs could not be loaded.</PanelMessage>
          ) : listQuery.data?.cases.length === 0 ? (
            <PanelMessage>No RMAs match the current filters.</PanelMessage>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>RMA</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Return</TableHead>
                    <TableHead>Inspection</TableHead>
                    <TableHead>Refund</TableHead>
                    <TableHead>Opened</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {listQuery.data?.cases.map((returnCase) => (
                    <TableRow
                      key={returnCase.recordKey}
                      className="cursor-pointer"
                      tabIndex={0}
                      onClick={() => openRma(returnCase)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openRma(returnCase);
                        }
                      }}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{returnCase.caseNumber}</span>
                          {returnCase.recordOrigin === "legacy_dropship" && (
                            <Badge variant="outline">Historical</Badge>
                          )}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {returnCase.itemCount} line{plural(returnCase.itemCount)} / {returnCase.unitCount} unit{plural(returnCase.unitCount)}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div>{titleCase(returnCase.sourceProvider)}</div>
                        <div className="text-xs text-muted-foreground">{returnCase.channelName ?? "Channel not recorded"}</div>
                      </TableCell>
                      <TableCell>
                        <div>{returnCase.omsOrderNumber ?? (returnCase.omsOrderId ? `OMS ${returnCase.omsOrderId}` : "Order not linked")}</div>
                        <div className="text-xs text-muted-foreground">
                          {returnCase.wmsOrderNumber ? `WMS ${returnCase.wmsOrderNumber}` : "WMS order not linked"}
                        </div>
                      </TableCell>
                      <TableCell><StatusBadge value={returnCase.caseStatus} /></TableCell>
                      <TableCell><StatusBadge value={returnCase.logisticsStatus} /></TableCell>
                      <TableCell><StatusBadge value={returnCase.inspectionStatus} /></TableCell>
                      <TableCell><StatusBadge value={returnCase.customerRefundStatus} /></TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(returnCase.openedAt)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {listQuery.data && listQuery.data.pagination.total > 0 && (
            <div className="flex items-center justify-between border-t px-3 py-2 text-sm md:px-4">
              <span className="text-muted-foreground">
                {listQuery.data.pagination.total} RMA{plural(listQuery.data.pagination.total)}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  title="Previous page"
                  disabled={page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span>Page {page} of {Math.max(1, listQuery.data.pagination.totalPages)}</span>
                <Button
                  size="icon"
                  variant="outline"
                  className="h-8 w-8"
                  title="Next page"
                  disabled={page >= listQuery.data.pagination.totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={selectedCaseId !== null} onOpenChange={(open) => !open && setSelectedCaseId(null)}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{detailQuery.data?.caseNumber ?? "RMA"}</DialogTitle>
            <DialogDescription>
              Operational actions, lifecycle state, source records, policy, items, and event evidence.
            </DialogDescription>
          </DialogHeader>
          {detailQuery.isLoading ? (
            <PanelMessage>Loading RMA details...</PanelMessage>
          ) : detailQuery.isError || !detailQuery.data ? (
            <PanelMessage tone="error">RMA details could not be loaded.</PanelMessage>
          ) : (
            <ReturnCaseDetailBody
              detail={detailQuery.data}
              onOperationCompleted={refreshReturnCase}
            />
          )}
        </DialogContent>
      </Dialog>

      <OpenReturnCaseDialog
        open={openCaseDialog}
        onOpenChange={setOpenCaseDialog}
        onCreated={(result) => {
          setOpenCaseDialog(false);
          setSelectedCaseId(result.caseId);
          void queryClient.invalidateQueries({ queryKey: ["return-cases"] });
        }}
      />
    </>
  );
}

function ReturnCaseDetailBody({
  detail,
  onOperationCompleted,
}: {
  detail: ReturnCaseDetail;
  onOperationCompleted(caseId: number): Promise<void>;
}) {
  const lifecycle = [
    ["RMA", detail.caseStatus],
    ["Approval", detail.approvalStatus],
    ["Return", detail.logisticsStatus],
    ["Inspection", detail.inspectionStatus],
    ["Customer refund", detail.customerRefundStatus],
    ["Vendor settlement", detail.vendorSettlementStatus],
  ];
  return (
    <div className="space-y-5">
      <ReturnCaseOperationsCard
        returnCaseId={detail.id}
        actionPlan={detail.actionPlan}
        items={detail.items}
        onOperationCompleted={() => {
          void onOperationCompleted(detail.id);
        }}
        onRefreshRequested={() => onOperationCompleted(detail.id)}
      />

      <section>
        <h3 className="mb-2 text-sm font-semibold">Lifecycle</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {lifecycle.map(([label, value]) => (
            <div key={label} className="border px-3 py-2">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="mt-1"><StatusBadge value={value} /></div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Reference label="Source" value={`${titleCase(detail.sourceProvider)} ${detail.sourceEventType} ${detail.sourceEventId}`} />
        <Reference label="OMS order" value={detail.omsOrderNumber ?? (detail.omsOrderId ? String(detail.omsOrderId) : "Not linked")} />
        <Reference label="WMS order" value={detail.wmsOrderNumber ?? "Not linked"} />
        <Reference label="WMS return" value={detail.wmsReturnId ? String(detail.wmsReturnId) : "Not linked"} />
        <Reference label="Channel" value={detail.channelName ?? "Not recorded"} />
        <Reference label="Vendor" value={detail.vendorName || "Not applicable"} />
        <Reference label="Store" value={detail.storeName || "Not applicable"} />
        <Reference label="Opened" value={formatDateTime(detail.openedAt)} />
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Items</h3>
        <div className="overflow-x-auto border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit paid</TableHead>
                <TableHead className="text-right">Source total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.title || item.externalLineItemId || "Unnamed line"}</TableCell>
                  <TableCell>{item.sku || "Not provided"}</TableCell>
                  <TableCell className="text-right">{item.quantity}</TableCell>
                  <TableCell className="text-right">{formatCents(item.unitPaidPriceCents)}</TableCell>
                  <TableCell className="text-right">{formatCents(item.sourceLineTotalCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Policy snapshot</h3>
        <div className="border p-3">
          <div className="mb-2 text-xs text-muted-foreground">Policy {detail.policyId}, version {detail.policyVersion}</div>
          <pre className="overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(detail.policySnapshot, null, 2)}</pre>
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Event history</h3>
        <div className="divide-y border">
          {detail.events.length === 0 ? (
            <div className="p-3 text-sm text-muted-foreground">No events recorded.</div>
          ) : detail.events.map((event) => (
            <div key={event.id} className="grid gap-1 p-3 text-sm sm:grid-cols-[180px_1fr]">
              <div className="text-muted-foreground">{formatDateTime(event.occurredAt)}</div>
              <div>
                <div className="font-medium">{titleCase(event.eventType)}</div>
                <div className="text-xs text-muted-foreground">Actor: {event.actor}</div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs">{JSON.stringify(event.details, null, 2)}</pre>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

function Reference({ label, value }: { label: string; value: string }) {
  return (
    <div className="border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 break-words text-sm font-medium">{value}</div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase();
  const variant = normalized === "failed" || normalized === "rejected" || normalized === "exception"
    ? "destructive"
    : "outline";
  return <Badge variant={variant}>{titleCase(value)}</Badge>;
}

function PanelMessage({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "error" }) {
  return (
    <div className={`border-t p-6 text-center text-sm ${tone === "error" ? "text-destructive" : "text-muted-foreground"}`}>
      {children}
    </div>
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `Request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString();
  const remainder = String(absolute % 100).padStart(2, "0");
  return `${sign}$${dollars}.${remainder}`;
}

function titleCase(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function plural(value: number): string {
  return value === 1 ? "" : "s";
}
