import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { ListingOperation } from "@shared/types/channel-listing-publication";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage, money } from "./model";
import { ListingActivityDetails } from "./ListingActivityDetails";

const operationLabels: Record<ListingOperation["state"], string> = {
  queued: "Queued",
  submitting: "Submitting",
  processing: "Walmart processing",
  completed: "Processed",
  partially_completed: "Partially processed",
  needs_attention: "Needs attention",
  needs_reconciliation: "Outcome needs verification",
};
type ActivityAction = "check" | "edit";

export function ListingActivity({
  channelId,
  connectionId,
  operations,
  canEdit,
  onReconcile,
  onEditFailed,
}: {
  channelId: number;
  connectionId: number;
  operations: ListingOperation[];
  canEdit: boolean;
  onReconcile(id: string): Promise<void>;
  onEditFailed(id: string): Promise<void>;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<{ id: string; action: ActivityAction } | null>(null);
  const [error, setError] = useState("");

  function toggleDetails(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runAction(id: string, action: ActivityAction) {
    setBusy({ id, action });
    setError("");
    try {
      if (action === "check") await onReconcile(id);
      else await onEditFailed(id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card role="region" aria-label="Publication activity" className="@container/activity min-w-0">
      <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-3">
        <CardTitle>Publication Activity</CardTitle>
        <CardDescription>
          Expand a submission for item results and Walmart messages. Processing continues after you leave.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
        {error && <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">{error}</p>}
        {operations.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No listing submissions yet. Add products, complete their details, and review the draft.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <table aria-label="Listing submissions" className="block w-full text-left text-sm @4xl/activity:table @4xl/activity:table-fixed">
              <thead className="hidden bg-muted/40 text-xs text-muted-foreground @4xl/activity:table-header-group">
                <tr>
                  <th scope="col" className="w-10"><span className="sr-only">Details</span></th>
                  <th scope="col" className="px-2 py-2 font-medium">SKU / Items</th>
                  <th scope="col" className="w-36 px-2 py-2 font-medium">Submitted</th>
                  <th scope="col" className="w-24 px-2 py-2 text-right font-medium">Price</th>
                  <th scope="col" className="w-52 px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="w-44 px-2 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="block @4xl/activity:table-row-group">
                {operations.map((operation) => {
                  const open = expanded.has(operation.id);
                  const singleItem = operation.items.length === 1 ? operation.items[0] : null;
                  const itemLabel = singleItem ? singleItem.sku : `${operation.items.length} items`;
                  const submitted = new Date(operation.createdAt);
                  const detailsId = `publication-details-${operation.id}`;
                  const checking = busy?.id === operation.id && busy.action === "check";
                  const editing = busy?.id === operation.id && busy.action === "edit";
                  const attentionCount = operation.items.filter((item) => item.state === "needs_attention" || item.state === "needs_reconciliation").length;
                  return (
                    <Fragment key={operation.id}>
                      <tr
                        data-submission-id={operation.id}
                        className={`grid grid-cols-[2rem_minmax(0,1fr)_4.5rem] items-center gap-x-1 gap-y-1 border-t px-1 py-2 first:border-t-0 @4xl/activity:table-row @4xl/activity:px-0 @4xl/activity:py-0 ${open ? "bg-muted/40" : "hover:bg-muted/20"}`}
                      >
                        <td className="col-start-1 row-span-3 row-start-1 block self-start @4xl/activity:table-cell @4xl/activity:p-1 @4xl/activity:align-middle">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`${open ? "Hide" : "Show"} details for ${itemLabel}, submitted ${submitted.toLocaleString()}`}
                            aria-expanded={open}
                            aria-controls={detailsId}
                            onClick={() => toggleDetails(operation.id)}
                          >
                            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          </Button>
                        </td>
                        <td className="col-start-2 row-start-1 block min-w-0 @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          <span className={`block truncate ${singleItem ? "font-mono text-xs" : "font-medium"}`} title={itemLabel}>{itemLabel}</span>
                        </td>
                        <td className="col-start-2 row-start-2 block text-xs text-muted-foreground @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          <span className="sr-only @4xl/activity:hidden">Submitted </span>
                          <time dateTime={operation.createdAt}>
                            {submitted.toLocaleDateString()}{" "}
                            <span className="@4xl/activity:block">{submitted.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                          </time>
                        </td>
                        <td className="col-start-3 row-start-1 block px-1 text-right text-xs tabular-nums @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2 @4xl/activity:text-sm">
                          <span className="sr-only @4xl/activity:hidden">Submitted price: </span>
                          {singleItem ? <span>{money(singleItem.priceCents)}</span> : operation.items.length > 1 ? <span className="text-xs text-muted-foreground">Per item</span> : "—"}
                        </td>
                        <td className="col-start-2 row-start-3 block min-w-0 @4xl/activity:table-cell @4xl/activity:px-3 @4xl/activity:py-2">
                          <span className="sr-only @4xl/activity:hidden">Submission status: </span>
                          <Badge
                            className="max-w-full whitespace-normal px-2 text-[11px] leading-4"
                            variant={operation.state.startsWith("needs_") || attentionCount > 0 ? "destructive" : "secondary"}
                          >
                            {operationLabels[operation.state]}
                          </Badge>
                          {operation.items.length > 1 && attentionCount > 0 && (
                            <span className="mt-0.5 block text-xs text-destructive">{attentionCount} {attentionCount === 1 ? "item needs" : "items need"} attention</span>
                          )}
                        </td>
                        <td className="col-start-3 row-span-2 row-start-2 block px-1 text-right @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          {canEdit && operation.state !== "queued" && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-8 w-8 px-0 @4xl/activity:w-auto @4xl/activity:px-3"
                              aria-label={checking ? "Checking Walmart status" : "Check Walmart status"}
                              title="Check Walmart status"
                              disabled={busy !== null}
                              onClick={() => void runAction(operation.id, "check")}
                            >
                              <RefreshCw aria-hidden="true" className={checking ? "animate-spin" : "@4xl/activity:hidden"} />
                              <span className="hidden @4xl/activity:inline">{checking ? "Checking…" : "Check Walmart status"}</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="block border-t bg-muted/20 @4xl/activity:table-row">
                          <td colSpan={6} className="block min-w-0 p-3 @4xl/activity:table-cell @4xl/activity:p-4">
                            <div id={detailsId} role="region" aria-label={`Submission details for ${itemLabel}, submitted ${submitted.toLocaleString()}`} className="min-w-0 space-y-4">
                              {canEdit && operation.items.some((item) => item.canRetry) && (
                                <div className="space-y-1.5">
                                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void runAction(operation.id, "edit")}>
                                    {editing ? "Adding to draft…" : "Edit failed items"}
                                  </Button>
                                  <p className="text-xs text-muted-foreground">Add failed items to the draft for correction and review. Existing draft edits are preserved.</p>
                                </div>
                              )}
                              <ListingActivityDetails channelId={channelId} connectionId={connectionId} operation={operation} />
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
