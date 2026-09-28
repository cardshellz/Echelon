/**
 * Vendor portal, Cost changes: the .ops cost changes announced on the
 * vendor's listings and not yet in effect, what changed recently, and the
 * policy's notice terms (docs/DROPSHIP-COST-CHANGE-CONTROLS.md, C4). Read
 * only; every word and decision lives in `@/lib/dropship-cost-changes`.
 */

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, TrendingUp } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fetchJson, formatDateTime, queryErrorMessage } from "@/lib/dropship-ops-surface";
import {
  DROPSHIP_COST_CHANGES_URL,
  describeVendorNoticeDecision,
  describeVendorNoticeTerms,
  describeVendorRecentChange,
  formatVendorCostCents,
  formatVendorCostChangeVariant,
  isVendorCostIncrease,
  parseDropshipVendorCostChanges,
  type DropshipVendorCostChanges,
} from "@/lib/dropship-cost-changes";
import { DropshipPortalShell } from "./DropshipPortalShell";

export default function DropshipPortalCostChanges() {
  const query = useQuery<DropshipVendorCostChanges>({
    queryKey: [DROPSHIP_COST_CHANGES_URL],
    queryFn: async ({ signal }) => parseDropshipVendorCostChanges(await fetchJson<unknown>(DROPSHIP_COST_CHANGES_URL, { signal })),
  });
  const data = query.data;

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <TrendingUp className="h-6 w-6 text-[#C060E0]" />
            Cost changes
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Changes to the .ops cost of products on your listings: what is coming, and what changed recently.
          </p>
        </div>

        {query.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{queryErrorMessage(query.error, "Unable to load cost changes.")}</AlertDescription>
          </Alert>
        )}
        {!data && query.isLoading && (
          <div className="mt-5 space-y-3" role="status" aria-label="Loading cost changes">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        )}

        {data && (
          <>
            <section className="mt-5 rounded-md border bg-white p-4" data-testid="cost-changes-terms">
              <h2 className="font-semibold">How notice works</h2>
              <ul className="mt-2 space-y-1 text-sm text-zinc-600">
                {describeVendorNoticeTerms(data.policy).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </section>

            <section className="mt-5 rounded-md border bg-white p-4" data-testid="cost-changes-announced">
              <h2 className="font-semibold">Coming changes</h2>
              {data.announced.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500" data-testid="cost-changes-announced-empty">
                  No cost change is announced for your listings.
                </p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Takes effect</TableHead>
                        <TableHead>Product</TableHead>
                        <TableHead>Change</TableHead>
                        <TableHead>Cost</TableHead>
                        <TableHead>Announced</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.announced.map((change) => (
                        <TableRow key={change.entryId} data-testid={`cost-changes-announced-${change.entryId}`}>
                          <TableCell className="whitespace-nowrap">{formatDateTime(change.effectiveAt)}</TableCell>
                          <TableCell>{formatVendorCostChangeVariant(change)}</TableCell>
                          <TableCell>
                            <Badge variant={change.kind === "increase" ? "destructive" : "secondary"}>
                              {change.kind === "increase" ? "Increase" : "Decrease"}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {formatVendorCostCents(change.fromCents)} → {formatVendorCostCents(change.unitCostCents)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">{formatDateTime(change.announcedAt)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </section>

            <section className="mt-5 rounded-md border bg-white p-4" data-testid="cost-changes-recent">
              <h2 className="font-semibold">Recent changes</h2>
              <p className="mt-1 text-sm text-zinc-500">The last 30 days, newest first.</p>
              {data.recent.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-500" data-testid="cost-changes-recent-empty">Nothing changed in the last 30 days.</p>
              ) : (
                <ol className="mt-3 divide-y rounded-md border">
                  {data.recent.map((change) => (
                    <li key={change.logId} className="space-y-1 p-3 text-sm" data-testid={`cost-changes-recent-${change.logId}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{formatVendorCostChangeVariant(change)}</span>
                        {change.eventType !== "baseline" && (
                          <Badge variant={isVendorCostIncrease(change.eventType) ? "destructive" : "secondary"}>
                            {isVendorCostIncrease(change.eventType) ? "Increase" : change.eventType === "change_withdrawn" ? "Withdrawn" : "Decrease"}
                          </Badge>
                        )}
                      </div>
                      <p>{describeVendorRecentChange(change, formatDateTime)}</p>
                      <p className="text-xs text-zinc-500">
                        Found {formatDateTime(change.observedAt)} · {describeVendorNoticeDecision(change.noticeDecision)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </DropshipPortalShell>
  );
}
