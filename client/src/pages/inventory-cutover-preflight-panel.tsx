import React, { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  inventoryCutoverPreflightSchema,
  type InventoryCutoverPreflight,
} from "@shared/types/inventory-cutover-preflight";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const PREFLIGHT_URL = "/api/inventory-planning/admin/cutover-preflight";
const EVIDENCE_PAGE_SIZE = 20;

export async function fetchInventoryCutoverPreflight(signal?: AbortSignal): Promise<InventoryCutoverPreflight> {
  const response = await fetch(PREFLIGHT_URL, { method: "GET", credentials: "include", signal });
  if (!response.ok) {
    throw new Error(`Could not capture inventory evidence (HTTP ${response.status}). Review access or server availability and retry.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The inventory evidence response is not valid JSON. No new snapshot is being shown; retry after the service is corrected.");
  }
  const parsed = inventoryCutoverPreflightSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("The inventory evidence response could not be verified. No new snapshot is being shown; retry after the service is corrected.");
  }
  return parsed.data;
}

export function evidencePage<T>(rows: readonly T[], requestedPage: number) {
  const totalPages = Math.max(1, Math.ceil(rows.length / EVIDENCE_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number.isSafeInteger(requestedPage) ? requestedPage : 0, totalPages - 1));
  return { page, totalPages, rows: rows.slice(page * EVIDENCE_PAGE_SIZE, (page + 1) * EVIDENCE_PAGE_SIZE) };
}

function EvidencePages<T>({ rows, label, renderRows }: {
  rows: readonly T[];
  label: string;
  renderRows: (visibleRows: readonly T[]) => ReactNode;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  const visible = evidencePage(rows, requestedPage);
  return <section className="space-y-2" aria-label={label}>
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span>{label}: {rows.length} records · page {visible.page + 1} of {visible.totalPages}</span>
      {visible.totalPages > 1 && <>
        <Button size="sm" variant="outline" aria-label={`Previous ${label} page`} disabled={visible.page === 0}
          onClick={() => setRequestedPage(visible.page - 1)}>Previous</Button>
        <Button size="sm" variant="outline" aria-label={`Next ${label} page`} disabled={visible.page + 1 >= visible.totalPages}
          onClick={() => setRequestedPage(visible.page + 1)}>Next</Button>
      </>}
    </div>
    {renderRows(visible.rows)}
  </section>;
}

export function InventoryCutoverEvidence({ report }: { report: InventoryCutoverPreflight }) {
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge variant="outline">{report.outcome === "review_required" ? "Findings need review" : "Evidence captured"}</Badge>
      <span>Runtime authority: {report.runtimeAuthority ?? "Unknown"}</span>
      <span>Captured: <time dateTime={report.capturedAt}>{report.capturedAt}</time></span>
    </div>
    <p className="text-xs text-muted-foreground break-all">Evidence hash: {report.evidenceHash}</p>
    <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
      {[
        ["Open WMS orders", report.summary.orders], ["Order lines", report.summary.lines],
        ["Unstarted demand lines", report.summary.unstartedDemandLines], ["No inventory demand", report.summary.noInventoryDemandLines],
        ["Lines needing review", report.summary.reviewLines], ["Inventory levels", report.summary.inventoryLevels],
        ["Unattributed reservation levels", report.summary.unattributedReservationLevels],
        ["Terminal orders excluded", report.excludedTerminalOrderCount],
      ].map(([label, value]) => <div className="rounded border p-2" key={label}><dt>{label}</dt><dd className="font-semibold">{value}</dd></div>)}
    </dl>
    <p className="text-sm">Candidate demand is evidence for untouched order lines, not a reservation or a fulfillability promise.
      Unattributed reservations are unresolved records, not free stock or an instruction to clear inventory.</p>
    {report.findings.length === 0 ? <p>No findings in this bounded snapshot. This is not approval to activate.</p>
      : <EvidencePages rows={report.findings} label="Findings" renderRows={(findings) => <ul className="space-y-2 text-sm">
        {findings.map((finding, index) => <li key={`${finding.code}:${finding.orderItemId}:${finding.inventoryLevelId}:${index}`} className="rounded border p-2">
          <p className="font-medium">{finding.code}</p><p>{finding.message}</p>
          <p className="text-muted-foreground">{[
            finding.orderId !== null ? `Order ${finding.orderId}` : null,
            finding.orderItemId !== null ? `line ${finding.orderItemId}` : null,
            finding.inventoryLevelId !== null ? `inventory level ${finding.inventoryLevelId}` : null,
          ].filter(Boolean).join(" · ") || "Catalog-level evidence"}</p>
        </li>)}
      </ul>} />}
    <details className="rounded border p-3">
      <summary className="cursor-pointer text-sm font-medium">Inspect captured order lines</summary>
      <div className="mt-3 overflow-x-auto"><EvidencePages rows={report.lines} label="Order lines" renderRows={(lines) =>
        <table className="w-full text-sm"><thead><tr>
          <th className="text-left">Order / line</th><th className="text-left">SKU / warehouse</th>
          <th>Ordered</th><th>Picked</th><th>Fulfilled</th><th>Candidate demand</th><th className="text-left">Assessment</th>
        </tr></thead><tbody>{lines.map((line) => <tr key={line.orderItemId} className="border-t">
          <td>{line.orderId} / {line.orderItemId}</td><td>{line.sku} / {line.warehouseId ?? "Unknown"}</td>
          <td className="text-center">{line.orderedQty}</td><td className="text-center">{line.recordedPickedQty}</td>
          <td className="text-center">{line.recordedFulfilledQty}</td><td className="text-center">{line.candidateDemandQty ?? "Not proven"}</td>
          <td>{line.disposition.replaceAll("_", " ")}{line.findingCodes.length > 0 && <p>{line.findingCodes.join(", ")}</p>}</td>
        </tr>)}</tbody></table>} /></div>
    </details>
    <details className="rounded border p-3">
      <summary className="cursor-pointer text-sm font-medium">Inspect captured inventory encumbrances</summary>
      <div className="mt-3 overflow-x-auto"><EvidencePages rows={report.inventoryLevels} label="Inventory levels" renderRows={(levels) =>
        <table className="w-full text-sm"><thead><tr><th className="text-left">Level / variant / location</th>
          <th>Physical</th><th>Recorded reserved</th><th>Canonical open</th><th>Build open</th><th>Unattributed</th><th>Picked</th><th>Packed</th>
        </tr></thead><tbody>{levels.map((level) => <tr key={level.inventoryLevelId} className="border-t text-center">
          <td className="text-left">{level.inventoryLevelId} / {level.productVariantId} / {level.warehouseLocationId}</td>
          <td>{level.physicalQty}</td><td>{level.recordedReservedQty}</td><td>{level.canonicalOpenQty}</td><td>{level.standaloneBuildOpenQty}</td>
          <td>{level.unattributedReservedQty}</td><td>{level.pickedQty}</td><td>{level.packedQty}</td>
        </tr>)}</tbody></table>} /></div>
    </details>
    <section className="rounded border border-amber-300 p-3 text-sm" aria-label="Not evaluated">
      <h4 className="font-semibold">Not evaluated by this report</h4>
      <ul className="list-disc pl-5">{report.notEvaluated.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </section>
  </div>;
}

export function InventoryCutoverPreflightPanel({ canView, actorId }: { canView: boolean; actorId: string | null }) {
  const actor = actorId?.trim() || null;
  const query = useQuery({
    queryKey: [PREFLIGHT_URL, actor],
    queryFn: ({ signal }) => {
      if (!canView || !actor) throw new Error("An authenticated operator with inventory planning view permission is required.");
      return fetchInventoryCutoverPreflight(signal);
    },
    // Manual capture only: this can inspect the complete open-WMS cohort.
    // Never reuse another operator's snapshot after an in-app account change.
    enabled: false, retry: false, refetchInterval: false, gcTime: 0,
    refetchOnMount: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  if (!canView || !actor) return null;
  return <Card>
    <CardHeader>
      <CardTitle>Open-order and inventory evidence</CardTitle>
      <p className="text-sm text-muted-foreground">Read-only evidence from nonterminal WMS demand and current inventory encumbrances.
        This is not full activation readiness and does not reserve, repair, publish, or switch authority.</p>
    </CardHeader>
    <CardContent className="space-y-4">
      <Button variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>
        {query.isFetching ? "Capturing evidence…" : query.data ? "Refresh read-only evidence" : "Capture read-only evidence"}
      </Button>
      {query.isFetching && <p role="status">{query.data ? "Refreshing; the previous snapshot remains below until a new capture succeeds." : "Capturing the current evidence. No inventory is being changed."}</p>}
      {query.error && <p role="alert" className="text-sm text-destructive">{query.error.message}
        {query.data ? " The last successful snapshot remains below and may be stale; it is not current readiness evidence." : " No verified snapshot is available."}</p>}
      {!query.data && !query.isFetching && !query.error && <p className="text-sm">No snapshot captured in this view. Use the read-only capture to inspect the current records.</p>}
      {query.data && <>
        <p className="text-sm text-muted-foreground">Point-in-time snapshot, not live availability. Refresh after order or inventory changes.</p>
        <InventoryCutoverEvidence key={query.data.evidenceHash} report={query.data} />
      </>}
    </CardContent>
  </Card>;
}
