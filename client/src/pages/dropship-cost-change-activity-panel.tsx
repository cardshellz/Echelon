/**
 * What cost detection has found (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C2):
 * whether the worker runs here and when it last passed, the announced changes
 * still ahead of their date, and the change log a page at a time. Read-only:
 * the schedule is written only by the detection worker. Every word and
 * decision lives in `dropship-cost-change-policy-model.ts`.
 */

import React, { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchJson, formatDateTime, queryErrorMessage } from "@/lib/dropship-ops-surface";
import {
  DROPSHIP_COST_CHANGE_DETECTION_ADMIN_URL,
  describeDropshipCostDetection,
  dropshipCostChangeLogPageUrl,
  formatDropshipCostChangeAmounts,
  formatDropshipCostChangeEvent,
  formatDropshipCostChangeNoticeDecision,
  formatDropshipCostChangeVariant,
  formatDropshipCostChangeVendor,
  formatDropshipCostScheduleRecorder,
  formatDropshipCostSource,
  parseDropshipCostChangeDetectionOverview,
  parseDropshipCostChangeLogPage,
  type DropshipCostChangeDetectionOverview,
  type DropshipCostChangeLogPage,
  type DropshipCostChangeLogRowView,
} from "./dropship-cost-change-policy-model";

export function DropshipCostChangeActivityPanel() {
  const detectionQuery = useQuery<DropshipCostChangeDetectionOverview>({
    queryKey: [DROPSHIP_COST_CHANGE_DETECTION_ADMIN_URL],
    queryFn: async ({ signal }) =>
      parseDropshipCostChangeDetectionOverview(
        await fetchJson<unknown>(DROPSHIP_COST_CHANGE_DETECTION_ADMIN_URL, { signal }),
      ),
  });

  return (
    <>
      <DetectionSection query={detectionQuery} />
      <ChangeLogSection />
    </>
  );
}

