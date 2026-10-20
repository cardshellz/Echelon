import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { z } from "zod";

import { listingIntentChangePageSchema, type ListingIntentChangeStatus } from "@shared/listing-intent-propagation";

import { Button } from "@/components/ui/button";

import { publicationRequest } from "./api";

import { listingIntentChangesUrl, listingIntentChangePresentation, type ListingIntentChangeScope } from "./listing-intent-change-presentation";



interface Props {

  scope: ListingIntentChangeScope;

  canEdit: boolean;

  active?: boolean;

  onReview(row: ListingIntentChangeStatus): void;

  onOpenOperation?(row: ListingIntentChangeStatus): void;

}

/** This view ends at the existing workflow receipt. It never calls a provider or

 * interprets a successful queue handoff as a completed listing update. */

export function ListingIntentChanges(props: Props) {

  const base = listingIntentChangesUrl(props.scope);

  return <ListingIntentChangesPanel key={base} {...props} base={base} />;

}

function ListingIntentChangesPanel({ base, canEdit, active = true, onReview, onOpenOperation }: Props & { base: string }) {

  const client = useQueryClient();

  const [offset, setOffset] = useState(0);

  const [retrying, setRetrying] = useState<string | null>(null);

  const [message, setMessage] = useState<string | null>(null);

  const limit = 20;

  const query = useQuery({

    queryKey: [base, offset],

    queryFn: () => publicationRequest("GET", `${base}?limit=${limit}&offset=${offset}`, listingIntentChangePageSchema),

    enabled: active,

    refetchInterval: active ? 30_000 : false,

  });

  const rows = query.data?.items ?? [];

  const attention = rows.filter(row => listingIntentChangePresentation(row).attention).length;

  async function retry(row: ListingIntentChangeStatus) {

    if (!canEdit || !listingIntentChangePresentation(row).retry || retrying) return;

    setRetrying(row.id); setMessage(null);

    try {

      const result = await publicationRequest("POST", `${base}/${row.id}/retry`, z.object({ retried: z.boolean() }));

      setMessage(result.retried ? "Another update attempt has been requested. Check update status for its result."

        : "This change is no longer eligible for retry. Its current status has been refreshed.");

      await client.invalidateQueries({ queryKey: [base] });

    } catch (error) {

      setMessage(error instanceof Error ? error.message : "The retry could not be requested. Refresh and try again.");

    } finally { setRetrying(null); }

  }

  return <details className="rounded-md border bg-background text-sm" data-testid="listing-intent-changes">

    <summary className="cursor-pointer px-3 py-2 font-medium">

      Listing updates{query.data ? ` (${query.data.total})` : ""}

      {attention > 0 ? ` - ${attention} on this page need attention` : query.isError ? " - Status unavailable" : ""}

    </summary>

    <div className="space-y-3 border-t px-3 py-3">

      <p className="text-xs text-muted-foreground">Product and settings changes are saved here. Some changes need review before an update can be requested.</p>
      <p className="text-xs text-muted-foreground">This is automatic update history. Later manual actions do not clear these records; check listing status for their result.</p>

      {query.isPending && <p role="status">Loading saved changes...</p>}

      {query.isError && <p role="alert">{query.error instanceof Error ? query.error.message : "Saved changes could not be loaded."}</p>}

      {message && <p role="status">{message}</p>}

      <Button size="sm" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh status</Button>

      {query.data && rows.length === 0 && <p className="text-muted-foreground">No saved changes on this page.</p>}

      <ul className="divide-y">

        {rows.map(row => {

          const status = listingIntentChangePresentation(row);

          return <li key={row.id} className="space-y-1 py-2">

            <p className="font-medium">Product {row.product_id} - {status.label}</p>

            <p className="text-xs text-muted-foreground">{status.message}</p>
            {row.lifecycle && <details className="text-xs">
              <summary className="cursor-pointer">Channel work checked {new Date(row.lifecycle.assessedAt).toLocaleString()}</summary>
              <ul className="space-y-1 py-1">{row.lifecycle.members.map(member =>
                <li key={member.productVariantId}>Variant {member.productVariantId}: {member.message}</li>)}</ul>
            </details>}

            <div className="flex flex-wrap gap-2 pt-1">

              {row.state !== "delivered" && row.state !== "not_applicable" && <Button size="sm" variant="outline" onClick={() => onReview(row)}>{row.last_error_resolution ? "Resolve issue" : "Review listing"}</Button>}

              {row.receipt && onOpenOperation && <Button size="sm" variant="outline" onClick={() => onOpenOperation(row)}>View update status</Button>}

              {canEdit && status.retry && <Button size="sm" variant="outline" disabled={retrying !== null} onClick={() => void retry(row)}>{retrying === row.id ? "Requesting retry..." : "Retry update"}</Button>}

            </div>

          </li>;

        })}

      </ul>

      {query.data && query.data.total > limit && <div className="flex items-center gap-3">

        <Button size="sm" variant="outline" disabled={offset === 0 || query.isFetching} onClick={() => setOffset(value => Math.max(0, value - limit))}>Previous</Button>

        <span className="text-xs">{offset + 1}-{Math.min(offset + rows.length, query.data.total)} of {query.data.total}</span>

        <Button size="sm" variant="outline" disabled={offset + rows.length >= query.data.total || query.isFetching} onClick={() => setOffset(value => value + limit)}>Next</Button>

      </div>}

    </div>

  </details>;

}
