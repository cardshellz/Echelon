import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import {
  listingUpdateViewSchema,
  type ListingUpdateState,
} from "@shared/types/channel-listing-update";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";
import { ListingUpdateVerification } from "./ListingUpdateVerification";

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
    queryFn: () =>
      publicationRequest("GET", base, z.array(listingUpdateViewSchema)),
    refetchInterval: 10_000,
  });
  const [checking, setChecking] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function check(id: string) {
    setChecking(id);
    setError("");
    setMessage("");
    try {
      const updated = await publicationRequest(
        "POST",
        `${base}/${id}/status`,
        listingUpdateViewSchema,
        {},
      );
      await query.refetch();
      setMessage(
        updated.state === "accepted"
          ? "Feed processed. Current item details are shown below."
          : updated.message ?? "Walmart status checked.",
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setChecking(null);
    }
  }
  if (!query.error && !query.data?.length) return null;
  return (
    <Card role="region" aria-label="Listing changes">
      <CardHeader>
        <CardTitle role="heading" aria-level={3}>
          Listing changes
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {(error || query.error) && (
          <p role="alert" className="text-sm text-destructive">
            {error || errorMessage(query.error)}
          </p>
        )}
        {message && (
          <p role="status" className="text-sm">
            {message}
          </p>
        )}
        {query.data?.map((update) => (
          <div key={update.id} className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-medium">{update.title}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {update.sku}
                </p>
              </div>
              <Badge
                variant={
                  update.state === "needs_attention" ||
                  update.state === "uncertain"
                    ? "destructive"
                    : "secondary"
                }
              >
                {labels[update.state]}
              </Badge>
            </div>
            {update.state === "accepted" ? (
              <p className="text-sm">
                Walmart processed this feed. Acceptance alone does not confirm
                the item's category or publication.
              </p>
            ) : update.message && <p className="text-sm">{update.message}</p>}
            {update.state === "accepted" &&
              query.data?.find(
                (candidate) => candidate.sku === update.sku && candidate.submissionId,
              )?.id === update.id && (
                <ListingUpdateVerification
                  channelId={channelId}
                  updateId={update.id}
                />
              )}
            <p className="text-xs text-muted-foreground">
              Updated {new Date(update.updatedAt).toLocaleString()}
            </p>
            {canEdit && (
              <div className="flex flex-wrap gap-2">
                {update.state === "processing" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={checking !== null}
                    onClick={() => void check(update.id)}
                  >
                    {checking === update.id
                      ? "Checking Walmart…"
                      : "Check Walmart status"}
                  </Button>
                )}
                {["accepted", "needs_attention"].includes(update.state) && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onEdit(update.sku)}
                  >
                    Edit listing
                  </Button>
                )}
              </div>
            )}
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">Technical details</summary>
              <p className="break-all">Update {update.id}</p>
              {update.submissionId && (
                <p className="break-all">Walmart feed {update.submissionId}</p>
              )}
            </details>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