function DetectionSection({ query }: { query: ReturnType<typeof useQuery<DropshipCostChangeDetectionOverview>> }) {
  const overview = query.data;
  const description = overview ? describeDropshipCostDetection(overview, formatDateTime) : null;
  return (
    <section className="rounded-md border bg-card p-4" data-testid="cost-change-detection">
      <h3 className="font-semibold">Announced changes</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Cost changes found by detection that have not yet taken effect, soonest first. A change is announced for the
        date the policy gave it when it was found.
      </p>
      {query.isError && (
        <Alert variant="destructive" className="mt-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{queryErrorMessage(query.error, "Detection results could not be read.")}</AlertDescription>
        </Alert>
      )}
      {!overview && query.isLoading && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">Loading detection results…</p>
      )}
      {overview && description && (
        <>
          <div className="mt-3 flex flex-wrap items-start gap-2 text-sm" data-testid="cost-change-detection-status">
            <Badge variant={description.status === "completed" || description.status === "in_progress" ? "default" : "outline"} className="shrink-0">
              {detectionBadge(description.status)}
            </Badge>
            <div>
              <p>{description.headline}</p>
              {description.detail && <p className="text-xs text-muted-foreground">{description.detail}</p>}
            </div>
          </div>
          {overview.pending.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground" data-testid="cost-change-pending-empty">
              No cost change is announced.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <Table data-testid="cost-change-pending">
                <TableHeader>
                  <TableRow>
                    <TableHead>Takes effect</TableHead>
                    <TableHead>Vendor</TableHead>
                    <TableHead>Variant</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Cost</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Found</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.pending.map((change) => (
                    <TableRow key={change.entryId} data-testid={`cost-change-pending-${change.entryId}`}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(change.effectiveAt)}</TableCell>
                      <TableCell>{formatDropshipCostChangeVendor(change)}</TableCell>
                      <TableCell>{formatDropshipCostChangeVariant(change)}</TableCell>
                      <TableCell>{change.kind === "increase" ? "Increase" : change.kind === "decrease" ? "Decrease" : "Schedule start"}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDropshipCostChangeAmounts({ fromCents: change.fromCents, toCents: change.unitCostCents })}
                      </TableCell>
                      <TableCell>{formatDropshipCostSource(change.costSource)}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(change.observedAt)} {formatDropshipCostScheduleRecorder(change.recordedBy)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {overview.pending.length >= overview.pendingLimit && (
                <p className="mt-2 text-xs text-muted-foreground">
                  Only the first {overview.pendingLimit.toLocaleString("en-US")} announced changes are listed.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ChangeLogSection() {
  // Pages already shown stay on screen; "Show older" fetches the rows before
  // the last one shown. The first page is a query so a reload refreshes it.
  const [olderPages, setOlderPages] = useState<DropshipCostChangeLogPage[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState("");
  const firstPageQuery = useQuery<DropshipCostChangeLogPage>({
    queryKey: [dropshipCostChangeLogPageUrl(null)],
    queryFn: async ({ signal }) =>
      parseDropshipCostChangeLogPage(await fetchJson<unknown>(dropshipCostChangeLogPageUrl(null), { signal })),
  });
  const pages = firstPageQuery.data ? [firstPageQuery.data, ...olderPages] : [];
  const rows = pages.flatMap((page) => page.items);
  const nextBeforeId = pages.length > 0 ? pages[pages.length - 1]!.nextBeforeId : null;

  async function showOlder() {
    if (nextBeforeId === null || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError("");
    try {
      const page = parseDropshipCostChangeLogPage(await fetchJson<unknown>(dropshipCostChangeLogPageUrl(nextBeforeId)));
      setOlderPages((current) => [...current, page]);
    } catch (caught) {
      setOlderError(queryErrorMessage(caught, "Older log rows could not be read."));
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <section className="rounded-md border bg-card p-4" data-testid="cost-change-log">
      <h3 className="font-semibold">Change log</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Everything detection recorded, newest first: schedule starts, announced and applied changes, and announced
        changes lowered or withdrawn when the live cost moved again. Rows are never edited.
      </p>
      {firstPageQuery.isError && (
        <Alert variant="destructive" className="mt-3">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{queryErrorMessage(firstPageQuery.error, "The change log could not be read.")}</AlertDescription>
        </Alert>
      )}
      {!firstPageQuery.data && firstPageQuery.isLoading && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">Loading the change log…</p>
      )}
      {firstPageQuery.data && rows.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="cost-change-log-empty">
          Nothing has been recorded yet.
        </p>
      )}
      {rows.length > 0 && (
        <ol className="mt-3 divide-y rounded-md border">
          {rows.map((row) => <ChangeLogRow key={row.logId} row={row} />)}
        </ol>
      )}
      {nextBeforeId !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={loadingOlder} onClick={() => void showOlder()} data-testid="cost-change-log-older">
            {loadingOlder ? "Loading…" : "Show older"}
          </Button>
          {olderError && (
            <span role="alert" className="text-sm text-destructive">{olderError}</span>
          )}
        </div>
      )}
    </section>
  );
}

function ChangeLogRow({ row }: { row: DropshipCostChangeLogRowView }) {
  return (
    <li className="space-y-1 p-3 text-sm" data-testid={`cost-change-log-${row.logId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{formatDropshipCostChangeEvent(row.eventType)}</span>
        <span>{formatDropshipCostChangeAmounts(row)}</span>
        {row.retailDriven && <Badge variant="outline">Retail price move</Badge>}
      </div>
      <p className="text-xs text-muted-foreground">
        {formatDropshipCostChangeVendor(row)} · {formatDropshipCostChangeVariant(row)} · {formatDropshipCostSource(row.costSource)}
      </p>
      <p className="text-xs text-muted-foreground">
        Takes effect {formatDateTime(row.effectiveAt)} · Found {formatDateTime(row.observedAt)} {formatDropshipCostScheduleRecorder(row.recordedBy)}
        {row.policyId !== null ? ` · Policy version id ${row.policyId}` : " · Default policy"}
        {` · ${formatDropshipCostChangeNoticeDecision(row.noticeDecision)}`}
      </p>
    </li>
  );
}

function detectionBadge(status: ReturnType<typeof describeDropshipCostDetection>["status"]): string {
  switch (status) {
    case "worker_off":
      return "Worker off here";
    case "never_ran":
      return "No pass yet";
    case "in_progress":
      return "Running";
    case "completed":
      return "Up to date";
  }
}
