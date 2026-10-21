// RFQ request tracking, immutable quote capture, and reviewed draft PO handoff.
import { RfqWorkflowPanel } from "@/features/purchasing/RfqWorkflowPanel";
import React, { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import { rfqWorkListQuerySchema, rfqWorkListResponseSchema, rfqStoredStatusSchema, type RfqWorkListItem } from "@shared/procurement/rfq-work-list";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkListPagination } from "@/features/purchasing/WorkListPagination";
import { useRfqCommands } from "@/features/purchasing/use-rfq-commands";
import { RfqCommandRecovery } from "@/features/purchasing/RfqCommandRecovery";
import { formatMills } from "@shared/utils/money";
import { ChevronDown, ChevronRight, ClipboardList, ExternalLink, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ---------------------------------------------------------------------------
// API types — client-side mirrors of the real server responses.
// ---------------------------------------------------------------------------

type RfqListItem = RfqWorkListItem;

// GET /api/purchasing/rfq-queue — the existing requirement-queue read the
// Order Builder also consumes (purchasing-recommendation.routes.ts). Only the
// fields this page renders.
interface RfqQueueAllocation {
  rfqId: number;
  rfqNumber: string;
  rfqStatus: string;
  lineStatus: string;
  requestedPieces: number;
  reservedPieces: number;
  vendorName: string | null;
}

interface RfqQueueItem {
  recommendationLineId: number;
  sku: string;
  productName: string;
  recommendedPieces: number;
  allocatedPieces: number;
  remainingPieces: number;
  excessPieces: number;
  sourcingStatus: "open" | "partially_allocated" | "fully_allocated";
  supplierAssignmentRequired: boolean;
  preferredVendorName: string | null;
  allocations: RfqQueueAllocation[];
}

interface RfqQueueResponse {
  run: { id: number } | null;
  generatedAt: string | null;
  summary: {
    total: number;
    open: number;
    partiallyAllocated: number;
    fullyAllocated: number;
    supplierAssignmentRequired: number;
    activeRfqs: number;
    aboveRecommendation: number;
    excessPieces: number;
  };
  items: RfqQueueItem[];
}

const RFQ_LIST_LIMIT = 25;

// ---------------------------------------------------------------------------
// Status presentation — full schema enums so a row that ever carries a
// post-draft status renders honestly instead of falling back to a mystery
// chip. Unknown values still render (label as-is, neutral style).
// ---------------------------------------------------------------------------

const RFQ_STATUS_BADGE: Record<string, string> = {
  draft: "border-zinc-200 bg-zinc-50 text-zinc-700",
  sent: "border-blue-200 bg-blue-50 text-blue-700",
  partially_quoted: "border-amber-200 bg-amber-50 text-amber-700",
  quoted: "border-violet-200 bg-violet-50 text-violet-700",
  declined: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-zinc-200 bg-zinc-100 text-zinc-500",
  expired: "border-amber-300 bg-amber-50 text-amber-800",
};

const RFQ_LINE_STATUS_BADGE: Record<string, string> = {
  draft: "border-zinc-200 bg-zinc-50 text-zinc-600",
  sent: "border-blue-200 bg-blue-50 text-blue-700",
  quoted: "border-violet-200 bg-violet-50 text-violet-700",
  declined: "border-red-200 bg-red-50 text-red-700",
  cancelled: "border-zinc-200 bg-zinc-100 text-zinc-500",
  accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
  ordered: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const SOURCING_STATUS_BADGE: Record<RfqQueueItem["sourcingStatus"], { label: string; className: string }> = {
  open: { label: "Open", className: "border-amber-200 bg-amber-50 text-amber-800" },
  partially_allocated: { label: "Partially allocated", className: "border-blue-200 bg-blue-50 text-blue-700" },
  fully_allocated: { label: "Fully allocated", className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
};

function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

function rfqStatusClass(status: string): string {
  return RFQ_STATUS_BADGE[status] ?? "border-zinc-200 bg-zinc-50 text-zinc-600";
}

function lineStatusClass(status: string): string {
  return RFQ_LINE_STATUS_BADGE[status] ?? "border-zinc-200 bg-zinc-50 text-zinc-600";
}

// Timestamps render via the viewer's locale; date-only strings (response due
// dates, quote validity) render verbatim — parsing "YYYY-MM-DD" through
// Date() shifts a day in negative-UTC-offset timezones.
function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

function formatDateOnly(value: string | null): string {
  return value ?? "—";
}

// Quoted unit cost stays integer mills end-to-end — the shared formatMills
// helper renders by integer digit math (no float division on money). The RFQ
// schema allows any ISO-4217 code (request_for_quotes_currency_chk), so a
// non-USD row labels its code instead of dishonestly implying "$".
function formatQuotedUnitCost(mills: number, currency: string): string {
  const usd = formatMills(mills);
  return currency === "USD" ? usd : `${usd.slice(1)} ${currency}`;
}

// ---------------------------------------------------------------------------
// Per-RFQ line detail (expanded row)
// ---------------------------------------------------------------------------

function RfqLineDetail({ rfq, readVerified }: { rfq: RfqListItem; readVerified: boolean }) {
  return (
    <div className="rounded-md border bg-zinc-50/60 p-2 dark:bg-zinc-900/40">
      {rfq.requestNote && (
        <div className="mb-2 px-1 text-xs text-zinc-600 dark:text-zinc-300">
          <span className="font-medium">Request note:</span> {rfq.requestNote}
        </div>
      )}
      <div className="overflow-x-auto"><table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500">
            <th className="px-1 py-1 font-medium">SKU</th>
            <th className="px-1 py-1 font-medium">Product</th>
            <th className="px-1 py-1 font-medium">Vendor SKU</th>
            <th className="px-1 py-1 text-right font-medium">Requested</th>
            <th className="px-1 py-1 text-right font-medium">Recommended</th>
            <th className="px-1 py-1 font-medium">Status</th>
            <th className="px-1 py-1 font-medium">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {rfq.lines.map((line) => {
            const overAllocated = line.allocationOverrideApprovedBy != null;
            const hasQuantityOverride = line.quantityOverrideReason != null && !overAllocated;
            const hasQuoteEvidence =
              line.quotedPieces != null
              || line.quotedUnitCostMills != null
              || line.quoteReference != null
              || line.quotedAt != null;
            return (
              <tr key={line.id} className="border-t border-zinc-200/70 align-top dark:border-zinc-800">
                <td className="px-1 py-1.5 font-mono font-semibold">{line.sku}</td>
                <td className="px-1 py-1.5">{line.productName}</td>
                <td className="px-1 py-1.5 text-zinc-500">{line.vendorSku ?? "—"}</td>
                <td className="px-1 py-1.5 text-right tabular-nums">
                  {line.requestedPieces.toLocaleString()} pc
                  {line.piecesPerPurchaseUom != null && line.purchaseUom && (
                    <div className="text-[10px] text-zinc-500">
                      {line.piecesPerPurchaseUom.toLocaleString()} pc/{line.purchaseUom}
                    </div>
                  )}
                </td>
                <td className="px-1 py-1.5 text-right tabular-nums text-zinc-500">
                  {line.recommendedPieces == null ? "—" : `${line.recommendedPieces.toLocaleString()} pc`}
                </td>
                <td className="px-1 py-1.5">
                  <Badge variant="outline" className={`text-[10px] capitalize ${lineStatusClass(line.status)}`}>
                    {statusLabel(line.status)}
                  </Badge>
                </td>
                <td className="px-1 py-1.5">
                  {/* Override evidence indicators — the audited reasons captured
                      at draft time (migration 158 contract). */}
                  {overAllocated && (
                    <div className="text-amber-700">
                      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                        Over-allocation approved
                      </Badge>
                      <div className="mt-0.5 text-[11px]">
                        +{(line.allocationOverrideExcessPieces ?? 0).toLocaleString()} pc above the{" "}
                        {(line.allocationOverrideBaselinePieces ?? 0).toLocaleString()}-pc baseline · approved by{" "}
                        {line.allocationOverrideApprovedBy}
                      </div>
                      {line.allocationOverrideReason && (
                        <div className="text-[11px] text-zinc-600 dark:text-zinc-300">
                          “{line.allocationOverrideReason}”
                        </div>
                      )}
                    </div>
                  )}
                  {hasQuantityOverride && (
                    <div className="text-amber-700">
                      <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-700">
                        Qty override
                      </Badge>
                      <div className="mt-0.5 text-[11px] text-zinc-600 dark:text-zinc-300">
                        “{line.quantityOverrideReason}”
                      </div>
                    </div>
                  )}
                  {hasQuoteEvidence && (
                    <div className="mt-0.5 text-[11px] text-violet-700">
                      Quoted{line.quotedPieces != null ? ` ${line.quotedPieces.toLocaleString()} pc` : ""}
                      {line.quotedUnitCostMills != null
                        ? ` · ${formatQuotedUnitCost(line.quotedUnitCostMills, rfq.currency)}/pc`
                        : ""}
                      {line.quoteReference ? ` · ref ${line.quoteReference}` : ""}
                      {line.quoteValidUntil ? ` · valid until ${formatDateOnly(line.quoteValidUntil)}` : ""}
                    </div>
                  )}
                  {!overAllocated && !hasQuantityOverride && !hasQuoteEvidence && (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {rfq.lines.length === 0 && (
            <tr className="border-t border-zinc-200/70 dark:border-zinc-800">
              <td colSpan={7} className="px-1 py-2 text-zinc-500">
                No lines recorded for this request.
              </td>
            </tr>
          )}
        </tbody>
      </table></div>
      <RfqWorkflowPanel rfqId={rfq.id} showRecovery={false} sourceVerified={readVerified} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ProcurementRfqs() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const commands = useRfqCommands();
  const params = new URLSearchParams(search);
  const requestedId = params.get("rfqId");
  const parsedId = requestedId && /^[1-9]\d*$/.test(requestedId) ? Number(requestedId) : null;
  const focusedRfqId = parsedId !== null && Number.isSafeInteger(parsedId) && parsedId <= 2_147_483_647
    && params.getAll("rfqId").length === 1 ? parsedId : null;
  const listFilter = rfqWorkListQuerySchema.safeParse({ limit: RFQ_LIST_LIMIT,
    offset: params.get("offset") ?? 0, status: params.get("status") || undefined, search: params.get("search") ?? "" });
  const repeatedFilter = ["offset", "status", "search"].some(key => params.getAll(key).length > 1);
  const validFilter = listFilter.success && !repeatedFilter;
  const query = listFilter.success ? listFilter.data : null;
  const listUrl = query ? `/api/purchasing/rfqs?${new URLSearchParams({ limit: String(query.limit), offset: String(query.offset),
    ...(query.status ? { status: query.status } : {}), ...(query.search ? { search: query.search } : {}) })}` : "";
  // Open editors belong to the operator, not to a transient result page.
  // Keeping them outside the row tree preserves drafts across refetch/filter changes.
  const [opened, setOpened] = useState<{ actorId: string | null; requests: Map<number, RfqListItem> }>(() => ({ actorId: user?.id ?? null, requests: new Map() }));
  const openedRfqs = opened.actorId === user?.id ? opened.requests : new Map<number, RfqListItem>();
  const changeFilter = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    navigate(`/procurement/rfqs${next.size ? `?${next}` : ""}`, { replace: true });
  };
  const rfqListQuery = useQuery({
    queryKey: [listUrl, user?.id], enabled: validFilter && !!user, retry: false, staleTime: 0,
    queryFn: async ({ signal }) => {
      const response = await fetch(listUrl, { credentials: "include", signal });
      if (!response.ok) throw new Error(`Quote requests could not be loaded (${response.status}). Retry after restoring access.`);
      const result = rfqWorkListResponseSchema.safeParse(await response.json());
      if (!result.success || !query || result.data.page.limit !== query.limit || result.data.page.offset !== query.offset
        || (query.status && result.data.rfqs.some(rfq => rfq.status !== query.status))) {
        throw new Error("The quote-request list could not be verified. Reload the list before continuing.");
      }
      return result.data;
    },
  });
  const rfqQueueQuery = useQuery<RfqQueueResponse>({ queryKey: ["/api/purchasing/rfq-queue"], retry: false });
  const listVerified = validFilter && !!rfqListQuery.data && !rfqListQuery.isFetching && !rfqListQuery.isError;
  const rfqs = listVerified ? rfqListQuery.data?.rfqs ?? [] : [];
  const statusCounts = listVerified ? rfqListQuery.data?.statusCounts ?? {} : {};
  const queue = !rfqQueueQuery.isFetching && !rfqQueueQuery.isError ? rfqQueueQuery.data ?? null : null;

  // Presentation-only ordering: what still needs sourcing first (open, then
  // partial, then covered), biggest remaining gap on top. No planning math is
  // recomputed here — every number comes from the server.
  const queueItems = useMemo(() => {
    const rank: Record<RfqQueueItem["sourcingStatus"], number> = {
      open: 0,
      partially_allocated: 1,
      fully_allocated: 2,
    };
    return [...(queue?.items ?? [])].sort(
      (left, right) =>
        rank[left.sourcingStatus] - rank[right.sourcingStatus]
        || right.remainingPieces - left.remainingPieces
        || left.sku.localeCompare(right.sku),
    );
  }, [queue?.items]);

  const toggleExpanded = (rfq: RfqListItem) => {
    setOpened(current => {
      const requests = new Map(current.actorId === user?.id ? current.requests : []);
      if (requests.has(rfq.id)) requests.delete(rfq.id); else requests.set(rfq.id, rfq);
      return { actorId: user?.id ?? null, requests };
    });
  };

  return (
    <div className="p-4 md:p-6">
      {/* ---------------- Topbar ---------------- */}
      <div className="mb-2 flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold md:text-2xl">RFQs</h1>
          <div className="mt-0.5 text-xs text-zinc-500">
            Review supplier quotes and follow each request into its purchase order
          </div>
        </div>
        <div className="flex-1" />
        {/* Quote requests start in the Order Builder; review continues here. */}
        <Link
          href="/reorder-analysis"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          <ExternalLink className="h-3 w-3" />
          RFQs start in the Order Builder
        </Link>
      </div>

      {/* ---------------- Engine tab strip ---------------- */}
      <div className="mb-4 overflow-x-auto">
        <nav aria-label="Reorder Engine sections" className="flex w-max min-w-full items-center gap-1 whitespace-nowrap border-b">
          <Link
            href="/reorder-analysis"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Analysis
          </Link>
          <Link
            href="/demand-planner"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Demand Planner
          </Link>
          <Link
            href="/procurement/automation"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Automation
          </Link>
          <Link
            href="/procurement/runs"
            className="-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:text-foreground"
          >
            Runs
          </Link>
          <span aria-current="page" className="-mb-px border-b-2 border-primary px-3 py-1.5 text-sm font-semibold text-primary">
            RFQs
          </span>
        </nav>
      </div>

      {/* ---------------- Quote workflow introduction ---------------- */}
      <div className="mb-4 flex items-start gap-2 rounded-md border border-zinc-200 bg-zinc-50/70 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-300">
        <Info className="mt-0.5 h-4 w-4 flex-none text-zinc-400" />
        <div>
          Choose <b>Request quote</b> in the{" "}
          <Link href="/reorder-analysis" className="font-medium text-primary underline">
            Order Builder
          </Link>
          . Record the final vendor quote here, review the quantities and costs, then create a draft purchase order with its source history attached.
        </div>
      </div>

      <div className="mb-4"><RfqCommandRecovery commands={commands} /></div>
      {requestedId !== null && focusedRfqId === null && <p role="alert" className="mb-4 text-destructive">The RFQ link has an invalid request ID. Open a request from the list.</p>}
      {focusedRfqId !== null && <Card className="mb-6 p-4"><RfqWorkflowPanel key={focusedRfqId} rfqId={focusedRfqId} showRecovery={false} /></Card>}

      {/* ---------------- 1 · Quote-request drafts ---------------- */}
      <Card className="mb-6 shadow-sm dark:bg-zinc-900">
        <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-lg">Quote requests</CardTitle>
              <CardDescription>
                Newest first. Request status and purchase-order handoff are shown separately.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {Object.keys(statusCounts).length > 0 && <span className="text-xs text-muted-foreground">On this page:</span>}
              {Object.entries(statusCounts).map(([status, count]) => (
                <Badge
                  key={status}
                  variant="outline"
                  className={`text-[10px] capitalize ${rfqStatusClass(status)}`}
                >
                  {statusLabel(status)} {count}
                </Badge>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="flex flex-wrap gap-3 border-b p-3">
            <label className="min-w-0 flex-1 text-sm">Search RFQs<Input aria-label="Search RFQs" maxLength={200} value={params.get("search") ?? ""}
              placeholder="RFQ number, supplier or SKU" onChange={event => changeFilter({ search: event.target.value, offset: null })} /></label>
            <label className="text-sm">RFQ status<select aria-label="RFQ status" className="block h-10 rounded-md border bg-background px-3" value={params.get("status") ?? ""}
              onChange={event => changeFilter({ status: event.target.value, offset: null })}>
              <option value="">All statuses</option>{rfqStoredStatusSchema.options.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select></label>
          </div>
          {!validFilter ? <div role="alert" className="space-y-2 p-4"><p>The RFQ list filters are invalid.</p><Button variant="outline" onClick={() => changeFilter({ offset: null, status: null, search: null })}>Reset RFQ filters</Button></div> : rfqListQuery.isFetching || rfqListQuery.isLoading ? (
            <div className="p-4 text-sm text-zinc-500">Loading quote requests…</div>
          ) : rfqListQuery.isError ? (
            <div role="alert" className="space-y-2 p-4 text-sm text-destructive"><p>{rfqListQuery.error.message}</p><Button variant="outline" onClick={() => void rfqListQuery.refetch()}>Reload quote requests</Button></div>
          ) : rfqs.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-zinc-500">
              <ClipboardList className="h-8 w-8 text-zinc-300" />
              <div className="font-medium text-zinc-600 dark:text-zinc-300">{query?.search || query?.status || query?.offset ? "No quote requests match this page" : "No quote requests yet"}</div>
              <div className="max-w-md">
                Build an order on the{" "}
                <Link href="/reorder-analysis" className="font-medium text-primary underline">
                  Analysis page
                </Link>{" "}
                and choose <b>Request quote</b> for a vendor group whose cost is unknown or stale — the draft
                lands here.
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-8" />
                    <TableHead>RFQ</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Purchase-order handoff</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead>Sent</TableHead>
                    <TableHead>Responses due</TableHead>
                    <TableHead className="text-right">Lines</TableHead>
                    <TableHead className="text-right">Pieces</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rfqs.map((rfq) => {
                    const expanded = openedRfqs.has(rfq.id);
                    return (
                      <Fragment key={rfq.id}>
                        <TableRow
                          aria-expanded={expanded}
                          onClick={() => toggleExpanded(rfq)}
                          className="cursor-pointer"
                        >
                          <TableCell className="pr-0 text-zinc-400">
                            <button type="button" className="min-h-[44px] min-w-[44px]" aria-label={`${expanded ? "Collapse" : "Expand"} ${rfq.rfqNumber}`} aria-expanded={expanded}
                              onClick={event => { event.stopPropagation(); toggleExpanded(rfq); }}>{expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
                          </TableCell>
                          <TableCell className="font-mono text-xs font-semibold text-primary">{rfq.rfqNumber}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={`text-[10px] capitalize ${rfqStatusClass(rfq.status)}`}>
                              {statusLabel(rfq.status)}
                            </Badge>
                          </TableCell>
                          <TableCell className="min-w-[190px] text-xs">
                            <div>{({ not_started: "Not converted", partially_converted: "Partly converted", converted: "Converted", review_required: "Review required" } as const)[rfq.handoff.state]}</div>
                            <div className="text-muted-foreground">{rfq.handoff.linkedLineCount} linked · {rfq.handoff.remainingLineCount} remaining</div>
                            {rfq.handoff.purchaseOrders.map(po => <Link key={po.id} className="block min-h-[32px] py-1 underline" href={`/purchase-orders/${po.id}`} onClick={event => event.stopPropagation()}>{po.poNumber} · {statusLabel(po.status)}</Link>)}
                            {rfq.handoff.issues.map(issue => <p key={issue.code} className="text-amber-700">{issue.message}</p>)}
                          </TableCell>
                          <TableCell className="text-xs">{rfq.vendorName ?? `Vendor #${rfq.vendorId}`}</TableCell>
                          <TableCell className="text-xs">{formatTimestamp(rfq.createdAt)}</TableCell>
                          <TableCell className="text-xs text-zinc-500">
                            {rfq.sentAt ? formatTimestamp(rfq.sentAt) : "Not sent"}
                          </TableCell>
                          <TableCell className="text-xs">{formatDateOnly(rfq.responseDueDate)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{rfq.lineCount}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">
                            {rfq.requestedPiecesTotal.toLocaleString()} pc
                          </TableCell>
                        </TableRow>
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <WorkListPagination label="RFQs" page={listVerified ? rfqListQuery.data?.page : undefined} busy={rfqListQuery.isFetching}
            onOffset={offset => changeFilter({ offset: String(offset) })} />
          <div className="space-y-3 p-3">
            {[...openedRfqs.values()].map(rfq => <section key={`${user?.id}:${rfq.id}`} aria-label={`Opened RFQ ${rfq.rfqNumber}`} className="space-y-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">Opened request · {rfq.rfqNumber}</h3>
                <Button variant="outline" size="sm" onClick={() => toggleExpanded(rfq)}>Close {rfq.rfqNumber}</Button></div>
              <p className="text-xs text-muted-foreground">Request details below were recorded when you opened it. The quote workflow shows the latest verified supplier evidence. This request stays open when the list changes.</p>
              {!listVerified && <p role="status" className="text-sm text-amber-700">The RFQ list is not verified. Your open draft is retained; reload the list before submitting new changes.</p>}
              <RfqLineDetail rfq={rfq} readVerified={listVerified} />
            </section>)}
          </div>
          <div className="border-t px-4 py-2 text-[11px] text-zinc-500 dark:border-zinc-800">
            Expand a request to capture supplier quotes, review revision history, and create a linked draft purchase order.
          </div>
        </CardContent>
      </Card>

      {/* ---------------- 2 · Sourcing requirement queue ---------------- */}
      <Card className="mb-6 shadow-sm dark:bg-zinc-900">
        <CardHeader className="border-b bg-zinc-50/50 pb-4 dark:border-zinc-800 dark:bg-zinc-900/50">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="text-lg">Sourcing requirements</CardTitle>
              <CardDescription>
                {queue?.run
                  ? `Latest completed recommendation run #${queue.run.id}${
                      queue.generatedAt ? ` · ${formatTimestamp(queue.generatedAt)}` : ""
                    } — what still needs quotes and what active requests already cover`
                  : "What still needs quotes and what active requests already cover"}
              </CardDescription>
            </div>
            {queue && (
              <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
                <Badge variant="outline" className="border-amber-200 bg-amber-50 text-[10px] text-amber-800">
                  Open {queue.summary.open}
                </Badge>
                <Badge variant="outline" className="border-blue-200 bg-blue-50 text-[10px] text-blue-700">
                  Partial {queue.summary.partiallyAllocated}
                </Badge>
                <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-[10px] text-emerald-700">
                  Covered {queue.summary.fullyAllocated}
                </Badge>
                <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-[10px] text-zinc-600">
                  Needs supplier {queue.summary.supplierAssignmentRequired}
                </Badge>
                <Badge variant="outline" className="border-violet-200 bg-violet-50 text-[10px] text-violet-700">
                  Active RFQs {queue.summary.activeRfqs}
                </Badge>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {rfqQueueQuery.isFetching || rfqQueueQuery.isLoading ? (
            <div className="p-4 text-sm text-zinc-500">Loading sourcing requirements…</div>
          ) : rfqQueueQuery.isError ? (
            <div role="alert" className="space-y-2 p-4 text-sm text-destructive"><p>{rfqQueueQuery.error?.message ?? "Failed to load the requirement queue."}</p><Button variant="outline" onClick={() => void rfqQueueQuery.refetch()}>Reload sourcing requirements</Button></div>
          ) : !queue?.run ? (
            <div className="p-6 text-sm text-zinc-500">
              No completed recommendation run yet — run the analysis from the{" "}
              <Link href="/reorder-analysis" className="font-medium text-primary underline">
                Analysis page
              </Link>{" "}
              to build the requirement queue.
            </div>
          ) : queueItems.length === 0 ? (
            <div className="p-6 text-sm text-zinc-500">
              Run #{queue.run.id} produced no sourcing requirements.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>SKU</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Recommended</TableHead>
                    <TableHead className="text-right">Allocated</TableHead>
                    <TableHead className="text-right">Remaining</TableHead>
                    <TableHead>Sourcing</TableHead>
                    <TableHead>Active RFQs</TableHead>
                    <TableHead>Preferred vendor</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queueItems.map((item) => {
                    const sourcing = SOURCING_STATUS_BADGE[item.sourcingStatus];
                    return (
                      <TableRow key={item.recommendationLineId}>
                        <TableCell className="font-mono text-xs font-semibold">{item.sku}</TableCell>
                        <TableCell className="max-w-[260px] truncate text-xs">{item.productName}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {item.recommendedPieces.toLocaleString()} pc
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {item.allocatedPieces.toLocaleString()} pc
                          {item.excessPieces > 0 && (
                            <div className="text-[10px] text-amber-700">
                              +{item.excessPieces.toLocaleString()} above recommendation
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs font-semibold tabular-nums">
                          {item.remainingPieces.toLocaleString()} pc
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-[10px] ${sourcing.className}`}>
                            {sourcing.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          {item.allocations.length === 0 ? (
                            <span className="text-zinc-400">—</span>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {item.allocations.map((allocation, index) => (
                                <Badge
                                  key={`${allocation.rfqId}-${index}`}
                                  variant="outline"
                                  className="border-violet-200 bg-violet-50 font-mono text-[10px] text-violet-700"
                                  title={`${allocation.reservedPieces.toLocaleString()} pc reserved (${allocation.requestedPieces.toLocaleString()} originally requested) · ${
                                    allocation.vendorName ?? "unknown vendor"
                                  } · line ${statusLabel(allocation.lineStatus)}`}
                                >
                                  <Link href={`/procurement/rfqs?rfqId=${allocation.rfqId}`} className="inline-flex min-h-[32px] items-center underline">{allocation.rfqNumber}</Link>
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {item.supplierAssignmentRequired ? (
                            <span className="text-amber-700">Needs supplier</span>
                          ) : (
                            item.preferredVendorName ?? "—"
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
