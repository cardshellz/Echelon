import { Fragment, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Pencil, RefreshCw } from "lucide-react";
import { z } from "zod";
import {
  listingUpdateViewSchema,
  type ListingUpdateState,
} from "@shared/types/channel-listing-update";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";
import { ListingUpdateActivityDetails } from "./ListingUpdateActivityDetails";

const labels: Record<ListingUpdateState, string> = {
  reviewed: "Reviewed",
  queued: "Queued",
  sending: "Sending changes",
  processing: "Walmart processing",
  accepted: "Feed accepted",
  needs_attention: "Needs attention",
  uncertain: "Check submission outcome",
};

export function ListingUpdateActivity({
  channelId,
  canEdit,
  onEdit,
}: {
  channelId: number;
  canEdit: boolean;
  onEdit(sku: string): void;
}) {
  const base = `/api/channels/${channelId}/listing-updates`;
  const query = useQuery({
    queryKey: [base],
    queryFn: () => publicationRequest("GET", base, z.array(listingUpdateViewSchema)),
    refetchInterval: 10_000,
  });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [checking, setChecking] = useState<string | null>(null);
  const checkInFlight = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function toggleDetails(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function check(id: string) {
    if (!canEdit || checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(id);
    setError("");
    setMessage("");
    try {
      const updated = await publicationRequest("POST", `${base}/${id}/status`, listingUpdateViewSchema, {});
      await query.refetch();
      setMessage(`Status checked for ${updated.sku}: ${labels[updated.state]}. Expand the change for details.`);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      checkInFlight.current = false;
      setChecking(null);
    }
  }

  return (
    <Card role="region" aria-label="Listing changes" className="@container/activity min-w-0">
      <CardHeader className="p-4 pb-3 sm:p-6 sm:pb-3">
        <CardTitle role="heading" aria-level={3}>Listing changes</CardTitle>
        <CardDescription>Expand a change for Walmart messages and item verification.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 sm:p-6 sm:pt-0">
        {(error || query.error) && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive [overflow-wrap:anywhere]">
              {error || errorMessage(query.error)}
            </p>
            {query.error && <Button variant="outline" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Reload listing changes</Button>}
          </div>
        )}
        {message && <p role="status" className="text-sm [overflow-wrap:anywhere]">{message}</p>}
        {query.isPending && !query.error && <p role="status" className="py-6 text-center text-sm text-muted-foreground">Loading listing changes…</p>}
        {!query.isPending && !query.error && query.data?.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No listing changes yet. Edits sent to Walmart will appear here.</p>
        )}
        {!!query.data?.length && (
          <div className="overflow-hidden rounded-md border">
            <table aria-label="Listing changes history" className="block w-full text-left text-sm @4xl/activity:table @4xl/activity:table-fixed">
              <thead className="hidden bg-muted/40 text-xs text-muted-foreground @4xl/activity:table-header-group">
                <tr>
                  <th scope="col" className="w-10"><span className="sr-only">Details</span></th>
                  <th scope="col" className="px-2 py-2 font-medium">Product / SKU</th>
                  <th scope="col" className="w-36 px-2 py-2 font-medium">Updated</th>
                  <th scope="col" className="w-48 px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="w-44 px-2 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="block @4xl/activity:table-row-group">
                {query.data.map((update) => {
                  const open = expanded.has(update.id);
                  const updated = new Date(update.updatedAt);
                  const detailsId = `listing-change-details-${update.id}`;
                  const isChecking = checking === update.id;
                  return (
                    <Fragment key={update.id}>
                      <tr data-listing-update-id={update.id}
                        className={`grid grid-cols-[2rem_minmax(0,1fr)_2.5rem] items-center gap-x-1 gap-y-1 border-t px-1 py-2 first:border-t-0 @4xl/activity:table-row @4xl/activity:px-0 @4xl/activity:py-0 ${open ? "bg-muted/40" : "hover:bg-muted/20"}`}>
                        <td className="col-start-1 row-span-3 row-start-1 block self-start @4xl/activity:table-cell @4xl/activity:p-1 @4xl/activity:align-middle">
                          <Button variant="ghost" size="icon" className="h-8 w-8"
                            aria-label={`${open ? "Hide" : "Show"} change details for ${update.sku}, updated ${updated.toLocaleString()}`}
                            aria-expanded={open} aria-controls={detailsId} onClick={() => toggleDetails(update.id)}>
                            {open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                          </Button>
                        </td>
                        <td className="col-start-2 row-start-1 block min-w-0 @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          <span className="block truncate font-medium" title={update.title}>{update.title}</span>
                          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground" title={update.sku}>{update.sku}</span>
                        </td>
                        <td className="col-start-2 row-start-2 block text-xs text-muted-foreground @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          <span className="sr-only @4xl/activity:hidden">Updated </span>
                          <time dateTime={update.updatedAt}>
                            {updated.toLocaleDateString()}{" "}
                            <span className="@4xl/activity:block">{updated.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
                          </time>
                        </td>
                        <td className="col-start-2 row-start-3 block min-w-0 @4xl/activity:table-cell @4xl/activity:px-3 @4xl/activity:py-2">
                          <Badge className="max-w-full whitespace-normal px-2 text-[11px] leading-4"
                            variant={update.state === "needs_attention" || update.state === "uncertain" ? "destructive" : "secondary"}>
                            {labels[update.state]}
                          </Badge>
                        </td>
                        <td className="col-start-3 row-span-3 row-start-1 block px-1 text-right @4xl/activity:table-cell @4xl/activity:px-2 @4xl/activity:py-2">
                          {canEdit && update.state === "processing" && (
                            <Button variant="outline" size="sm" className="h-8 w-8 px-0 @4xl/activity:w-auto @4xl/activity:px-3"
                              aria-label={isChecking ? "Checking Walmart status" : "Check Walmart status"} title="Check Walmart status"
                              disabled={checking !== null} onClick={() => void check(update.id)}>
                              <RefreshCw aria-hidden="true" className={isChecking ? "animate-spin" : "@4xl/activity:hidden"} />
                              <span className="hidden @4xl/activity:inline">{isChecking ? "Checking…" : "Check Walmart status"}</span>
                            </Button>
                          )}
                          {canEdit && (update.state === "accepted" || update.state === "needs_attention") && (
                            <Button variant="outline" size="sm" className="h-8 w-8 px-0 @4xl/activity:w-auto @4xl/activity:px-3"
                              aria-label={`Edit listing ${update.sku}`} title="Edit listing" onClick={() => onEdit(update.sku)}>
                              <Pencil aria-hidden="true" className="@4xl/activity:hidden" />
                              <span className="hidden @4xl/activity:inline">Edit listing</span>
                            </Button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="block border-t bg-muted/20 @4xl/activity:table-row">
                          <td colSpan={5} className="block min-w-0 p-3 @4xl/activity:table-cell @4xl/activity:p-4">
                            <div id={detailsId} role="region" aria-label={`Change details for ${update.sku}, updated ${updated.toLocaleString()}`}>
                              <ListingUpdateActivityDetails channelId={channelId} update={update}
                                verifyCurrentItem={query.data.find(candidate => candidate.sku === update.sku && candidate.submissionId)?.id === update.id} />
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
